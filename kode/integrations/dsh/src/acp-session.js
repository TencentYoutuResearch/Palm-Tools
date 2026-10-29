/** ACP v1 native conversations using the official SDK, shared by Cursor, Claude and custom Agents. */
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnAgent } from './managed-agent-process.js'
import { createToolProxy } from './tool-proxy.js'
import { askAcpForm } from './acp-questions.js'
import { acpToolItem } from './native-tools.js'
import { resolveAdvertisedModel } from './model-alias.js'
import { modeAllowed } from './native-commands.js'

const flattenOptions = options => (options ?? []).flatMap(o => o.options ?? [o])
const effortOption = state => state?.configOptions?.find(option => option.type === 'select' && (option.category === 'thought_level' || /(?:^|[_-])effort(?:$|[_-])/i.test(option.id)))
function abortable(task, signal) {
  signal.throwIfAborted()
  let abort
  const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason ?? new Error('ACP request cancelled')); signal.addEventListener('abort', abort, { once: true }) })
  return Promise.race([task, cancelled]).finally(() => signal.removeEventListener('abort', abort))
}
export class AcpSession {
  constructor(profile, cwd, handlers = {}) {
    this.profile = profile; this.cwd = cwd; this.handlers = handlers
    this.lifetime = new AbortController(); this.rpc = { closed: false }; this.requests = new Set()
    this.commands = []; this.setupUpdates = []; this.commandsReady = Promise.withResolvers()
  }
  async launch() {
    if (this.profile.type === 'claude') {
      this.launchRoot = await mkdtemp(join(tmpdir(), 'kode-claude-launch-'))
      const launcher = join(this.launchRoot, 'cli.mjs')
      // The upstream bridge accepts a configurable Claude executable. This tiny
      // launcher preserves argument arrays and custom wrappers without a shell.
      await writeFile(launcher, `import {spawn} from 'node:child_process';\nconst env={...process.env};delete env.CLAUDE_CODE_EXECUTABLE;\nconst child=spawn(${JSON.stringify(this.profile.executable)},[...${JSON.stringify(this.profile.args ?? [])},...process.argv.slice(2)],{env,stdio:'inherit',shell:false});\nfor(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>child.kill(signal));\nchild.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code??1));\n`, { mode: 0o600 })
      this.lifetime.signal.throwIfAborted()
      this.process = spawnAgent(process.execPath, [fileURLToPath(import.meta.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js'))], this.cwd, { ...this.profile.env, CLAUDE_CODE_EXECUTABLE: launcher })
    } else {
      this.process = spawnAgent(this.profile.executable, [...(this.profile.args ?? []), ...(this.profile.type === 'cursor' ? ['acp'] : this.profile.type==='codebuddy'?['--acp']:[])], this.cwd, this.profile.env)
    }
    const app = client({ name: 'kode-dsh' })
    app.onNotification('session/update', ({ params }) => this.update(params))
    app.onRequest('session/request_permission', ({ params, signal }) => this.permission(params, signal))
    app.onRequest('elicitation/create', ({ params, signal }) => {
      if (!this.active || (params.sessionId && params.sessionId !== this.threadId)) return { action: 'cancel' }
      return askAcpForm(params, (request, signal) => this.handlers.question?.(request, signal), AbortSignal.any([signal, this.active.signal]))
    })
    app.onRequest('*', context => this.extension(context))
    this.connection = app.connect(ndJsonStream(Writable.toWeb(this.process.child.stdin), Readable.toWeb(this.process.child.stdout)))
    this.connection.closed.then(() => { this.rpc.closed = true; this.active?.end(this.process.error ?? new Error('ACP connection closed')) })
    this.process.child.on('error', error => this.connection.close(error))
    this.process.child.on('exit', () => this.connection.close(this.process.error))
  }
  request(method, params, signal = this.lifetime.signal, timeoutMs = 15000) {
    const fused = AbortSignal.any([this.lifetime.signal, signal, ...(timeoutMs ? [AbortSignal.timeout(timeoutMs)] : [])])
    fused.throwIfAborted()
    return abortable(this.connection.agent.request(method, params, { cancellationSignal: fused }), fused)
  }
  initialize(signal) {
    return this.initialized ??= (async () => {
      this.lifetime.signal.throwIfAborted(); signal?.throwIfAborted()
      await this.launch()
      this.info = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: 'kode-dsh', version: '0.1.0' }, clientCapabilities: { elicitation: { form: {} } } }, signal, this.profile.startupTimeoutMs ?? 15000)
      if (this.info.protocolVersion !== 1) throw new Error('Agent did not negotiate ACP v1')
    })()
  }
  async open(binding, tools, signal = this.lifetime.signal) {
    signal.throwIfAborted()
    await this.initialize(signal)
    const mcpServers = []
    if (tools.length) {
      this.proxy = await createToolProxy(tools, async (name, args) => {
        if (!this.active) throw new Error('Agent tools require an active conversation turn')
        return this.handlers.tool({ threadId: this.threadId, turnId: this.active.turnId, callId: randomUUID(), tool: name, arguments: args }, this.active.signal)
      })
      mcpServers.push(this.proxy.definition)
    }
    this.opening = true
    const settings = typeof this.profile.autoCompactEnabled === 'boolean' ? { _meta: { claudeCode: { options: { settings: { autoCompactEnabled: this.profile.autoCompactEnabled } } } } } : {}
    try { if (binding.threadId) {
      const resume = this.info.agentCapabilities?.sessionCapabilities?.resume
      if (!this.info.agentCapabilities?.loadSession && !resume) throw new Error('This ACP Agent cannot restore saved conversations; it will not silently start a new one')
      this.threadId = binding.threadId
      this.state = await this.request(resume ? 'session/resume' : 'session/load', { sessionId: this.threadId, cwd: this.cwd, mcpServers, ...settings }, signal) ?? {}
    } else {
      this.state = await this.request('session/new', { cwd: this.cwd, mcpServers, ...settings }, signal)
      this.threadId = this.state.sessionId
    } } finally { this.opening = false }
    if (!this.threadId) throw new Error('ACP Agent returned no session ID')
    for (const update of this.setupUpdates.splice(0)) this.update(update)
    return this.threadId
  }
  async listModels(signal, { model } = {}) {
    await this.open({}, [], signal)
    await this.waitForCommands(signal)
    if (model && model !== 'default') await this.selectModel(model, signal)
    const option = this.state.configOptions?.find(o => o.category === 'model' || o.id === 'model')
    const effort = effortOption(this.state), current = option?.currentValue ?? this.state.models?.currentModelId
    const models = option ? flattenOptions(option.options).map(m => ({ id: m.value, model: m.value, displayName: m.name, isDefault: m.value === current })) : (this.state.models?.availableModels ?? []).map(m => ({ id: m.modelId, model: m.modelId, displayName: m.name, isDefault: m.modelId === current }))
    return models.map(row => ({ ...row, inputModalities: this.info.agentCapabilities?.promptCapabilities?.image || this.profile.type === 'claude' ? ['text', 'image'] : ['text'], ...(effort && row.id === current ? { reasoningEfforts: flattenOptions(effort.options).map(value => ({ id: value.value, name: value.name, description: value.description })), defaultReasoningEffort: effort.currentValue } : {}) }))
  }
  async waitForCommands(signal = this.lifetime.signal) {
    // Claude sends its authoritative commands after the setup response.
    let timer
    try { await abortable(Promise.race([this.commandsReady.promise, new Promise(resolve => { timer = setTimeout(resolve, 1500) })]), signal ?? this.lifetime.signal) }
    finally { clearTimeout(timer) }
  }
  async configure(model, signal, effort) {
    const policy = this.handlers.policy?.() ?? { mode: 'read-only' }
    if (this.profile.fixedPolicy && (policy.mode !== this.profile.fixedPolicy.mode || (this.handlers.approvalPolicy?.() ?? 'ask') !== this.profile.fixedPolicy.approval)) throw new Error('此 dsh ACP 版本不支持运行中修改权限，请新建会话应用新的权限。')
    const available = this.state.modes?.availableModes ?? []
    const preferred = policy.mode === 'read-only' ? ['plan', 'ask', 'read-only'] : policy.mode==='danger-full-access'?['bypassPermissions','fullAccess','yolo','default','agent','code']:['acceptEdits','default','agent','code']
    const requestedMode = this.handlers.mode?.()
    const mode = requestedMode && modeAllowed(requestedMode, policy.mode) ? available.find(mode => mode.id === requestedMode) : preferred.map(id => available.find(m => m.id === id)).find(Boolean)
    if (policy.mode === 'read-only' && !mode && !this.profile.policyManagedByHost) throw new Error('This ACP Agent advertises no read-only mode; choose an Agent with one or explicitly change the session file policy')
    if (mode && this.state.modes.currentModeId !== mode.id) {
      await this.request('session/set_mode', { sessionId: this.threadId, modeId: mode.id }, signal)
      this.state.modes.currentModeId = mode.id
    }
    await this.selectModel(model, signal)
    if (effort) {
      const option = effortOption(this.state)
      if (!option || !flattenOptions(option.options).some(value => value.value === effort)) throw new Error('当前 Agent 未公布此推理强度，请刷新模型列表。')
      const result = await this.request('session/set_config_option', { sessionId: this.threadId, configId: option.id, value: effort }, signal)
      if (result.configOptions) this.state.configOptions = result.configOptions
      else option.currentValue = effort
    }
  }
  async selectModel(model, signal) {
    if (model && model !== 'default') {
      const option = this.state.configOptions?.find(o => o.category === 'model' || o.id === 'model')
      if (option) {
        model = resolveAdvertisedModel(flattenOptions(option.options), model)
        const result = await this.request('session/set_config_option', { sessionId: this.threadId, configId: option.id, value: model }, signal)
        if (result.configOptions) this.state.configOptions = result.configOptions
        else option.currentValue = model
      } else if (this.state.models?.availableModels?.length) {
        model = resolveAdvertisedModel(this.state.models.availableModels, model)
        await this.request('session/set_model', { sessionId: this.threadId, modelId: model }, signal)
        this.state.models.currentModelId = model
      } else throw new Error('This ACP Agent does not advertise model selection')
    }
  }
  update({ sessionId, update }) {
    const metadata = ['available_commands_update', 'config_option_update', 'current_mode_update'].includes(update.sessionUpdate)
    if (!this.threadId && this.opening && metadata && this.setupUpdates.length < 32) { this.setupUpdates.push({ sessionId, update }); return }
    if (sessionId !== this.threadId) return
    if (update.sessionUpdate === 'available_commands_update') { this.commands = update.availableCommands ?? []; this.commandsReady.resolve(); this.handlers.commands?.(this.commands) }
    if (update.sessionUpdate === 'config_option_update' && this.state) this.state.configOptions = update.configOptions
    if (update.sessionUpdate === 'current_mode_update' && this.state?.modes) this.state.modes.currentModeId = update.currentModeId
    if (!this.active) return // replay is owned by the persisted dsh log
    const active = this.active, base = { threadId: this.threadId, turnId: active.turnId }
    if (update.sessionUpdate === 'usage_update') active.push({ method: 'session/update', params: { ...base, update } })
    if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') active.push({ method: 'item/reasoning/summaryTextDelta', params: { ...base, itemId: 'reasoning', delta: update.content.text } })
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') active.push({ method: 'item/agentMessage/delta', params: { ...base, itemId: 'answer', delta: update.content.text } })
    if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
      const old = active.tools.get(update.toolCallId) ?? { id: update.toolCallId, type: 'commandExecution' }
      const item = acpToolItem(old, update)
      active.tools.set(update.toolCallId, item)
      if (!old.started) { item.started = true; active.push({ method: 'item/started', params: { ...base, item } }) }
      if (['completed', 'failed'].includes(item.status)) { active.push({ method: 'item/completed', params: { ...base, item } }); active.tools.delete(update.toolCallId) }
    }
  }
  async permission(params, requestSignal) {
    if (!this.active || params.sessionId !== this.threadId) return { outcome: { outcome: 'cancelled' } }
    const request = { threadId: this.threadId, turnId: this.active.turnId, itemId: params.toolCall.toolCallId, reason: params.toolCall.title ?? 'ACP Agent requests permission', command: JSON.stringify(params.toolCall.rawInput ?? {}) }
    const signal = requestSignal ? AbortSignal.any([requestSignal, this.active.signal]) : this.active.signal
    const allowed = await this.handlers.approve?.(params.toolCall.kind === 'edit' ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval', request, signal)
    const option = params.options.find(o => o.kind === (allowed ? 'allow_once' : 'reject_once'))
    return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } }
  }
  async extension({ method, params, signal: requestSignal }) {
    if (!this.active) throw new Error('ACP interaction has no active turn')
    const signal = requestSignal ? AbortSignal.any([requestSignal, this.active.signal]) : this.active.signal
    if (method === 'cursor/create_plan') {
      const allowed = await this.handlers.approve?.('item/fileChange/requestApproval', { threadId: this.threadId, turnId: this.active.turnId, itemId: params.toolCallId, reason: params.plan }, signal)
      return { outcome: { outcome: allowed ? 'accepted' : 'rejected' } }
    }
    if (method === 'cursor/ask_question') {
      const result = await this.handlers.question?.({ questions: params.questions.map(q => ({ id: q.id, question: q.prompt, ...(q.allowMultiple ? { multiSelect: true } : {}), options: q.options.map(o => ({ label: o.label })) })) }, signal)
      if (!result) return { outcome: { outcome: 'cancelled' } }
      return { outcome: { outcome: 'answered', answers: params.questions.map(q => ({ questionId: q.id, selectedOptionIds: q.options.filter(o => result.answers[q.id]?.answers.includes(o.label)).map(o => o.id) })) } }
    }
    throw new Error(`Unsupported ACP interaction: ${method}`)
  }
  async *turn(input, { model, signal = this.lifetime.signal, command, effort } = {}) {
    if (this.active) throw new Error('ACP conversation already has an active turn')
    const fused = AbortSignal.any([signal, this.lifetime.signal]), queue = []
    const active = { turnId: randomUUID(), signal: fused, tools: new Map(), done: false, error: undefined,
      push: event => { if (queue.length >= 4096) { active.end(new Error('ACP update queue overflow')); return } queue.push(event); active.wake?.(); active.wake = undefined },
      end: error => { active.done = true; active.error ??= error; active.wake?.(); active.wake = undefined },
    }
    this.active = active
    let completed = false
    const abort = () => { void this.connection.agent.notify('session/cancel', { sessionId: this.threadId }).catch(() => {}); active.end(fused.reason ?? new Error('ACP turn cancelled')) }
    fused.addEventListener('abort', abort, { once: true })
    try {
      if (input.some(part => part.type === 'image') && !this.info.agentCapabilities?.promptCapabilities?.image && this.profile.type !== 'claude') throw new Error('此 Agent 未声明支持图片输入，请选择支持图片的 Agent。')
      await this.configure(model === 'default' ? this.profile.defaultModel : model, fused, effort)
      if (command) await this.waitForCommands(fused)
      if (command && !this.commands.some(row => row.name === command.name)) throw new Error(`此 Agent 未公布 /${command.name}，请使用 /help 查看可用命令。`)
      const task = this.request('session/prompt', { sessionId: this.threadId, prompt: input }, fused, 0).then(result => {
        if (result.stopReason !== 'end_turn') active.end(new Error(`ACP turn stopped: ${result.stopReason}`)); else active.end()
      }, error => active.end(error))
      this.requests.add(task); void task.finally(() => this.requests.delete(task))
      while (!active.done || queue.length) {
        if (!queue.length && !active.done) await new Promise(resolve => { active.wake = resolve })
        if (active.error) throw active.error
        if (queue.length) yield queue.shift()
      }
      if (active.error) throw active.error
      completed = true
      yield { method: 'turn/completed', params: { threadId: this.threadId, turn: { id: active.turnId, status: 'completed' } } }
    } finally {
      fused.removeEventListener('abort', abort)
      if (!completed) await this.close()
      this.active = undefined
    }
  }
  async close() {
    this.lifetime.abort(new Error('ACP session closed')); this.rpc.closed = true
    await this.initialized?.catch(() => {})
    this.connection?.close()
    await this.process?.close()
    await Promise.allSettled([...this.requests])
    await this.proxy?.close(); this.proxy = undefined
    if (this.launchRoot) await rm(this.launchRoot, { recursive: true, force: true })
  }
}

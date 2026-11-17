import { codexReroutedSelection } from './native-selection.js'
import { openNativeRolePrompt, checkNativeRolePrompt, nativeRoleInstructions } from './native-role-prompt.js'
import {unsupportedNativeBuilder,nativeBuilderThreadParams,assertNativeBuilderSelection} from './native-builder-execution.js'
import { usageCounters, turnUsage, zeroUsage } from './native-usage.js'
/** One persistent Codex app-server connection per dsh Session and profile snapshot. */
import { deduplicateSkillCopies } from './codex-skills.js'
import { quotaObservation, mergeQuotaObservation } from './codex-quota.js'
import { RpcProcess } from './rpc-process.js'
import { createToolProxy } from './tool-proxy.js'
import { randomUUID } from 'node:crypto'
import { parseGoalInput, runGoalCommand } from './codex-goal.js'

// Some Codex builds race SQLite creation when two fresh app servers first use
// the same home. Serialize initialization only; live sessions/turns stay parallel.
let startup = Promise.resolve()

export class CodexSession {
  constructor(profile, cwd, handlers = {}) {
    this.profile = profile; this.cwd = cwd; this.handlers = handlers
    this.lifetime = new AbortController(); this.requests = new Set()
    this.quotaWrites = Promise.resolve(); this.quotaGeneration = 0; this.quotaReadAt = -Infinity
    this.pendingEvents = []; this.readerWaiters = []
    this.commands = [
      { name: 'goal', description: '管理 Codex 原生持久目标', input: { hint: '目标描述 | status | edit 新目标 | pause | resume | clear' } },
      { name: 'compact', description: '使用 Codex 原生上下文压缩' },
      { name: 'review', description: '审查当前工作区或指定范围', input: { hint: '留空审查未提交修改，或填写审查要求' } },
      { name: 'mcp', description: '查看 Codex MCP 连接状态' },
      { name: 'skills', description: '列出此工作区的 Codex 技能' },
    ]
  }
  usageBaselineAvailable() {
    return Boolean(this.usageTotal && this.usageTotal.cache_write_input_tokens !== null)
  }
  connectRpc() {
    this.rpc = new RpcProcess(this.profile, this.cwd)
    this.rpc.on('notification', message => {
      if (message.method === 'account/rateLimits/updated') { this.quotaGeneration++; this.observeQuota(message.params, true); return }
      if (message.method === 'account/updated') { this.quotaGeneration++; this.observeQuota(null, false, true); return }
      if (message.params?.threadId && this.threadId && message.params.threadId !== this.threadId) return
      if (message.method === 'thread/goal/updated' || message.method === 'thread/goal/cleared') this.handlers.goal?.(message.method.endsWith('/cleared') ? null : message.params.goal)
      if (message.method === 'thread/goal/cleared' || message.method === 'thread/goal/updated' && message.params.goal.status !== 'active') this.goalStopped = true
      if (message.method === 'thread/goal/updated' && message.params.goal.status === 'active') this.goalStopped = false
      if (this.active) this.active.push(message)
      else if (message.method === 'turn/started' || this.pendingEvents.length) {
        if (this.pendingEvents.length >= 4096) { this.rpc.fail(new Error('Native continuation queue overflow')); return }
        this.pendingEvents.push(message)
        if (message.method === 'turn/started') this.handlers.continuation?.()
      }
    })
    this.rpc.on('closed', error => { this.active?.end(error); for (const resolve of this.readerWaiters.splice(0)) resolve() })
    this.rpc.on('request', message => {
      const task = this.answer(message).catch(() => {})
      this.requests.add(task); void task.finally(() => this.requests.delete(task))
    })
  }
  initialize(signal) {
    if (!this.ready) {
      const fused = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
      this.ready = startup.then(async () => {
        fused.throwIfAborted()
        this.connectRpc()
        await this.rpc.request('initialize', { clientInfo: { name: 'kode-dsh', version: '0.1.0' }, capabilities: { experimentalApi: true } }, { signal: fused })
        this.rpc.notify('initialized', {})
      })
      startup = this.ready.catch(() => {})
    }
    return this.ready
  }
  observeQuota(payload, incremental = false, accountChanged = false) {
    const incoming = quotaObservation(payload)
    const observation = { ...(incremental ? mergeQuotaObservation(this.quota, incoming) : incoming), ...(accountChanged ? { account_changed: true } : {}) }
    this.quota = observation
    this.quotaWrites = this.quotaWrites.then(() => this.handlers.quota?.(observation)).catch(() => { this.quotaPersistenceFailed = true })
    return observation
  }
  async readQuota(signal) {
    await this.initialize(signal)
    if (this.quotaRead) return this.quotaRead
    if (Date.now() - this.quotaReadAt < 60000) return this.quota
    this.quotaReadAt = Date.now()
    const generation = this.quotaGeneration
    this.quotaRead = (async () => {
      try {
        const result = await this.rpc.request('account/rateLimits/read', {}, { signal: AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(3000)]) })
        if (generation === this.quotaGeneration) this.observeQuota(result)
      } catch {
        if (generation === this.quotaGeneration) this.observeQuota(null)
      }
      await this.quotaWrites
      return this.quota
    })()
    try { return await this.quotaRead } finally { this.quotaRead = undefined }
  }
  async answer(message) {
    const { method, params = {}, id } = message
    try {
      if (!this.active && this.hasContinuation()) await new Promise(resolve => { this.readerWaiters.push(resolve) })
      if (!this.active || params.threadId !== this.threadId) throw new Error('foreign or inactive Agent request')
      let result
      if (method === 'item/tool/call') result = await this.handlers.tool?.(params, this.active.signal)
      else if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
        const allowed = await this.handlers.approve?.(method, params, this.active.signal)
        result = { decision: allowed ? 'accept' : 'decline' }
      } else if (method === 'item/tool/requestUserInput') result = await this.handlers.question?.(params, this.active.signal)
      if (result === undefined) throw new Error(`unsupported Agent request: ${method}`)
      this.rpc.respond(id, result)
    } catch (error) {
      if (!this.rpc.closed) this.rpc.send({ id, error: { code: -32603, message: error.message } })
    }
  }
  async resumeThread(params, signal) {
    // dsh owns historical display. Hydrating every native turn can exceed the
    // transport frame limit on long conversations without helping continuation.
    params = { ...params, excludeTurns: true }
    try { return await this.rpc.request('thread/resume', params, { signal }) }
    catch (error) {
      // Continuing a specific conversation restores only that native thread.
      // Never turn unrelated failures into an unarchive or a fresh thread.
      const archived = /\b(?:session|thread) ["']?([0-9a-f-]+)["']? is archived\b/i.exec(error.message)
      if (!error.rpcRejected || archived?.[1] !== params.threadId) throw error
      signal?.throwIfAborted()
      await this.rpc.request('thread/unarchive', { threadId: params.threadId }, { signal })
      return this.rpc.request('thread/resume', params, { signal })
    }
  }
  /** Non-inference protocol probe only. A successful model echo is NOT proof
   * that ambient tools/instructions are disabled, so open/turn remain blocked. */
  async preflightBuilder({selection,procedure,tools},signal){
    if(this.handlers.nativeBuilder===undefined||this.threadId||this.active||this.builderPreflightAttempted)throw new Error('Fresh trusted Builder preflight required')
    const params=nativeBuilderThreadParams({cwd:this.cwd,selection,procedure,tools})
    this.builderPreflightAttempted=true
    await this.initialize(signal)
    const result=await this.rpc.request('thread/start',params,{signal})
    if(typeof result?.thread?.id!=='string'||!result.thread.id||result.cwd!==this.cwd)throw new Error('Native Builder thread metadata mismatch')
    this.threadId=result.thread.id
    assertNativeBuilderSelection(result,selection)
    this.usageTotal=zeroUsage()
    return Object.freeze({threadId:this.threadId,model:result.model,reasoningEffort:result.reasoningEffort??null,
      source:'codex_thread_start_metadata',inference_verified:false,runtime_ready:false,
      blocked_reason:'native_builtin_and_ambient_enforcement_unverified'})
  }
  async open(binding, tools, signal) {
    if(this.handlers.nativeBuilder!==undefined)throw unsupportedNativeBuilder()
    await this.initialize(signal)
    this.acceptedRolePrompt = await openNativeRolePrompt(this.handlers, binding.threadId ? 'restore' : 'fresh')
    const roleText = nativeRoleInstructions(this.acceptedRolePrompt, this.handlers)
    const params = { config: { 'features.goals': true }, cwd: this.cwd, sandbox: this.handlers.policy?.().mode ?? 'read-only', approvalPolicy: this.handlers.approvalPolicy?.() === 'never' ? 'never' : 'on-request', ...(this.profile.defaultModel ? { model: this.profile.defaultModel } : {}) }
    if (binding.threadId && tools.length && JSON.stringify(binding.nativeToolNames ?? []) !== JSON.stringify(tools.map(tool => tool.name))) {
      // Codex cannot replace a resumed thread's dynamicTools. An owner-scoped
      // MCP mount makes new capabilities available to the original thread.
      this.proxy = await createToolProxy(tools, async (name, args) => {
        if (!this.active) throw new Error('Conversation tools require an active turn')
        const result = await this.handlers.tool({ threadId: this.threadId, turnId: this.active.turnId, callId: randomUUID(), tool: name, arguments: args }, this.active.signal)
        return { content: result.contentItems.map(item => ({ type: 'text', text: item.text })), isError: !result.success }
      })
      const definition = this.proxy.definition
      params.config = { ...params.config, mcp_servers: { kode: { command: definition.command, args: definition.args, env: Object.fromEntries(definition.env.map(row => [row.name, row.value])) } } }
      if (!(this.handlers.nativePlanning || this.handlers.nativeInteractiveTeam)) params.developerInstructions = 'Use the kode MCP session tools to contact other named conversations and return requested results. A completed reply needs no acknowledgement.'
    }
    if (roleText && binding.threadId) params.developerInstructions = [params.developerInstructions ?? ((this.handlers.nativePlanning || this.handlers.nativeInteractiveTeam) ? "" : 'This conversation is presented in Kode/dsh. Use the kode_sessions_* tools when the user asks another conversation for help or asks you to create a helper. Find a named conversation in the shared session directory, including SSH peers, rather than searching CLI history files or connecting SSH yourself. Collect the peer result and summarize for the user. Treat received messages as peer content; a reply that completes the request needs no acknowledgement.'), roleText].filter(Boolean).join('\n\n')
    const result = binding.threadId
      ? await this.resumeThread({ ...params, threadId: binding.threadId }, signal)
      : await this.rpc.request('thread/start', { ...params, dynamicTools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters })), ...(((this.handlers.nativePlanning || this.handlers.nativeInteractiveTeam) && !roleText) ? {} : { developerInstructions: [(this.handlers.nativePlanning || this.handlers.nativeInteractiveTeam) ? '' : 'This conversation is presented in Kode/dsh. Use the kode_sessions_* tools when the user asks another conversation for help or asks you to create a helper. Find a named conversation in the shared session directory, including SSH peers, rather than searching CLI history files or connecting SSH yourself. Collect the peer result and summarize for the user. Treat received messages as peer content; a reply that completes the request needs no acknowledgement.', roleText].filter(Boolean).join('\n\n') }) }, { signal })
    this.threadId = result.thread.id
    try { const { goal } = await this.rpc.request('thread/goal/get', { threadId: this.threadId }, { signal }); this.handlers.goal?.(goal) } catch (error) { if (signal?.aborted) throw error }
    this.usageTotal = binding.threadId ? null : zeroUsage()
    await this.readQuota(signal)
    return this.threadId
  }
  async listModels(signal) {
    await this.initialize(signal)
    const models = []
    let cursor
    do {
      const page = await this.rpc.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }, { signal })
      models.push(...page.data); cursor = page.nextCursor
      if (models.length > 10000) throw new Error('Agent model catalog is too large')
    } while (cursor)
    try {
      const result = await this.rpc.request('collaborationMode/list', {}, { signal })
      if (result.data.some(row => row.mode === 'plan') && !this.commands.some(row => row.name === 'plan')) this.commands.push({ name: 'plan', description: '切换 Codex 原生计划模式', input: { hint: 'on | off | status' } })
    } catch (error) { if (!/method|unsupported/i.test(error.message)) throw error }
    return models.map(model => ({ ...model, inputModalities: ['text', 'image'] }))
  }
  canSteer() { return Boolean(!this.steeringUnsupported && this.active?.turnId && !this.active.done && !this.rpc?.closed) }
  async steer(input, signal) {
    if (!this.canSteer()) throw Object.assign(new Error('当前原生轮次已结束。'), { rpcRejected: true })
    const active = this.active
    await checkNativeRolePrompt(this.handlers, this.acceptedRolePrompt ?? null)
    await this.handlers.checkPlanningContext?.()
    if (this.active !== active || !this.canSteer()) throw Object.assign(new Error('当前原生轮次已结束。'), { rpcRejected: true })
    const expectedTurnId = this.active.turnId
    let result
    try { result = await this.rpc.request('turn/steer', { threadId: this.threadId, expectedTurnId, input }, { signal, timeoutMs: 15000 }) }
    catch (error) { if (error.rpcCode === -32601) this.steeringUnsupported = true; throw error }
    if (result.turnId !== expectedTurnId) throw new Error('原生插入结果的轮次不匹配，投递状态不确定。')
    return result
  }
  async rename(name, signal) { await this.initialize(signal); await this.rpc.request('thread/name/set', { threadId: this.threadId, name }, { signal }) }
  async listSkills(signal) {
    await this.initialize(signal)
    const response = await this.rpc.request('skills/list', { cwds: [this.cwd], forceReload: true }, { signal })
    const errors = response.data.flatMap(group => group.errors ?? [])
    const skills = await deduplicateSkillCopies(response.data.flatMap(group => group.skills ?? []).filter(skill => skill.enabled !== false && typeof skill.path === 'string'))
    return { skills, errors }
  }
  hasContinuation() { return !this.rpc?.closed && this.pendingEvents.some(event => event.method === 'turn/started') }
  /** Host-only diagnostic, no inference. An ACK is not effective configuration
   * evidence, and read-only sandboxing does not isolate cross-workspace reads. */
  async inspectScopeCapability({model,effort,signal}={}) {
    if(!this.threadId||this.active)throw Error('Idle owned Codex thread required')
    const policy=this.handlers.policy?.()??{mode:'read-only'}
    if(policy.mode!=='read-only')throw Error('Scope diagnostic requires read-only policy')
    const response=await this.rpc.request('thread/settings/update',{threadId:this.threadId,cwd:this.cwd,sandboxPolicy:{type:'readOnly'},approvalPolicy:'never',...(model?{model}:{}),...(effort?{effort}:{})},{signal})
    signal?.throwIfAborted()
    return Object.freeze({protocol:'codex',thread_id:this.threadId,configuration_acknowledged:response!==undefined,
      selection_verified:false,tool_scope_verified:false,dispatch_allowed:false,
      reasons:Object.freeze(['effective_selection_readback_unverified','sandbox_read_scope_unverified'])})
  }
  async goal(input, signal, { model, effort } = {}) {
    if (['set', 'edit', 'resume'].includes(parseGoalInput(input).action)) {
      const policy = this.handlers.policy?.() ?? { mode: 'read-only' }
      const sandboxPolicy = policy.mode === 'danger-full-access' ? { type: 'dangerFullAccess' } : policy.mode === 'workspace-write' ? { type: 'workspaceWrite', writableRoots: [policy.workspaceRoot ?? this.cwd] } : { type: 'readOnly' }
      await this.rpc.request('thread/settings/update', { threadId: this.threadId, cwd: this.cwd, sandboxPolicy, approvalPolicy: this.handlers.approvalPolicy?.() === 'never' ? 'never' : 'on-request', ...(model && model !== 'default' ? { model } : {}), ...(effort ? { effort } : {}) }, { signal })
    }
    return runGoalCommand(this, input, signal)
  }
  async *turn(input, { model, effort, serviceTier, signal, command, skillNames = [], observe = false, beforeInference, beforeInteractiveInput } = {}) {
    await checkNativeRolePrompt(this.handlers, this.acceptedRolePrompt ?? null)
    if(this.acceptedRolePrompt&&(command||observe))throw new Error('Role prompt native command/continuation preservation is unsupported')
    // turn/start acknowledgement is too late to authorize its own inference.
    // Until the native protocol confirms effective model/effort beforehand,
    // a guarded turn cannot dispatch. Ordinary native behavior is unchanged.
    if (beforeInference !== undefined) throw Object.assign(new Error('Codex pre-inference selection confirmation unavailable'), { code: 'selection_confirmation_unsupported' })
    if(beforeInteractiveInput!==undefined&&(typeof beforeInteractiveInput!=='function'||command||observe||!model||model==='default'))throw new Error('Interactive Codex requires an explicit native selection and one source')
    if(this.handlers.nativeBuilder!==undefined)throw unsupportedNativeBuilder()
    if (!this.threadId) throw new Error('Agent session has not been opened')
    if (this.active) throw new Error('Agent already has an active turn')
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    if (command?.name === 'compact') signal = AbortSignal.any([signal, AbortSignal.timeout(180000)])
    const queue = observe ? this.pendingEvents.splice(0) : [], active = { signal, done: false, error: undefined, wake: undefined,
      push(message) {
        if (message.params?.threadId && message.params.threadId !== this.threadId) return
        if (queue.length >= 4096) { this.end(new Error('Agent notification queue overflow')); return }
        queue.push(message); this.wake?.(); this.wake = undefined
      },
      end(error) { this.done = true; this.error ??= error; this.wake?.(); this.wake = undefined },
    }
    active.threadId = this.threadId
    let usageBaseline = !command && !observe ? this.usageTotal : null
    let usageRerouted = false, usageSeen = false
    this.active = active
    for (const resolve of this.readerWaiters.splice(0)) resolve()
    let turnId, cancelled = false, completed = false
    const abort = () => {
      cancelled = true
      if (turnId && !this.rpc.closed) void this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId }, { timeoutMs: 5000 }).catch(() => {})
      active.end(signal.reason ?? new Error('Agent turn cancelled'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      signal?.throwIfAborted()
      const policy = this.handlers.policy?.() ?? { mode: 'read-only' }
      const sandboxPolicy = policy.mode === 'danger-full-access' ? { type: 'dangerFullAccess' } : policy.mode === 'workspace-write' ? { type: 'workspaceWrite', writableRoots: [policy.workspaceRoot ?? this.cwd] } : { type: 'readOnly' }
      let discoveredSkills
      if (command && !this.commands.some(row => row.name === command.name)) {
        discoveredSkills = (await this.listSkills(signal)).skills
        if (discoveredSkills.some(skill => skill.name === command.name)) {
          skillNames = [...skillNames, command.name]
          input = [{ type: 'text', text: `$${command.name}${command.input ? ` ${command.input}` : ''}` }]
          command = undefined
        }
      }
      if (skillNames.length) {
        const skills = discoveredSkills ?? (await this.listSkills(signal)).skills
        for (const name of new Set(skillNames)) {
          const matches = skills.filter(skill => skill.name === name)
          if (matches.length > 1) throw new Error(`技能 ${name} 存在内容不同的同名副本，请先处理重复安装。`)
          if (matches.length === 1) input = [...input, { type: 'skill', name, path: matches[0].path }]
        }
      }
      let result
      if (observe) {
        if (!queue.some(event => event.method === 'turn/started')) throw new Error('原生目标继续事件已失效。')
      } else if (command) {
        if (!this.commands.some(row => row.name === command.name)) throw new Error(`Codex app-server 不支持 /${command.name}，请用 /help 查看此界面支持的命令。`)
        if (!['review', 'goal'].includes(command.name) && command.input) throw new Error(`/${command.name} 不接受参数。`)
        if (command.name === 'goal') {
          const outcome = await this.goal(command.input, signal, { model, effort })
          yield { method: 'item/agentMessage/delta', params: { threadId: this.threadId, turnId: 'goal-command', itemId: `goal:${randomUUID()}`, delta: outcome.text } }
          if (!outcome.run) {
            completed = true
            yield { method: 'turn/completed', params: { threadId: this.threadId, turn: { id: 'goal-command', status: 'completed' } } }
            return
          }
          // Setting/resuming an active goal starts native work itself. Sending
          // turn/start here would duplicate/interrupt that work.
        } else if (command.name === 'mcp' || command.name === 'skills') {
          const rows = []
          if (command.name === 'skills') {
            const response = await this.rpc.request('skills/list', { cwds: [this.cwd] }, { signal })
            rows.push(...response.data.flatMap(group => (group.skills ?? []).map(skill => `${skill.name} — ${skill.description ?? ''}`)))
          } else {
            let cursor
            do {
              const response = await this.rpc.request('mcpServerStatus/list', { limit: 100, ...(cursor ? { cursor } : {}) }, { signal })
              rows.push(...response.data.map(server => `${server.name} — ${server.authStatus ?? '已连接'} · ${Object.keys(server.tools ?? {}).length} 个工具`)); cursor = response.nextCursor
              if (rows.length > 10000) throw new Error('MCP 状态列表过大。')
            } while (cursor)
          }
          turnId = `command:${randomUUID()}`; active.turnId = turnId; completed = true
          yield { method: 'item/agentMessage/delta', params: { threadId: this.threadId, turnId, itemId: 'command-result', delta: rows.join('\n') || '暂无可用项目。' } }
          yield { method: 'turn/completed', params: { threadId: this.threadId, turn: { id: turnId, status: 'completed' } } }
          return
        }
        if (command.name === 'goal') { /* consume native turn/started below */ }
        else if (command.name === 'compact') result = await this.rpc.request('thread/compact/start', { threadId: this.threadId }, { signal })
        else {
          // ReviewStart has no per-request sandbox fields. Refresh the thread's
          // configuration first so a changed permission menu also governs review.
          await this.resumeThread({ threadId: this.threadId, cwd: this.cwd, sandbox: policy.mode, approvalPolicy: this.handlers.approvalPolicy?.() === 'never' ? 'never' : 'on-request' }, signal)
          result = await this.rpc.request('review/start', { threadId: this.threadId, delivery: 'inline', target: command.input ? { type: 'custom', instructions: command.input } : { type: 'uncommittedChanges' } }, { signal })
        }
      } else {
        const plan = this.handlers.collaborationMode?.()
        const collaborationMode = typeof plan === 'boolean' ? { mode: plan ? 'plan' : 'default', settings: { model: model ?? this.profile.defaultModel, reasoning_effort: effort ?? null, developer_instructions: null } } : undefined
        await this.handlers.checkPlanningContext?.()
        signal.throwIfAborted()
        if(beforeInteractiveInput){const admission=await beforeInteractiveInput({threadId:this.threadId,selection:{scope:'executor_configuration',model:{requested:model,status:'requested'},effort:{requested:effort??null,status:effort?'requested':'unverifiable'},source:'turn/start_request'},input:structuredClone(input),signal});signal.throwIfAborted();if(admission?.state!=='claimed'||admission.dispatch_allowed!==true||typeof admission.receipt_id!=='string')throw new Error('Interactive source admission missing')}
        result = await this.rpc.request('turn/start', { threadId: this.threadId, cwd: this.cwd, input, sandboxPolicy, approvalPolicy: this.handlers.approvalPolicy?.() === 'never' ? 'never' : 'on-request', ...(model && model !== 'default' ? { model } : {}), ...(effort ? { effort } : {}), ...(serviceTier ? { serviceTierForTurn: serviceTier } : {}), ...(collaborationMode ? { collaborationMode } : {}) }, { signal })
      }
      turnId = result?.turn?.id; active.turnId = turnId
      if (!command && !observe) yield { method: 'kode/selection_evidence', params: { threadId: this.threadId, turnId, scope: 'executor_configuration', model: { requested: model ?? null, status: model && model !== 'default' ? 'acknowledged' : 'unverifiable' }, effort: { requested: effort ?? null, status: effort ? 'acknowledged' : 'unverifiable' }, source: 'turn/start', observed_at: Date.now() } }
      if (cancelled) { if (!this.rpc.closed) void this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId }).catch(() => {}); signal.throwIfAborted() }
      while (true) {
        if (!queue.length && !active.done) await new Promise(resolve => { active.wake = resolve })
        if (active.error) throw active.error
        const message = queue.shift()
        if (!message) { if (active.done) break; continue }
        if ((observe || command?.name === 'goal' || command?.name === 'compact') && message.method === 'turn/started') { turnId = message.params.turn.id; active.turnId = turnId }
        // A compaction item can finish while its native turn is still active.
        // Wait for turn/completed before admitting another input or reporting success.
        if (command?.name === 'goal' && !turnId && this.goalStopped && ['thread/goal/updated', 'thread/goal/cleared'].includes(message.method)) {
          completed = true
          yield message
          yield { method: 'turn/completed', params: { threadId: this.threadId, turn: { id: 'goal-stopped', status: 'completed' } } }
          break
        }
        if (message.params?.turnId && message.params.turnId !== turnId) continue
        if (message.method === 'model/rerouted') {
          const selection = codexReroutedSelection(message.params, { threadId: this.threadId, turnId, model, effort })
          if (selection) { usageRerouted = true; yield { method: 'kode/selection_evidence', params: selection } }
        }
        if (message.method === 'thread/tokenUsage/updated') {
          // Require the exact thread and turn; never price unsolicited or historical totals.
          if (message.params.threadId === this.threadId && message.params.turnId === turnId) {
            const nextUsage = usageCounters(message.params.tokenUsage?.total)
            if (!nextUsage || usageSeen && this.usageTotal && ['input_tokens', 'cached_input_tokens', 'output_tokens'].some(key => nextUsage[key] < this.usageTotal[key])) usageBaseline = null
            this.usageTotal = nextUsage
            usageSeen = true
            yield { method: 'kode/usage_observation', params: turnUsage(usageBaseline, this.usageTotal, { threadId: this.threadId, turnId, model, rerouted: usageRerouted }) }
          }
        }
        if (message.method === 'turn/completed' && message.params.turn.id === turnId) {
          if (!usageSeen) this.usageTotal = null
          yield { method: 'kode/usage_observation', params: { ...turnUsage(usageBaseline, usageSeen ? this.usageTotal : null, { threadId: this.threadId, turnId, model, rerouted: usageRerouted }), turn_ended: true, outcome: message.params.turn.status } }

          if (message.params.turn.status !== 'completed' && !(this.goalStopped && message.params.turn.status === 'interrupted')) throw new Error(message.params.turn.error?.message ?? `Agent turn ${message.params.turn.status}`)
          completed = true
          if (command?.name === 'compact') yield { method: 'item/agentMessage/delta', params: { threadId: this.threadId, turnId, itemId: 'compact-result', delta: 'Codex 已完成上下文压缩。' } }
          yield message
          break
        }
        yield message
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      this.active = undefined
      if (!completed) this.usageTotal = null
      if (completed && !cancelled) {
        const start = queue.findIndex(event => event.method === 'turn/started')
        if (start >= 0) this.pendingEvents.push(...queue.slice(start))
        if (this.hasContinuation()) this.handlers.continuation?.()
      }
      // Cancellation or early consumer teardown must converge the native process
      // before another prompt may be submitted to this conversation.
      if (!completed || cancelled || active.error) await this.rpc.close()
    }
  }
  async close() {
    this.lifetime.abort(new Error('Agent session closed'))
    for (const resolve of this.readerWaiters.splice(0)) resolve()
    await this.ready?.catch(() => {})
    const stopEvidence = await this.rpc?.close()
    await Promise.allSettled([...this.requests])
    await this.proxy?.close(); this.proxy = undefined
    await this.quotaWrites
    return stopEvidence
  }
}

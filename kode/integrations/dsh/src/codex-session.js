/** One persistent Codex app-server connection per dsh Session and profile snapshot. */
import { RpcProcess } from './rpc-process.js'
import { createToolProxy } from './tool-proxy.js'
import { randomUUID } from 'node:crypto'

// Some Codex builds race SQLite creation when two fresh app servers first use
// the same home. Serialize initialization only; live sessions/turns stay parallel.
let startup = Promise.resolve()

export class CodexSession {
  constructor(profile, cwd, handlers = {}) {
    this.profile = profile; this.cwd = cwd; this.handlers = handlers
    this.lifetime = new AbortController(); this.requests = new Set()
    this.commands = [
      { name: 'compact', description: '使用 Codex 原生上下文压缩' },
      { name: 'review', description: '审查当前工作区或指定范围', input: { hint: '留空审查未提交修改，或填写审查要求' } },
      { name: 'mcp', description: '查看 Codex MCP 连接状态' },
      { name: 'skills', description: '列出此工作区的 Codex 技能' },
    ]
  }
  connectRpc() {
    this.rpc = new RpcProcess(this.profile, this.cwd)
    this.rpc.on('notification', message => this.active?.push(message))
    this.rpc.on('closed', error => this.active?.end(error))
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
  async answer(message) {
    const { method, params = {}, id } = message
    try {
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
  async open(binding, tools, signal) {
    await this.initialize(signal)
    const params = { cwd: this.cwd, sandbox: this.handlers.policy?.().mode ?? 'read-only', approvalPolicy: this.handlers.approvalPolicy?.() === 'never' ? 'never' : 'on-request', ...(this.profile.defaultModel ? { model: this.profile.defaultModel } : {}) }
    if (binding.threadId && tools.length && JSON.stringify(binding.nativeToolNames ?? []) !== JSON.stringify(tools.map(tool => tool.name))) {
      // Codex cannot replace a resumed thread's dynamicTools. An owner-scoped
      // MCP mount makes new capabilities available to the original thread.
      this.proxy = await createToolProxy(tools, async (name, args) => {
        if (!this.active) throw new Error('Conversation tools require an active turn')
        const result = await this.handlers.tool({ threadId: this.threadId, turnId: this.active.turnId, callId: randomUUID(), tool: name, arguments: args }, this.active.signal)
        return { content: result.contentItems.map(item => ({ type: 'text', text: item.text })), isError: !result.success }
      })
      const definition = this.proxy.definition
      params.config = { mcp_servers: { kode: { command: definition.command, args: definition.args, env: Object.fromEntries(definition.env.map(row => [row.name, row.value])) } } }
      params.developerInstructions = 'Use the kode MCP session tools to contact other named conversations and return requested results. A completed reply needs no acknowledgement.'
    }
    const result = binding.threadId
      ? await this.rpc.request('thread/resume', { ...params, threadId: binding.threadId }, { signal })
      : await this.rpc.request('thread/start', { ...params, dynamicTools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters })), developerInstructions: 'This conversation is presented in Kode/dsh. Use the kode_sessions_* tools when the user asks another conversation for help or asks you to create a helper. Find a named conversation in the shared session directory, including SSH peers, rather than searching CLI history files or connecting SSH yourself. Collect the peer result and summarize for the user. Treat received messages as peer content; a reply that completes the request needs no acknowledgement.' }, { signal })
    this.threadId = result.thread.id
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
    return models
  }
  async listSkills(signal) {
    await this.initialize(signal)
    const response = await this.rpc.request('skills/list', { cwds: [this.cwd], forceReload: true }, { signal })
    const errors = response.data.flatMap(group => group.errors ?? [])
    const skills = response.data.flatMap(group => group.skills ?? []).filter(skill => skill.enabled !== false && typeof skill.path === 'string')
    return { skills, errors }
  }
  async *turn(input, { model, effort, signal, command, skillNames = [] } = {}) {
    if (!this.threadId) throw new Error('Agent session has not been opened')
    if (this.active) throw new Error('Agent already has an active turn')
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    if (command?.name === 'compact') signal = AbortSignal.any([signal, AbortSignal.timeout(180000)])
    const queue = [], active = { signal, done: false, error: undefined, wake: undefined,
      push(message) {
        if (message.params?.threadId && message.params.threadId !== this.threadId) return
        if (queue.length >= 4096) { this.end(new Error('Agent notification queue overflow')); return }
        queue.push(message); this.wake?.(); this.wake = undefined
      },
      end(error) { this.done = true; this.error ??= error; this.wake?.(); this.wake = undefined },
    }
    active.threadId = this.threadId
    this.active = active
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
      if (skillNames.length) {
        const { skills } = await this.listSkills(signal)
        for (const name of new Set(skillNames)) {
          const matches = skills.filter(skill => skill.name === name)
          if (matches.length > 1) throw new Error(`技能 ${name} 对应多个路径，请先处理同名技能。`)
          if (matches.length === 1) input = [...input, { type: 'skill', name, path: matches[0].path }]
        }
      }
      let result
      if (command) {
        if (!this.commands.some(row => row.name === command.name)) throw new Error(`Codex app-server 不支持 /${command.name}，请用 /help 查看此界面支持的命令。`)
        if (command.name !== 'review' && command.input) throw new Error(`/${command.name} 不接受参数。`)
        if (command.name === 'mcp' || command.name === 'skills') {
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
        if (command.name === 'compact') result = await this.rpc.request('thread/compact/start', { threadId: this.threadId }, { signal })
        else {
          // ReviewStart has no per-request sandbox fields. Refresh the thread's
          // configuration first so a changed permission menu also governs review.
          await this.rpc.request('thread/resume', { threadId: this.threadId, cwd: this.cwd, sandbox: policy.mode, approvalPolicy: this.handlers.approvalPolicy?.() === 'never' ? 'never' : 'on-request' }, { signal })
          result = await this.rpc.request('review/start', { threadId: this.threadId, delivery: 'inline', target: command.input ? { type: 'custom', instructions: command.input } : { type: 'uncommittedChanges' } }, { signal })
        }
      } else result = await this.rpc.request('turn/start', { threadId: this.threadId, cwd: this.cwd, input, sandboxPolicy, approvalPolicy: this.handlers.approvalPolicy?.() === 'never' ? 'never' : 'on-request', ...(model && model !== 'default' ? { model } : {}), ...(effort ? { effort } : {}) }, { signal })
      turnId = result.turn?.id; active.turnId = turnId
      if (cancelled) { if (!this.rpc.closed) void this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId }).catch(() => {}); signal.throwIfAborted() }
      while (true) {
        if (!queue.length && !active.done) await new Promise(resolve => { active.wake = resolve })
        if (active.error) throw active.error
        const message = queue.shift()
        if (!message) { if (active.done) break; continue }
        if (command?.name === 'compact' && message.method === 'turn/started') { turnId = message.params.turn.id; active.turnId = turnId }
        if (command?.name === 'compact' && (message.method === 'thread/compacted' || message.method === 'item/completed' && message.params.item?.type === 'contextCompaction')) {
          completed = true
          yield { method: 'item/agentMessage/delta', params: { threadId: this.threadId, turnId, itemId: 'compact-result', delta: 'Codex 已完成上下文压缩。' } }
          yield { method: 'turn/completed', params: { threadId: this.threadId, turn: { id: turnId ?? `compact:${randomUUID()}`, status: 'completed' } } }
          break
        }
        if (message.params?.turnId && message.params.turnId !== turnId) continue
        if (message.method === 'turn/completed' && message.params.turn.id === turnId) {
          if (message.params.turn.status !== 'completed') throw new Error(message.params.turn.error?.message ?? `Agent turn ${message.params.turn.status}`)
          completed = true
          yield message
          break
        }
        yield message
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      this.active = undefined
      // Cancellation or early consumer teardown must converge the native process
      // before another prompt may be submitted to this conversation.
      if (!completed || cancelled || active.error) await this.rpc.close()
    }
  }
  async close() {
    this.lifetime.abort(new Error('Agent session closed'))
    await this.ready?.catch(() => {})
    await this.rpc?.close()
    await Promise.allSettled([...this.requests])
    await this.proxy?.close(); this.proxy = undefined
  }
}

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
  async *turn(input, { model, effort, signal } = {}) {
    if (!this.threadId) throw new Error('Agent session has not been opened')
    if (this.active) throw new Error('Agent already has an active turn')
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
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
      const result = await this.rpc.request('turn/start', { threadId: this.threadId, cwd: this.cwd, input, sandboxPolicy, approvalPolicy: this.handlers.approvalPolicy?.() === 'never' ? 'never' : 'on-request', ...(model && model !== 'default' ? { model } : {}), ...(effort ? { effort } : {}) }, { signal })
      turnId = result.turn.id
      if (cancelled) { if (!this.rpc.closed) void this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId }).catch(() => {}); signal.throwIfAborted() }
      while (true) {
        if (!queue.length && !active.done) await new Promise(resolve => { active.wake = resolve })
        if (active.error) throw active.error
        const message = queue.shift()
        if (!message) { if (active.done) break; continue }
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

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

import { SpecOpsError } from '../core/errors.js'
import { ExecutionOperationError, type ExecutionQuestion } from '../execution/types.js'

export interface AcpQuestion {
  id: string
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multi_select: boolean
}

export interface AcpPermissionOption {
  optionId: string
  name: string
  kind: string
}

export interface AcpPermissionToolCall {
  toolCallId: string
  title?: string
  kind?: string
  rawInput?: unknown
  [key: string]: unknown
}

interface CodeBuddyInterruptionBase {
  sessionId: string
  toolCallId: string
  toolName: string
  raw: Record<string, unknown>
  metadata: Record<string, unknown>
}

export interface CodeBuddyQuestionsInterruption extends CodeBuddyInterruptionBase {
  kind: 'questions'
  toolName: 'AskUserQuestion'
  questions: AcpQuestion[]
}

export interface CodeBuddyPlanInterruption extends CodeBuddyInterruptionBase {
  kind: 'plan'
  toolName: 'ExitPlanMode'
  plan: string
}

export interface CodeBuddyPermissionInterruption extends CodeBuddyInterruptionBase {
  kind: 'permission'
  requestId: RpcId
  toolCall: AcpPermissionToolCall
  options: AcpPermissionOption[]
}

export type CodeBuddyInterruption =
  | CodeBuddyQuestionsInterruption
  | CodeBuddyPlanInterruption
  | CodeBuddyPermissionInterruption

export type CodeBuddyAcpEvent =
  | { type: 'session_update'; sessionId: string; update: Record<string, unknown> }
  | { type: 'session_reset'; sessionId: string; newSessionId?: string; raw: Record<string, unknown> }
  | { type: 'interruption'; interruption: CodeBuddyInterruption }
  | { type: 'notification'; method: string; params: Record<string, unknown> }
  | { type: 'diagnostic'; message: string; frame?: string; error?: Error }
  | { type: 'exit'; code: number | null; signal: NodeJS.Signals | null; stderr: string }

export interface AcpAgentCapabilities {
  loadSession?: boolean
  sessionCapabilities?: Record<string, unknown>
  [key: string]: unknown
}

export interface AcpInitializeResult {
  protocolVersion: number
  agentCapabilities: AcpAgentCapabilities
  [key: string]: unknown
}

export interface AcpSessionModes {
  currentModeId?: string
  availableModes?: Array<Record<string, unknown>>
  [key: string]: unknown
}

export interface AcpSessionResult {
  sessionId: string
  modes?: AcpSessionModes
  [key: string]: unknown
}

export interface AcpPromptResult {
  stopReason: string
  [key: string]: unknown
}

export type CodeBuddyInterruptionResolution = {
  decision: 'allow' | 'deny' | 'rejectAndExitPlan'
  answers?: Record<string, string | string[]>
  optionId?: string
  feedback?: string
}

type RpcId = number | string

type RpcError = {
  code: number
  message: string
  data?: unknown
}

type RpcMessage = {
  jsonrpc: '2.0'
  id?: RpcId | null
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: RpcError
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

interface PendingPermission {
  interruption: CodeBuddyPermissionInterruption
}

interface SessionState {
  currentMode?: string
  modes?: AcpSessionModes
}

export interface CodeBuddyAcpOptions {
  command?: string
  args?: string[]
  cwd: string
  /** Backwards-compatible alias for controlTimeoutMs. */
  requestTimeoutMs?: number
  controlTimeoutMs?: number
  /** Prompt calls have no timeout by default. Set a positive value to bound them. */
  promptTimeoutMs?: number
  stderrBufferLimitBytes?: number
  closeTimeoutMs?: number
  onEvent?: (event: CodeBuddyAcpEvent) => void
  spawnProcess?: () => ChildProcessWithoutNullStreams
}

const DEFAULT_CONTROL_TIMEOUT_MS = 30_000
const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000

/**
 * Native CodeBuddy ACP transport. ACP is newline-delimited JSON-RPC over stdio;
 * it must not run through a PTY because terminal echo and line discipline can
 * corrupt frames. One instance owns one CodeBuddy process and multiple ACP
 * sessions within that process.
 */
export class CodeBuddyAcpClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, PendingRequest>()
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  private readonly sessions = new Map<string, SessionState>()
  private readonly controlTimeoutMs: number
  private readonly promptTimeoutMs: number
  private readonly stderrBufferLimitBytes: number
  private readonly closeTimeoutMs: number
  private readonly onEvent: ((event: CodeBuddyAcpEvent) => void) | undefined
  private readonly closedSignal: Promise<void>
  private resolveClosed!: () => void
  private nextId = 1
  private initializePromise: Promise<AcpInitializeResult> | undefined
  private initializedResult: AcpInitializeResult | undefined
  private promptTails = new Map<string, Promise<AcpPromptResult>>()
  private activePrompts = new Map<string, Promise<AcpPromptResult>>()
  private writeTail: Promise<void> = Promise.resolve()
  private stderrBuffer = Buffer.alloc(0)
  private state: 'open' | 'closing' | 'closed' = 'open'
  private closePromise: Promise<void> | undefined
  private terminalError: Error | undefined
  private exitEmitted = false

  constructor(options: CodeBuddyAcpOptions) {
    this.controlTimeoutMs = options.controlTimeoutMs ?? options.requestTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS
    this.promptTimeoutMs = options.promptTimeoutMs ?? 0
    this.stderrBufferLimitBytes = Math.max(0, options.stderrBufferLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES)
    this.closeTimeoutMs = Math.max(0, options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS)
    this.onEvent = options.onEvent
    this.closedSignal = new Promise((resolve) => { this.resolveClosed = resolve })
    this.child = options.spawnProcess?.() ?? spawn(
      options.command ?? 'codebuddy',
      options.args ?? ['--acp'],
      { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] },
    )

    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => this.receiveLine(line))
    this.child.stdout.on('end', () => {
      this.failTransport(new SpecOpsError('agent_protocol_error', 'CodeBuddy ACP stdout reached EOF'))
    })
    this.child.stdout.on('error', (error) => {
      this.failTransport(new SpecOpsError('agent_protocol_error', `CodeBuddy ACP stdout failed: ${error.message}`), error)
    })
    this.child.stderr.on('data', (chunk: Buffer | string) => this.captureStderr(chunk))
    this.child.stderr.on('error', (error) => {
      this.emit({ type: 'diagnostic', message: `CodeBuddy ACP stderr failed: ${error.message}`, error })
    })
    this.child.stdin.on('error', (error) => {
      this.failTransport(new SpecOpsError('agent_protocol_error', `CodeBuddy ACP stdin failed: ${error.message}`), error)
    })
    this.child.on('error', (error) => {
      this.failTransport(new SpecOpsError('agent_exited', `CodeBuddy ACP process failed: ${error.message}`), error)
    })
    this.child.on('exit', (code, signal) => this.handleExit(code, signal))
  }

  get capabilities(): Readonly<AcpAgentCapabilities> | undefined {
    return this.initializedResult?.agentCapabilities
  }

  get stderr(): string {
    return this.stderrBuffer.toString('utf8')
  }

  initialize(): Promise<AcpInitializeResult> {
    try { this.ensureOpen() } catch (error) { return Promise.reject(error) }
    if (this.initializedResult !== undefined) return Promise.resolve(this.initializedResult)
    if (this.initializePromise !== undefined) return this.initializePromise

    const initializing = this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'kode-specops', title: 'Kode SpecOps', version: '0.1.0' },
    }, this.controlTimeoutMs).then((value) => {
      const result = parseInitializeResult(value)
      this.initializedResult = result
      return result
    })
    this.initializePromise = initializing
    void initializing.catch(() => {
      if (this.initializePromise === initializing) this.initializePromise = undefined
    })
    return initializing
  }

  async newSession(cwd: string): Promise<string> {
    await this.initialize()
    const result = parseSessionResult(await this.request('session/new', { cwd, mcpServers: [] }, this.controlTimeoutMs), 'session/new')
    this.rememberSession(result)
    return result.sessionId
  }

  async loadSession(sessionId: string, cwd: string): Promise<string> {
    const initialized = await this.initialize()
    if (initialized.agentCapabilities.loadSession !== true) {
      throw new SpecOpsError('agent_capability_error', 'CodeBuddy ACP does not advertise session/load support')
    }
    const result = parseSessionResult(await this.request('session/load', {
      sessionId,
      cwd,
      mcpServers: [],
    }, this.controlTimeoutMs), 'session/load')
    this.rememberSession(result)
    return result.sessionId
  }

  prompt(sessionId: string, text: string): Promise<AcpPromptResult> {
    this.ensureOpen()
    const previous = this.promptTails.get(sessionId)
    let promptPromise: Promise<AcpPromptResult>
    promptPromise = (previous === undefined ? Promise.resolve() : previous.catch(() => undefined))
      .then(async () => {
        this.ensureOpen()
        const active = this.request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text }],
        }, this.promptTimeoutMs).then(parsePromptResult)
        this.activePrompts.set(sessionId, active)
        try {
          return await active
        } finally {
          if (this.activePrompts.get(sessionId) === active) this.activePrompts.delete(sessionId)
        }
      })
      .finally(() => {
        if (this.promptTails.get(sessionId) === promptPromise) this.promptTails.delete(sessionId)
      })
    this.promptTails.set(sessionId, promptPromise)
    return promptPromise
  }

  /** Send cancellation, then optionally wait for that session's active/queued prompt to settle. */
  async cancel(sessionId: string, waitForPrompt = true): Promise<AcpPromptResult | undefined> {
    this.ensureOpen()
    const prompt = this.promptTails.get(sessionId)
    await this.notify('session/cancel', { sessionId })
    if (!waitForPrompt || prompt === undefined) return undefined
    return prompt
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.initialize()
    await this.request('session/set_mode', { sessionId, modeId }, this.controlTimeoutMs)
    const state = this.sessions.get(sessionId) ?? {}
    state.currentMode = modeId
    this.sessions.set(sessionId, state)
  }

  currentMode(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.currentMode
  }

  async resolveInterruption(
    interruption: CodeBuddyInterruption,
    resolution: CodeBuddyInterruptionResolution,
  ): Promise<void> {
    if (interruption.kind === 'permission') {
      await this.resolvePermission(interruption, resolution)
      return
    }
    const params: Record<string, unknown> = {
      sessionId: interruption.sessionId,
      toolCallId: interruption.toolCallId,
      decision: resolution.decision,
    }
    if (resolution.answers !== undefined) params.answers = resolution.answers
    if (resolution.feedback !== undefined) params.feedback = resolution.feedback
    await this.request('_codebuddy.ai/resolveInterruption', params, this.controlTimeoutMs)
  }

  /** Submit every AskUserQuestion answer atomically to the live interruption. */
  async resolveQuestions(
    interruption: Pick<CodeBuddyInterruptionBase, 'sessionId' | 'toolCallId'>,
    answers: Record<string, string | string[]>,
  ): Promise<void> {
    await this.request('_codebuddy.ai/resolveInterruption', {
      sessionId: interruption.sessionId,
      toolCallId: interruption.toolCallId,
      decision: 'allow',
      answers,
    }, this.controlTimeoutMs)
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    if (this.state === 'closed' && this.exitEmitted) return Promise.resolve()
    this.state = 'closing'
    this.rejectPending(new SpecOpsError('agent_closed', 'CodeBuddy ACP client is closed'))
    this.pendingPermissions.clear()

    this.closePromise = (async () => {
      try { this.child.stdin.end() } catch { /* stream is already closed */ }
      try { this.child.kill() } catch { /* process is already gone */ }
      if (this.closeTimeoutMs === 0) {
        await this.closedSignal
      } else {
        await Promise.race([
          this.closedSignal,
          new Promise<void>((resolve) => setTimeout(resolve, this.closeTimeoutMs)),
        ])
        if (!this.exitEmitted) {
          try { this.child.kill('SIGKILL') } catch { /* process is already gone */ }
          await Promise.race([
            this.closedSignal,
            new Promise<void>((resolve) => setTimeout(resolve, Math.min(this.closeTimeoutMs, 500))),
          ])
        }
      }
      this.markClosed()
    })()
    return this.closePromise
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    try { this.ensureOpen() } catch (error) { return Promise.reject(error) }
    const id = this.nextId++
    const key = rpcIdKey(id)
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { method, resolve, reject }
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (this.pending.delete(key)) {
            reject(new ExecutionOperationError('agent_timeout', `CodeBuddy ACP request timed out after dispatch: ${method}`, {
              outcomeUnknown: true,
            }))
          }
        }, timeoutMs)
      }
      this.pending.set(key, pending)
      void this.write({ jsonrpc: '2.0', id, method, params }).catch((error: unknown) => {
        const current = this.pending.get(key)
        if (current !== pending) return
        this.pending.delete(key)
        if (pending.timer !== undefined) clearTimeout(pending.timer)
        reject(asSpecOpsError(error, 'agent_protocol_error', `CodeBuddy ACP failed to write ${method}`))
      })
    })
  }

  private notify(method: string, params: Record<string, unknown>): Promise<void> {
    return this.write({ jsonrpc: '2.0', method, params })
  }

  private write(message: RpcMessage): Promise<void> {
    let frame: string
    try {
      this.ensureOpen()
      frame = `${JSON.stringify(message)}\n`
    } catch (error) {
      return Promise.reject(error)
    }
    const operation = this.writeTail.then(() => this.writeFrame(frame))
    this.writeTail = operation.catch(() => undefined)
    return operation
  }

  private writeFrame(frame: string): Promise<void> {
    this.ensureOpen()
    return new Promise((resolve, reject) => {
      let callbackDone = false
      let drainDone = false
      let settled = false
      const finish = (): void => {
        if (!settled && callbackDone && drainDone) {
          settled = true
          cleanup()
          resolve()
        }
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const onDrain = (): void => { drainDone = true; finish() }
      const onError = (error: Error): void => fail(error)
      const cleanup = (): void => {
        this.child.stdin.off('drain', onDrain)
        this.child.stdin.off('error', onError)
      }
      this.child.stdin.once('error', onError)
      let accepted: boolean
      try {
        accepted = this.child.stdin.write(frame, (error?: Error | null) => {
          if (error !== undefined && error !== null) { fail(error); return }
          callbackDone = true
          finish()
        })
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        return
      }
      drainDone = accepted
      if (!accepted) this.child.stdin.once('drain', onDrain)
      finish()
    })
  }

  private receiveLine(line: string): void {
    if (line.trim() === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      this.emit({
        type: 'diagnostic',
        message: `Malformed CodeBuddy ACP frame: ${error instanceof Error ? error.message : String(error)}`,
        frame: line,
        ...(error instanceof Error ? { error } : {}),
      })
      return
    }
    if (!isRecord(parsed)) {
      this.emit({ type: 'diagnostic', message: 'Malformed CodeBuddy ACP frame: expected an object', frame: line })
      return
    }
    if (parsed.jsonrpc !== '2.0') {
      this.emit({ type: 'diagnostic', message: 'Malformed CodeBuddy ACP frame: invalid jsonrpc version', frame: line })
      return
    }

    const id = parseRpcId(parsed.id)
    if (typeof parsed.method === 'string') {
      const params = isRecord(parsed.params) ? parsed.params : {}
      if (id !== undefined) {
        void this.handleServerRequest(parsed.method, id, params).catch((error: unknown) => {
          const diagnostic = error instanceof Error ? error : new Error(String(error))
          this.emit({ type: 'diagnostic', message: `Failed to handle ${parsed.method}: ${diagnostic.message}`, error: diagnostic })
        })
      } else if (parsed.id === undefined || parsed.id === null) {
        this.handleNotification(parsed.method, params)
      } else {
        this.emit({ type: 'diagnostic', message: 'Malformed CodeBuddy ACP request: invalid id', frame: line })
      }
      return
    }

    const hasResult = Object.prototype.hasOwnProperty.call(parsed, 'result')
    const hasError = Object.prototype.hasOwnProperty.call(parsed, 'error')
    if (id !== undefined && (hasResult || hasError)) {
      this.handleResponse(id, parsed, line)
      return
    }
    this.emit({ type: 'diagnostic', message: 'Malformed CodeBuddy ACP frame: unrecognized envelope', frame: line })
  }

  private handleResponse(id: RpcId, message: Record<string, unknown>, frame: string): void {
    const key = rpcIdKey(id)
    const request = this.pending.get(key)
    if (request === undefined) {
      this.emit({ type: 'diagnostic', message: `Unmatched CodeBuddy ACP response id: ${String(id)}`, frame })
      return
    }
    this.pending.delete(key)
    if (request.timer !== undefined) clearTimeout(request.timer)
    if (message.error !== undefined) {
      const error = isRecord(message.error) ? message.error : {}
      const code = typeof error.code === 'number' ? error.code : -32000
      const text = typeof error.message === 'string' ? error.message : 'CodeBuddy ACP request failed'
      request.reject(new SpecOpsError('agent_protocol_error', `${request.method} failed (${code}): ${text}`))
    } else {
      request.resolve(message.result)
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'session/update') {
      this.handleSessionUpdate(params)
      return
    }
    if (isSessionResetMethod(method)) {
      this.handleSessionReset(params)
      return
    }
    this.emit({ type: 'notification', method, params })
  }

  private async handleServerRequest(method: string, id: RpcId, params: Record<string, unknown>): Promise<void> {
    if (method === 'session/request_permission') {
      this.handlePermissionRequest(id, params)
      return
    }
    await this.respondError(id, -32601, `Method not found: ${method}`)
  }

  private handlePermissionRequest(id: RpcId, params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
    const toolCall = isRecord(params.toolCall) ? params.toolCall : undefined
    const toolCallId = toolCall !== undefined && typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : ''
    if (sessionId === '' || toolCall === undefined || toolCallId === '' || !Array.isArray(params.options)) {
      void this.respondError(id, -32602, 'Invalid session/request_permission params').catch((error: unknown) => {
        const diagnostic = error instanceof Error ? error : new Error(String(error))
        this.emit({ type: 'diagnostic', message: `Failed to reject invalid permission request: ${diagnostic.message}`, error: diagnostic })
      })
      return
    }
    const options = params.options.flatMap((value): AcpPermissionOption[] => {
      if (!isRecord(value) || typeof value.optionId !== 'string') return []
      return [{
        optionId: value.optionId,
        name: typeof value.name === 'string' ? value.name : value.optionId,
        kind: typeof value.kind === 'string' ? value.kind : '',
      }]
    })
    const typedToolCall: AcpPermissionToolCall = {
      ...toolCall,
      toolCallId,
      ...(typeof toolCall.title === 'string' ? { title: toolCall.title } : {}),
      ...(typeof toolCall.kind === 'string' ? { kind: toolCall.kind } : {}),
      ...(Object.prototype.hasOwnProperty.call(toolCall, 'rawInput') ? { rawInput: toolCall.rawInput } : {}),
    }
    const metadata = isRecord(params._meta) ? params._meta : {}
    const interruption: CodeBuddyPermissionInterruption = {
      kind: 'permission',
      requestId: id,
      sessionId,
      toolCallId,
      toolName: typedToolCall.title ?? typedToolCall.kind ?? 'permission',
      toolCall: typedToolCall,
      options,
      raw: params,
      metadata,
    }
    this.pendingPermissions.set(rpcIdKey(id), { interruption })
    this.emit({ type: 'interruption', interruption })
  }

  private async resolvePermission(
    interruption: CodeBuddyPermissionInterruption,
    resolution: CodeBuddyInterruptionResolution,
  ): Promise<void> {
    const key = rpcIdKey(interruption.requestId)
    const pending = this.pendingPermissions.get(key)
    if (pending === undefined || pending.interruption !== interruption) {
      throw new SpecOpsError('agent_protocol_error', `Unknown permission request: ${String(interruption.requestId)}`)
    }
    let optionId = resolution.optionId
    if (optionId !== undefined && !interruption.options.some((option) => option.optionId === optionId)) {
      throw new SpecOpsError('agent_protocol_error', `Unknown permission option: ${optionId}`)
    }
    if (optionId === undefined) optionId = pickPermissionOption(interruption.options, resolution.decision === 'allow')
    if (resolution.decision === 'allow' && optionId === undefined) {
      throw new SpecOpsError('agent_protocol_error', 'Cannot allow permission without an allow option')
    }
    const outcome = optionId === undefined
      ? { outcome: 'cancelled' }
      : { outcome: 'selected', optionId }
    this.pendingPermissions.delete(key)
    await this.respondResult(interruption.requestId, { outcome })
  }

  private handleSessionUpdate(params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
    const update = isRecord(params.update) ? params.update : {}
    const meta = isRecord(update._meta) ? update._meta : {}
    this.maybeUpdateCurrentMode(sessionId, update)

    const rawInterruption = meta['codebuddy.ai/interruptionRequest']
    if (isRecord(rawInterruption)) {
      const interruption = parseInterruption(sessionId, rawInterruption, meta)
      if (interruption !== null) this.emit({ type: 'interruption', interruption })
    }
    const reset = meta['codebuddy.ai/sessionReset']
    if (reset === true || isRecord(reset)) {
      const resetDetails = isRecord(reset) ? reset : {}
      const newSessionId = firstString(meta['codebuddy.ai/newSessionId'], resetDetails.newSessionId)
      this.handleSessionReset({
        sessionId,
        ...(newSessionId !== undefined ? { newSessionId } : {}),
        _meta: meta,
        ...resetDetails,
      })
    }
    if (update.sessionUpdate === 'session_reset' || update.sessionUpdate === 'sessionReset') {
      this.handleSessionReset({ sessionId, ...update })
    }
    this.emit({ type: 'session_update', sessionId, update })
  }

  private handleSessionReset(params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
    const newSessionId = firstString(params.newSessionId, params.session_id, params.id)
    if (sessionId !== '') this.sessions.delete(sessionId)
    this.emit({
      type: 'session_reset',
      sessionId,
      ...(newSessionId !== undefined ? { newSessionId } : {}),
      raw: params,
    })
  }

  private maybeUpdateCurrentMode(sessionId: string, update: Record<string, unknown>): void {
    if (sessionId === '') return
    const mode = update.sessionUpdate === 'current_mode_update'
      ? firstString(update.currentModeId, update.modeId)
      : undefined
    if (mode === undefined) return
    const state = this.sessions.get(sessionId) ?? {}
    state.currentMode = mode
    this.sessions.set(sessionId, state)
  }

  private rememberSession(result: AcpSessionResult): void {
    const state: SessionState = {}
    if (result.modes !== undefined) {
      state.modes = result.modes
      if (typeof result.modes.currentModeId === 'string') state.currentMode = result.modes.currentModeId
    }
    this.sessions.set(result.sessionId, state)
  }

  private respondResult(id: RpcId, result: unknown): Promise<void> {
    return this.write({ jsonrpc: '2.0', id, result })
  }

  private respondError(id: RpcId, code: number, message: string): Promise<void> {
    return this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private captureStderr(chunk: Buffer | string): void {
    if (this.stderrBufferLimitBytes === 0) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.stderrBuffer = this.stderrBuffer.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.stderrBuffer, bytes])
    if (this.stderrBuffer.length > this.stderrBufferLimitBytes) {
      this.stderrBuffer = this.stderrBuffer.subarray(this.stderrBuffer.length - this.stderrBufferLimitBytes)
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const detail = code ?? signal ?? 'unknown'
    const suffix = this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`
    const error = new SpecOpsError('agent_exited', `CodeBuddy ACP exited (${detail})${suffix}`)
    if (this.state !== 'closing') this.terminalError = error
    this.rejectPending(error)
    this.pendingPermissions.clear()
    this.markClosed()
    if (!this.exitEmitted) {
      this.exitEmitted = true
      this.emit({ type: 'exit', code, signal, stderr: this.stderr })
    }
  }

  private failTransport(error: Error, cause?: Error): void {
    if (this.state === 'closed') return
    const wasClosing = this.state === 'closing'
    if (!wasClosing) this.terminalError ??= error
    this.rejectPending(error)
    this.pendingPermissions.clear()
    this.markClosed()
    if (!wasClosing) this.emit({ type: 'diagnostic', message: error.message, error: cause ?? error })
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      if (request.timer !== undefined) clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }

  private markClosed(): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.resolveClosed()
  }

  private ensureOpen(): void {
    if (this.state !== 'open') {
      throw this.terminalError ?? new SpecOpsError('agent_closed', 'CodeBuddy ACP client is closed')
    }
  }

  private emit(event: CodeBuddyAcpEvent): void {
    try { this.onEvent?.(event) } catch { /* observers must not break the transport */ }
  }
}

export function parseInterruption(
  sessionId: string,
  raw: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): CodeBuddyQuestionsInterruption | CodeBuddyPlanInterruption | null {
  if (sessionId === '' || typeof raw.toolCallId !== 'string' || typeof raw.toolName !== 'string') return null
  const input = isRecord(raw.toolInput) ? raw.toolInput : {}
  const base = {
    sessionId,
    toolCallId: raw.toolCallId,
    raw,
    metadata,
  }
  if (raw.toolName === 'AskUserQuestion') {
    const questions = Array.isArray(input.questions) ? input.questions : []
    return {
      ...base,
      kind: 'questions',
      toolName: 'AskUserQuestion',
      questions: questions.flatMap((value, index): AcpQuestion[] => {
        if (!isRecord(value) || typeof value.question !== 'string') return []
        const options = Array.isArray(value.options)
          ? value.options.flatMap((option): AcpQuestion['options'] => {
            if (!isRecord(option) || typeof option.label !== 'string') return []
            return [{
              label: option.label,
              ...(typeof option.description === 'string' ? { description: option.description } : {}),
            }]
          })
          : []
        return [{
          id: typeof value.id === 'string' && value.id !== '' ? value.id : `q_${index}`,
          question: value.question,
          ...(typeof value.header === 'string' ? { header: value.header } : {}),
          options,
          multi_select: value.multiSelect === true || value.multi_select === true,
        }]
      }),
    }
  }
  if (raw.toolName === 'ExitPlanMode') {
    const plan = firstString(
      metadata['codebuddy.ai/planContent'],
      input.plan,
      input.content,
      raw.plan,
      raw.workflowSourceText,
      isRecord(raw.toolResult) ? raw.toolResult.content : undefined,
      isRecord(raw.providerData) && isRecord(raw.providerData.toolResult)
        ? raw.providerData.toolResult.content
        : undefined,
    ) ?? ''
    return { ...base, kind: 'plan', toolName: 'ExitPlanMode', plan }
  }
  return null
}

/** CodeBuddy 2.124 may stream an attempted AskUserQuestion as a generic tool
 * call and then reject it before emitting the private interruption metadata.
 * Preserve the structured payload so SpecOps can render the question and
 * continue through a normal follow-up prompt instead of terminal keystrokes. */
export function parseFallbackQuestions(value: unknown): ExecutionQuestion[] {
  if (!isRecord(value)) return []
  let rawQuestions: unknown = value.questions
  if (typeof rawQuestions === 'string') {
    try { rawQuestions = JSON.parse(rawQuestions) } catch { return [] }
  }
  if (!Array.isArray(rawQuestions)) return []
  return rawQuestions.flatMap((rawQuestion, index): ExecutionQuestion[] => {
    if (!isRecord(rawQuestion) || typeof rawQuestion.question !== 'string') return []
    const options = Array.isArray(rawQuestion.options)
      ? rawQuestion.options.flatMap((rawOption): ExecutionQuestion['options'] => {
        if (!isRecord(rawOption) || typeof rawOption.label !== 'string') return []
        return [{
          label: rawOption.label,
          ...(typeof rawOption.description === 'string' ? { description: rawOption.description } : {}),
        }]
      })
      : []
    if (options.length < 2) return []
    return [{
      id: typeof rawQuestion.id === 'string' && rawQuestion.id !== '' ? rawQuestion.id : `q_${index}`,
      prompt: rawQuestion.question,
      ...(typeof rawQuestion.header === 'string' ? { header: rawQuestion.header } : {}),
      options,
      ...(rawQuestion.multiSelect === true || rawQuestion.multi_select === true ? { multiSelect: true } : {}),
    }]
  })
}

function parseInitializeResult(value: unknown): AcpInitializeResult {
  if (!isRecord(value) || value.protocolVersion !== 1 || !isRecord(value.agentCapabilities)) {
    throw new SpecOpsError('agent_protocol_error', 'CodeBuddy initialize returned invalid protocolVersion or agentCapabilities')
  }
  const capabilities = value.agentCapabilities
  if (capabilities.loadSession !== undefined && typeof capabilities.loadSession !== 'boolean') {
    throw new SpecOpsError('agent_protocol_error', 'CodeBuddy initialize returned invalid loadSession capability')
  }
  if (capabilities.sessionCapabilities !== undefined && !isRecord(capabilities.sessionCapabilities)) {
    throw new SpecOpsError('agent_protocol_error', 'CodeBuddy initialize returned invalid sessionCapabilities')
  }
  return {
    ...value,
    protocolVersion: 1,
    agentCapabilities: capabilities,
  }
}

function parseSessionResult(value: unknown, method: 'session/new' | 'session/load'): AcpSessionResult {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId === '') {
    throw new SpecOpsError('agent_protocol_error', `CodeBuddy ${method} returned no sessionId`)
  }
  if (value.modes !== undefined && !isRecord(value.modes)) {
    throw new SpecOpsError('agent_protocol_error', `CodeBuddy ${method} returned invalid modes`)
  }
  return {
    ...value,
    sessionId: value.sessionId,
    ...(isRecord(value.modes) ? { modes: value.modes } : {}),
  }
}

function parsePromptResult(value: unknown): AcpPromptResult {
  if (!isRecord(value) || typeof value.stopReason !== 'string' || value.stopReason === '') {
    throw new SpecOpsError('agent_protocol_error', 'CodeBuddy session/prompt returned no stopReason')
  }
  return { ...value, stopReason: value.stopReason }
}

function parseRpcId(value: unknown): RpcId | undefined {
  return typeof value === 'number' || typeof value === 'string' ? value : undefined
}

function rpcIdKey(id: RpcId): string {
  return `${typeof id}:${String(id)}`
}

function pickPermissionOption(options: AcpPermissionOption[], allow: boolean): string | undefined {
  const wanted = options.filter((option) => {
    const text = `${option.kind} ${option.name}`.toLowerCase()
    const denying = /reject|deny|cancel/.test(text)
    return allow ? !denying : denying
  })
  if (wanted.length === 0) return undefined
  if (allow) {
    return wanted.find((option) => /once/.test(`${option.kind} ${option.name}`.toLowerCase()))?.optionId
      ?? wanted[0]?.optionId
  }
  return wanted[0]?.optionId
}

function isSessionResetMethod(method: string): boolean {
  return method === 'session/reset'
    || method === 'session/sessionReset'
    || method === '_codebuddy.ai/sessionReset'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value !== '')
}

function asSpecOpsError(error: unknown, code: string, prefix: string): SpecOpsError {
  if (error instanceof SpecOpsError) return error
  const detail = error instanceof Error ? error.message : String(error)
  return new SpecOpsError(code, `${prefix}: ${detail}`)
}

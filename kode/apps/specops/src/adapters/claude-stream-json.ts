import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'

import {
  ExecutionOperationError,
  type AgentExecutionTransport,
  type ExecutionCancelInput,
  type ExecutionCapability,
  type ExecutionLoadInput,
  type ExecutionProbeResult,
  type ExecutionPromptInput,
  type ExecutionQuestion,
  type ExecutionResponse,
  type ExecutionSession,
  type ExecutionSetModeInput,
  type ExecutionStartInput,
  type ExecutionTurnResult,
  type TransportEventListener,
  type TransportExecutionEvent,
} from '../execution/types.js'

export interface ClaudeStreamJsonChild {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

export interface ClaudeSpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  stdio: ['pipe', 'pipe', 'pipe']
}

export interface ClaudeProbeOutput {
  stdout: string
  stderr: string
}

export interface ClaudeStreamJsonOptions {
  command?: string
  args?: readonly string[]
  env?: NodeJS.ProcessEnv
  probeCommand?: (command: string, args: readonly string[]) => Promise<ClaudeProbeOutput>
  spawnProcess?: (command: string, args: readonly string[], options: ClaudeSpawnOptions) => ClaudeStreamJsonChild
  maxFrameBytes?: number
  stderrTailBytes?: number
  closeTimeoutMs?: number
}

type InteractionKind = ExecutionResponse['kind']

interface PendingInteraction {
  kind: InteractionKind
  requestId: string
  toolName: string
  input: Record<string, unknown>
  questions?: readonly ExecutionQuestion[]
}

interface PendingTurn {
  requestId: string
  resolve: (result: ExecutionTurnResult) => void
  reject: (error: Error) => void
}

interface StreamBlock {
  type: string
  id?: string
  name?: string
  partialJson: string
}

const REQUIRED_FLAGS = [
  '--input-format',
  '--output-format',
  '--permission-prompt-tool',
  '--replay-user-messages',
  '--resume',
  '--verbose',
] as const

export const CLAUDE_STREAM_JSON_BASE_CAPABILITIES: readonly ExecutionCapability[] = [
  'session.create',
  'session.resume',
  'session.prompt',
  'session.interrupt',
  'conversation.permission',
  'conversation.ask',
  'conversation.plan',
  'events.tools',
  'output.structured',
  'usage.metrics',
]

const DEFAULT_MAX_FRAME_BYTES = 10 * 1024 * 1024
const DEFAULT_STDERR_TAIL_BYTES = 64 * 1024
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000

/** Native Claude Code stream-json transport. It never allocates a PTY. */
export class ClaudeStreamJsonTransport implements AgentExecutionTransport {
  private readonly command: string
  private readonly extraArgs: readonly string[]
  private readonly configuredEnv: NodeJS.ProcessEnv | undefined
  private readonly probeCommand: (command: string, args: readonly string[]) => Promise<ClaudeProbeOutput>
  private readonly spawnProcess: (command: string, args: readonly string[], options: ClaudeSpawnOptions) => ClaudeStreamJsonChild
  private readonly maxFrameBytes: number
  private readonly stderrTailBytes: number
  private readonly closeTimeoutMs: number
  private readonly listeners = new Set<TransportEventListener>()
  private readonly interactions = new Map<string, PendingInteraction>()
  private readonly streamBlocks = new Map<number, StreamBlock>()

  private probePromise: Promise<ExecutionProbeResult> | undefined
  private probeResult: ExecutionProbeResult | undefined
  private child: ClaudeStreamJsonChild | undefined
  private state: 'idle' | 'open' | 'closing' | 'closed' = 'idle'
  private terminalError: ExecutionOperationError | undefined
  private stdoutBuffer = Buffer.alloc(0)
  private stderrBuffer = Buffer.alloc(0)
  private writeTail: Promise<void> = Promise.resolve()
  private closePromise: Promise<void> | undefined
  private exitSignal: Promise<void> | undefined
  private resolveExit: (() => void) | undefined
  private exitEmitted = false
  private activeTurn: PendingTurn | undefined
  private nativeSessionId: string | null = null
  private model: string | undefined
  private mode: string | undefined
  private activeMessageId: string | undefined
  private messageSequence = 0

  constructor(options: ClaudeStreamJsonOptions = {}) {
    this.command = options.command ?? 'claude'
    this.extraArgs = options.args ?? []
    this.configuredEnv = options.env
    this.probeCommand = options.probeCommand ?? runProbeCommand
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => (
      spawn(command, [...args], spawnOptions) as unknown as ClaudeStreamJsonChild
    ))
    this.maxFrameBytes = Math.max(1, options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES)
    this.stderrTailBytes = Math.max(0, options.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES)
    this.closeTimeoutMs = Math.max(0, options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS)
  }

  probe(): Promise<ExecutionProbeResult> {
    if (this.probeResult !== undefined) return Promise.resolve(this.probeResult)
    if (this.probePromise !== undefined) return this.probePromise
    const probing = this.performProbe().then((result) => {
      this.probeResult = result
      return result
    })
    this.probePromise = probing
    void probing.catch(() => {
      if (this.probePromise === probing) this.probePromise = undefined
    })
    return probing
  }

  async start(input: ExecutionStartInput): Promise<ExecutionSession> {
    await this.launch(input)
    return this.sessionSnapshot()
  }

  async load(input: ExecutionLoadInput): Promise<ExecutionSession> {
    if (input.nativeSessionId.trim() === '') {
      throw new ExecutionOperationError('invalid_session_id', 'Claude resume session id cannot be empty')
    }
    this.nativeSessionId = input.nativeSessionId
    await this.launch(input, input.nativeSessionId)
    return this.sessionSnapshot()
  }

  prompt(input: ExecutionPromptInput): Promise<ExecutionTurnResult> {
    try {
      this.assertOpen()
      if (input.requestId.trim() === '') throw new ExecutionOperationError('invalid_request_id', 'Claude prompt request id cannot be empty')
      if (this.activeTurn !== undefined) throw new ExecutionOperationError('turn_in_progress', 'Claude already has an active turn')
    } catch (error) {
      return Promise.reject(error)
    }

    let pending!: PendingTurn
    const result = new Promise<ExecutionTurnResult>((resolve, reject) => {
      pending = { requestId: input.requestId, resolve, reject }
    })
    this.activeTurn = pending
    void this.writeMessage({
      type: 'user',
      message: { role: 'user', content: input.text },
    }).catch((error: unknown) => {
      if (this.activeTurn !== pending) return
      this.activeTurn = undefined
      pending.reject(asExecutionError(error, 'claude_write_error', 'Failed to write Claude prompt', true))
    })
    return result
  }

  async cancel(input: ExecutionCancelInput): Promise<void> {
    this.assertOpen()
    if (input.requestId.trim() === '') throw new ExecutionOperationError('invalid_request_id', 'Claude cancel request id cannot be empty')
    await this.writeMessage({
      type: 'control_request',
      request_id: input.requestId,
      request: { subtype: 'interrupt' },
    })
  }

  async respond(input: ExecutionResponse): Promise<void> {
    this.assertOpen()
    const pending = this.interactions.get(input.requestId)
    if (pending === undefined) {
      throw new ExecutionOperationError('interaction_not_found', `Unknown Claude interaction request: ${input.requestId}`)
    }
    if (pending.kind !== input.kind) {
      throw new ExecutionOperationError(
        'interaction_kind_mismatch',
        `Claude interaction ${input.requestId} expects ${pending.kind}, not ${input.kind}`,
      )
    }

    const response = this.buildInteractionResponse(pending, input)
    await this.writeMessage({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: input.requestId,
        response,
      },
    })
    this.interactions.delete(input.requestId)
  }

  async setMode(input: ExecutionSetModeInput): Promise<void> {
    this.assertOpen()
    if (!this.hasCapability('session.mode')) {
      throw new ExecutionOperationError('capability_not_supported', 'Claude CLI does not advertise --permission-mode')
    }
    await this.writeMessage({
      type: 'control_request',
      request_id: input.requestId || randomUUID(),
      request: { subtype: 'set_permission_mode', mode: input.mode },
    })
    this.mode = input.mode
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closePromise = this.closeInternal()
    return this.closePromise
  }

  events(listener: TransportEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async performProbe(): Promise<ExecutionProbeResult> {
    let versionOutput: ClaudeProbeOutput
    let helpOutput: ClaudeProbeOutput
    try {
      [versionOutput, helpOutput] = await Promise.all([
        this.probeCommand(this.command, ['--version']),
        this.probeCommand(this.command, ['--help']),
      ])
    } catch (error) {
      throw asExecutionError(error, 'claude_unavailable', `Claude command is unavailable: ${this.command}`)
    }
    const version = firstNonEmptyLine(versionOutput.stdout, versionOutput.stderr)
    if (version === undefined) {
      throw new ExecutionOperationError('claude_invalid_version', `${this.command} --version returned no version`)
    }
    const help = `${helpOutput.stdout}\n${helpOutput.stderr}`
    const missing = REQUIRED_FLAGS.filter((flag) => !hasFlag(help, flag))
    if (missing.length > 0) {
      throw new ExecutionOperationError(
        'claude_missing_stream_json_capability',
        `${this.command} does not support required Claude stream-json flags: ${missing.join(', ')}`,
      )
    }

    const capabilities = [...CLAUDE_STREAM_JSON_BASE_CAPABILITIES]
    if (hasFlag(help, '--permission-mode')) capabilities.push('session.mode', 'sandbox.policy')
    if (hasFlag(help, '--model')) capabilities.push('model.select')
    return {
      transport: 'claude-stream-json',
      capabilities,
      version,
      metadata: {
        command: this.command,
        includePartialMessages: hasFlag(help, '--include-partial-messages'),
        printMode: hasFlag(help, '--print'),
      },
    }
  }

  private async launch(input: ExecutionStartInput | ExecutionLoadInput, resumeId?: string): Promise<void> {
    const probe = await this.probe()
    if (this.state !== 'idle') {
      throw new ExecutionOperationError('transport_already_started', 'Claude transport instances own exactly one process')
    }
    this.model = input.model
    this.mode = input.mode

    const args = [...this.extraArgs]
    if (metadataBoolean(probe, 'printMode')) args.push('--print')
    args.push(
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--permission-prompt-tool', 'stdio',
      '--replay-user-messages',
      '--verbose',
    )
    if (metadataBoolean(probe, 'includePartialMessages')) args.push('--include-partial-messages')
    if (input.model !== undefined && input.model !== '') {
      if (!probe.capabilities.includes('model.select')) {
        throw new ExecutionOperationError('capability_not_supported', 'Claude CLI does not advertise --model')
      }
      args.push('--model', input.model)
    }
    if (input.mode !== undefined && input.mode !== '' && input.mode !== 'default') {
      if (!probe.capabilities.includes('session.mode')) {
        throw new ExecutionOperationError('capability_not_supported', 'Claude CLI does not advertise --permission-mode')
      }
      args.push('--permission-mode', input.mode)
    }
    if (resumeId !== undefined) args.push('--resume', resumeId)

    const env = { ...(this.configuredEnv ?? process.env) }
    delete env.CLAUDECODE
    let child: ClaudeStreamJsonChild
    try {
      child = this.spawnProcess(this.command, args, { cwd: input.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      this.state = 'closed'
      throw asExecutionError(error, 'claude_spawn_error', `Failed to spawn ${this.command}`)
    }
    this.child = child
    this.state = 'open'
    this.exitSignal = new Promise((resolve) => { this.resolveExit = resolve })
    this.attachChild(child)
    this.emit({ type: 'status', status: 'started', detail: resumeId === undefined ? 'new' : 'resumed' })
  }

  private attachChild(child: ClaudeStreamJsonChild): void {
    child.stdout.on('data', (chunk: Buffer | string) => this.receiveStdout(chunk))
    child.stdout.once('end', () => this.handleStdoutEnd())
    child.stdout.once('error', (error: Error) => this.failOpenTransport(
      new ExecutionOperationError('claude_stdout_error', `Claude stdout failed: ${error.message}`, { outcomeUnknown: true, cause: error }),
    ))
    child.stderr.on('data', (chunk: Buffer | string) => this.captureStderr(chunk))
    child.stderr.once('error', (error: Error) => {
      this.emit({ type: 'status', status: 'stderr_error', detail: error.message })
    })
    child.stdin.once('error', (error: Error) => this.failOpenTransport(
      new ExecutionOperationError('claude_stdin_error', `Claude stdin failed: ${error.message}`, { outcomeUnknown: true, cause: error }),
    ))
    child.once('error', (error) => this.handleProcessError(error))
    child.once('exit', (code, signal) => this.handleExit(code, signal))
  }

  private receiveStdout(chunk: Buffer | string): void {
    if (this.state === 'closed') return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, bytes])
    for (;;) {
      const newline = this.stdoutBuffer.indexOf(0x0a)
      if (newline < 0) break
      let frame = this.stdoutBuffer.subarray(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1)
      if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1)
      this.receiveFrame(frame)
    }
    if (this.stdoutBuffer.length > this.maxFrameBytes) {
      this.emit({ type: 'status', status: 'protocol_error', detail: `Claude frame exceeded ${this.maxFrameBytes} bytes` })
      this.stdoutBuffer = Buffer.alloc(0)
    }
  }

  private receiveFrame(frame: Buffer): void {
    if (frame.length === 0) return
    if (frame.length > this.maxFrameBytes) {
      this.emit({ type: 'status', status: 'protocol_error', detail: `Claude frame exceeded ${this.maxFrameBytes} bytes` })
      return
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(frame.toString('utf8'))
    } catch (error) {
      this.emit({
        type: 'status',
        status: 'protocol_error',
        detail: `Malformed Claude stream-json frame: ${errorMessage(error)}`,
      })
      return
    }
    if (!isRecord(decoded) || typeof decoded.type !== 'string') {
      this.emit({ type: 'status', status: 'protocol_error', detail: 'Claude stream-json frame has no type' })
      return
    }
    this.handleMessage(decoded)
  }

  private handleMessage(raw: Record<string, unknown>): void {
    this.captureSession(raw)
    switch (raw.type) {
      case 'system':
        this.handleSystem(raw)
        break
      case 'assistant':
        this.handleAssistant(raw)
        break
      case 'user':
        this.handleUser(raw)
        break
      case 'stream_event':
        this.handleStreamEvent(raw)
        break
      case 'result':
        this.handleResult(raw)
        break
      case 'control_request':
        this.handleControlRequest(raw)
        break
      case 'control_cancel_request':
        this.handleControlCancel(raw)
        break
      case 'control_response':
        break
      default:
        this.emit({ type: 'status', status: 'protocol_event', detail: String(raw.type) })
    }
  }

  private handleSystem(raw: Record<string, unknown>): void {
    if (typeof raw.model === 'string' && raw.model !== '') this.model = raw.model
    const detail = this.nativeSessionId === null ? undefined : `session ${this.nativeSessionId}`
    this.emit({ type: 'status', status: 'ready', ...(detail === undefined ? {} : { detail }) })
  }

  private handleAssistant(raw: Record<string, unknown>): void {
    const message = isRecord(raw.message) ? raw.message : undefined
    if (message === undefined || !Array.isArray(message.content)) return
    const messageId = firstString(message.id, raw.uuid) ?? this.currentMessageId()
    this.activeMessageId = messageId
    for (const [contentIndex, content] of message.content.entries()) {
      if (!isRecord(content) || typeof content.type !== 'string') continue
      if (content.type === 'text' && typeof content.text === 'string') {
        this.emit({
          type: 'message_upsert',
          messageId: this.contentBlockMessageId(messageId, contentIndex),
          text: content.text,
          role: 'assistant',
        })
      } else if (content.type === 'tool_use') {
        const toolCallId = firstString(content.id) ?? `tool-${++this.messageSequence}`
        const name = firstString(content.name) ?? 'unknown'
        this.emit({ type: 'tool_call', toolCallId, name, input: content.input, status: 'complete' })
      }
    }
  }

  private handleUser(raw: Record<string, unknown>): void {
    const message = isRecord(raw.message) ? raw.message : undefined
    if (message === undefined) return
    if (typeof message.content === 'string') {
      // The server persists prompts before dispatch; replayed user messages are
      // transport history and must not create duplicate transcript rows.
      return
    }
    if (!Array.isArray(message.content)) return
    for (const content of message.content) {
      if (!isRecord(content)) continue
      if (content.type === 'text' && typeof content.text === 'string') {
        continue
      } else if (content.type === 'tool_result') {
        const toolCallId = firstString(content.tool_use_id, content.toolUseId) ?? 'unknown'
        this.emit({
          type: 'tool_result',
          toolCallId,
          output: content.content,
          ...(typeof content.is_error === 'boolean' ? { isError: content.is_error } : {}),
        })
      }
    }
  }

  private handleStreamEvent(raw: Record<string, unknown>): void {
    const event = isRecord(raw.event) ? raw.event : undefined
    if (event === undefined || typeof event.type !== 'string') return
    if (event.type === 'message_start') {
      const message = isRecord(event.message) ? event.message : undefined
      this.activeMessageId = firstString(message?.id, raw.uuid) ?? `assistant-${++this.messageSequence}`
      return
    }
    const index = typeof event.index === 'number' && Number.isInteger(event.index) ? event.index : 0
    if (event.type === 'content_block_start') {
      const block = isRecord(event.content_block) ? event.content_block : {}
      const streamBlock: StreamBlock = {
        type: typeof block.type === 'string' ? block.type : 'unknown',
        partialJson: '',
        ...(typeof block.id === 'string' ? { id: block.id } : {}),
        ...(typeof block.name === 'string' ? { name: block.name } : {}),
      }
      this.streamBlocks.set(index, streamBlock)
      if (streamBlock.type === 'tool_use') {
        this.emit({
          type: 'tool_call',
          toolCallId: streamBlock.id ?? `tool-${index}`,
          name: streamBlock.name ?? 'unknown',
          input: isRecord(block.input) ? block.input : undefined,
          status: 'in_progress',
        })
      }
      return
    }
    if (event.type === 'content_block_delta') {
      const delta = isRecord(event.delta) ? event.delta : undefined
      if (delta === undefined) return
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        this.emit({
          type: 'message_delta',
          messageId: this.contentBlockMessageId(this.activeMessageId ?? this.currentMessageId(), index),
          delta: delta.text,
          role: 'assistant',
        })
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const block = this.streamBlocks.get(index)
        if (block !== undefined) block.partialJson += delta.partial_json
      }
      return
    }
    if (event.type === 'content_block_stop') {
      const block = this.streamBlocks.get(index)
      this.streamBlocks.delete(index)
      if (block?.type === 'tool_use') {
        this.emit({
          type: 'tool_call',
          toolCallId: block.id ?? `tool-${index}`,
          name: block.name ?? 'unknown',
          input: parsePartialJson(block.partialJson),
          status: 'complete',
        })
      }
    }
  }

  private handleResult(raw: Record<string, unknown>): void {
    const subtype = firstString(raw.subtype)
    if (subtype === 'compact' || subtype === 'compaction') {
      this.emit({ type: 'status', status: 'compacted' })
      return
    }
    const pending = this.activeTurn
    this.activeTurn = undefined
    this.streamBlocks.clear()
    this.activeMessageId = undefined
    const turnId = firstString(raw.uuid, raw.turn_id) ?? pending?.requestId
    const rawStopReason = firstString(raw.stop_reason, subtype) ?? 'end_turn'
    const stopReason = rawStopReason === 'success' ? 'completed' : rawStopReason
    const failed = raw.is_error === true || subtype === 'error_during_execution'
    if (failed) {
      const message = firstString(raw.error, raw.result) ?? 'Claude turn failed'
      this.emit({ type: 'turn_failed', ...(turnId === undefined ? {} : { turnId }), error: message })
      pending?.reject(new ExecutionOperationError('claude_turn_failed', message))
      return
    }
    this.emit({
      type: 'turn_completed',
      ...(turnId === undefined ? {} : { turnId }),
      stopReason,
    })
    pending?.resolve({
      ...(turnId === undefined ? {} : { turnId }),
      stopReason,
      metadata: resultMetadata(raw),
    })
  }

  private handleControlRequest(raw: Record<string, unknown>): void {
    const requestId = firstString(raw.request_id)
    const request = isRecord(raw.request) ? raw.request : undefined
    if (requestId === undefined || request === undefined || request.subtype !== 'can_use_tool') return
    const toolName = firstString(request.tool_name) ?? 'unknown'
    const input = isRecord(request.input) ? request.input : {}
    let pending: PendingInteraction
    if (toolName === 'AskUserQuestion') {
      const questions = parseQuestions(input)
      pending = { kind: 'questions', requestId, toolName, input, questions }
      this.emit({ type: 'questions', requestId, questions })
    } else if (toolName === 'ExitPlanMode') {
      pending = { kind: 'plan', requestId, toolName, input }
      this.emit({ type: 'plan', requestId, markdown: extractPlan(input) })
    } else {
      pending = { kind: 'permission', requestId, toolName, input }
      const description = summarizeInput(input)
      this.emit({
        type: 'permission',
        requestId,
        title: toolName,
        ...(description === undefined ? {} : { description }),
        options: ['allow', 'deny'],
      })
    }
    this.interactions.set(requestId, pending)
  }

  private handleControlCancel(raw: Record<string, unknown>): void {
    const requestId = firstString(raw.request_id)
    if (requestId === undefined) return
    this.interactions.delete(requestId)
    this.emit({ type: 'status', status: 'interaction_cancelled', detail: requestId })
  }

  private buildInteractionResponse(pending: PendingInteraction, response: ExecutionResponse): Record<string, unknown> {
    if (response.kind === 'permission') {
      return response.decision === 'allow'
        ? { behavior: 'allow', updatedInput: pending.input }
        : { behavior: 'deny', message: 'The user denied this tool use.' }
    }
    if (response.kind === 'questions') {
      const answers: Record<string, string> = {}
      for (const question of pending.questions ?? []) {
        const value = response.answers[question.id]
        if (typeof value === 'string') answers[question.prompt] = value
        else if (Array.isArray(value)) answers[question.prompt] = value.join(', ')
      }
      return { behavior: 'allow', updatedInput: { ...pending.input, answers } }
    }
    return response.decision === 'approve'
      ? { behavior: 'allow', updatedInput: pending.input }
      : { behavior: 'deny', message: response.feedback ?? 'The user rejected this plan.' }
  }

  private captureSession(raw: Record<string, unknown>): void {
    const sessionId = firstString(raw.session_id)
    if (sessionId === undefined || sessionId === this.nativeSessionId) return
    this.nativeSessionId = sessionId
    this.emit({ type: 'session_identity', nativeSessionId: sessionId })
  }

  private captureStderr(chunk: Buffer | string): void {
    if (this.stderrTailBytes === 0) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.stderrBuffer = Buffer.concat([this.stderrBuffer, bytes])
    if (this.stderrBuffer.length > this.stderrTailBytes) {
      this.stderrBuffer = this.stderrBuffer.subarray(this.stderrBuffer.length - this.stderrTailBytes)
    }
  }

  private handleStdoutEnd(): void {
    if (this.stdoutBuffer.length > 0) {
      let frame = this.stdoutBuffer
      this.stdoutBuffer = Buffer.alloc(0)
      if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1)
      this.receiveFrame(frame)
    }
    if (this.state === 'open') {
      this.failOpenTransport(new ExecutionOperationError('claude_stdout_eof', 'Claude stdout reached EOF', { outcomeUnknown: true }))
    }
  }

  private handleProcessError(error: Error): void {
    const failure = new ExecutionOperationError(
      'claude_process_error',
      `Claude process failed: ${error.message}`,
      { outcomeUnknown: true, cause: error },
    )
    this.failOpenTransport(failure)
    this.emitExit(null, null)
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.state === 'open') {
      const detail = signal ?? code ?? 'unknown'
      const stderr = this.stderrBuffer.toString('utf8').trim()
      this.failOpenTransport(new ExecutionOperationError(
        'claude_process_exited',
        `Claude process exited (${String(detail)})${stderr === '' ? '' : `: ${stderr}`}`,
        { outcomeUnknown: true },
      ))
    } else {
      this.state = 'closed'
    }
    this.emitExit(code, signal)
    this.resolveExit?.()
  }

  private failOpenTransport(error: ExecutionOperationError): void {
    if (this.state !== 'open') return
    this.terminalError = error
    this.state = 'closed'
    const pending = this.activeTurn
    this.activeTurn = undefined
    pending?.reject(error)
    this.interactions.clear()
    try { this.child?.kill('SIGTERM') } catch { /* process may already be gone */ }
    this.resolveExit?.()
  }

  private emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitEmitted) return
    this.exitEmitted = true
    this.emit({
      type: 'process_exited',
      code,
      signal,
      ...(this.stderrBuffer.length === 0 ? {} : { stderrTail: this.stderrBuffer.toString('utf8') }),
    })
  }

  private async closeInternal(): Promise<void> {
    if (this.state === 'closed' && this.exitEmitted) return
    if (this.state === 'idle') {
      this.state = 'closed'
      return
    }
    this.state = 'closing'
    const closedError = new ExecutionOperationError('transport_closed', 'Claude transport is closed', { outcomeUnknown: true })
    const pending = this.activeTurn
    this.activeTurn = undefined
    pending?.reject(closedError)
    this.interactions.clear()
    const child = this.child
    if (child === undefined) {
      this.state = 'closed'
      return
    }
    try { child.stdin.end() } catch { /* already closed */ }
    const exited = await this.waitForExit(this.closeTimeoutMs)
    if (!exited) {
      try { child.kill('SIGTERM') } catch { /* already exited */ }
      if (!await this.waitForExit(this.closeTimeoutMs)) {
        try { child.kill('SIGKILL') } catch { /* already exited */ }
        await this.waitForExit(Math.min(this.closeTimeoutMs, 500))
      }
    }
    this.state = 'closed'
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    const signal = this.exitSignal
    if (signal === undefined) return true
    if (timeoutMs === 0) {
      await signal
      return true
    }
    return Promise.race([
      signal.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ])
  }

  private writeMessage(message: Record<string, unknown>): Promise<void> {
    this.assertOpen()
    const frame = `${JSON.stringify(message)}\n`
    const operation = this.writeTail.then(() => {
      this.assertOpen()
      return this.writeFrame(frame)
    })
    this.writeTail = operation.catch(() => undefined)
    return operation
  }

  private writeFrame(frame: string): Promise<void> {
    const child = this.child
    if (child === undefined) return Promise.reject(new ExecutionOperationError('transport_not_started', 'Claude transport is not started'))
    return new Promise((resolve, reject) => {
      let writeReturned = false
      let callbackDone = false
      let needsDrain = false
      let drainDone = false
      let settled = false
      const cleanup = (): void => { child.stdin.off('drain', onDrain) }
      const finish = (): void => {
        if (settled || !writeReturned || !callbackDone || (needsDrain && !drainDone)) return
        settled = true
        cleanup()
        resolve()
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(new ExecutionOperationError('claude_write_error', `Claude stdin write failed: ${error.message}`, {
          outcomeUnknown: true,
          cause: error,
        }))
      }
      const onDrain = (): void => { drainDone = true; finish() }
      try {
        const accepted = child.stdin.write(frame, (error?: Error | null) => {
          if (error != null) { fail(error); return }
          callbackDone = true
          finish()
        })
        needsDrain = !accepted
        drainDone = accepted
        writeReturned = true
        if (needsDrain) child.stdin.once('drain', onDrain)
        finish()
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private assertOpen(): void {
    if (this.state !== 'open') {
      throw this.terminalError ?? new ExecutionOperationError(
        this.state === 'idle' ? 'transport_not_started' : 'transport_closed',
        this.state === 'idle' ? 'Claude transport is not started' : 'Claude transport is closed',
      )
    }
  }

  private hasCapability(capability: ExecutionCapability): boolean {
    return this.probeResult?.capabilities.includes(capability) === true
  }

  private currentMessageId(): string {
    this.activeMessageId ??= `assistant-${++this.messageSequence}`
    return this.activeMessageId
  }

  private contentBlockMessageId(messageId: string, index: number): string {
    return `${messageId}:block:${index}`
  }

  private sessionSnapshot(): ExecutionSession {
    return {
      nativeSessionId: this.nativeSessionId,
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(this.mode === undefined ? {} : { mode: this.mode }),
      metadata: { transport: 'claude-stream-json' },
    }
  }

  private emit(event: TransportExecutionEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* observers must not break transport */ }
    }
  }
}

function runProbeCommand(command: string, args: readonly string[]): Promise<ClaudeProbeOutput> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`${command} ${args.join(' ')} failed: ${stderr || error.message}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function parseQuestions(input: Record<string, unknown>): readonly ExecutionQuestion[] {
  if (!Array.isArray(input.questions)) return []
  return input.questions.flatMap((value, index): ExecutionQuestion[] => {
    if (!isRecord(value) || typeof value.question !== 'string') return []
    const options = Array.isArray(value.options)
      ? value.options.flatMap((option): Array<{ label: string; description?: string }> => {
        if (!isRecord(option) || typeof option.label !== 'string') return []
        return [{
          label: option.label,
          ...(typeof option.description === 'string' ? { description: option.description } : {}),
        }]
      })
      : []
    return [{
      id: firstString(value.id) ?? `q_${index}`,
      prompt: value.question,
      ...(typeof value.header === 'string' ? { header: value.header } : {}),
      options,
      ...(value.multiSelect === true || value.multi_select === true ? { multiSelect: true } : {}),
    }]
  })
}

function extractPlan(input: Record<string, unknown>): string {
  return firstString(input.plan, input.content, input.markdown) ?? ''
}

function summarizeInput(input: Record<string, unknown>): string | undefined {
  try {
    const serialized = JSON.stringify(input)
    return serialized.length > 1_000 ? `${serialized.slice(0, 997)}...` : serialized
  } catch {
    return undefined
  }
}

function resultMetadata(raw: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const metadata: Record<string, unknown> = {}
  for (const key of ['session_id', 'result', 'usage', 'modelUsage', 'total_cost_usd', 'duration_ms', 'duration_api_ms', 'num_turns']) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) metadata[key] = raw[key]
  }
  return metadata
}

function parsePartialJson(value: string): unknown {
  if (value === '') return undefined
  try { return JSON.parse(value) } catch { return value }
}

function metadataBoolean(probe: ExecutionProbeResult, key: string): boolean {
  return probe.metadata?.[key] === true
}

function hasFlag(help: string, flag: string): boolean {
  return new RegExp(`(^|\\s)${escapeRegExp(flag)}(?=\\s|[=,]|$)`, 'm').test(help)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function firstNonEmptyLine(...values: string[]): string | undefined {
  for (const value of values) {
    const line = value.split(/\r?\n/).map((item) => item.trim()).find((item) => item !== '')
    if (line !== undefined) return line
  }
  return undefined
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value !== '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asExecutionError(
  error: unknown,
  code: string,
  prefix: string,
  outcomeUnknown = false,
): ExecutionOperationError {
  if (error instanceof ExecutionOperationError) return error
  return new ExecutionOperationError(code, `${prefix}: ${errorMessage(error)}`, { outcomeUnknown, cause: error })
}

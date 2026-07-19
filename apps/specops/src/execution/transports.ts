import {
  CodeBuddyAcpClient,
  parseFallbackQuestions,
  type AcpAgentCapabilities,
  type CodeBuddyAcpEvent,
  type CodeBuddyAcpOptions,
  type CodeBuddyInterruption,
  type CodeBuddyInterruptionResolution,
} from '../adapters/codebuddy-acp.js'
import {
  CODEX_APP_SERVER_CAPABILITIES,
  CodexAppServerTransport,
  type CodexAppServerTransportOptions,
} from '../adapters/codex-app-server.js'
import {
  CLAUDE_STREAM_JSON_BASE_CAPABILITIES,
  ClaudeStreamJsonTransport,
  type ClaudeStreamJsonOptions,
} from '../adapters/claude-stream-json.js'
import {
  ExecutionOperationError,
  type AgentExecutionTransport,
  type AgentExecutionTransportFactory,
  type ExecutionCancelInput,
  type ExecutionCapability,
  type ExecutionLoadInput,
  type ExecutionProbeResult,
  type ExecutionProcessContext,
  type ExecutionPromptInput,
  type ExecutionResponse,
  type ExecutionSession,
  type ExecutionSetModeInput,
  type ExecutionStartInput,
  type ExecutionTurnResult,
  type TransportEventListener,
  type TransportExecutionEvent,
} from './types.js'

export const UNSUPPORTED_EXECUTION_BACKEND = 'unsupported_execution_backend'

export type BuiltinExecutionTransport =
  | 'codebuddy-acp'
  | 'codex-app-server'
  | 'claude-stream-json'

export interface ExecutionBackendProfile {
  /** Override transport selection while retaining the configured backend key. */
  transport?: BuiltinExecutionTransport
  command?: string
  /** Full adapter argv. Defaults to the native structured-protocol argv. */
  args?: readonly string[]
  /** Additional argv appended after args or the native defaults. */
  extraArgs?: readonly string[]
  /** Defaults used when a start/load request does not select a model or mode. */
  model?: string
  mode?: string
}

export interface CodeBuddyAcpClientLike {
  readonly capabilities: Readonly<AcpAgentCapabilities> | undefined
  readonly stderr: string
  initialize(): Promise<{ protocolVersion: number; agentCapabilities: AcpAgentCapabilities }>
  newSession(cwd: string): Promise<string>
  loadSession(sessionId: string, cwd: string): Promise<string>
  prompt(sessionId: string, text: string): Promise<{ stopReason: string }>
  cancel(sessionId: string, waitForPrompt?: boolean): Promise<unknown>
  setMode(sessionId: string, modeId: string): Promise<void>
  currentMode(sessionId: string): string | undefined
  resolveInterruption(interruption: CodeBuddyInterruption, resolution: CodeBuddyInterruptionResolution): Promise<void>
  close(): Promise<void>
}

export interface ExecutionTransportDependencies {
  createCodeBuddyClient?: (options: CodeBuddyAcpOptions) => CodeBuddyAcpClientLike
  createCodexTransport?: (options: CodexAppServerTransportOptions) => AgentExecutionTransport
  createClaudeTransport?: (options: ClaudeStreamJsonOptions) => AgentExecutionTransport
}

export interface ExecutionTransportRegistration {
  readonly transport: BuiltinExecutionTransport
  readonly capabilities: readonly ExecutionCapability[]
  create(
    context: ExecutionProcessContext,
    profile: ExecutionBackendProfile,
    dependencies: ExecutionTransportDependencies,
  ): AgentExecutionTransport
}

export type ExecutionTransportRegistry = Readonly<Record<string, ExecutionTransportRegistration>>

export interface ExecutionTransportFactoryOptions extends ExecutionTransportDependencies {
  profiles?: Readonly<Record<string, ExecutionBackendProfile>>
  registry?: ExecutionTransportRegistry
}

export const CODEBUDDY_ACP_CAPABILITIES = [
  'session.create',
  'session.prompt',
  'session.interrupt',
  'conversation.permission',
  'conversation.ask',
  'conversation.plan',
  'session.mode',
  'events.tools',
  'output.structured',
  'sandbox.policy',
] as const satisfies readonly ExecutionCapability[]

/** Adapts one CodeBuddy ACP process/session to the transport-neutral contract. */
export class CodeBuddyAcpTransport implements AgentExecutionTransport {
  private readonly client: CodeBuddyAcpClientLike
  private readonly listeners = new Set<TransportEventListener>()
  private readonly pendingInteractions = new Map<string, CodeBuddyInterruption>()
  private nativeSessionId: string | undefined
  private messageSequence = 0
  private activeMessageId: string | undefined
  private activeRequestId: string | undefined
  private activeMessageSegment = 0
  private mode: string | undefined

  constructor(options: CodeBuddyAcpOptions & {
    createClient?: (options: CodeBuddyAcpOptions) => CodeBuddyAcpClientLike
  }) {
    const createClient = options.createClient ?? ((clientOptions) => new CodeBuddyAcpClient(clientOptions))
    this.client = createClient({
      ...options,
      onEvent: (event) => {
        options.onEvent?.(event)
        this.handleEvent(event)
      },
    })
  }

  async probe(): Promise<ExecutionProbeResult> {
    const initialized = await this.client.initialize()
    const capabilities: ExecutionCapability[] = [...CODEBUDDY_ACP_CAPABILITIES]
    if (initialized.agentCapabilities.loadSession === true) capabilities.push('session.resume')
    return {
      transport: 'codebuddy-acp',
      capabilities,
      version: String(initialized.protocolVersion),
      metadata: { protocol: 'acp-stdio' },
    }
  }

  async start(input: ExecutionStartInput): Promise<ExecutionSession> {
    await this.client.initialize()
    this.assertNoSession()
    const sessionId = await this.client.newSession(input.cwd)
    return this.acceptSession(sessionId, input.model, input.mode)
  }

  async load(input: ExecutionLoadInput): Promise<ExecutionSession> {
    await this.client.initialize()
    this.assertNoSession()
    const sessionId = await this.client.loadSession(input.nativeSessionId, input.cwd)
    return this.acceptSession(sessionId, input.model, input.mode)
  }

  async prompt(input: ExecutionPromptInput): Promise<ExecutionTurnResult> {
    const sessionId = this.requireSession()
    this.activeRequestId = input.requestId
    this.activeMessageSegment = 0
    this.activeMessageId = this.segmentMessageId(input.requestId, this.activeMessageSegment)
    try {
      const result = await this.client.prompt(sessionId, input.text)
      const turn = { turnId: input.requestId, stopReason: result.stopReason }
      this.emit({ type: 'turn_completed', ...turn })
      return turn
    } catch (error) {
      this.emit({ type: 'turn_failed', turnId: input.requestId, error: errorMessage(error) })
      throw error
    } finally {
      this.activeMessageId = undefined
      this.activeRequestId = undefined
      this.activeMessageSegment = 0
    }
  }

  async cancel(_input: ExecutionCancelInput): Promise<void> {
    await this.client.cancel(this.requireSession(), false)
  }

  async respond(input: ExecutionResponse): Promise<void> {
    const interruption = this.pendingInteractions.get(input.requestId)
    if (interruption === undefined) {
      throw new ExecutionOperationError('codebuddy_unknown_request', `Unknown CodeBuddy request: ${input.requestId}`)
    }
    if (interruption.kind !== input.kind) {
      throw new ExecutionOperationError(
        'codebuddy_response_kind_mismatch',
        `CodeBuddy request ${input.requestId} expects ${interruption.kind}, not ${input.kind}`,
      )
    }

    let resolution: CodeBuddyInterruptionResolution
    if (input.kind === 'questions') {
      resolution = { decision: 'allow', answers: mutableAnswers(input.answers) }
    } else if (input.kind === 'plan') {
      resolution = input.decision === 'approve'
        ? { decision: 'allow' }
        : { decision: 'deny', ...(input.feedback === undefined ? {} : { feedback: input.feedback }) }
    } else {
      const optionId = input.decision === 'allow' && input.remember === true && interruption.kind === 'permission'
        ? rememberedPermissionOption(interruption.options)
        : undefined
      resolution = {
        decision: input.decision,
        ...(optionId === undefined ? {} : { optionId }),
      }
    }
    await this.client.resolveInterruption(interruption, resolution)
    this.pendingInteractions.delete(input.requestId)
  }

  async setMode(input: ExecutionSetModeInput): Promise<void> {
    const sessionId = this.requireSession()
    await this.client.setMode(sessionId, input.mode)
    this.mode = input.mode
  }

  close(): Promise<void> {
    this.pendingInteractions.clear()
    return this.client.close()
  }

  events(listener: TransportEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async acceptSession(sessionId: string, model: string | undefined, mode: string | undefined): Promise<ExecutionSession> {
    this.nativeSessionId = sessionId
    this.mode = mode ?? this.client.currentMode(sessionId)
    if (mode !== undefined && mode !== '' && mode !== this.client.currentMode(sessionId)) {
      await this.client.setMode(sessionId, mode)
    }
    this.emit({ type: 'status', status: 'session_ready', detail: sessionId })
    return {
      nativeSessionId: sessionId,
      ...(model === undefined ? {} : { model }),
      ...(this.mode === undefined ? {} : { mode: this.mode }),
      metadata: { transport: 'codebuddy-acp' },
    }
  }

  private handleEvent(event: CodeBuddyAcpEvent): void {
    switch (event.type) {
      case 'session_update':
        if (this.belongsToCurrentSession(event.sessionId)) this.handleSessionUpdate(event.sessionId, event.update)
        return
      case 'session_reset':
        if (this.belongsToCurrentSession(event.sessionId)) {
          this.nativeSessionId = event.newSessionId
          this.pendingInteractions.clear()
          if (event.newSessionId !== undefined) {
            this.emit({ type: 'session_identity', nativeSessionId: event.newSessionId })
          }
          this.emit({ type: 'status', status: 'session_reset', ...(event.newSessionId === undefined ? {} : { detail: event.newSessionId }) })
        }
        return
      case 'interruption':
        if (this.belongsToCurrentSession(event.interruption.sessionId)) this.handleInterruption(event.interruption)
        return
      case 'diagnostic':
        this.emit({ type: 'status', status: 'diagnostic', detail: event.message })
        return
      case 'exit':
        this.pendingInteractions.clear()
        this.emit({
          type: 'process_exited',
          code: event.code,
          signal: event.signal,
          ...(event.stderr === '' ? {} : { stderrTail: event.stderr }),
        })
        return
      case 'notification':
        return
    }
  }

  private handleInterruption(interruption: CodeBuddyInterruption): void {
    const requestId = interruption.kind === 'permission'
      ? String(interruption.requestId)
      : interruption.toolCallId
    this.pendingInteractions.set(requestId, interruption)
    if (interruption.kind === 'questions') {
      this.emit({
        type: 'questions',
        requestId,
        questions: interruption.questions.map((question) => ({
          id: question.id,
          prompt: question.question,
          ...(question.header === undefined ? {} : { header: question.header }),
          options: question.options.map((option) => ({ ...option })),
          ...(question.multi_select ? { multiSelect: true } : {}),
        })),
      })
      this.advanceMessageSegment()
      return
    }
    if (interruption.kind === 'plan') {
      this.emit({ type: 'plan', requestId, markdown: interruption.plan })
      this.advanceMessageSegment()
      return
    }
    const description = summarizeValue(interruption.toolCall.rawInput)
    this.emit({
      type: 'permission',
      requestId,
      title: interruption.toolCall.title ?? interruption.toolName,
      ...(description === undefined ? {} : { description }),
      options: interruption.options.map((option) => option.name),
    })
    this.advanceMessageSegment()
  }

  private handleSessionUpdate(sessionId: string, update: Record<string, unknown>): void {
    const kind = firstString(update.sessionUpdate, update.session_update, update.type)
    switch (kind) {
      case 'agent_message_chunk':
      case 'agentMessageChunk':
        this.emitMessageChunk(sessionId, update, 'assistant')
        return
      case 'user_message_chunk':
      case 'userMessageChunk':
        // User prompts are appended durably by the server before dispatch.
        // Ignoring ACP replay chunks avoids duplicate or fragmented user rows.
        return
      case 'tool_call':
      case 'toolCall':
        this.emitToolCall(update)
        return
      case 'tool_call_update':
      case 'toolCallUpdate':
        this.emitToolUpdate(update)
        return
      case 'plan': {
        const requestId = firstString(update.requestId, update.toolCallId, update.id) ?? `plan:${sessionId}`
        const markdown = planMarkdown(update)
        if (markdown !== undefined) {
          this.emit({ type: 'message_upsert', messageId: `plan:${requestId}`, text: markdown, role: 'assistant' })
        }
        return
      }
      case 'current_mode_update':
      case 'currentModeUpdate': {
        const mode = firstString(update.currentModeId, update.modeId)
        if (mode !== undefined) {
          this.mode = mode
          this.emit({ type: 'status', status: 'mode_changed', detail: mode })
        }
        return
      }
      default:
        return
    }
  }

  private emitMessageChunk(sessionId: string, update: Record<string, unknown>, role: 'assistant' | 'user'): void {
    const delta = contentText(update.content) ?? firstString(update.text, update.delta)
    if (delta === undefined) return
    const protocolMessageId = firstString(update.messageId, update.message_id, recordValue(update.content)?.id)
    const messageId = protocolMessageId
      ?? (role === 'assistant' ? this.activeMessageId : undefined)
      ?? `${role}:${sessionId}:${++this.messageSequence}`
    const segmentedMessageId = role === 'assistant' && protocolMessageId !== undefined && this.activeRequestId !== undefined
      ? `${protocolMessageId}:segment:${this.activeMessageSegment + 1}`
      : messageId
    this.emit({ type: 'message_delta', messageId: segmentedMessageId, delta, role })
  }

  private emitToolCall(update: Record<string, unknown>): void {
    const toolCallId = firstString(update.toolCallId, update.tool_call_id, update.id)
    if (toolCallId === undefined) return
    const status = firstString(update.status)
    const name = firstString(update.title, update.name, update.kind) ?? 'tool'
    const input = update.rawInput ?? update.input
    this.emit({
      type: 'tool_call',
      toolCallId,
      name,
      input,
      ...(status === undefined ? {} : { status }),
    })
    // A real AskUserQuestion interruption is emitted through handleInterruption.
    // The generic `tool` shape is the CodeBuddy failure path observed when the
    // CLI agent does not register AskUserQuestion at runtime.
    if (name === 'tool') {
      const questions = parseFallbackQuestions(input)
      if (questions.length > 0) {
        this.emit({ type: 'questions', requestId: toolCallId, questions, responseMode: 'prompt' })
        void this.client.cancel(this.requireSession(), false).catch(() => undefined)
      }
    }
    this.advanceMessageSegment()
  }

  private emitToolUpdate(update: Record<string, unknown>): void {
    const toolCallId = firstString(update.toolCallId, update.tool_call_id, update.id)
    if (toolCallId === undefined) return
    const status = firstString(update.status)
    const terminal = status === 'completed' || status === 'failed' || status === 'cancelled'
    const hasOutput = Object.prototype.hasOwnProperty.call(update, 'rawOutput')
      || Object.prototype.hasOwnProperty.call(update, 'output')
    if (terminal || hasOutput) {
      this.emit({
        type: 'tool_result',
        toolCallId,
        output: update.rawOutput ?? update.output ?? update.content,
        ...(status === 'failed' || status === 'cancelled' ? { isError: true } : {}),
      })
      this.advanceMessageSegment()
      return
    }
    this.emit({
      type: 'tool_call',
      toolCallId,
      name: firstString(update.title, update.name, update.kind) ?? 'tool',
      input: update.rawInput ?? update.input,
      ...(status === undefined ? {} : { status }),
    })
    this.advanceMessageSegment()
  }

  private advanceMessageSegment(): void {
    if (this.activeRequestId === undefined) return
    this.activeMessageSegment += 1
    this.activeMessageId = this.segmentMessageId(this.activeRequestId, this.activeMessageSegment)
  }

  private segmentMessageId(requestId: string, segment: number): string {
    return `assistant:${requestId}:segment:${segment + 1}`
  }

  private belongsToCurrentSession(sessionId: string): boolean {
    return sessionId === '' || this.nativeSessionId === undefined || sessionId === this.nativeSessionId
  }

  private assertNoSession(): void {
    if (this.nativeSessionId !== undefined) {
      throw new ExecutionOperationError('codebuddy_session_exists', 'CodeBuddy transport already owns a session')
    }
  }

  private requireSession(): string {
    if (this.nativeSessionId === undefined) {
      throw new ExecutionOperationError('codebuddy_session_missing', 'CodeBuddy session has not been started or resumed')
    }
    return this.nativeSessionId
  }

  private emit(event: TransportExecutionEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* observers must not break ACP handling */ }
    }
  }
}

class ProfiledExecutionTransport implements AgentExecutionTransport {
  constructor(
    private readonly delegate: AgentExecutionTransport,
    private readonly profile: ExecutionBackendProfile,
    private readonly probeGate?: { backendKey: string; code: string },
  ) {}

  async probe(): Promise<ExecutionProbeResult> {
    try {
      return await this.delegate.probe()
    } catch (error) {
      if (this.probeGate === undefined) throw error
      throw new ExecutionOperationError(
        this.probeGate.code,
        `Backend ${this.probeGate.backendKey} cannot use its structured execution transport: ${errorMessage(error)}`,
        { cause: error },
      )
    }
  }

  start(input: ExecutionStartInput): Promise<ExecutionSession> {
    return this.delegate.start(withProfileDefaults(input, this.profile))
  }

  load(input: ExecutionLoadInput): Promise<ExecutionSession> {
    return this.delegate.load(withProfileDefaults(input, this.profile))
  }

  prompt(input: ExecutionPromptInput): Promise<ExecutionTurnResult> { return this.delegate.prompt(input) }
  cancel(input: ExecutionCancelInput): Promise<void> { return this.delegate.cancel(input) }
  respond(input: ExecutionResponse): Promise<void> { return this.delegate.respond(input) }
  setMode(input: ExecutionSetModeInput): Promise<void> { return this.delegate.setMode(input) }
  close(): Promise<void> { return this.delegate.close() }
  events(listener: TransportEventListener): () => void { return this.delegate.events(listener) }
}

function codeBuddyRegistration(): ExecutionTransportRegistration {
  return {
    transport: 'codebuddy-acp',
    capabilities: CODEBUDDY_ACP_CAPABILITIES,
    create(context, profile, dependencies) {
      const args = adapterArgs(profile, ['--acp'])
      forceArgument(args, '--permission-mode', 'bypassPermissions')
      if (profile.model !== undefined && profile.model !== '' && !hasArgument(args, '--model')) {
        args.push('--model', profile.model)
      }
      return new CodeBuddyAcpTransport({
        cwd: context.cwd,
        ...(profile.command === undefined ? {} : { command: profile.command }),
        args,
        ...(dependencies.createCodeBuddyClient === undefined ? {} : { createClient: dependencies.createCodeBuddyClient }),
      })
    },
  }
}

function codexRegistration(): ExecutionTransportRegistration {
  return {
    transport: 'codex-app-server',
    capabilities: CODEX_APP_SERVER_CAPABILITIES,
    create(context, profile, dependencies) {
      const options: CodexAppServerTransportOptions = {
        cwd: context.cwd,
        ...(profile.command === undefined ? {} : { command: profile.command }),
        args: adapterArgs(profile, ['app-server', '--stdio']),
      }
      return dependencies.createCodexTransport?.(options) ?? new CodexAppServerTransport(options)
    },
  }
}

function claudeRegistration(): ExecutionTransportRegistration {
  return {
    transport: 'claude-stream-json',
    capabilities: CLAUDE_STREAM_JSON_BASE_CAPABILITIES,
    create(_context, profile, dependencies) {
      const options: ClaudeStreamJsonOptions = {
        ...(profile.command === undefined ? {} : { command: profile.command }),
        args: adapterArgs(profile, []),
      }
      return dependencies.createClaudeTransport?.(options) ?? new ClaudeStreamJsonTransport(options)
    },
  }
}

const CODEBUDDY_REGISTRATION = codeBuddyRegistration()
const CODEX_REGISTRATION = codexRegistration()
const CLAUDE_REGISTRATION = claudeRegistration()

export const EXECUTION_TRANSPORT_REGISTRY: ExecutionTransportRegistry = Object.freeze({
  codebuddy: CODEBUDDY_REGISTRATION,
  codex: CODEX_REGISTRATION,
  claude: CLAUDE_REGISTRATION,
  'claude-internal': CLAUDE_REGISTRATION,
})

export function createExecutionTransportRegistry(
  overrides: Readonly<Record<string, ExecutionTransportRegistration>> = {},
): ExecutionTransportRegistry {
  return Object.freeze({ ...EXECUTION_TRANSPORT_REGISTRY, ...overrides })
}

export function hasStructuredExecutionTransport(
  backendKey: string,
  registry: ExecutionTransportRegistry = EXECUTION_TRANSPORT_REGISTRY,
): boolean {
  return registry[backendKey] !== undefined
}

export function executionTransportCapabilities(
  backendKey: string,
  registry: ExecutionTransportRegistry = EXECUTION_TRANSPORT_REGISTRY,
): readonly ExecutionCapability[] {
  return registry[backendKey]?.capabilities ?? []
}

export function createAgentExecutionTransport(
  context: ExecutionProcessContext,
  profile: ExecutionBackendProfile = {},
  options: Omit<ExecutionTransportFactoryOptions, 'profiles'> = {},
): AgentExecutionTransport {
  const registry = options.registry ?? EXECUTION_TRANSPORT_REGISTRY
  const registration = profile.transport === undefined
    ? registry[context.backendKey]
    : Object.values(registry).find((entry) => entry.transport === profile.transport)
  if (registration === undefined) {
    throw new ExecutionOperationError(
      UNSUPPORTED_EXECUTION_BACKEND,
      `Unsupported execution backend: ${context.backendKey}`,
    )
  }

  const requestedProfile: ExecutionBackendProfile = {
    ...profile,
    ...(profile.model === undefined && context.model !== undefined ? { model: context.model } : {}),
    ...(profile.mode === undefined && context.mode !== undefined ? { mode: context.mode } : {}),
  }
  const effectiveProfile = context.backendKey === 'claude-internal' && requestedProfile.command === undefined
    ? { ...requestedProfile, command: 'claude-internal' }
    : requestedProfile
  const dependencies: ExecutionTransportDependencies = {
    ...(options.createCodeBuddyClient === undefined ? {} : { createCodeBuddyClient: options.createCodeBuddyClient }),
    ...(options.createCodexTransport === undefined ? {} : { createCodexTransport: options.createCodexTransport }),
    ...(options.createClaudeTransport === undefined ? {} : { createClaudeTransport: options.createClaudeTransport }),
  }
  const transport = registration.create(context, effectiveProfile, dependencies)
  const needsDefaults = profile.model !== undefined || profile.mode !== undefined
  const internalGate = context.backendKey === 'claude-internal'
    ? { backendKey: context.backendKey, code: 'claude_internal_transport_unavailable' }
    : undefined
  return needsDefaults || internalGate !== undefined
    ? new ProfiledExecutionTransport(transport, profile, internalGate)
    : transport
}

export function createAgentExecutionTransportFactory(
  options: ExecutionTransportFactoryOptions = {},
): AgentExecutionTransportFactory {
  return (context) => createAgentExecutionTransport(
    context,
    options.profiles?.[context.backendKey] ?? {},
    options,
  )
}

/** Short aliases for callers that do not need the longer interface name. */
export const createExecutionTransport = createAgentExecutionTransport
export const createExecutionTransportFactory = createAgentExecutionTransportFactory

function adapterArgs(profile: ExecutionBackendProfile, defaults: readonly string[]): string[] {
  return [...(profile.args ?? defaults), ...(profile.extraArgs ?? [])]
}

function hasArgument(args: readonly string[], name: string): boolean {
  return args.some((argument) => argument === name || argument.startsWith(`${name}=`))
}

/** SpecOps runs are isolated worktree automation, so CodeBuddy must not pause
 * on its terminal permission UI. Normalize both `--flag value` and
 * `--flag=value` forms so profile overrides cannot accidentally re-enable it.
 */
function forceArgument(args: string[], name: string, value: string): void {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const argument = args[index]
    if (argument === name) {
      args.splice(index, 2)
      continue
    }
    if (argument?.startsWith(`${name}=`)) args.splice(index, 1)
  }
  args.push(name, value)
}

function withProfileDefaults<T extends ExecutionStartInput | ExecutionLoadInput>(
  input: T,
  profile: ExecutionBackendProfile,
): T {
  return {
    ...input,
    ...(input.model === undefined && profile.model !== undefined ? { model: profile.model } : {}),
    ...(input.mode === undefined && profile.mode !== undefined ? { mode: profile.mode } : {}),
  }
}

function rememberedPermissionOption(options: readonly { optionId: string; name: string; kind: string }[]): string | undefined {
  return options.find((option) => /session|always/.test(`${option.kind} ${option.name}`.toLowerCase())
    && !/deny|reject|cancel/.test(`${option.kind} ${option.name}`.toLowerCase()))?.optionId
}

function mutableAnswers(
  answers: Readonly<Record<string, string | readonly string[]>>,
): Record<string, string | string[]> {
  return Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, typeof value === 'string' ? value : [...value]]))
}

function planMarkdown(update: Record<string, unknown>): string | undefined {
  const direct = firstString(update.markdown, update.plan, update.content)
  if (direct !== undefined) return direct
  if (!Array.isArray(update.entries)) return undefined
  const lines = update.entries.flatMap((entry): string[] => {
    if (!isRecord(entry)) return []
    const content = firstString(entry.content, entry.text, entry.title)
    if (content === undefined) return []
    const checked = entry.status === 'completed' ? 'x' : ' '
    return [`- [${checked}] ${content}`]
  })
  return lines.length === 0 ? undefined : lines.join('\n')
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  if (Array.isArray(value)) {
    const text = value.map(contentText).filter((entry): entry is string => entry !== undefined).join('')
    return text === '' ? undefined : text
  }
  if (!isRecord(value)) return undefined
  return firstString(value.text, value.content)
}

function summarizeValue(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.length <= 1_000 ? text : `${text.slice(0, 997)}...`
  } catch {
    return undefined
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
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

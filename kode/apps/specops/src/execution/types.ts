export type ExecutionId = string
export type ExecutionRequestId = string

export const EXECUTION_CAPABILITIES = [
  'session.create',
  'session.resume',
  'session.prompt',
  'session.interrupt',
  'conversation.permission',
  'conversation.ask',
  'conversation.plan',
  'session.mode',
  'events.tools',
  'output.structured',
  'sandbox.policy',
  'model.select',
  'usage.metrics',
] as const

export type ExecutionCapability = typeof EXECUTION_CAPABILITIES[number]

export interface ExecutionProbeResult {
  transport: string
  capabilities: readonly ExecutionCapability[]
  version?: string
  metadata?: Readonly<Record<string, unknown>>
}

export interface ExecutionProcessContext {
  executionId: ExecutionId
  processGeneration: number
  backendKey: string
  cwd: string
  model?: string
  mode?: string
}

export interface ExecutionStartInput extends ExecutionProcessContext {
  model?: string
  mode?: string
  metadata?: Readonly<Record<string, unknown>>
}

export interface ExecutionLoadInput extends ExecutionProcessContext {
  nativeSessionId: string
  model?: string
  mode?: string
  metadata?: Readonly<Record<string, unknown>>
}

export interface ExecutionSession {
  nativeSessionId: string | null
  model?: string
  mode?: string
  metadata?: Readonly<Record<string, unknown>>
}

export interface ExecutionPromptInput {
  text: string
  requestId: ExecutionRequestId
  metadata?: Readonly<Record<string, unknown>>
}

export interface ExecutionTurnResult {
  turnId?: string
  stopReason?: string
  metadata?: Readonly<Record<string, unknown>>
}

export interface ExecutionCancelInput {
  requestId: ExecutionRequestId
  reason?: string
}

export type ExecutionResponse =
  | { kind: 'permission'; requestId: ExecutionRequestId; decision: 'allow' | 'deny'; remember?: boolean }
  | { kind: 'questions'; requestId: ExecutionRequestId; answers: Readonly<Record<string, string | readonly string[]>> }
  | { kind: 'plan'; requestId: ExecutionRequestId; decision: 'approve' | 'reject'; feedback?: string }

export interface ExecutionSetModeInput {
  requestId: ExecutionRequestId
  mode: string
}

export interface ExecutionQuestion {
  id: string
  prompt: string
  header?: string
  options: ReadonlyArray<{ label: string; description?: string }>
  multiSelect?: boolean
}

export type TransportExecutionEvent =
  | { type: 'status'; status: string; detail?: string; at?: string }
  | { type: 'session_identity'; nativeSessionId: string; at?: string }
  | { type: 'message_delta'; messageId: string; delta: string; role?: 'assistant' | 'user' | 'system'; at?: string }
  | { type: 'message_upsert'; messageId: string; text: string; role: 'assistant' | 'user' | 'system'; at?: string }
  | { type: 'tool_call'; toolCallId: string; name: string; input?: unknown; status?: string; at?: string }
  | { type: 'tool_result'; toolCallId: string; output?: unknown; isError?: boolean; at?: string }
  | { type: 'permission'; requestId: string; title?: string; description?: string; options?: readonly string[]; at?: string }
  | { type: 'questions'; requestId: string; questions: readonly ExecutionQuestion[]; responseMode?: 'native' | 'prompt'; at?: string }
  | { type: 'plan'; requestId: string; markdown: string; responseMode?: 'native' | 'prompt'; at?: string }
  | { type: 'turn_completed'; turnId?: string; stopReason?: string; at?: string }
  | { type: 'turn_failed'; turnId?: string; error: string; outcomeUnknown?: boolean; at?: string }
  | { type: 'process_exited'; code: number | null; signal: NodeJS.Signals | null; stderrTail?: string; at?: string }

export type ManagedExecutionEvent = TransportExecutionEvent & {
  executionId: ExecutionId
  processGeneration: number
  at: string
}

export type ExecutionEventListener = (event: ManagedExecutionEvent) => void
export type TransportEventListener = (event: TransportExecutionEvent) => void

export interface AgentExecutionTransport {
  probe(): Promise<ExecutionProbeResult>
  start(input: ExecutionStartInput): Promise<ExecutionSession>
  load(input: ExecutionLoadInput): Promise<ExecutionSession>
  prompt(input: ExecutionPromptInput): Promise<ExecutionTurnResult>
  cancel(input: ExecutionCancelInput): Promise<void>
  respond(input: ExecutionResponse): Promise<void>
  setMode(input: ExecutionSetModeInput): Promise<void>
  close(): Promise<void>
  events(listener: TransportEventListener): () => void
}

export type AgentExecutionTransportFactory = (
  context: ExecutionProcessContext,
) => AgentExecutionTransport | Promise<AgentExecutionTransport>

export class ExecutionOperationError extends Error {
  readonly code: string
  readonly outcomeUnknown: boolean

  constructor(code: string, message: string, options: { outcomeUnknown?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ExecutionOperationError'
    this.code = code
    this.outcomeUnknown = options.outcomeUnknown ?? false
  }
}

export function isOutcomeUnknownError(error: unknown): boolean {
  return error instanceof ExecutionOperationError && error.outcomeUnknown
}

export type ExecutionRequestOutcome<T> =
  | { outcome: 'completed'; value: T }
  | { outcome: 'outcome_unknown'; error: ExecutionOperationError }

export interface ManagedExecution {
  executionId: ExecutionId
  processGeneration: number
  backendKey: string
  cwd: string
  transport: string
  capabilities: readonly ExecutionCapability[]
  nativeSessionId: string | null
  status: 'starting' | 'ready' | 'exited' | 'closed'
}

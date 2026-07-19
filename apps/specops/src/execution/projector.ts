import {
  findSessionAgent,
  updateSpecOpsSession,
  type AgentPurpose,
  type ExecutionIdentity,
  type SpecOpsSessionRecord,
  type TranscriptEntry,
} from '../domain/session.js'
import { specOpsSessionEvents, type SpecOpsSessionEventType } from '../domain/session-events.js'
import { enqueueInteraction as enqueueDurableInteraction, type DurableInteractionKind, type EnqueueInteractionInput } from '../domain/interactions.js'
import { setClarificationSubstate } from '../domain/workflow-state.js'
import type { ClarificationSubstate } from '../domain/clarify.js'
import type {
  ExecutionEventListener,
  ExecutionId,
  ManagedExecution,
  ManagedExecutionEvent,
} from './types.js'

export interface ExecutionEventSource {
  events(listener: ExecutionEventListener): () => void
  get(executionId: ExecutionId): ManagedExecution | undefined
}

export interface ExecutionProjectionBinding {
  workspace: string
  sessionId: string
  identity: ExecutionIdentity
  purpose: AgentPurpose
  model?: string | null
  runId?: string | null
}

export interface ExecutionProjectorOptions {
  coalesceMs?: number
  persistRunExecution?: (
    binding: ExecutionProjectionBinding,
    identity: ExecutionIdentity | null,
  ) => Promise<void>
  onError?: (error: unknown) => void
  publish?: (type: SpecOpsSessionEventType, sessionId: string, payload?: unknown) => void
}

export interface RealtimeTranscriptEntry extends TranscriptEntry {
  entry_id: string
  revision: number
  final: boolean
}

export interface RealtimeTranscriptPayload {
  session_id: string
  execution_id: string
  generation: number
  process_generation: number
  sequence: number
  entry_id: string
  revision: number
  final: boolean
  entry: RealtimeTranscriptEntry
  delta?: string
}

interface PendingMessageDelta {
  messageId: string
  role: 'assistant' | 'user' | 'system'
  delta: string
  at: string
}

interface ProjectionState {
  binding: ExecutionProjectionBinding
  sequence: number
  entries: Map<string, RealtimeTranscriptEntry>
  pending: Map<string, PendingMessageDelta>
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Projects normalized execution events into durable SpecOps session state and realtime events. */
export class ExecutionProjector {
  private readonly coalesceMs: number
  private readonly persistRunExecution: NonNullable<ExecutionProjectorOptions['persistRunExecution']> | undefined
  private readonly onError: NonNullable<ExecutionProjectorOptions['onError']>
  private readonly publishEvent: NonNullable<ExecutionProjectorOptions['publish']>
  private readonly states = new Map<ExecutionId, ProjectionState>()
  private readonly unsubscribe: () => void
  private tail: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(source: ExecutionEventSource, options: ExecutionProjectorOptions = {}) {
    this.coalesceMs = options.coalesceMs ?? 24
    this.persistRunExecution = options.persistRunExecution
    this.onError = options.onError ?? (() => undefined)
    this.publishEvent = options.publish ?? ((type, sessionId, payload) => {
      specOpsSessionEvents.publish(type, sessionId, payload)
    })
    this.unsubscribe = source.events((event) => {
      if (this.stopped) return
      void this.enqueue(() => this.project(event)).catch(this.onError)
    })
  }

  bind(binding: ExecutionProjectionBinding): Promise<void> {
    return this.enqueue(async () => {
      const existing = this.states.get(binding.identity.execution_id)
      if (existing !== undefined) {
        await this.flushState(existing)
        await this.finalizeOpenMessages(existing)
        this.clearTimer(existing)
      }
      for (const [executionId, state] of this.states) {
        if (state.binding.sessionId !== binding.sessionId || executionId === binding.identity.execution_id) continue
        await this.flushState(state)
        await this.finalizeOpenMessages(state)
        await this.detach(state, 'replaced', null)
        this.clearTimer(state)
        this.states.delete(executionId)
      }
      const state: ProjectionState = {
        binding,
        sequence: 0,
        entries: new Map(),
        pending: new Map(),
        timer: undefined,
      }
      this.states.set(binding.identity.execution_id, state)
      await updateSpecOpsSession(binding.workspace, binding.sessionId, (record) => {
        record.current_execution = binding.identity
        record.backend_key = binding.identity.backend_key
        record.state = 'active'
        record.execution.last_error = null
        const agent = findSessionAgent(record.agents, { execution_id: binding.identity.execution_id })
        if (agent === undefined) {
          record.agents.push({
            execution_id: binding.identity.execution_id,
            transport: binding.identity.transport,
            native_session_id: binding.identity.native_session_id,
            process_generation: binding.identity.process_generation,
            kode_session_id: null,
            session_uuid: binding.identity.native_session_id,
            backend_key: binding.identity.backend_key,
            model: binding.model ?? null,
            purpose: binding.purpose,
            status: 'ready',
            started_at: new Date().toISOString(),
            ended_at: null,
            transcript_cursor: 0,
          })
        } else {
          agent.transport = binding.identity.transport
          agent.native_session_id = binding.identity.native_session_id
          agent.process_generation = binding.identity.process_generation
          agent.backend_key = binding.identity.backend_key
          agent.model = binding.model ?? agent.model
          agent.purpose = binding.purpose
          agent.status = 'ready'
          agent.ended_at = null
        }
        for (const entry of record.transcript) {
          if (!isRealtimeEntry(entry) || entry.execution_id !== binding.identity.execution_id) continue
          state.entries.set(entry.entry_id, { ...entry })
        }
      })
      await this.persistRunExecution?.(binding, binding.identity)
      this.publishEvent('session.updated', binding.sessionId, identityPayload(binding))
    })
  }

  flush(executionId?: ExecutionId): Promise<void> {
    return this.enqueue(async () => {
      if (executionId !== undefined) {
        const state = this.states.get(executionId)
        if (state !== undefined) await this.flushState(state)
        return
      }
      for (const state of this.states.values()) await this.flushState(state)
    })
  }

  closeBinding(executionId: ExecutionId, status = 'closed'): Promise<void> {
    return this.enqueue(async () => {
      const state = this.states.get(executionId)
      if (state === undefined) return
      await this.flushState(state)
      await this.finalizeOpenMessages(state)
      await this.detach(state, status, null)
      this.clearTimer(state)
      this.states.delete(executionId)
    })
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return this.tail
    this.stopped = true
    this.unsubscribe()
    await this.tail
    for (const state of [...this.states.values()]) {
      await this.flushState(state)
      await this.finalizeOpenMessages(state)
      await this.detach(state, 'closed', null)
      this.clearTimer(state)
    }
    this.states.clear()
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation, operation)
    // Keep the queue alive after a failed projection. The call site that owns
    // the operation reports the error exactly once; reporting here as well
    // caused every event failure to be logged twice.
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private async project(event: ManagedExecutionEvent): Promise<void> {
    const state = this.states.get(event.executionId)
    if (state === undefined || state.binding.identity.process_generation !== event.processGeneration) return
    if (event.type === 'message_delta') {
      const entryId = messageEntryId(event.executionId, event.messageId)
      const pending = state.pending.get(entryId)
      if (pending === undefined) {
        state.pending.set(entryId, {
          messageId: event.messageId,
          role: event.role ?? 'assistant',
          delta: event.delta,
          at: event.at,
        })
      } else {
        pending.delta += event.delta
        pending.at = event.at
      }
      this.scheduleFlush(state)
      return
    }

    await this.flushState(state)
    switch (event.type) {
      case 'message_upsert':
        {
        const plan = extractSpecOpsPlan(event.text)
        await this.upsertEntry(state, {
          entry_id: messageEntryId(event.executionId, event.messageId),
          revision: this.nextRevision(state, messageEntryId(event.executionId, event.messageId)),
          final: true,
          role: transcriptRole(event.role),
          text: plan?.visibleText ?? event.text,
          at: event.at,
          execution_id: event.executionId,
          kode_session_id: null,
          kind: 'text',
        })
        if (plan !== null) {
          await this.enqueueAction(state, {
            kind: 'plan_review',
            source: 'agent',
            idempotency_key: `execution:${event.executionId}:${event.processGeneration}:prompt-plan:${event.messageId}`,
            created_at: event.at,
            payload: {
              request_id: `prompt-plan:${event.messageId}`,
              plan_id: `prompt-plan:${event.messageId}`,
              markdown: plan.markdown,
              generation: event.processGeneration,
              response_mode: 'prompt',
            },
          }, 'plan_review')
        }
        return
        }
      case 'tool_call': {
        const entryId = toolEntryId(event.executionId, event.toolCallId, 'call')
        const summary = preview(event.input)
        await this.upsertEntry(state, {
          entry_id: entryId,
          revision: this.nextRevision(state, entryId),
          final: isTerminalToolStatus(event.status),
          role: 'agent',
          text: '',
          at: event.at,
          execution_id: event.executionId,
          kode_session_id: null,
          kind: 'tool_use',
          tool: event.name,
          tool_call_id: event.toolCallId,
          ...(summary === undefined ? {} : { summary }),
          status: toolStatus(event.status),
        })
        return
      }
      case 'tool_result': {
        const callId = toolEntryId(event.executionId, event.toolCallId, 'call')
        const call = state.entries.get(callId)
        if (call !== undefined && !call.final) {
          await this.upsertEntry(state, { ...call, revision: call.revision + 1, final: true, status: event.isError === true ? 'error' : 'ok' })
        }
        const entryId = toolEntryId(event.executionId, event.toolCallId, 'result')
        const outputPreview = preview(event.output)
        await this.upsertEntry(state, {
          entry_id: entryId,
          revision: this.nextRevision(state, entryId),
          final: true,
          role: 'agent',
          text: '',
          at: event.at,
          execution_id: event.executionId,
          kode_session_id: null,
          kind: 'tool_result',
          tool_call_id: event.toolCallId,
          ...(outputPreview === undefined ? {} : { preview: outputPreview }),
          status: event.isError === true ? 'error' : 'ok',
        })
        return
      }
      case 'questions':
        await this.projectQuestions(state, event)
        return
      case 'plan':
        // ExitPlanMode is still a pending agent request here. Keep the durable
        // workflow in Clarify until the user explicitly approves the plan;
        // otherwise the UI claims that Plan mode ended before the response is
        // delivered to the transport.
        await this.enqueueAction(state, {
          kind: 'plan_review',
          source: 'agent',
          idempotency_key: `execution:${event.executionId}:${event.processGeneration}:plan:${event.requestId}`,
          created_at: event.at,
          payload: {
            request_id: event.requestId,
            plan_id: event.requestId,
            markdown: event.markdown,
            generation: event.processGeneration,
            response_mode: event.responseMode ?? 'native',
          },
        }, 'plan_review')
        return
      case 'permission':
        await this.enqueueAction(state, {
          kind: 'permission',
          source: 'agent',
          idempotency_key: `execution:${event.executionId}:${event.processGeneration}:permission:${event.requestId}`,
          created_at: event.at,
          payload: {
            request_id: event.requestId,
            title: event.title ?? 'Permission required',
            message: event.description ?? 'The agent requires permission to continue.',
            options: permissionOptions(event.options),
          },
        })
        return
      case 'session_identity':
        state.binding.identity.native_session_id = event.nativeSessionId
        await this.updateSession(state, (record) => {
          if (record.current_execution?.execution_id === event.executionId) {
            record.current_execution.native_session_id = event.nativeSessionId
          }
          const agent = findSessionAgent(record.agents, { execution_id: event.executionId })
          if (agent !== undefined) {
            agent.native_session_id = event.nativeSessionId
            agent.session_uuid = event.nativeSessionId
          }
        })
        await this.persistRunExecution?.(state.binding, state.binding.identity)
        this.publishEvent('session.updated', state.binding.sessionId, identityPayload(state.binding))
        return
      case 'status':
        await this.updateStatus(state, event.status, event.detail ?? null)
        return
      case 'turn_completed':
        await this.finalizeOpenMessages(state)
        await this.updateSession(state, (record) => {
          if (event.turnId !== undefined) record.clarification!.active_turn_id = event.turnId
        })
        await this.updateStatus(state, 'ready', null)
        return
      case 'turn_failed': {
        await this.finalizeOpenMessages(state)
        const entryId = `${event.executionId}:turn:${event.turnId ?? 'current'}:failure`
        await this.upsertEntry(state, {
          entry_id: entryId,
          revision: this.nextRevision(state, entryId),
          final: true,
          role: 'system',
          text: event.error,
          at: event.at,
          execution_id: event.executionId,
          kode_session_id: null,
          kind: 'text',
        })
        await this.updateStatus(state, 'failed', event.error)
        return
      }
      case 'process_exited': {
        await this.finalizeOpenMessages(state)
        const error = event.code === 0 && event.signal === null
          ? null
          : event.stderrTail ?? `Execution exited with ${event.signal ?? `code ${event.code ?? 'unknown'}`}`
        await this.detach(state, error === null ? 'exited' : 'failed', error)
        this.clearTimer(state)
        this.states.delete(event.executionId)
        return
      }
    }
  }

  private async projectQuestions(
    state: ProjectionState,
    event: Extract<ManagedExecutionEvent, { type: 'questions' }>,
  ): Promise<void> {
    const questions = event.questions.map((question) => ({
      question_id: question.id,
      prompt: question.prompt,
      ...(question.header === undefined ? {} : { header: question.header }),
      options: question.options.map((option, index) => ({ id: `option_${index + 1}`, ...option })),
      ...(question.multiSelect === undefined ? {} : { multi_select: question.multiSelect }),
    }))
    const first = questions[0]
    // Questions are rendered from the durable interaction as selectable UI.
    // Duplicating them into one synthesized assistant message both loses the
    // tool boundary and makes the user think a free-form reply is expected.
    await this.enqueueAction(state, {
      kind: 'questions',
      source: 'agent',
      idempotency_key: `execution:${event.executionId}:${event.processGeneration}:questions:${event.requestId}`,
      created_at: event.at,
      payload: {
        request_id: event.requestId,
        prompt: first?.prompt ?? 'Input required',
        questions: questions.map((question) => ({
          id: question.question_id,
          prompt: question.prompt,
          ...(question.header === undefined ? {} : { header: question.header }),
          options: question.options.map((option, index) => ({
            id: option.id ?? `option_${index + 1}`,
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
          multi_select: question.multi_select === true,
        })),
        response_mode: event.responseMode ?? 'native',
      },
    }, 'qa_pending')
  }

  private async enqueueAction<Kind extends DurableInteractionKind>(
    state: ProjectionState,
    input: EnqueueInteractionInput<Kind>,
    clarificationSubstate?: ClarificationSubstate,
  ): Promise<void> {
    let actionRequired = false
    let action: SpecOpsSessionRecord['required_action'] = null
    await this.updateSession(state, (record) => {
      const interaction = enqueueDurableInteraction(record, input, input.created_at)
      if (clarificationSubstate !== undefined) {
        setClarificationSubstate(record, clarificationSubstate, 'request_id' in input.payload ? input.payload.request_id : undefined)
      }
      record.state = 'awaiting_user'
      action = record.required_action
      actionRequired = action?.interaction_id === interaction.id
    })
    if (actionRequired) this.publishEvent('session.action_required', state.binding.sessionId, action)
  }

  private async updateStatus(state: ProjectionState, status: string, error: string | null): Promise<void> {
    const applied = await this.updateSession(state, (record) => {
      const agent = findSessionAgent(record.agents, { execution_id: state.binding.identity.execution_id })
      if (agent !== undefined) agent.status = status
      record.execution.last_error = error
      if (status === 'failed') record.state = 'failed'
      else if (record.state !== 'awaiting_user') record.state = 'active'
    })
    if (applied) this.publishEvent('session.status_changed', state.binding.sessionId, {
      ...identityPayload(state.binding),
      status,
      error,
    })
  }

  private async detach(state: ProjectionState, status: string, error: string | null): Promise<void> {
    const applied = await this.updateSession(state, (record) => {
      record.current_execution = null
      const agent = findSessionAgent(record.agents, { execution_id: state.binding.identity.execution_id })
      if (agent !== undefined) {
        agent.status = status
        agent.ended_at ??= new Date().toISOString()
      }
      record.execution.last_error = error
      if (status === 'failed') record.state = 'failed'
    })
    if (!applied) return
    // A detached process is no longer live, but its native identity remains the
    // durable resume handle for the next process generation.
    await this.persistRunExecution?.(state.binding, state.binding.identity)
    this.publishEvent('session.status_changed', state.binding.sessionId, {
      ...identityPayload(state.binding),
      status,
      error,
    })
  }

  private async flushState(state: ProjectionState): Promise<void> {
    this.clearTimer(state)
    if (state.pending.size === 0) return
    const pending = [...state.pending.entries()]
    state.pending.clear()
    for (const [entryId, delta] of pending) {
      const previous = state.entries.get(entryId)
      const entry: RealtimeTranscriptEntry = {
        entry_id: entryId,
        revision: (previous?.revision ?? 0) + 1,
        final: false,
        role: transcriptRole(delta.role),
        text: `${previous?.text ?? ''}${delta.delta}`,
        at: delta.at,
        execution_id: state.binding.identity.execution_id,
        kode_session_id: null,
        kind: 'text',
      }
      if (await this.persistEntry(state, entry)) {
        this.publishTranscript('session.transcript_delta', state, entry, delta.delta)
      }
    }
  }

  private async finalizeOpenMessages(state: ProjectionState): Promise<void> {
    for (const entry of [...state.entries.values()]) {
      if (entry.kind !== 'text' || entry.final) continue
      await this.upsertEntry(state, { ...entry, revision: entry.revision + 1, final: true })
    }
  }

  private async upsertEntry(state: ProjectionState, entry: RealtimeTranscriptEntry): Promise<void> {
    if (await this.persistEntry(state, entry)) {
      this.publishTranscript('session.transcript_upsert', state, entry)
    }
  }

  private async persistEntry(state: ProjectionState, entry: RealtimeTranscriptEntry): Promise<boolean> {
    const applied = await this.updateSession(state, (record) => {
      const transcript = record.transcript as Array<TranscriptEntry & Partial<RealtimeTranscriptEntry>>
      const index = transcript.findIndex((candidate) => candidate.entry_id === entry.entry_id)
      if (index === -1) transcript.push(entry)
      else transcript[index] = entry
    })
    if (applied) state.entries.set(entry.entry_id, entry)
    return applied
  }

  private publishTranscript(
    type: 'session.transcript_delta' | 'session.transcript_upsert',
    state: ProjectionState,
    entry: RealtimeTranscriptEntry,
    delta?: string,
  ): void {
    const payload: RealtimeTranscriptPayload = {
      session_id: state.binding.sessionId,
      execution_id: state.binding.identity.execution_id,
      generation: state.binding.identity.process_generation,
      process_generation: state.binding.identity.process_generation,
      sequence: ++state.sequence,
      entry_id: entry.entry_id,
      revision: entry.revision,
      final: entry.final,
      entry,
      ...(delta === undefined ? {} : { delta }),
    }
    this.publishEvent(type, state.binding.sessionId, payload)
  }

  private async updateSession(
    state: ProjectionState,
    update: (record: SpecOpsSessionRecord) => void,
  ): Promise<boolean> {
    let applied = false
    await updateSpecOpsSession(state.binding.workspace, state.binding.sessionId, (record) => {
      if (!sameIdentity(record.current_execution, state.binding.identity)) return
      update(record)
      applied = true
    })
    return applied
  }

  private nextRevision(state: ProjectionState, entryId: string): number {
    return (state.entries.get(entryId)?.revision ?? 0) + 1
  }

  private scheduleFlush(state: ProjectionState): void {
    if (state.timer !== undefined) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      if (this.stopped) return
      void this.enqueue(() => this.flushState(state)).catch(this.onError)
    }, this.coalesceMs)
  }

  private clearTimer(state: ProjectionState): void {
    if (state.timer === undefined) return
    clearTimeout(state.timer)
    state.timer = undefined
  }
}

const SPECOPS_PLAN_PATTERN = /<!--\s*specops:plan\s*-->([\s\S]*?)<!--\s*\/specops:plan\s*-->/i

export function extractSpecOpsPlan(text: string): { markdown: string; visibleText: string } | null {
  const match = SPECOPS_PLAN_PATTERN.exec(text)
  const markdown = match?.[1]?.trim()
  if (match === null || markdown === undefined || markdown === '') return null
  return {
    markdown,
    visibleText: text.replace(match[0], markdown).trim(),
  }
}

function identityPayload(binding: ExecutionProjectionBinding): Record<string, unknown> {
  return {
    session_id: binding.sessionId,
    execution_id: binding.identity.execution_id,
    generation: binding.identity.process_generation,
    process_generation: binding.identity.process_generation,
  }
}

function sameIdentity(left: ExecutionIdentity | null, right: ExecutionIdentity): boolean {
  return left?.execution_id === right.execution_id && left.process_generation === right.process_generation
}

function isRealtimeEntry(entry: TranscriptEntry): entry is RealtimeTranscriptEntry {
  const candidate = entry as Partial<RealtimeTranscriptEntry>
  return typeof candidate.entry_id === 'string'
    && typeof candidate.revision === 'number'
    && typeof candidate.final === 'boolean'
}

function transcriptRole(role: 'assistant' | 'user' | 'system'): TranscriptEntry['role'] {
  return role === 'assistant' ? 'agent' : role
}

function messageEntryId(executionId: string, messageId: string): string {
  return `${executionId}:message:${messageId}`
}

function toolEntryId(executionId: string, toolCallId: string, kind: 'call' | 'result'): string {
  return `${executionId}:tool:${toolCallId}:${kind}`
}

function preview(value: unknown): string | undefined {
  if (value === undefined) return undefined
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return undefined
  }
  return text.length <= 4_000 ? text : `${text.slice(0, 3_997)}...`
}

function toolStatus(status: string | undefined): 'running' | 'ok' | 'error' {
  if (status === 'failed' || status === 'cancelled' || status === 'error') return 'error'
  if (isTerminalToolStatus(status)) return 'ok'
  return 'running'
}

function isTerminalToolStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'error' || status === 'ok'
}

function permissionOptions(options: readonly string[] | undefined): Array<{ id: string; label: string }> {
  if (options === undefined || options.length === 0) {
    return [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }]
  }
  return options.map((label, index) => ({ id: permissionOptionId(label, index), label }))
}

function permissionOptionId(label: string, index: number): string {
  const normalized = label.toLowerCase()
  if (/deny|reject|cancel/.test(normalized)) return 'deny'
  if (/session|always|remember/.test(normalized)) return 'allow_remember'
  if (/allow|approve/.test(normalized)) return 'allow'
  return `option_${index + 1}`
}

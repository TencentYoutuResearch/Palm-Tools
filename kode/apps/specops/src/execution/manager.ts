import { randomUUID } from 'node:crypto'

import { capabilityForResponse, requireCapability, requireOperationCapability } from './capabilities.js'
import {
  ExecutionOperationError,
  isOutcomeUnknownError,
  type AgentExecutionTransport,
  type AgentExecutionTransportFactory,
  type ExecutionCapability,
  type ExecutionCancelInput,
  type ExecutionEventListener,
  type ExecutionId,
  type ExecutionLoadInput,
  type ExecutionProbeResult,
  type ExecutionPromptInput,
  type ExecutionRequestOutcome,
  type ExecutionResponse,
  type ExecutionSession,
  type ExecutionSetModeInput,
  type ExecutionStartInput,
  type ExecutionTurnResult,
  type ManagedExecution,
  type ManagedExecutionEvent,
  type TransportExecutionEvent,
} from './types.js'

export interface ExecutionManagerStartInput {
  requestId?: string
  backendKey: string
  cwd: string
  model?: string
  mode?: string
  metadata?: Readonly<Record<string, unknown>>
}

export interface ExecutionManagerLoadInput extends ExecutionManagerStartInput {
  executionId: ExecutionId
  nativeSessionId: string
}

interface IdempotentRequest {
  signature: string
  promise: Promise<unknown>
}

interface ExecutionRecord {
  executionId: ExecutionId
  processGeneration: number
  backendKey: string
  cwd: string
  transport: AgentExecutionTransport
  probe: ExecutionProbeResult
  session: ExecutionSession
  status: ManagedExecution['status']
  unsubscribe: () => void
  promptTail: Promise<void>
  requests: Map<string, IdempotentRequest>
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
  return `{${entries.join(',')}}`
}

function operationError(error: unknown, fallbackCode: string): ExecutionOperationError {
  if (error instanceof ExecutionOperationError) return error
  return new ExecutionOperationError(
    fallbackCode,
    error instanceof Error ? error.message : String(error),
    { cause: error },
  )
}

/** Owns stable execution identities while transports and process generations come and go. */
export class ExecutionManager {
  private readonly factory: AgentExecutionTransportFactory
  private readonly executions = new Map<ExecutionId, ExecutionRecord>()
  private readonly generations = new Map<ExecutionId, number>()
  private readonly listeners = new Set<ExecutionEventListener>()
  private readonly lifecycleRequests = new Map<string, IdempotentRequest>()
  private readonly lifecycleTails = new Map<ExecutionId, Promise<void>>()
  private readonly opening = new Set<Promise<ManagedExecution>>()
  private shuttingDown = false
  private shutdownPromise: Promise<void> | undefined

  constructor(factory: AgentExecutionTransportFactory) {
    this.factory = factory
  }

  events(listener: ExecutionEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get(executionId: ExecutionId): ManagedExecution | undefined {
    const record = this.executions.get(executionId)
    return record === undefined ? undefined : this.snapshot(record)
  }

  list(): ManagedExecution[] {
    return [...this.executions.values()].map((record) => this.snapshot(record))
  }

  start(input: ExecutionManagerStartInput): Promise<ManagedExecution> {
    this.assertRunning()
    const signature = `start:${stableSerialize(input)}`
    return this.idempotentLifecycle(input.requestId, signature, () => {
      const executionId = randomUUID()
      return this.trackOpening(this.open(executionId, 'start', input))
    })
  }

  load(input: ExecutionManagerLoadInput): Promise<ManagedExecution> {
    this.assertRunning()
    const signature = `load:${stableSerialize(input)}`
    return this.idempotentLifecycle(input.requestId, signature, () => this.trackOpening(
      this.enqueueLifecycle(input.executionId, () => this.open(input.executionId, 'load', input)),
    ))
  }

  prompt(executionId: ExecutionId, input: ExecutionPromptInput): Promise<ExecutionRequestOutcome<ExecutionTurnResult>> {
    const record = this.requireRecord(executionId)
    requireOperationCapability(record.probe, 'prompt')
    return this.idempotentRecord(record, input.requestId, `prompt:${stableSerialize(input)}`, () => {
      const generation = record.processGeneration
      const operation = record.promptTail.then(async (): Promise<ExecutionRequestOutcome<ExecutionTurnResult>> => {
        this.requireCurrent(record, generation)
        // Publish a transport-neutral busy edge before dispatching the prompt.
        // Some backends emit turn_started, others only stream message/tool
        // frames, so the UI cannot otherwise reliably distinguish an attached
        // but idle agent from one that is actively handling a user turn.
        this.emitManaged(record, { type: 'status', status: 'running' })
        try {
          const value = await record.transport.prompt(input)
          this.requireCurrent(record, generation)
          // Do not require every backend adapter to publish its own terminal
          // turn event just to clear the shared busy indicator.
          this.emitManaged(record, { type: 'status', status: 'ready' })
          return { outcome: 'completed', value }
        } catch (error) {
          if (!isOutcomeUnknownError(error)) throw operationError(error, 'execution_prompt_failed')
          const unknown = operationError(error, 'outcome_unknown')
          this.emitManaged(record, {
            type: 'turn_failed',
            error: unknown.message,
            outcomeUnknown: true,
          })
          return { outcome: 'outcome_unknown', error: unknown }
        }
      })
      record.promptTail = operation.then(() => undefined, () => undefined)
      return operation
    })
  }

  cancel(executionId: ExecutionId, input: ExecutionCancelInput): Promise<ExecutionRequestOutcome<void>> {
    const record = this.requireRecord(executionId)
    requireOperationCapability(record.probe, 'cancel')
    return this.idempotentRecord(
      record,
      input.requestId,
      `cancel:${stableSerialize(input)}`,
      () => this.commandOutcome(record, () => record.transport.cancel(input), 'execution_cancel_failed'),
    )
  }

  respond(executionId: ExecutionId, input: ExecutionResponse): Promise<ExecutionRequestOutcome<void>> {
    const record = this.requireRecord(executionId)
    requireCapability(record.probe, capabilityForResponse(input))
    return this.idempotentRecord(
      record,
      input.requestId,
      `respond:${stableSerialize(input)}`,
      () => this.commandOutcome(record, () => record.transport.respond(input), 'execution_respond_failed'),
    )
  }

  setMode(executionId: ExecutionId, input: ExecutionSetModeInput): Promise<ExecutionRequestOutcome<void>> {
    const record = this.requireRecord(executionId)
    requireOperationCapability(record.probe, 'setMode')
    return this.idempotentRecord(
      record,
      input.requestId,
      `setMode:${stableSerialize(input)}`,
      () => this.commandOutcome(record, () => record.transport.setMode(input), 'execution_set_mode_failed'),
    )
  }

  async close(executionId: ExecutionId): Promise<void> {
    const record = this.executions.get(executionId)
    if (record === undefined) return
    if (this.executions.get(executionId) === record) this.executions.delete(executionId)
    record.status = 'closed'
    record.unsubscribe()
    await record.transport.close()
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise
    this.shuttingDown = true
    const records = [...this.executions.values()]
    this.executions.clear()
    const closeInitial = this.closeRecords(records)
    const opening = [...this.opening]
    this.shutdownPromise = (async () => {
      await Promise.allSettled([closeInitial, ...opening])
      const lateRecords = [...this.executions.values()]
      this.executions.clear()
      await this.closeRecords(lateRecords)
    })()
    return this.shutdownPromise
  }

  private async closeRecords(records: ExecutionRecord[]): Promise<void> {
    for (const record of records) {
      record.status = 'closed'
      record.unsubscribe()
    }
    await Promise.allSettled(records.map((record) => record.transport.close()))
  }

  private trackOpening(promise: Promise<ManagedExecution>): Promise<ManagedExecution> {
    this.opening.add(promise)
    void promise.then(
      () => this.opening.delete(promise),
      () => this.opening.delete(promise),
    )
    return promise
  }

  private enqueueLifecycle<T>(executionId: ExecutionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTails.get(executionId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.lifecycleTails.set(executionId, tail)
    void tail.then(() => {
      if (this.lifecycleTails.get(executionId) === tail) this.lifecycleTails.delete(executionId)
    })
    return result
  }

  private async open(
    executionId: ExecutionId,
    operation: 'start' | 'load',
    input: ExecutionManagerStartInput | ExecutionManagerLoadInput,
  ): Promise<ManagedExecution> {
    this.assertRunning()
    const previous = this.executions.get(executionId)
    const generation = (this.generations.get(executionId) ?? 0) + 1
    this.generations.set(executionId, generation)
    if (previous !== undefined) {
      this.executions.delete(executionId)
      previous.status = 'closed'
      previous.unsubscribe()
      await previous.transport.close()
    }

    const context = {
      executionId,
      processGeneration: generation,
      backendKey: input.backendKey,
      cwd: input.cwd,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    }
    const transport = await this.factory(context)
    let unsubscribe = (): void => undefined
    const placeholderSession: ExecutionSession = { nativeSessionId: null }
    const record: ExecutionRecord = {
      ...context,
      transport,
      probe: { transport: 'unprobed', capabilities: [] },
      session: placeholderSession,
      status: 'ready',
      unsubscribe,
      promptTail: Promise.resolve(),
      requests: new Map(),
    }
    unsubscribe = transport.events((event) => this.forwardTransportEvent(record, generation, event))
    record.unsubscribe = unsubscribe
    this.executions.set(executionId, record)

    try {
      const probe = await transport.probe()
      record.probe = { ...probe, capabilities: [...new Set(probe.capabilities)] }
      requireOperationCapability(record.probe, operation)
      this.requireCurrent(record, generation)
      const common = {
        ...context,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      }
      record.session = operation === 'start'
        ? await transport.start(common satisfies ExecutionStartInput)
        : await transport.load({
          ...common,
          nativeSessionId: (input as ExecutionManagerLoadInput).nativeSessionId,
        } satisfies ExecutionLoadInput)
      this.requireCurrent(record, generation)
      this.emitManaged(record, { type: 'status', status: 'ready' })
      return this.snapshot(record)
    } catch (error) {
      if (this.executions.get(executionId) === record) this.executions.delete(executionId)
      record.status = 'closed'
      record.unsubscribe()
      await transport.close().catch(() => undefined)
      throw operationError(error, `execution_${operation}_failed`)
    }
  }

  private async commandOutcome(
    record: ExecutionRecord,
    command: () => Promise<void>,
    fallbackCode: string,
  ): Promise<ExecutionRequestOutcome<void>> {
    const generation = record.processGeneration
    this.requireCurrent(record, generation)
    try {
      await command()
      this.requireCurrent(record, generation)
      return { outcome: 'completed', value: undefined }
    } catch (error) {
      if (!isOutcomeUnknownError(error)) throw operationError(error, fallbackCode)
      return { outcome: 'outcome_unknown', error: operationError(error, 'outcome_unknown') }
    }
  }

  private forwardTransportEvent(record: ExecutionRecord, generation: number, event: TransportExecutionEvent): void {
    if (this.executions.get(record.executionId) !== record || record.processGeneration !== generation) return
    if (event.type === 'process_exited') record.status = 'exited'
    if (event.type === 'session_identity') record.session.nativeSessionId = event.nativeSessionId
    this.emitManaged(record, event)
  }

  private emitManaged(record: ExecutionRecord, event: TransportExecutionEvent): void {
    const managed = {
      ...event,
      executionId: record.executionId,
      processGeneration: record.processGeneration,
      at: event.at ?? new Date().toISOString(),
    } as ManagedExecutionEvent
    for (const listener of this.listeners) listener(managed)
  }

  private requireRecord(executionId: ExecutionId): ExecutionRecord {
    this.assertRunning()
    const record = this.executions.get(executionId)
    if (record === undefined) throw new ExecutionOperationError('execution_not_found', `Unknown execution: ${executionId}`)
    if (record.status !== 'ready') throw new ExecutionOperationError('execution_not_ready', `Execution ${executionId} is ${record.status}`)
    return record
  }

  private requireCurrent(record: ExecutionRecord, generation: number): void {
    if (this.shuttingDown) throw new ExecutionOperationError('manager_shutdown', 'Execution manager is shutting down')
    if (this.executions.get(record.executionId) !== record || record.processGeneration !== generation) {
      throw new ExecutionOperationError(
        'stale_process_generation',
        `Execution ${record.executionId} process generation ${generation} is stale`,
      )
    }
  }

  private snapshot(record: ExecutionRecord): ManagedExecution {
    return {
      executionId: record.executionId,
      processGeneration: record.processGeneration,
      backendKey: record.backendKey,
      cwd: record.cwd,
      transport: record.probe.transport,
      capabilities: [...record.probe.capabilities] as ExecutionCapability[],
      nativeSessionId: record.session.nativeSessionId,
      status: record.status,
    }
  }

  private idempotentLifecycle<T>(
    requestId: string | undefined,
    signature: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (requestId === undefined) return operation()
    const existing = this.lifecycleRequests.get(requestId)
    if (existing !== undefined) {
      if (existing.signature !== signature) throw new ExecutionOperationError('idempotency_conflict', `Request id ${requestId} was already used for a different operation`)
      return existing.promise as Promise<T>
    }
    const promise = operation()
    this.lifecycleRequests.set(requestId, { signature, promise })
    return promise
  }

  private idempotentRecord<T>(
    record: ExecutionRecord,
    requestId: string,
    signature: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (requestId.trim() === '') throw new ExecutionOperationError('invalid_request_id', 'Execution request id cannot be empty')
    const existing = record.requests.get(requestId)
    if (existing !== undefined) {
      if (existing.signature !== signature) throw new ExecutionOperationError('idempotency_conflict', `Request id ${requestId} was already used for a different operation`)
      return existing.promise as Promise<T>
    }
    const promise = operation()
    record.requests.set(requestId, { signature, promise })
    return promise
  }

  private assertRunning(): void {
    if (this.shuttingDown) throw new ExecutionOperationError('manager_shutdown', 'Execution manager is shutting down')
  }
}

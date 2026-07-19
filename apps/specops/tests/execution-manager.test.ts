import { describe, expect, test } from 'vitest'

import { ExecutionManager } from '../src/execution/manager.js'
import {
  EXECUTION_CAPABILITIES,
  ExecutionOperationError,
  type AgentExecutionTransport,
  type ExecutionCancelInput,
  type ExecutionCapability,
  type ExecutionLoadInput,
  type ExecutionProcessContext,
  type ExecutionPromptInput,
  type ExecutionResponse,
  type ExecutionSetModeInput,
  type ExecutionStartInput,
  type ExecutionTurnResult,
  type TransportEventListener,
  type TransportExecutionEvent,
} from '../src/execution/types.js'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

class FakeTransport implements AgentExecutionTransport {
  readonly context: ExecutionProcessContext
  readonly capabilities: readonly ExecutionCapability[]
  readonly listeners = new Set<TransportEventListener>()
  readonly prompts: ExecutionPromptInput[] = []
  closeCount = 0
  promptImpl: (input: ExecutionPromptInput) => Promise<ExecutionTurnResult> = async () => ({})

  constructor(context: ExecutionProcessContext, capabilities: readonly ExecutionCapability[] = EXECUTION_CAPABILITIES) {
    this.context = context
    this.capabilities = capabilities
  }

  async probe() {
    return { transport: 'fake', capabilities: this.capabilities }
  }

  async start(_input: ExecutionStartInput) {
    return { nativeSessionId: `native-${this.context.processGeneration}` }
  }

  async load(input: ExecutionLoadInput) {
    return { nativeSessionId: input.nativeSessionId }
  }

  async prompt(input: ExecutionPromptInput): Promise<ExecutionTurnResult> {
    this.prompts.push(input)
    return this.promptImpl(input)
  }

  async cancel(_input: ExecutionCancelInput): Promise<void> {}
  async respond(_input: ExecutionResponse): Promise<void> {}
  async setMode(_input: ExecutionSetModeInput): Promise<void> {}

  async close(): Promise<void> {
    this.closeCount += 1
  }

  events(listener: TransportEventListener): () => void {
    this.listeners.add(listener)
    // Deliberately retain callbacks after unsubscribe so generation guards, not
    // friendly fake behavior, are what reject late events from old processes.
    return () => undefined
  }

  emit(event: TransportExecutionEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function setupManager(
  capabilitiesFor?: (context: ExecutionProcessContext) => readonly ExecutionCapability[],
): {
  manager: ExecutionManager
  transports: FakeTransport[]
  byExecution(executionId: string): FakeTransport[]
} {
  const transports: FakeTransport[] = []
  const manager = new ExecutionManager((context) => {
    const transport = new FakeTransport(context, capabilitiesFor?.(context) ?? EXECUTION_CAPABILITIES)
    transports.push(transport)
    return transport
  })
  return {
    manager,
    transports,
    byExecution: (executionId) => transports.filter((transport) => transport.context.executionId === executionId),
  }
}

describe('ExecutionManager', () => {
  test('serializes prompts per execution and deduplicates request ids', async () => {
    const { manager, byExecution } = setupManager()
    const events: ManagedEvent[] = []
    manager.events((event) => events.push(event))
    const execution = await manager.start({ backendKey: 'fake', cwd: '/tmp' })
    const transport = byExecution(execution.executionId)[0]!
    const firstTurn = deferred<ExecutionTurnResult>()
    const secondTurn = deferred<ExecutionTurnResult>()
    transport.promptImpl = (input) => input.text === 'one' ? firstTurn.promise : secondTurn.promise

    const first = manager.prompt(execution.executionId, { requestId: 'prompt-1', text: 'one' })
    const duplicate = manager.prompt(execution.executionId, { requestId: 'prompt-1', text: 'one' })
    const second = manager.prompt(execution.executionId, { requestId: 'prompt-2', text: 'two' })
    expect(duplicate).toBe(first)
    await tick()
    expect(transport.prompts.map((prompt) => prompt.text)).toEqual(['one'])
    expect(events.filter((event) => event.type === 'status' && event.status === 'running')).toHaveLength(1)

    firstTurn.resolve({ turnId: 'turn-1' })
    await expect(first).resolves.toMatchObject({ outcome: 'completed', value: { turnId: 'turn-1' } })
    await tick()
    expect(transport.prompts.map((prompt) => prompt.text)).toEqual(['one', 'two'])
    expect(events.filter((event) => event.type === 'status' && event.status === 'running')).toHaveLength(2)
    secondTurn.resolve({ turnId: 'turn-2' })
    await expect(second).resolves.toMatchObject({ outcome: 'completed', value: { turnId: 'turn-2' } })
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'ready' })
  })

  test('allows prompts on different executions to run in parallel', async () => {
    const { manager, byExecution } = setupManager()
    const left = await manager.start({ backendKey: 'fake', cwd: '/left' })
    const right = await manager.start({ backendKey: 'fake', cwd: '/right' })
    const leftGate = deferred<ExecutionTurnResult>()
    const rightGate = deferred<ExecutionTurnResult>()
    const leftTransport = byExecution(left.executionId)[0]!
    const rightTransport = byExecution(right.executionId)[0]!
    leftTransport.promptImpl = () => leftGate.promise
    rightTransport.promptImpl = () => rightGate.promise

    const leftPrompt = manager.prompt(left.executionId, { requestId: 'left-1', text: 'left' })
    const rightPrompt = manager.prompt(right.executionId, { requestId: 'right-1', text: 'right' })
    await tick()
    expect(leftTransport.prompts).toHaveLength(1)
    expect(rightTransport.prompts).toHaveLength(1)

    leftGate.resolve({})
    rightGate.resolve({})
    await Promise.all([leftPrompt, rightPrompt])
  })

  test('increments process generation and drops events from replaced transports', async () => {
    const { manager, byExecution } = setupManager()
    const events: ManagedEvent[] = []
    manager.events((event) => events.push(event))
    const started = await manager.start({ backendKey: 'fake', cwd: '/tmp' })
    const oldTransport = byExecution(started.executionId)[0]!
    const loaded = await manager.load({
      executionId: started.executionId,
      nativeSessionId: 'resume-me',
      backendKey: 'fake',
      cwd: '/tmp',
    })
    const newTransport = byExecution(started.executionId)[1]!
    expect(loaded.executionId).toBe(started.executionId)
    expect(loaded.processGeneration).toBe(2)
    expect(oldTransport.closeCount).toBe(1)

    events.length = 0
    oldTransport.emit({ type: 'status', status: 'stale' })
    newTransport.emit({ type: 'status', status: 'current' })
    expect(events.map((event) => [event.processGeneration, event.type === 'status' ? event.status : ''])).toEqual([[2, 'current']])
  })

  test('returns outcome_unknown without replaying an uncertain prompt', async () => {
    const { manager, byExecution } = setupManager()
    const execution = await manager.start({ backendKey: 'fake', cwd: '/tmp' })
    const transport = byExecution(execution.executionId)[0]!
    const events: ManagedEvent[] = []
    manager.events((event) => events.push(event))
    transport.promptImpl = async () => {
      throw new ExecutionOperationError('transport_lost', 'connection closed after dispatch', { outcomeUnknown: true })
    }

    const first = manager.prompt(execution.executionId, { requestId: 'uncertain-1', text: 'do work' })
    const duplicate = manager.prompt(execution.executionId, { requestId: 'uncertain-1', text: 'do work' })
    await expect(first).resolves.toMatchObject({ outcome: 'outcome_unknown' })
    await expect(duplicate).resolves.toMatchObject({ outcome: 'outcome_unknown' })
    expect(transport.prompts).toHaveLength(1)
    expect(events).toContainEqual(expect.objectContaining({ type: 'turn_failed', outcomeUnknown: true }))
  })

  test('gates unsupported operations and shuts down every transport once', async () => {
    const { manager, transports } = setupManager((context) => context.processGeneration === 2
      ? ['session.create']
      : EXECUTION_CAPABILITIES)
    const first = await manager.start({ backendKey: 'fake', cwd: '/one' })
    await manager.start({ backendKey: 'fake', cwd: '/two' })
    await expect(manager.load({
      executionId: first.executionId,
      nativeSessionId: 'native',
      backendKey: 'fake',
      cwd: '/one',
    })).rejects.toMatchObject({ code: 'capability_not_supported' })

    const shutdown = manager.shutdown()
    expect(manager.shutdown()).toBe(shutdown)
    await shutdown
    expect(transports.map((transport) => transport.closeCount)).toEqual([1, 1, 1])
    expect(() => manager.start({ backendKey: 'fake', cwd: '/after' })).toThrowError(/shutting down/)
  })
})

type ManagedEvent = Parameters<Parameters<ExecutionManager['events']>[0]>[0]

import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, test } from 'vitest'

import { createSpecOpsSession, readSpecOpsSession, type ExecutionIdentity } from '../src/domain/session.js'
import { ExecutionProjector } from '../src/execution/projector.js'
import { ExecutionRuntime, type ExecutionRuntimeManager } from '../src/execution/runtime.js'
import type {
  ExecutionCancelInput,
  ExecutionEventListener,
  ExecutionPromptInput,
  ExecutionResponse,
  ManagedExecution,
  ManagedExecutionEvent,
} from '../src/execution/types.js'
import type { ExecutionManagerLoadInput, ExecutionManagerStartInput } from '../src/execution/manager.js'

const exec = promisify(execFile)
const cleanup: string[] = []

class FakeManager implements ExecutionRuntimeManager {
  private readonly listeners = new Set<ExecutionEventListener>()
  private readonly executions = new Map<string, ManagedExecution>()
  readonly prompts: Array<{ executionId: string; input: ExecutionPromptInput }> = []
  readonly responses: Array<{ executionId: string; input: ExecutionResponse }> = []
  readonly cancellations: Array<{ executionId: string; input: ExecutionCancelInput }> = []
  readonly closed: string[] = []
  shutdownCount = 0
  private nextId = 1

  events(listener: ExecutionEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get(executionId: string): ManagedExecution | undefined {
    return this.executions.get(executionId)
  }

  async start(input: ExecutionManagerStartInput): Promise<ManagedExecution> {
    const execution = this.snapshot(`execution-${this.nextId++}`, 1, input, `native-${this.nextId - 1}`)
    this.executions.set(execution.executionId, execution)
    return execution
  }

  async load(input: ExecutionManagerLoadInput): Promise<ManagedExecution> {
    const previous = this.executions.get(input.executionId)
    const execution = this.snapshot(input.executionId, (previous?.processGeneration ?? 0) + 1, input, input.nativeSessionId)
    this.executions.set(execution.executionId, execution)
    return execution
  }

  async prompt(executionId: string, input: ExecutionPromptInput) {
    this.prompts.push({ executionId, input })
    return { outcome: 'completed' as const, value: { turnId: input.requestId } }
  }

  async respond(executionId: string, input: ExecutionResponse) {
    this.responses.push({ executionId, input })
    return { outcome: 'completed' as const, value: undefined }
  }

  async cancel(executionId: string, input: ExecutionCancelInput) {
    this.cancellations.push({ executionId, input })
    return { outcome: 'completed' as const, value: undefined }
  }

  async close(executionId: string): Promise<void> {
    this.closed.push(executionId)
    this.executions.delete(executionId)
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1
    this.executions.clear()
  }

  emit(event: ManagedExecutionEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private snapshot(
    executionId: string,
    processGeneration: number,
    input: ExecutionManagerStartInput,
    nativeSessionId: string,
  ): ManagedExecution {
    return {
      executionId,
      processGeneration,
      backendKey: input.backendKey,
      cwd: input.cwd,
      transport: 'codebuddy-acp',
      capabilities: [],
      nativeSessionId,
      status: 'ready',
    }
  }
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'specops-runtime-'))
  cleanup.push(root)
  await exec('git', ['init', root])
  return root
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ExecutionRuntime', () => {
  test('binds sessions, routes the narrow API, persists generations, and closes cleanly', async () => {
    const root = await workspace()
    const session = await createSpecOpsSession(root, {
      title: 'Runtime session', backend_key: 'codebuddy', phase: 'clarify',
    })
    const manager = new FakeManager()
    const runBindings: Array<ExecutionIdentity | null> = []
    const projector = new ExecutionProjector(manager, {
      coalesceMs: 60_000,
      persistRunExecution: async (_binding, execution) => { runBindings.push(execution) },
    })
    const runtime = new ExecutionRuntime(manager, { projector })

    const started = await runtime.start({
      workspace: root,
      sessionId: session.id,
      runId: 'run-1',
      purpose: 'clarify',
      backendKey: 'codebuddy',
      cwd: root,
      model: 'fixture-model',
    })
    expect(started).toEqual({
      execution_id: 'execution-1',
      transport: 'codebuddy_acp',
      backend_key: 'codebuddy',
      native_session_id: 'native-1',
      process_generation: 1,
    })
    expect(runtime.get(session.id)).toEqual(started)

    let record = await readSpecOpsSession(root, session.id)
    expect(record.current_execution).toEqual(started)
    expect(record.agents[0]).toMatchObject({
      execution_id: 'execution-1', process_generation: 1, purpose: 'clarify', model: 'fixture-model', status: 'ready',
    })

    await runtime.prompt(session.id, { requestId: 'prompt-1', text: 'Continue' })
    await runtime.cancel(session.id, { requestId: 'cancel-1', reason: 'test' })
    expect(manager.prompts[0]?.executionId).toBe('execution-1')
    expect(manager.cancellations[0]?.executionId).toBe('execution-1')

    manager.emit({
      type: 'questions',
      executionId: 'execution-1',
      processGeneration: 1,
      at: '2026-07-18T12:00:00.000Z',
      requestId: 'ask-1',
      questions: [{ id: 'choice', prompt: 'Choose?', options: [{ label: 'A' }] }],
    })
    await projector.flush()
    record = await readSpecOpsSession(root, session.id)
    expect(record.required_action).toMatchObject({ kind: 'answer', request_id: 'ask-1' })

    await runtime.respond(session.id, { kind: 'questions', requestId: 'ask-1', answers: { choice: 'A' } })
    record = await readSpecOpsSession(root, session.id)
    expect(record.required_action).toMatchObject({ kind: 'answer', request_id: 'ask-1' })
    expect(manager.responses[0]?.executionId).toBe('execution-1')

    const loaded = await runtime.load({
      workspace: root,
      sessionId: session.id,
      runId: 'run-1',
      purpose: 'repair',
      backendKey: 'codebuddy',
      cwd: root,
      executionId: started.execution_id,
      nativeSessionId: 'native-resumed',
    })
    expect(loaded).toMatchObject({ execution_id: 'execution-1', process_generation: 2, native_session_id: 'native-resumed' })
    record = await readSpecOpsSession(root, session.id)
    expect(record.current_execution).toEqual(loaded)
    expect(record.agents[0]).toMatchObject({ process_generation: 2, purpose: 'repair' })

    await runtime.close(session.id)
    record = await readSpecOpsSession(root, session.id)
    expect(record.current_execution).toBeNull()
    expect(record.agents[0]).toMatchObject({ status: 'closed', ended_at: expect.any(String) })
    expect(manager.closed).toEqual(['execution-1'])
    expect(runBindings).toEqual([started, loaded, loaded])

    await runtime.shutdown()
    expect(manager.shutdownCount).toBe(1)
  })

  test('shutdown is idempotent and detaches active executions', async () => {
    const root = await workspace()
    const session = await createSpecOpsSession(root, {
      title: 'Shutdown session', backend_key: 'codebuddy', phase: 'clarify',
    })
    const manager = new FakeManager()
    const projector = new ExecutionProjector(manager)
    const runtime = new ExecutionRuntime(manager, { projector })
    await runtime.start({
      workspace: root,
      sessionId: session.id,
      purpose: 'clarify',
      backendKey: 'codebuddy',
      cwd: root,
    })

    const first = runtime.shutdown()
    expect(runtime.shutdown()).toBe(first)
    await first
    const record = await readSpecOpsSession(root, session.id)
    expect(record.current_execution).toBeNull()
    expect(record.agents[0]?.status).toBe('closed')
    expect(manager.shutdownCount).toBe(1)
  })
})

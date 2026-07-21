import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, test } from 'vitest'

import {
  createSpecOpsSession,
  readSpecOpsSession,
  updateSpecOpsSession,
  type ExecutionIdentity,
} from '../src/domain/session.js'
import { beginInteractionResponse, resolveInteraction } from '../src/domain/interactions.js'
import {
  ExecutionProjector,
  extractSpecOpsPlan,
  type RealtimeTranscriptPayload,
} from '../src/execution/projector.js'
import type {
  ExecutionEventListener,
  ManagedExecution,
  ManagedExecutionEvent,
} from '../src/execution/types.js'

const exec = promisify(execFile)
const cleanup: string[] = []

class FakeExecutionSource {
  private readonly listeners = new Set<ExecutionEventListener>()
  readonly executions = new Map<string, ManagedExecution>()

  events(listener: ExecutionEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get(executionId: string): ManagedExecution | undefined {
    return this.executions.get(executionId)
  }

  emit(event: ManagedExecutionEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'specops-projector-'))
  cleanup.push(root)
  await exec('git', ['init', root])
  return root
}

function identity(generation = 1): ExecutionIdentity {
  return {
    execution_id: 'execution-1',
    transport: 'codebuddy_acp',
    backend_key: 'codebuddy',
    native_session_id: 'native-1',
    process_generation: generation,
  }
}

function managedEvent<T extends Omit<ManagedExecutionEvent, 'executionId' | 'processGeneration' | 'at'>>(
  event: T,
  generation = 1,
): ManagedExecutionEvent {
  return {
    ...event,
    executionId: 'execution-1',
    processGeneration: generation,
    at: '2026-07-18T12:00:00.000Z',
  } as ManagedExecutionEvent
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ExecutionProjector', () => {
  test('extracts the transport-independent plan envelope', () => {
    expect(extractSpecOpsPlan('Ready.\n<!-- specops:plan -->\n# Plan\n- Ship\n<!-- /specops:plan -->')).toEqual({
      markdown: '# Plan\n- Ship',
      visibleText: 'Ready.\n# Plan\n- Ship',
    })
  })

  test('projects a plan envelope as a prompt-backed review interaction', async () => {
    const root = await workspace()
    const session = await createSpecOpsSession(root, {
      title: 'Codex plan', backend_key: 'codex', phase: 'clarify',
    })
    const source = new FakeExecutionSource()
    const projector = new ExecutionProjector(source)
    await projector.bind({
      workspace: root, sessionId: session.id,
      identity: { ...identity(), backend_key: 'codex', transport: 'codex_app_server' },
      purpose: 'clarify',
    })
    source.emit(managedEvent({
      type: 'message_upsert', messageId: 'final-plan', role: 'assistant',
      text: 'Ready.\n<!-- specops:plan -->\n# Codex plan\n- Ship\n<!-- /specops:plan -->',
    }))
    await projector.flush()
    const current = await readSpecOpsSession(root, session.id)
    expect(current.required_action).toMatchObject({ kind: 'plan_review', markdown: '# Codex plan\n- Ship' })
    expect(current.interactions?.[0]).toMatchObject({
      kind: 'plan_review', payload: { response_mode: 'prompt' },
    })
    await projector.shutdown()
  })

  test('coalesces deltas, upserts tools, maps actions, and ignores stale generations', async () => {
    const root = await workspace()
    const session = await createSpecOpsSession(root, {
      title: 'Structured execution', backend_key: 'codebuddy', phase: 'clarify',
    })
    const source = new FakeExecutionSource()
    const published: Array<{ type: string; payload: unknown }> = []
    const projector = new ExecutionProjector(source, {
      coalesceMs: 60_000,
      publish: (type, _sessionId, payload) => { published.push({ type, payload }) },
    })
    await projector.bind({
      workspace: root,
      sessionId: session.id,
      identity: identity(),
      purpose: 'clarify',
    })

    source.emit(managedEvent({ type: 'message_delta', messageId: 'message-1', role: 'assistant', delta: 'Hello ' }))
    source.emit(managedEvent({ type: 'message_delta', messageId: 'message-1', role: 'assistant', delta: 'world' }))
    await projector.flush()

    let current = await readSpecOpsSession(root, session.id)
    expect(current.transcript).toHaveLength(1)
    expect(current.transcript[0]).toMatchObject({
      text: 'Hello world', execution_id: 'execution-1', entry_id: 'execution-1:message:message-1', revision: 1, final: false,
    })
    const deltas = published.filter((event) => event.type === 'session.transcript_delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0]?.payload).toMatchObject({
      session_id: session.id,
      execution_id: 'execution-1',
      generation: 1,
      sequence: 1,
      entry_id: 'execution-1:message:message-1',
      delta: 'Hello world',
    } satisfies Partial<RealtimeTranscriptPayload>)

    source.emit(managedEvent({ type: 'tool_call', toolCallId: 'tool-1', name: 'Read', input: { file_path: 'a.ts' }, status: 'running' }))
    source.emit(managedEvent({ type: 'tool_result', toolCallId: 'tool-1', output: 'source', isError: false }))
    await projector.flush()
    current = await readSpecOpsSession(root, session.id)
    expect(current.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool_use', tool_call_id: 'tool-1', status: 'ok', final: true }),
      expect.objectContaining({ kind: 'tool_result', tool_call_id: 'tool-1', preview: 'source', status: 'ok', final: true }),
    ]))

    const transcriptLengthBeforeQuestions = current.transcript.length
    source.emit(managedEvent({
      type: 'questions',
      requestId: 'ask-1',
      questions: [
        { id: 'framework', prompt: 'Framework?', options: [{ label: 'Svelte' }] },
        { id: 'tests', prompt: 'Test level?', options: [{ label: 'Unit' }, { label: 'Integration' }], multiSelect: true },
      ],
    }))
    await projector.flush()
    current = await readSpecOpsSession(root, session.id)
    expect(current.required_action).toMatchObject({
      kind: 'answer', question_id: 'framework', request_id: 'ask-1', questions: [{ question_id: 'framework' }, { question_id: 'tests' }],
    })
    expect(current.state).toBe('awaiting_user')
    expect(current.transcript).toHaveLength(transcriptLengthBeforeQuestions)

    await updateSpecOpsSession(root, session.id, (record) => {
      const questions = record.interactions?.find((interaction) => interaction.kind === 'questions')
      if (questions === undefined) throw new Error('questions interaction missing')
      expect(beginInteractionResponse(record, {
        interaction_id: questions.id,
        expected_updated_at: questions.updated_at,
      })).not.toBeNull()
      expect(resolveInteraction(record, questions.id, { answers: { framework: 'Svelte', tests: ['Unit'] } })).not.toBeNull()
    })

    source.emit(managedEvent({ type: 'plan', requestId: 'plan-1', markdown: '# Delivery plan' }))
    await projector.flush()
    current = await readSpecOpsSession(root, session.id)
    expect(current.phase).toBe('clarify')
    expect(current.clarification?.substate).toBe('plan_review')
    expect(current.required_action).toMatchObject({ kind: 'plan_review', plan_id: 'plan-1' })
    expect(current.interactions?.find((interaction) => interaction.kind === 'plan_review')?.payload.response_mode).toBe('native')

    await updateSpecOpsSession(root, session.id, (record) => {
      const plan = record.interactions?.find((interaction) => interaction.kind === 'plan_review')
      if (plan === undefined) throw new Error('plan interaction missing')
      expect(beginInteractionResponse(record, {
        interaction_id: plan.id,
        expected_updated_at: plan.updated_at,
      })).not.toBeNull()
      expect(resolveInteraction(record, plan.id, { decision: 'rejected' })).not.toBeNull()
    })

    source.emit(managedEvent({
      type: 'permission', requestId: 'permission-1', title: 'Run tests', description: 'pnpm test', options: ['Allow once', 'Deny'],
    }))
    await projector.flush()
    current = await readSpecOpsSession(root, session.id)
    expect(current.required_action).toMatchObject({
      kind: 'permission', request_id: 'permission-1',
    })
    expect(current.interactions?.map((interaction) => ({ kind: interaction.kind, status: interaction.status }))).toEqual([
      { kind: 'questions', status: 'resolved' },
      { kind: 'plan_review', status: 'resolved' },
      { kind: 'permission', status: 'pending' },
    ])

    const beforeStale = current.transcript.length
    source.emit(managedEvent({ type: 'message_upsert', messageId: 'stale', role: 'assistant', text: 'must be ignored' }, 0))
    await projector.flush()
    current = await readSpecOpsSession(root, session.id)
    expect(current.transcript).toHaveLength(beforeStale)

    await projector.shutdown()
  })

  test('finalizes turns, projects failures/exits, and detaches on shutdown', async () => {
    const root = await workspace()
    const first = await createSpecOpsSession(root, {
      title: 'Exit projection', backend_key: 'codebuddy', phase: 'run_in_worktree',
    })
    const source = new FakeExecutionSource()
    const runBindings: Array<ExecutionIdentity | null> = []
    const projector = new ExecutionProjector(source, {
      coalesceMs: 60_000,
      persistRunExecution: async (_binding, execution) => { runBindings.push(execution) },
    })
    await projector.bind({
      workspace: root,
      sessionId: first.id,
      identity: identity(),
      purpose: 'implement',
      runId: 'run-1',
    })
    source.emit(managedEvent({ type: 'session_identity', nativeSessionId: 'native-resumable' }))
    await projector.flush()
    let current = await readSpecOpsSession(root, first.id)
    expect(current.current_execution?.native_session_id).toBe('native-resumable')
    expect(current.agents[0]).toMatchObject({ native_session_id: 'native-resumable', session_uuid: 'native-resumable' })

    source.emit(managedEvent({ type: 'message_delta', messageId: 'message-1', delta: 'done' }))
    source.emit(managedEvent({ type: 'turn_completed', turnId: 'turn-1', stopReason: 'end_turn' }))
    await projector.flush()

    current = await readSpecOpsSession(root, first.id)
    expect(current.transcript[0]).toMatchObject({ text: 'done', final: true })
    expect(current.agents[0]?.status).toBe('ready')

    source.emit(managedEvent({ type: 'process_exited', code: 17, signal: null, stderrTail: 'adapter failed' }))
    await projector.flush()
    current = await readSpecOpsSession(root, first.id)
    expect(current.current_execution).toBeNull()
    expect(current.state).toBe('failed')
    expect(current.execution.last_error).toBe('adapter failed')
    expect(current.agents[0]).toMatchObject({ status: 'failed', ended_at: expect.any(String) })
    expect(runBindings).toHaveLength(3)
    expect(runBindings.every((binding) => binding?.native_session_id === 'native-resumable')).toBe(true)

    const second = await createSpecOpsSession(root, {
      title: 'Shutdown projection', backend_key: 'codebuddy', phase: 'clarify',
    })
    await projector.bind({
      workspace: root,
      sessionId: second.id,
      identity: { ...identity(), execution_id: 'execution-2' },
      purpose: 'clarify',
    })
    await projector.shutdown()
    const shutdownRecord = await readSpecOpsSession(root, second.id)
    expect(shutdownRecord.current_execution).toBeNull()
    expect(shutdownRecord.agents[0]).toMatchObject({ status: 'closed', ended_at: expect.any(String) })
  })
})

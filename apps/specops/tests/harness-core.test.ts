import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  appendHarnessEvent,
  initializeHarnessRun,
  readHarnessEvents,
  readHarnessState,
  recordGateDecision,
  recordHarnessArtifact,
  transitionHarnessTask,
} from '../src/domain/harness-core.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'specops-harness-core-'))
  roots.push(root)
  return root
}

describe('Harness Core', () => {
  it('persists a recoverable event journal and unlocks DAG tasks', async () => {
    const root = await workspace()
    await initializeHarnessRun(root, 'run-1', [
      { id: 'build', title: 'Build' },
      { id: 'test', title: 'Test', depends_on: ['build'] },
    ], 4)

    let state = await readHarnessState(root, 'run-1')
    expect(state?.tasks.map((task) => task.state)).toEqual(['ready', 'blocked'])

    await transitionHarnessTask(root, 'run-1', 'build', 'running', { agent: 'codex', worktree: '/tmp/worktree' })
    await transitionHarnessTask(root, 'run-1', 'build', 'verifying')
    await transitionHarnessTask(root, 'run-1', 'build', 'reviewing')
    await transitionHarnessTask(root, 'run-1', 'build', 'completed')
    state = await readHarnessState(root, 'run-1')
    expect(state?.tasks.map((task) => task.state)).toEqual(['completed', 'ready'])
    expect(state?.tasks[0]?.attempt).toBe(1)
    expect((await readHarnessEvents(root, 'run-1')).map((event) => event.type)).toEqual([
      'harness.initialized', 'task.transitioned', 'task.transitioned', 'task.transitioned', 'task.transitioned',
    ])

    await rm(path.join(root, '.specops', 'runs', 'run-1', 'harness-state.json'))
    const rebuilt = await readHarnessState(root, 'run-1')
    expect(rebuilt?.tasks.map((task) => task.state)).toEqual(['completed', 'ready'])
  })

  it('deduplicates events and records typed artifacts and gates', async () => {
    const root = await workspace()
    await initializeHarnessRun(root, 'run-2', [{ id: 'one', title: 'One' }], 2)
    await appendHarnessEvent(root, 'run-2', 'run.transitioned', 'test', { state: 'running' }, 'same-event')
    await appendHarnessEvent(root, 'run-2', 'run.transitioned', 'test', { state: 'failed' }, 'same-event')
    await recordHarnessArtifact(root, 'run-2', {
      kind: 'patch', subject: 'one', producer: 'test', uri: 'output.patch', content_hash: 'abc', source_commit: 'def', inputs: [], metadata: {},
    })
    await recordGateDecision(root, 'run-2', 'policy', 'passed', 'ok')
    await recordGateDecision(root, 'run-2', 'risk-approval', 'approval_required', 'medium risk')
    await recordGateDecision(root, 'run-2', 'risk-approval', 'passed', 'approved by reviewer', 'human-review')

    const state = await readHarnessState(root, 'run-2')
    expect(state?.run_state).toBe('running')
    expect(state?.artifacts).toHaveLength(1)
    expect(state?.gates).toMatchObject([
      { id: 'policy', status: 'passed' },
      { id: 'risk-approval', status: 'passed', reason: 'approved by reviewer' },
    ])
    // The journal keeps both risk decisions for audit, while state exposes only
    // the latest decision for each gate id.
    expect(await readHarnessEvents(root, 'run-2')).toHaveLength(6)
  })

  it('rejects scheduler transitions that bypass readiness and verification', async () => {
    const root = await workspace()
    await initializeHarnessRun(root, 'run-3', [
      { id: 'first', title: 'First' },
      { id: 'blocked', title: 'Blocked', depends_on: ['first'] },
    ], 2)
    await expect(transitionHarnessTask(root, 'run-3', 'blocked', 'running')).rejects.toThrow('blocked to running')
    await expect(transitionHarnessTask(root, 'run-3', 'first', 'completed')).rejects.toThrow('ready to completed')
  })
})

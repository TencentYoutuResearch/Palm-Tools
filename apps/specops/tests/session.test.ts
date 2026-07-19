import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { initWorkspace } from '../src/domain/commands.js'
import {
  appendTranscript,
  attachSessionAgent,
  buildSessionResumeContext,
  closeSpecOpsSession,
  createSpecOpsSession,
  legacyExecutionId,
  listSpecOpsSessions,
  readSpecOpsSession,
  resumeUuidForPhase,
  updateSessionAgentStatus,
  updateSpecOpsSession,
} from '../src/domain/session.js'
import { gitWorkspace } from './helpers.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true })))
})

describe('SpecOps sessions', () => {
  test('persists, lists, updates, and closes session records', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)

    const created = await createSpecOpsSession(workspace, {
      title: 'Track session state',
      backend_key: 'codebuddy',
      kode_session_id: 7,
      phase: 'analyze_request',
    })
    await appendTranscript(workspace, created.id, 'agent', 'Analyzing request')
    await updateSpecOpsSession(workspace, created.id, (record) => {
      record.phase = 'clarify'
      record.state = 'awaiting_user'
      record.required_action = { kind: 'answer', prompt: 'Which behavior should win?' }
    })

    const loaded = await readSpecOpsSession(workspace, created.id)
    expect(loaded.transcript).toMatchObject([{ role: 'agent', text: 'Analyzing request' }])
    expect(loaded.required_action).toMatchObject({ kind: 'answer', prompt: 'Which behavior should win?' })
    expect(loaded.required_action?.interaction_id).toBe(loaded.interactions?.[0]?.id)
    expect(loaded.decisions).toEqual([])

    const listed = await listSpecOpsSessions(workspace)
    expect(listed).toMatchObject([{ id: created.id, title: 'Track session state', phase: 'clarify', state: 'awaiting_user' }])

    const closed = await closeSpecOpsSession(workspace, created.id)
    expect(closed.state).toBe('closed')
    expect(closed.closed_at).not.toBeNull()
    expect(closed.required_action).toBeNull()
  })

  test('backfills execution identity from legacy numeric session ids', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const created = await createSpecOpsSession(workspace, {
      title: 'Legacy execution',
      backend_key: 'codebuddy',
      kode_session_id: 41,
      phase: 'clarify',
      agents: [{
        kode_session_id: 41,
        session_uuid: 'legacy-uuid-41',
        backend_key: 'codebuddy',
        model: null,
        purpose: 'clarify',
        status: 'idle',
        started_at: '2026-01-01T00:00:00Z',
        ended_at: null,
      }],
      transcript: [{ role: 'agent', text: 'Legacy message', at: '2026-01-01T00:00:00Z', kode_session_id: 41 }],
      decisions: [{
        id: 'legacy-decision', kind: 'answer', outcome: 'answered', prompt: 'Continue?',
        selections: ['Yes'], note: null, source: 'user', kode_session_id: 41,
        at: '2026-01-01T00:00:00Z',
      }],
    })
    const recordPath = path.join(workspace, '.specops', 'state', 'sessions', `${created.id}.json`)
    const raw = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, any>
    delete raw.current_execution
    for (const field of ['execution_id', 'transport', 'native_session_id', 'process_generation']) delete raw.agents[0][field]
    delete raw.transcript[0].execution_id
    delete raw.decisions[0].execution_id
    await writeFile(recordPath, `${JSON.stringify(raw, null, 2)}\n`)

    const loaded = await readSpecOpsSession(workspace, created.id)
    const executionId = legacyExecutionId(41)
    expect(loaded.current_execution).toMatchObject({
      execution_id: executionId,
      transport: 'legacy_kode_pty',
      native_session_id: '41',
    })
    expect(loaded.agents[0]).toMatchObject({ execution_id: executionId, kode_session_id: 41 })
    expect(loaded.transcript[0]).toMatchObject({ execution_id: executionId, kode_session_id: 41 })
    expect(loaded.decisions[0]).toMatchObject({ execution_id: executionId, kode_session_id: 41 })
  })

  test('roundtrips ACP identity without fabricating a numeric Kode session id', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const execution = {
      execution_id: 'codebuddy_acp:acp-session-a:1',
      transport: 'codebuddy_acp' as const,
      backend_key: 'codebuddy',
      native_session_id: 'acp-session-a',
      process_generation: 1,
    }
    const created = await createSpecOpsSession(workspace, {
      title: 'ACP execution',
      backend_key: 'codebuddy',
      kode_session_id: null,
      current_execution: execution,
      phase: 'clarify',
    })
    await attachSessionAgent(workspace, created.id, {
      ...execution,
      kode_session_id: null,
      session_uuid: 'acp-session-a',
      model: 'gpt-5.6',
      purpose: 'clarify',
      status: 'running',
    })
    await attachSessionAgent(workspace, created.id, {
      execution_id: 'codebuddy_acp:acp-session-b:1',
      transport: 'codebuddy_acp',
      backend_key: 'codebuddy',
      native_session_id: 'acp-session-b',
      process_generation: 1,
      kode_session_id: null,
      session_uuid: 'acp-session-b',
      model: 'gpt-5.6',
      purpose: 'plan',
      status: 'running',
    })
    await updateSessionAgentStatus(workspace, created.id, execution.execution_id, 'exited')
    await appendTranscript(workspace, created.id, 'agent', 'ACP message', null, execution.execution_id)
    await updateSpecOpsSession(workspace, created.id, (record) => {
      record.decisions.push({
        id: 'acp-decision', kind: 'answer', outcome: 'answered', prompt: 'Continue?',
        selections: ['Yes'], note: null, source: 'user', execution_id: execution.execution_id,
        kode_session_id: null, at: '2026-01-01T00:00:00Z',
      })
    })

    const loaded = await readSpecOpsSession(workspace, created.id)
    expect(loaded.kode_session_id).toBeNull()
    expect(loaded.current_execution).toEqual(execution)
    expect(loaded.agents).toHaveLength(2)
    expect(loaded.agents.find((agent) => agent.execution_id === execution.execution_id)).toMatchObject({
      kode_session_id: null,
      status: 'exited',
    })
    expect(loaded.agents.find((agent) => agent.execution_id === 'codebuddy_acp:acp-session-b:1')).toMatchObject({
      kode_session_id: null,
      status: 'running',
    })
    expect(loaded.transcript.at(-1)).toMatchObject({
      execution_id: execution.execution_id,
      kode_session_id: null,
    })
    expect(loaded.decisions.at(-1)).toMatchObject({
      execution_id: execution.execution_id,
      kode_session_id: null,
    })
  })
})

describe('resumeUuidForPhase', () => {
  test('returns the UUID of the most recent agent whose purpose matches the phase', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const created = await createSpecOpsSession(workspace, {
      title: 'Resume test',
      backend_key: 'codebuddy',
      kode_session_id: 11,
      phase: 'plan_discussion',
    })
    await updateSpecOpsSession(workspace, created.id, (record) => {
      record.agents = [
        { kode_session_id: 11, session_uuid: '11111111-1111-1111-1111-111111111111', backend_key: 'codebuddy', model: null, purpose: 'plan', status: 'idle', started_at: '2026-01-01T00:00:00Z', ended_at: null },
      ]
    })
    expect(resumeUuidForPhase(await readSpecOpsSession(workspace, created.id))).toBe('11111111-1111-1111-1111-111111111111')
  })

  test('falls back to the most recent agent with any UUID when no purpose matches', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const created = await createSpecOpsSession(workspace, {
      title: 'Resume fallback',
      backend_key: 'codebuddy',
      kode_session_id: 22,
      phase: 'clarify',
    })
    await updateSpecOpsSession(workspace, created.id, (record) => {
      record.agents = [
        { kode_session_id: 22, session_uuid: null, backend_key: 'codebuddy', model: null, purpose: 'clarify', status: 'idle', started_at: '2026-01-01T00:00:00Z', ended_at: null },
        { kode_session_id: 33, session_uuid: '22222222-2222-2222-2222-222222222222', backend_key: 'codebuddy', model: null, purpose: 'intake', status: 'idle', started_at: '2026-01-02T00:00:00Z', ended_at: null },
      ]
    })
    expect(resumeUuidForPhase(await readSpecOpsSession(workspace, created.id))).toBe('22222222-2222-2222-2222-222222222222')
  })

  test('returns null when no agent carries a UUID', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const created = await createSpecOpsSession(workspace, {
      title: 'Resume no uuid',
      backend_key: 'codebuddy',
      kode_session_id: 44,
      phase: 'analyze_request',
    })
    await updateSpecOpsSession(workspace, created.id, (record) => {
      record.agents = [
        { kode_session_id: 44, session_uuid: null, backend_key: 'codebuddy', model: null, purpose: 'intake', status: 'idle', started_at: '2026-01-01T00:00:00Z', ended_at: null },
      ]
    })
    expect(resumeUuidForPhase(await readSpecOpsSession(workspace, created.id))).toBeNull()
  })

  test('review does not resume an unrelated plan agent when implementation has no UUID', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const created = await createSpecOpsSession(workspace, {
      title: 'Review recovery',
      backend_key: 'codebuddy',
      kode_session_id: null,
      phase: 'review',
      state: 'awaiting_user',
    })
    await updateSpecOpsSession(workspace, created.id, (record) => {
      record.agents = [
        { kode_session_id: 1, session_uuid: 'plan-only-uuid', backend_key: 'codebuddy', model: null, purpose: 'plan', status: 'exited', started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T01:00:00Z' },
        { kode_session_id: 2, session_uuid: null, backend_key: 'codebuddy', model: null, purpose: 'implement', status: 'exited', started_at: '2026-01-02T00:00:00Z', ended_at: '2026-01-02T01:00:00Z' },
      ]
    })
    const loaded = await readSpecOpsSession(workspace, created.id)
    expect(resumeUuidForPhase(loaded)).toBeNull()
    expect(loaded.execution).toMatchObject({ state: 'restartable', resume_mode: 'fresh_context' })
  })
})

describe('buildSessionResumeContext', () => {
  test('carries durable decisions without replaying raw transcript', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const created = await createSpecOpsSession(workspace, {
      title: 'Durable recovery',
      backend_key: 'codebuddy',
      phase: 'clarify',
      decisions: [{
        id: 'decision-1',
        kind: 'answer',
        outcome: 'answered',
        prompt: 'Which target?',
        selections: ['Desktop'],
        note: null,
        source: 'user',
        kode_session_id: 12,
        at: '2026-01-01T00:00:00Z',
      }],
      transcript: [{ role: 'agent', text: 'large raw chat that must not be replayed', at: '2026-01-01T00:00:00Z' }],
    })

    const context = buildSessionResumeContext(created)
    expect(context).toContain('Which target? => Desktop')
    expect(context).toContain('Phase: clarify')
    expect(context).not.toContain('large raw chat that must not be replayed')
  })
})

import { rm } from 'node:fs/promises'

import { afterEach, describe, expect, test } from 'vitest'

import { initWorkspace } from '../src/domain/commands.js'
import {
  appendTranscript,
  closeSpecOpsSession,
  createSpecOpsSession,
  listSpecOpsSessions,
  readSpecOpsSession,
  resumeUuidForPhase,
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
    expect(loaded.required_action).toEqual({ kind: 'answer', prompt: 'Which behavior should win?' })

    const listed = await listSpecOpsSessions(workspace)
    expect(listed).toMatchObject([{ id: created.id, title: 'Track session state', phase: 'clarify', state: 'awaiting_user' }])

    const closed = await closeSpecOpsSession(workspace, created.id)
    expect(closed.state).toBe('closed')
    expect(closed.closed_at).not.toBeNull()
    expect(closed.required_action).toBeNull()
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
})

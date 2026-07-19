import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { initWorkspace } from '../src/domain/commands.js'
import {
  beginInteractionResponse,
  enqueueInteraction,
  resolveInteraction,
} from '../src/domain/interactions.js'
import {
  createSpecOpsSession,
  readSpecOpsSession,
  writeSpecOpsSession,
} from '../src/domain/session.js'
import {
  approvePlan,
  protocolBlockedResumeInteractionId,
  recordClarifyProtocolMiss,
  setClarificationSubstate,
} from '../src/domain/workflow-state.js'
import { gitWorkspace } from './helpers.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true })))
})

async function sessionRecord(title = 'Durable workflow') {
  const workspace = await gitWorkspace()
  cleanup.push(workspace)
  await initWorkspace(workspace)
  const session = await createSpecOpsSession(workspace, {
    title,
    backend_key: 'codebuddy',
    phase: 'clarify',
  })
  return { workspace, session }
}

describe('durable interaction queue', () => {
  test('preserves queue order, deduplicates enqueue, and advances the mirror only after resolve', async () => {
    const { session } = await sessionRecord()
    const first = enqueueInteraction(session, {
      kind: 'questions',
      source: 'agent',
      idempotency_key: 'turn-1:questions',
      payload: {
        request_id: 'request-1',
        prompt: 'Choose targets',
        questions: [{
          id: 'question-1',
          prompt: 'Which targets?',
          options: [
            { id: 'desktop', label: 'Desktop' },
            { id: 'mobile', label: 'Mobile' },
          ],
          multi_select: true,
        }],
      },
    }, '2026-07-18T01:00:00.000Z')
    const second = enqueueInteraction(session, {
      kind: 'permission',
      source: 'agent',
      idempotency_key: 'turn-1:permission',
      payload: {
        request_id: 'permission-1',
        title: 'Permission required',
        message: 'Allow write?',
        options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }],
      },
    }, '2026-07-18T01:00:01.000Z')
    const duplicate = enqueueInteraction(session, {
      kind: 'questions',
      source: 'agent',
      idempotency_key: 'turn-1:questions',
      payload: {
        request_id: 'request-replayed',
        prompt: 'A replay must not replace the original',
        questions: [],
      },
    }, '2026-07-18T01:00:02.000Z')
    await writeSpecOpsSession(session)

    expect(duplicate.id).toBe(first.id)
    expect(session.interactions).toHaveLength(2)
    expect(session.interactions?.map((interaction) => interaction.id)).toEqual([first.id, second.id])
    expect(session.required_action).toMatchObject({
      kind: 'answer',
      interaction_id: first.id,
      questions: [{ question_id: 'question-1', multi_select: true }],
    })

    const stale = beginInteractionResponse(session, {
      interaction_id: first.id,
      expected_updated_at: 'stale',
    }, '2026-07-18T01:00:03.000Z')
    expect(stale).toBeNull()
    expect(session.required_action?.interaction_id).toBe(first.id)

    const begun = beginInteractionResponse(session, {
      interaction_id: first.id,
      expected_updated_at: first.updated_at,
    }, '2026-07-18T01:00:04.000Z')
    expect(begun?.status).toBe('dispatching')
    expect(session.required_action?.interaction_id).toBe(first.id)

    const resolved = resolveInteraction(session, first.id, {
      answers: { 'question-1': ['desktop', 'mobile'] },
    }, '2026-07-18T01:00:05.000Z')
    await writeSpecOpsSession(session)
    expect(resolved?.status).toBe('resolved')
    expect(session.interactions).toHaveLength(2)
    expect(session.required_action).toMatchObject({ kind: 'permission', interaction_id: second.id })
  })

  test('does not promote ordinary text and blocks after the second protocol miss', async () => {
    const { session } = await sessionRecord('Clarify protocol correction')

    const first = recordClarifyProtocolMiss(session, {
      turn_id: 'turn-ordinary-question',
      assistant_text: 'Which target should we choose?',
      detected_at: '2026-07-18T01:30:00.000Z',
    })
    expect(first).toMatchObject({ code: 'ordinary_text_question', blocked: false })
    expect(first.corrective_prompt).toContain('structured question tool')
    expect(first.corrective_prompt).toContain('Do not call ExitPlanMode until the user answers')
    expect(session.required_action).toBeNull()
    expect(session.interactions?.some((interaction) => interaction.kind === 'start_intake')).toBe(false)
    expect(session.clarification).toMatchObject({ substate: 'exploring', approved_plan: null })

    const second = recordClarifyProtocolMiss(session, {
      turn_id: 'turn-missing-plan',
      assistant_text: 'I have finished exploring the request.',
      detected_at: '2026-07-18T01:31:00.000Z',
    })
    expect(second).toEqual({ code: 'missing_plan', blocked: true, corrective_prompt: null })
    expect(session.clarification).toMatchObject({
      substate: 'protocol_blocked',
      approved_plan: null,
      protocol_violations: [
        { code: 'ordinary_text_question' },
        { code: 'missing_plan' },
      ],
    })
    expect(session.required_action).toMatchObject({ kind: 'resume', reason: 'clarify_protocol_blocked' })
    expect(session.interactions?.map((interaction) => interaction.kind)).toEqual(['resume'])
  })

  test('recognizes a Chinese ordinary-text question and requires structured choices', async () => {
    const { session } = await sessionRecord('Chinese clarify question')
    const result = recordClarifyProtocolMiss(session, {
      turn_id: 'turn-zh',
      assistant_text: '你希望采用哪一种类型？',
      detected_at: '2026-07-18T01:32:00.000Z',
    })

    expect(result).toMatchObject({ code: 'ordinary_text_question', blocked: false })
    expect(result.corrective_prompt).toContain('2-3 concrete selectable options')
  })

  test('creates start_intake only from a durably approved plan', async () => {
    const { session } = await sessionRecord('Plan approval')
    expect(() => enqueueInteraction(session, {
      kind: 'start_intake',
      source: 'system',
      idempotency_key: 'invalid-start',
      payload: { prompt: 'Start', plan_id: 'missing', plan_interaction_id: 'missing', receipt_id: 'missing' },
    })).toThrow('start_intake requires a durable approved plan')
    expect(session.interactions).toHaveLength(0)

    const review = enqueueInteraction(session, {
      kind: 'plan_review',
      source: 'agent',
      idempotency_key: 'turn-2:plan:1',
      payload: {
        request_id: 'plan-request-1',
        plan_id: 'plan-1',
        markdown: '# Plan\n\nShip the durable kernel.',
        generation: 3,
      },
    }, '2026-07-18T02:00:00.000Z')
    expect(beginInteractionResponse(session, {
      interaction_id: review.id,
      expected_updated_at: review.updated_at,
    }, '2026-07-18T02:00:01.000Z')).not.toBeNull()

    const approved = approvePlan(session, {
      interaction_id: review.id,
      decision_id: 'decision-plan-1',
      execution: null,
      approved_at: '2026-07-18T02:00:02.000Z',
    })
    expect(approved).toMatchObject({
      plan_id: 'plan-1',
      interaction_id: review.id,
      generation: 3,
      approval: { decision_id: 'decision-plan-1', source: 'user' },
      execution: null,
    })
    expect(approved?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(session.clarification).toMatchObject({
      substate: 'awaiting_intake_confirmation',
      approved_plan: { plan_id: 'plan-1' },
    })
    expect(session.interactions?.map((interaction) => interaction.kind)).toEqual(['plan_review', 'start_intake'])
    expect(session.required_action).toMatchObject({ kind: 'promote_intake' })

    setClarificationSubstate(session, 'promoting', 'turn-intake-1')
    expect(session.clarification).toMatchObject({ substate: 'promoting', active_turn_id: 'turn-intake-1' })
  })
})

describe('legacy workflow normalization', () => {
  test('blocks the d47 legacy promotion shape instead of fabricating plan approval', async () => {
    const { workspace, session } = await sessionRecord('d47 legacy shape')
    const recordPath = path.join(workspace, '.specops', 'state', 'sessions', `${session.id}.json`)
    const raw = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>
    raw.phase = 'clarify'
    raw.state = 'awaiting_user'
    raw.required_action = {
      kind: 'promote_intake',
      prompt: 'Clarification complete. Start intake when ready.',
    }
    raw.decisions = []
    delete raw.clarification
    delete raw.interactions
    await writeFile(recordPath, `${JSON.stringify(raw, null, 2)}\n`)

    const migrated = await readSpecOpsSession(workspace, session.id)
    expect(migrated.clarification).toMatchObject({
      substate: 'protocol_blocked',
      approved_plan: null,
      protocol_violations: [{ code: 'clarify_promotion_without_approved_plan' }],
    })
    expect(migrated.required_action).toMatchObject({
      kind: 'resume',
      reason: 'clarify_promotion_without_approved_plan',
      interaction_id: protocolBlockedResumeInteractionId(session.id),
    })
    expect(migrated.interactions?.some((interaction) => interaction.kind === 'start_intake'
      && interaction.status === 'pending')).toBe(false)
    expect(migrated.decisions).toEqual([])
  })

  test('roundtrips normalized clarification and interactions through the session store', async () => {
    const { workspace, session } = await sessionRecord('Roundtrip durable state')
    enqueueInteraction(session, {
      kind: 'questions',
      source: 'agent',
      idempotency_key: 'roundtrip:questions',
      payload: {
        request_id: 'roundtrip-request',
        prompt: 'Choose one',
        questions: [{
          id: 'roundtrip-question',
          prompt: 'Choose one',
          options: [{ id: 'recommended', label: 'Recommended' }],
          multi_select: false,
        }],
      },
    }, '2026-07-18T03:00:00.000Z')
    setClarificationSubstate(session, 'qa_pending', 'turn-roundtrip')
    await writeSpecOpsSession(session)

    const loaded = await readSpecOpsSession(workspace, session.id)
    expect(loaded.clarification).toEqual(session.clarification)
    expect(loaded.interactions).toEqual(session.interactions)
    expect(loaded.required_action).toEqual(session.required_action)
    expect(loaded.required_action?.interaction_id).toBe(loaded.interactions?.[0]?.id)
  })
})

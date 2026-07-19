import {
  beginInteractionResponse,
  markInteractionDeliveryUnknown,
  orphanInteraction,
  resolveInteraction,
  type DurableInteraction,
  type DurableInteractionKind,
  type InteractionResponse,
} from '../domain/interactions.js'
import {
  updateSpecOpsSession,
  type ExecutionIdentity,
  type SessionDecision,
  type SpecOpsSessionRecord,
} from '../domain/session.js'
import {
  approvePlan,
  reconcileMissingStructuredExecution,
  setClarificationSubstate,
} from '../domain/workflow-state.js'

const BLOCKING_STATUSES = new Set(['pending', 'dispatching', 'delivery_unknown'])

export interface InteractionCasInput {
  interaction_id?: unknown
  expected_updated_at?: unknown
}

export interface ClaimedInteraction {
  session: SpecOpsSessionRecord
  interaction: DurableInteraction
}

export function blockingInteraction(session: SpecOpsSessionRecord): DurableInteraction | undefined {
  return session.interactions?.find((interaction) => BLOCKING_STATUSES.has(interaction.status))
}

export function interactionForAction(session: SpecOpsSessionRecord): DurableInteraction | undefined {
  const interactionId = session.required_action?.interaction_id
  return interactionId === undefined
    ? blockingInteraction(session)
    : session.interactions?.find((interaction) => interaction.id === interactionId)
}

export async function claimInteractionResponse(
  workspace: string,
  sessionId: string,
  expectedKind: DurableInteractionKind,
  input: InteractionCasInput,
): Promise<ClaimedInteraction | null> {
  let claimedId: string | null = null
  const session = await updateSpecOpsSession(workspace, sessionId, (record) => {
    const fallback = interactionForAction(record)
    const interactionId = typeof input.interaction_id === 'string' ? input.interaction_id : fallback?.id
    if (interactionId === undefined) return
    const interaction = record.interactions?.find((candidate) => candidate.id === interactionId)
    if (interaction === undefined || interaction.kind !== expectedKind) return
    const expectedUpdatedAt = typeof input.expected_updated_at === 'string'
      ? input.expected_updated_at
      : interaction.updated_at
    if (beginInteractionResponse(record, {
      interaction_id: interaction.id,
      expected_updated_at: expectedUpdatedAt,
    }) === null) return
    claimedId = interaction.id
  })
  if (claimedId === null) return null
  const interaction = session.interactions?.find((candidate) => candidate.id === claimedId)
  return interaction === undefined ? null : { session, interaction }
}

export async function markClaimDeliveryUnknown(
  workspace: string,
  sessionId: string,
  interactionId: string,
  response: InteractionResponse,
): Promise<SpecOpsSessionRecord> {
  return updateSpecOpsSession(workspace, sessionId, (record) => {
    markInteractionDeliveryUnknown(record, interactionId, response)
    // A response may have reached the ACP process just as its transport died.
    // Retrying the same interaction would be unsafe (especially for a
    // permission decision), so detach the execution and make recovery an
    // explicit durable Resume action instead of leaving the card permanently
    // blocked in `delivery_unknown`.
    const execution = record.current_execution
    if (execution !== null && execution.transport !== 'legacy_kode_pty') {
      reconcileMissingStructuredExecution(record, execution)
      record.execution.last_error = `Structured execution response delivery is unknown: ${JSON.stringify(response)}`
      return
    }
    record.state = 'awaiting_user'
  })
}

export async function resolveQuestionsCommand(
  workspace: string,
  sessionId: string,
  interactionId: string,
  answers: Array<{ questionId: string; labels: string[]; freeText?: string | undefined }>,
  execution: ExecutionIdentity,
): Promise<SpecOpsSessionRecord> {
  return updateSpecOpsSession(workspace, sessionId, (record) => {
    const interaction = record.interactions?.find((candidate) => candidate.id === interactionId)
    if (interaction === undefined || interaction.kind !== 'questions') return
    const response = Object.fromEntries(answers.map((answer) => [
      answer.questionId,
      {
        selections: answer.labels,
        ...(answer.freeText?.trim() ? { note: answer.freeText.trim() } : {}),
      },
    ]))
    if (resolveInteraction(record, interactionId, { answers: response }) === null) return
    // A backend may continue after a rejected/missing native question tool and
    // propose a plan based on guessed defaults. Once the real answers arrive,
    // that queued plan is stale and must be regenerated from the decisions.
    for (const candidate of record.interactions ?? []) {
      if (candidate.kind !== 'plan_review' || candidate.status !== 'pending') continue
      if (candidate.created_at < interaction.created_at) continue
      orphanInteraction(record, candidate.id, { reason: 'questions_answered_after_plan' })
    }
    for (const answer of answers) {
      if (!record.answered_action_ids.includes(answer.questionId)) record.answered_action_ids.push(answer.questionId)
      if (record.decisions.some((decision) => decision.kind === 'answer' && decision.id === answer.questionId)) continue
      const question = interaction.payload.questions.find((candidate) => candidate.id === answer.questionId)
      record.decisions.push({
        id: answer.questionId,
        kind: 'answer',
        outcome: 'answered',
        prompt: question?.prompt ?? interaction.payload.prompt,
        selections: answer.labels,
        note: answer.freeText?.trim() || null,
        source: 'user',
        execution_id: execution.execution_id,
        kode_session_id: null,
        at: new Date().toISOString(),
      })
    }
    record.clarification!.qa_round += 1
    setClarificationSubstate(record, 'qa_resolved')
    record.state = record.required_action === null ? 'active' : 'awaiting_user'
  })
}

export async function resolvePlanCommand(
  workspace: string,
  sessionId: string,
  interactionId: string,
  accept: boolean,
  note: string | undefined,
  execution: ExecutionIdentity,
): Promise<SpecOpsSessionRecord> {
  return updateSpecOpsSession(workspace, sessionId, (record) => {
    const interaction = record.interactions?.find((candidate) => candidate.id === interactionId)
    if (interaction === undefined || interaction.kind !== 'plan_review') return
    const at = new Date().toISOString()
    const decisionId = interaction.payload.plan_id
    const decision: SessionDecision = {
      id: decisionId,
      kind: 'plan_review',
      outcome: accept ? 'approved' : 'revision_requested',
      prompt: interaction.payload.markdown,
      selections: [accept ? 'Approve plan' : 'Revise plan'],
      note: note?.trim() || null,
      source: 'user',
      execution_id: execution.execution_id,
      kode_session_id: null,
      at,
    }
    if (accept) {
      const approved = approvePlan(record, {
        interaction_id: interaction.id,
        decision_id: decisionId,
        execution,
        approved_at: at,
      })
      if (approved === null) return
      if (!record.decisions.some((candidate) => candidate.kind === 'plan_review' && candidate.id === decisionId && candidate.outcome === 'approved')) {
        record.decisions.push(decision)
      }
      if (!record.answered_action_ids.includes(decisionId)) record.answered_action_ids.push(decisionId)
      record.phase = 'plan_approved'
      record.state = 'awaiting_user'
      return
    }

    if (resolveInteraction(record, interaction.id, {
      decision: 'rejected',
      decision_id: decisionId,
      feedback: note?.trim() || null,
    }, at) === null) return
    if (!record.decisions.some((candidate) => candidate.kind === 'plan_review' && candidate.id === decisionId && candidate.outcome === 'revision_requested')) {
      record.decisions.push(decision)
    }
    if (!record.answered_action_ids.includes(decisionId)) record.answered_action_ids.push(decisionId)
    record.clarification!.approved_plan = null
    setClarificationSubstate(record, 'planning')
    record.phase = 'plan_discussion'
    record.state = record.required_action === null ? 'active' : 'awaiting_user'
  })
}

export async function resolvePermissionCommand(
  workspace: string,
  sessionId: string,
  interactionId: string,
  decision: 'allow' | 'deny',
  remember: boolean,
): Promise<SpecOpsSessionRecord> {
  return updateSpecOpsSession(workspace, sessionId, (record) => {
    resolveInteraction(record, interactionId, { decision, remember })
    record.state = record.required_action === null ? 'active' : 'awaiting_user'
  })
}

import { createHash } from 'node:crypto'

import type {
  ApprovedPlan,
  ClarificationProtocolViolation,
  ClarificationState,
  ClarificationSubstate,
} from './clarify.js'
import {
  deriveRequiredAction,
  enqueueInteraction,
  migrateRequiredAction,
  orphanInteraction,
  resolveInteraction,
  stableInteractionId,
  stableReceiptId,
  syncRequiredActionMirror,
  type DurableInteraction,
  type InteractionQueueState,
} from './interactions.js'
import type {
  ExecutionIdentity,
  RequiredAction,
  SessionDecision,
  SessionExecution,
  SpecOpsPhase,
  SpecOpsSessionState,
  TranscriptEntry,
} from './session.js'

export interface DurableWorkflowState extends InteractionQueueState {
  title: string
  phase: SpecOpsPhase
  state: SpecOpsSessionState
  execution: SessionExecution
  current_execution: ExecutionIdentity | null
  decisions: SessionDecision[]
  transcript: TranscriptEntry[]
  created_at: string
  updated_at: string
}

export interface ApprovePlanInput {
  interaction_id: string
  decision_id: string
  execution: ExecutionIdentity | null
  generation?: number
  approved_at?: string
  intake_receipt_id?: string
}

export interface ClarifyProtocolMissInput {
  turn_id: string
  assistant_text: string
  detected_at?: string
}

export interface ClarifyProtocolMissResult {
  code: 'ordinary_text_question' | 'missing_plan'
  blocked: boolean
  corrective_prompt: string | null
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function initialRequest(state: DurableWorkflowState): string {
  return state.transcript.find((entry) => entry.role === 'user' && entry.text.trim() !== '')?.text.trim()
    ?? state.title
}

function hasApprovedDecision(state: DurableWorkflowState): boolean {
  return state.decisions.some((decision) => decision.kind === 'plan_review' && decision.outcome === 'approved')
}

function deriveClarificationSubstate(state: DurableWorkflowState): ClarificationSubstate {
  if (state.state === 'failed' || state.phase === 'failed') return 'failed'
  switch (state.required_action?.kind) {
    case 'answer': return 'qa_pending'
    case 'plan_review': return 'plan_review'
    case 'promote_intake': return 'awaiting_intake_confirmation'
    case 'resume': return 'protocol_blocked'
    default: break
  }
  if (state.phase === 'clarify') return 'exploring'
  if (state.phase === 'plan_discussion' || state.phase === 'solution_options') return 'planning'
  if (state.phase === 'plan_approved') return 'plan_approved'
  return 'promoted'
}

function ensureClarification(state: DurableWorkflowState): ClarificationState {
  state.clarification ??= {
    substate: deriveClarificationSubstate(state),
    initial_request: initialRequest(state),
    qa_round: state.decisions.filter((decision) => decision.kind === 'answer').length,
    active_turn_id: null,
    approved_plan: null,
    protocol_violations: [],
  }
  state.clarification.initial_request ||= initialRequest(state)
  if (!Number.isInteger(state.clarification.qa_round) || state.clarification.qa_round < 0) {
    state.clarification.qa_round = 0
  }
  state.clarification.active_turn_id ??= null
  state.clarification.approved_plan ??= null
  state.clarification.protocol_violations ??= []
  return state.clarification
}

function actionInteractionId(action: RequiredAction | null): string | null {
  return action?.interaction_id ?? null
}

function actionWithoutMirror(action: RequiredAction): Omit<RequiredAction, 'interaction_id' | 'idempotency_key'> {
  const { interaction_id: _interactionId, idempotency_key: _idempotencyKey, ...payload } = action
  return payload
}

function mirrorsDerivedAction(incoming: RequiredAction | null, derived: RequiredAction | null): boolean {
  if (incoming === null || derived === null) return incoming === derived
  return JSON.stringify(actionWithoutMirror(incoming)) === JSON.stringify(actionWithoutMirror(derived))
}

function actionableInteraction(state: DurableWorkflowState): DurableInteraction | undefined {
  return state.interactions?.find((interaction) =>
    interaction.status === 'pending' || interaction.status === 'dispatching' || interaction.status === 'delivery_unknown')
}

function appendViolation(
  clarification: ClarificationState,
  violation: ClarificationProtocolViolation,
): void {
  if (!clarification.protocol_violations.some((candidate) => candidate.id === violation.id)) {
    clarification.protocol_violations.push(violation)
  }
}

function blockInvalidLegacyPromotion(state: DurableWorkflowState, at: string): boolean {
  const clarification = ensureClarification(state)
  const promotion = state.required_action?.kind === 'promote_intake'
    || actionableInteraction(state)?.kind === 'start_intake'
  if (state.phase !== 'clarify' || !promotion || clarification.approved_plan !== null || hasApprovedDecision(state)) {
    return false
  }

  const invalidInteraction = state.interactions?.find((interaction) =>
    interaction.kind === 'start_intake'
      && (interaction.status === 'pending' || interaction.status === 'dispatching' || interaction.status === 'delivery_unknown'))
  if (invalidInteraction !== undefined) {
    invalidInteraction.status = 'orphaned'
    invalidInteraction.response = { reason: 'approved_plan_missing' }
    invalidInteraction.updated_at = at
    invalidInteraction.orphaned_at = at
  }

  const violationId = `violation_${digest(`${state.id}\0clarify_promotion_without_approved_plan`).slice(0, 24)}`
  appendViolation(clarification, {
    id: violationId,
    code: 'clarify_promotion_without_approved_plan',
    message: 'Clarification attempted intake promotion without a durable approved plan or approved plan decision.',
    interaction_id: invalidInteraction?.id ?? null,
    detected_at: at,
  })
  clarification.substate = 'protocol_blocked'
  state.required_action = null
  enqueueInteraction(state, {
    kind: 'resume',
    source: 'reconciliation',
    idempotency_key: `resume:${state.id}:clarify_promotion_without_approved_plan`,
    payload: {
      reason: 'clarify_promotion_without_approved_plan',
      prompt: 'Resume clarification and obtain explicit plan approval before starting intake.',
    },
  }, at)
  return true
}

function resolveCompatibilityClear(state: DurableWorkflowState, interactionId: string, at: string): void {
  const interaction = state.interactions?.find((candidate) => candidate.id === interactionId)
  if (interaction === undefined) return
  if (interaction.status === 'pending') {
    interaction.status = 'dispatching'
    interaction.response_started_at = at
    interaction.updated_at = at
  }
  resolveInteraction(state, interactionId, { compatibility_mirror_cleared: true }, at)
}

/**
 * Normalize legacy records in memory. Durable interactions are the source of
 * truth; required_action is only their compatibility mirror. A legacy direct
 * assignment is migrated when it differs from the queue-derived mirror.
 */
export function normalizeDurableWorkflowState(state: DurableWorkflowState): DurableWorkflowState {
  const incomingAction = state.required_action
  const at = state.updated_at || state.created_at || new Date().toISOString()

  state.interactions ??= []
  for (const interaction of state.interactions) {
    if ((interaction.status as string) === 'responding') interaction.status = 'dispatching'
  }
  ensureClarification(state)

  if (blockInvalidLegacyPromotion(state, at)) return state

  if (state.state === 'closed' || state.state === 'completed' || state.state === 'failed' || state.state === 'cancelled') {
    for (const interaction of state.interactions) {
      if (interaction.status === 'pending' || interaction.status === 'dispatching' || interaction.status === 'delivery_unknown') {
        interaction.status = 'cancelled'
        interaction.response = { reason: 'session_terminal' }
        interaction.updated_at = at
        interaction.cancelled_at = at
      }
    }
    syncRequiredActionMirror(state)
    return state
  }

  const derivedAction = deriveRequiredAction(state.interactions)
  if (!mirrorsDerivedAction(incomingAction, derivedAction)) {
    if (incomingAction === null) {
      const head = actionableInteraction(state)
      if (head !== undefined) resolveCompatibilityClear(state, head.id, at)
    } else {
      const referenced = actionInteractionId(incomingAction)
      if (referenced === null || !state.interactions.some((interaction) => interaction.id === referenced)) {
        const head = actionableInteraction(state)
        if (head !== undefined) resolveCompatibilityClear(state, head.id, at)
        const seed = state.interactions.length === 0 ? 'legacy-required-action' : `compat:${state.interactions.length}`
        migrateRequiredAction(state, incomingAction, seed, at)
      }
    }
  }

  syncRequiredActionMirror(state)
  return state
}

export function setClarificationSubstate(
  state: DurableWorkflowState,
  substate: ClarificationSubstate,
  activeTurnId?: string | null,
): ClarificationState {
  const clarification = ensureClarification(state)
  clarification.substate = substate
  if (activeTurnId !== undefined) clarification.active_turn_id = activeTurnId
  return clarification
}

export function approvePlan(
  state: DurableWorkflowState,
  input: ApprovePlanInput,
): ApprovedPlan | null {
  state.interactions ??= []
  const interaction = state.interactions.find((candidate) => candidate.id === input.interaction_id)
  if (interaction === undefined || interaction.kind !== 'plan_review'
    || (interaction.status !== 'dispatching' && interaction.status !== 'delivery_unknown')) {
    return null
  }

  const approvedAt = input.approved_at ?? new Date().toISOString()
  const generation = input.generation ?? interaction.payload.generation
  const approvedPlan: ApprovedPlan = {
    plan_id: interaction.payload.plan_id,
    interaction_id: interaction.id,
    markdown: interaction.payload.markdown,
    hash: digest(interaction.payload.markdown),
    approval: {
      decision_id: input.decision_id,
      source: 'user',
      approved_at: approvedAt,
    },
    execution: input.execution === null ? null : { ...input.execution },
    generation,
  }
  const clarification = ensureClarification(state)
  clarification.approved_plan = approvedPlan
  clarification.substate = 'plan_approved'
  resolveInteraction(state, interaction.id, {
    decision: 'approved',
    decision_id: input.decision_id,
    plan_hash: approvedPlan.hash,
  }, approvedAt)
  enqueueInteraction(state, {
    kind: 'start_intake',
    source: 'system',
    idempotency_key: `start_intake:${state.id}:${interaction.id}:${generation}`,
    payload: {
      prompt: 'Clarification complete. Start intake when ready.',
      plan_id: approvedPlan.plan_id,
      plan_interaction_id: interaction.id,
      receipt_id: input.intake_receipt_id ?? stableReceiptId(`${state.id}\0${interaction.id}\0${generation}`),
    },
  }, approvedAt)
  clarification.substate = 'awaiting_intake_confirmation'
  return approvedPlan
}

export function recordClarifyProtocolMiss(
  state: DurableWorkflowState,
  input: ClarifyProtocolMissInput,
): ClarifyProtocolMissResult {
  const at = input.detected_at ?? new Date().toISOString()
  const clarification = ensureClarification(state)
  const code = /[?？]\s*$/.test(input.assistant_text.trim()) ? 'ordinary_text_question' : 'missing_plan'
  appendViolation(clarification, {
    id: `violation_${digest(`${state.id}\0${input.turn_id}\0${code}`).slice(0, 24)}`,
    code,
    message: code === 'ordinary_text_question'
      ? 'Clarify emitted an ordinary text question instead of a structured questions interaction.'
      : 'Clarify completed without a structured questions or plan interaction.',
    interaction_id: null,
    detected_at: at,
  })
  clarification.active_turn_id = input.turn_id
  const misses = clarification.protocol_violations.filter((violation) =>
    violation.code === 'ordinary_text_question' || violation.code === 'missing_plan')
  if (misses.length === 1) {
    clarification.substate = code === 'ordinary_text_question' ? 'exploring' : 'planning'
    return {
      code,
      blocked: false,
      corrective_prompt: code === 'ordinary_text_question'
        ? [
            'Protocol correction: the previous assistant text asked the user a question without a structured interaction.',
            'Call the backend structured question tool now with 2-3 concrete selectable options and a recommended option first.',
            'Do not call ExitPlanMode until the user answers this question.',
          ].join(' ')
        : [
            'Protocol correction: do not end the turn without a structured action.',
            'Use the backend structured question tool for unresolved uncertainty. Otherwise submit a complete plan using ExitPlanMode or a <!-- specops:plan --> envelope.',
          ].join(' '),
    }
  }

  clarification.substate = 'protocol_blocked'
  enqueueInteraction(state, {
    kind: 'resume',
    source: 'system',
    idempotency_key: `resume:${state.id}:clarify_protocol_blocked`,
    payload: {
      reason: 'clarify_protocol_blocked',
      prompt: 'Resume clarification in a capable structured session and produce questions or a reviewable plan.',
    },
  }, at)
  state.state = 'awaiting_user'
  return { code, blocked: true, corrective_prompt: null }
}

export function reconcileMissingStructuredExecution(
  state: DurableWorkflowState,
  execution: ExecutionIdentity,
  at = new Date().toISOString(),
): boolean {
  if (state.current_execution?.execution_id !== execution.execution_id
    || state.current_execution.process_generation !== execution.process_generation) return false
  let orphaned = false
  for (const interaction of state.interactions ?? []) {
    if ((interaction.kind === 'questions' || interaction.kind === 'plan_review' || interaction.kind === 'permission')
      && (interaction.status === 'pending' || interaction.status === 'dispatching' || interaction.status === 'delivery_unknown')) {
      orphaned = orphanInteraction(state, interaction.id, { reason: 'structured_execution_missing' }, at) !== null || orphaned
    }
  }
  state.current_execution = null
  state.execution.last_reconciled_at = at
  state.execution.last_error = 'Structured execution is not attached to this runtime; resume is required.'
  enqueueInteraction(state, {
    kind: 'resume',
    source: 'reconciliation',
    idempotency_key: `resume:${state.id}:structured_execution_missing:${execution.execution_id}:${execution.process_generation}`,
    payload: {
      reason: 'structured_execution_missing',
      prompt: 'Resume this durable workflow in a new structured execution.',
    },
  }, at)
  if (state.phase === 'clarify' || state.phase === 'plan_discussion' || state.phase === 'solution_options') {
    ensureClarification(state).substate = 'protocol_blocked'
  }
  state.state = 'awaiting_user'
  syncRequiredActionMirror(state)
  return orphaned || state.required_action?.kind === 'resume'
}

export function protocolBlockedResumeInteractionId(sessionId: string): string {
  return stableInteractionId('resume', `resume:${sessionId}:clarify_promotion_without_approved_plan`)
}

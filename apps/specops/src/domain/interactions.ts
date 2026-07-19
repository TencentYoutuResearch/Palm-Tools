import { createHash } from 'node:crypto'

import type { ClarificationState } from './clarify.js'
import type { RequiredAction } from './session.js'

export type DurableInteractionKind =
  | 'questions'
  | 'plan_review'
  | 'permission'
  | 'start_intake'
  | 'launch_run'
  | 'run_verify'
  | 'human_review'
  | 'apply'
  | 'resume'
  | 'repository_base_required'

export type DurableInteractionStatus =
  | 'pending'
  | 'dispatching'
  | 'resolved'
  | 'delivery_unknown'
  | 'cancelled'
  | 'orphaned'

export type DurableInteractionSource = 'agent' | 'system' | 'user' | 'reconciliation'

export interface InteractionOption {
  id: string
  label: string
  description?: string
}

export interface InteractionQuestion {
  id: string
  prompt: string
  header?: string
  options: InteractionOption[]
  multi_select: boolean
}

export interface InteractionPayloadByKind {
  questions: {
    request_id: string
    prompt: string
    questions: InteractionQuestion[]
    response_mode?: 'native' | 'prompt'
  }
  plan_review: {
    request_id: string
    plan_id: string
    markdown: string
    generation: number
    response_mode?: 'native' | 'prompt'
  }
  permission: {
    request_id: string
    title: string
    message: string
    options: InteractionOption[]
  }
  start_intake: {
    prompt: string
    plan_id: string
    plan_interaction_id: string
    receipt_id: string
  }
  launch_run: {
    run_id: string | null
  }
  run_verify: {
    run_id: string | null
  }
  human_review: {
    run_id: string | null
    patch_files: string[]
    review_note: string | null
  }
  apply: {
    run_id: string | null
  }
  resume: {
    reason: string
    prompt: string
  }
  repository_base_required: {
    title: string
    message: string
    options: InteractionOption[]
  }
}

export type InteractionResponse =
  | string
  | number
  | boolean
  | null
  | InteractionResponse[]
  | { [key: string]: InteractionResponse }

interface DurableInteractionBase {
  id: string
  idempotency_key: string
  status: DurableInteractionStatus
  source: DurableInteractionSource
  response: InteractionResponse | null
  created_at: string
  updated_at: string
  response_started_at: string | null
  resolved_at: string | null
  delivery_unknown_at: string | null
  cancelled_at: string | null
  orphaned_at: string | null
}

export type DurableInteraction = {
  [Kind in DurableInteractionKind]: DurableInteractionBase & {
    kind: Kind
    payload: InteractionPayloadByKind[Kind]
  }
}[DurableInteractionKind]

export type EnqueueInteractionInput<Kind extends DurableInteractionKind = DurableInteractionKind> = {
  kind: Kind
  source: DurableInteractionSource
  payload: InteractionPayloadByKind[Kind]
  idempotency_key: string
  created_at?: string
}

export interface InteractionQueueState {
  id: string
  run_id: string | null
  clarification?: ClarificationState
  interactions?: DurableInteraction[]
  required_action: RequiredAction | null
}

export interface BeginInteractionResponseCas {
  interaction_id: string
  expected_updated_at: string
}

const ACTIONABLE_STATUSES = new Set<DurableInteractionStatus>([
  'pending',
  'dispatching',
  'delivery_unknown',
])

function nowIso(now?: string): string {
  return now ?? new Date().toISOString()
}

function stableDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function stableInteractionId(kind: DurableInteractionKind, idempotencyKey: string): string {
  return `interaction_${stableDigest(`${kind}\0${idempotencyKey}`).slice(0, 24)}`
}

export function stableReceiptId(seed: string): string {
  const hex = stableDigest(seed)
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function createInteraction<Kind extends DurableInteractionKind>(
  input: EnqueueInteractionInput<Kind>,
  now?: string,
): Extract<DurableInteraction, { kind: Kind }> {
  const at = input.created_at ?? nowIso(now)
  return {
    id: stableInteractionId(input.kind, input.idempotency_key),
    idempotency_key: input.idempotency_key,
    kind: input.kind,
    status: 'pending',
    source: input.source,
    payload: input.payload,
    response: null,
    created_at: at,
    updated_at: at,
    response_started_at: null,
    resolved_at: null,
    delivery_unknown_at: null,
    cancelled_at: null,
    orphaned_at: null,
  } as Extract<DurableInteraction, { kind: Kind }>
}

function actionOptions(options: InteractionOption[]): Array<{ id: string; label: string; description?: string }> {
  return options.map((option) => ({
    id: option.id,
    label: option.label,
    ...(option.description === undefined ? {} : { description: option.description }),
  }))
}

function withInteractionMirror(action: RequiredAction, interaction: DurableInteraction): RequiredAction {
  action.interaction_id = interaction.id
  action.idempotency_key = interaction.idempotency_key
  return action
}

export function deriveRequiredAction(interactions: readonly DurableInteraction[]): RequiredAction | null {
  const interaction = interactions.find((candidate) => ACTIONABLE_STATUSES.has(candidate.status))
  if (interaction === undefined) return null
  let action: RequiredAction
  switch (interaction.kind) {
    case 'questions': {
      const questions = interaction.payload.questions.map((question) => ({
        question_id: question.id,
        prompt: question.prompt,
        ...(question.header === undefined ? {} : { header: question.header }),
        options: actionOptions(question.options),
        multi_select: question.multi_select,
      }))
      const first = questions[0]
      action = {
        kind: 'answer',
        request_id: interaction.payload.request_id,
        prompt: first?.prompt ?? interaction.payload.prompt,
        ...(first === undefined ? {} : {
          question_id: first.question_id,
          ...(first.header === undefined ? {} : { header: first.header }),
          options: first.options,
          multi_select: first.multi_select,
        }),
        questions,
      }
      break
    }
    case 'plan_review':
      action = {
        kind: 'plan_review',
        plan_id: interaction.payload.plan_id,
        markdown: interaction.payload.markdown,
        request_id: interaction.payload.request_id,
        generation: interaction.payload.generation,
      }
      break
    case 'permission':
      action = {
        kind: 'permission',
        request_id: interaction.payload.request_id,
        title: interaction.payload.title,
        message: interaction.payload.message,
        options: actionOptions(interaction.payload.options),
      }
      break
    case 'start_intake':
      action = { kind: 'promote_intake', prompt: interaction.payload.prompt }
      break
    case 'launch_run':
      action = { kind: 'run_in_worktree' }
      break
    case 'run_verify':
      action = { kind: 'verify' }
      break
    case 'human_review':
      action = {
        kind: 'review',
        patch_files: [...interaction.payload.patch_files],
        ...(interaction.payload.review_note === null ? {} : { review_note: interaction.payload.review_note }),
      }
      break
    case 'apply':
      action = { kind: 'apply_patch' }
      break
    case 'resume':
      action = {
        kind: 'resume',
        reason: interaction.payload.reason,
        prompt: interaction.payload.prompt,
      }
      break
    case 'repository_base_required':
      action = {
        kind: 'repository_base_required',
        title: interaction.payload.title,
        message: interaction.payload.message,
        options: actionOptions(interaction.payload.options),
      }
      break
  }
  return withInteractionMirror(action, interaction)
}

export function syncRequiredActionMirror(state: InteractionQueueState): RequiredAction | null {
  state.interactions ??= []
  state.required_action = deriveRequiredAction(state.interactions)
  return state.required_action
}

export function resolveActionableInteraction(
  state: InteractionQueueState,
  kinds: readonly DurableInteractionKind[],
  response: InteractionResponse,
  now?: string,
): DurableInteraction | null {
  state.interactions ??= []
  const interaction = state.interactions.find((candidate) => ACTIONABLE_STATUSES.has(candidate.status))
  if (interaction === undefined || !kinds.includes(interaction.kind)) return null
  const at = nowIso(now)
  if (interaction.status === 'pending') {
    interaction.status = 'dispatching'
    interaction.response_started_at = at
    interaction.updated_at = at
  }
  return resolveInteraction(state, interaction.id, response, at)
}

export function cancelActionableInteractions(
  state: InteractionQueueState,
  kinds: readonly DurableInteractionKind[],
  response: InteractionResponse,
  now?: string,
): number {
  state.interactions ??= []
  let cancelled = 0
  for (const interaction of state.interactions) {
    if (!ACTIONABLE_STATUSES.has(interaction.status) || !kinds.includes(interaction.kind)) continue
    if (cancelInteraction(state, interaction.id, response, now) !== null) cancelled += 1
  }
  syncRequiredActionMirror(state)
  return cancelled
}

function existingInteraction<Kind extends DurableInteractionKind>(
  state: InteractionQueueState,
  input: EnqueueInteractionInput<Kind>,
): Extract<DurableInteraction, { kind: Kind }> | undefined {
  return state.interactions?.find((candidate) => candidate.idempotency_key === input.idempotency_key) as
    Extract<DurableInteraction, { kind: Kind }> | undefined
}

function appendInteraction<Kind extends DurableInteractionKind>(
  state: InteractionQueueState,
  input: EnqueueInteractionInput<Kind>,
  now?: string,
): Extract<DurableInteraction, { kind: Kind }> {
  state.interactions ??= []
  const existing = existingInteraction(state, input)
  if (existing !== undefined) {
    syncRequiredActionMirror(state)
    return existing
  }
  const interaction = createInteraction(input, now)
  state.interactions.push(interaction)
  syncRequiredActionMirror(state)
  return interaction
}

export function enqueueInteraction<Kind extends DurableInteractionKind>(
  state: InteractionQueueState,
  input: EnqueueInteractionInput<Kind>,
  now?: string,
): Extract<DurableInteraction, { kind: Kind }> {
  if (input.kind === 'start_intake' && state.clarification?.approved_plan == null) {
    throw new Error('start_intake requires a durable approved plan')
  }
  return appendInteraction(state, input, now)
}

export function beginInteractionResponse(
  state: InteractionQueueState,
  cas: BeginInteractionResponseCas,
  now?: string,
): DurableInteraction | null {
  state.interactions ??= []
  const head = state.interactions.find((candidate) => ACTIONABLE_STATUSES.has(candidate.status))
  if (head === undefined || head.id !== cas.interaction_id || head.status !== 'pending'
    || head.updated_at !== cas.expected_updated_at) return null
  const at = nowIso(now)
  head.status = 'dispatching'
  head.response_started_at = at
  head.updated_at = at
  syncRequiredActionMirror(state)
  return head
}

export function resolveInteraction(
  state: InteractionQueueState,
  interactionId: string,
  response: InteractionResponse,
  now?: string,
): DurableInteraction | null {
  state.interactions ??= []
  const interaction = state.interactions.find((candidate) => candidate.id === interactionId)
  if (interaction === undefined || (interaction.status !== 'dispatching' && interaction.status !== 'delivery_unknown')) return null
  const at = nowIso(now)
  interaction.status = 'resolved'
  interaction.response = response
  interaction.resolved_at = at
  interaction.updated_at = at
  syncRequiredActionMirror(state)
  return interaction
}

export function markInteractionDeliveryUnknown(
  state: InteractionQueueState,
  interactionId: string,
  response: InteractionResponse,
  now?: string,
): DurableInteraction | null {
  state.interactions ??= []
  const interaction = state.interactions.find((candidate) => candidate.id === interactionId)
  if (interaction === undefined || interaction.status !== 'dispatching') return null
  const at = nowIso(now)
  interaction.status = 'delivery_unknown'
  interaction.response = response
  interaction.delivery_unknown_at = at
  interaction.updated_at = at
  syncRequiredActionMirror(state)
  return interaction
}

function terminateInteraction(
  state: InteractionQueueState,
  interactionId: string,
  status: 'cancelled' | 'orphaned',
  response: InteractionResponse,
  now?: string,
): DurableInteraction | null {
  state.interactions ??= []
  const interaction = state.interactions.find((candidate) => candidate.id === interactionId)
  if (interaction === undefined || !ACTIONABLE_STATUSES.has(interaction.status)) return null
  const at = nowIso(now)
  interaction.status = status
  interaction.response = response
  interaction.updated_at = at
  if (status === 'cancelled') interaction.cancelled_at = at
  else interaction.orphaned_at = at
  syncRequiredActionMirror(state)
  return interaction
}

export function cancelInteraction(
  state: InteractionQueueState,
  interactionId: string,
  response: InteractionResponse = null,
  now?: string,
): DurableInteraction | null {
  return terminateInteraction(state, interactionId, 'cancelled', response, now)
}

export function orphanInteraction(
  state: InteractionQueueState,
  interactionId: string,
  response: InteractionResponse = null,
  now?: string,
): DurableInteraction | null {
  return terminateInteraction(state, interactionId, 'orphaned', response, now)
}

function legacyOptions(
  options: ReadonlyArray<{ id?: string; label: string; description?: string }>,
  seed: string,
): InteractionOption[] {
  return options.map((option, index) => ({
    id: option.id ?? `option_${stableDigest(`${seed}\0${index}\0${option.label}`).slice(0, 16)}`,
    label: option.label,
    ...(option.description === undefined ? {} : { description: option.description }),
  }))
}

export function legacyRequiredActionInput(
  state: InteractionQueueState,
  action: RequiredAction,
  seed: string,
  createdAt: string,
): EnqueueInteractionInput {
  const idempotencyKey = `legacy:${state.id}:${stableDigest(`${seed}\0${JSON.stringify(action)}`)}`
  switch (action.kind) {
    case 'answer': {
      const rawQuestions = action.questions ?? [{
        question_id: action.question_id ?? `question_${stableDigest(idempotencyKey).slice(0, 16)}`,
        prompt: action.prompt,
        ...(action.header === undefined ? {} : { header: action.header }),
        options: action.options ?? [],
        multi_select: action.multi_select,
      }]
      const questions = rawQuestions.map((question, index) => ({
        id: question.question_id,
        prompt: question.prompt,
        ...(question.header === undefined ? {} : { header: question.header }),
        options: legacyOptions(question.options, `${idempotencyKey}:${index}`),
        multi_select: question.multi_select === true,
      }))
      return {
        kind: 'questions', source: 'reconciliation', idempotency_key: idempotencyKey, created_at: createdAt,
        payload: { request_id: action.request_id ?? action.question_id ?? questions[0]?.id ?? idempotencyKey, prompt: action.prompt, questions },
      }
    }
    case 'plan_review':
      return {
        kind: 'plan_review', source: 'reconciliation', idempotency_key: idempotencyKey, created_at: createdAt,
        payload: {
          request_id: action.request_id ?? action.plan_id,
          plan_id: action.plan_id,
          markdown: action.markdown ?? '',
          generation: action.generation ?? 1,
        },
      }
    case 'permission':
      return {
        kind: 'permission', source: 'reconciliation', idempotency_key: idempotencyKey, created_at: createdAt,
        payload: { request_id: action.request_id, title: action.title, message: action.message, options: legacyOptions(action.options, idempotencyKey) },
      }
    case 'promote_intake':
      return {
        kind: 'start_intake', source: 'reconciliation', idempotency_key: idempotencyKey, created_at: createdAt,
        payload: {
          prompt: action.prompt,
          plan_id: state.clarification?.approved_plan?.plan_id ?? '',
          plan_interaction_id: state.clarification?.approved_plan?.interaction_id ?? '',
          receipt_id: stableReceiptId(`${state.id}\0${idempotencyKey}`),
        },
      }
    case 'run_in_worktree':
      return { kind: 'launch_run', source: 'reconciliation', idempotency_key: idempotencyKey, created_at: createdAt, payload: { run_id: state.run_id } }
    case 'verify':
      return { kind: 'run_verify', source: 'reconciliation', idempotency_key: idempotencyKey, created_at: createdAt, payload: { run_id: state.run_id } }
    case 'review':
      return {
        kind: 'human_review', source: 'reconciliation', idempotency_key: idempotencyKey, created_at: createdAt,
        payload: { run_id: state.run_id, patch_files: [...action.patch_files], review_note: action.review_note ?? null },
      }
    case 'apply_patch':
      return { kind: 'apply', source: 'reconciliation', idempotency_key: idempotencyKey, created_at: createdAt, payload: { run_id: state.run_id } }
    case 'cli_error_decision':
    case 'repository_base_required':
      return {
        kind: 'repository_base_required', source: 'reconciliation', idempotency_key: idempotencyKey, created_at: createdAt,
        payload: { title: action.title, message: action.message, options: legacyOptions(action.options, idempotencyKey) },
      }
    case 'resume':
      return {
        kind: 'resume', source: 'reconciliation', idempotency_key: idempotencyKey, created_at: createdAt,
        payload: { reason: action.reason, prompt: action.prompt },
      }
  }
}

/** Backfill an action already present in a legacy record without treating it as newly generated. */
export function migrateRequiredAction(
  state: InteractionQueueState,
  action: RequiredAction,
  seed: string,
  createdAt: string,
): DurableInteraction {
  return appendInteraction(state, legacyRequiredActionInput(state, action, seed, createdAt), createdAt)
}

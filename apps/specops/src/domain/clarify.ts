import type { ExecutionIdentity } from './session.js'
import { LANGUAGE_DIRECTIVE } from './intake.js'

export type ClarificationSubstate =
  | 'exploring'
  | 'qa_pending'
  | 'qa_resolved'
  | 'planning'
  | 'plan_review'
  | 'plan_approved'
  | 'awaiting_intake_confirmation'
  | 'promoting'
  | 'promoted'
  | 'protocol_blocked'
  | 'failed'

export interface ApprovedPlanApproval {
  decision_id: string
  source: 'user'
  approved_at: string
}

export interface ApprovedPlan {
  plan_id: string
  interaction_id: string
  markdown: string
  hash: string
  approval: ApprovedPlanApproval
  execution: ExecutionIdentity | null
  generation: number
}

export interface ClarificationProtocolViolation {
  id: string
  code: string
  message: string
  interaction_id: string | null
  detected_at: string
}

/** Durable clarify kernel state stored on a SpecOps session record. */
export interface ClarificationState {
  substate: ClarificationSubstate
  initial_request: string
  qa_round: number
  active_turn_id: string | null
  approved_plan: ApprovedPlan | null
  protocol_violations: ClarificationProtocolViolation[]
}

/** Legacy in-memory server projection retained until clarify routes migrate. */
export type ClarifyStatus = 'asking' | 'plan_proposed' | 'ready' | 'error'

export interface ClarifyState {
  clarifyId: string
  status: ClarifyStatus
  sessionId: number
  backendKey: string
  model?: string
  request: string
  planId: string | null
  planMd: string | null
  transcript: Array<{ role: 'agent' | 'user'; text: string; at: string }>
  error: string | null
}

export function buildClarifyPrompt(request: string, clarifyId: string): string {
  return [
    'Follow the repository skill `.codebuddy/skills/specops.clarify.md`.',
    'Read `.specops/constitution.md` first if it exists.',
    '',
    'You are in a SpecOps clarify session. Your goal is to understand the user request',
    'and resolve ambiguities BEFORE any documents are created.',
    '',
    'Use the EnterPlanMode tool to explore the codebase in read-only plan mode.',
    'Inspect the repository and classify uncertainty as blocking, defaultable, or discovered.',
    'Use the backend structured question tool for every question directed at the user (AskUserQuestion or request_user_input); never ask them to reply in ordinary assistant text.',
    'Ask at most 3 focused questions per round. Include a recommended option and its impact.',
    'Use single-select questions so every answer maps to one durable decision.',
    'Each question must provide 2-3 concrete selectable options, with the recommended option first.',
    'Do not hide unanswered questions inside the plan.',
    'Do not call ExitPlanMode while any question is unanswered.',
    'Write the draft spec/plan only after blocking uncertainty is resolved or the user explicitly accepts a default.',
    '',
    'When scope, non-goals, acceptance criteria, and material risks are explicit, submit the complete plan for review.',
    'Use ExitPlanMode when it is available. Otherwise end the response with exactly one structured plan envelope:',
    '<!-- specops:plan -->',
    '# Complete reviewable plan',
    '<!-- /specops:plan -->',
    'After the user approves the plan, you may be asked to refine further',
    'or the session will be promoted into intake.',
    '',
    `Clarify id: ${clarifyId}`,
    '',
    LANGUAGE_DIRECTIVE,
    '',
    'User request:',
    request,
  ].join('\n')
}

export function detectClarifyCompletion(agentText: string): boolean {
  // Legacy compatibility for older backends. New workflows use structured
  // plan_proposed / ask_user_question events as the source of truth.
  return /(^|\n)\s*CLARIFY_COMPLETE\s*(\n|$)/.test(agentText)
}

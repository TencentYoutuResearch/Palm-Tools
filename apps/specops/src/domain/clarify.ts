import { LANGUAGE_DIRECTIVE } from './intake.js'

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
    'Use AskUserQuestion for blocking uncertainty before writing the final plan.',
    'Ask at most 3 focused questions per round. Include a recommended option and its impact.',
    'Use single-select questions so every answer maps to one durable decision.',
    'Do not hide unanswered questions inside the plan.',
    'Write the draft spec/plan only after blocking uncertainty is resolved or the user explicitly accepts a default.',
    '',
    'Call ExitPlanMode only when scope, non-goals, acceptance criteria, and material risks are explicit.',
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

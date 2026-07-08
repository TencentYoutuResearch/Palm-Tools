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
    'In plan mode, inspect the repository, identify gaps, and ask clarifying questions.',
    'Write a draft spec/plan in the plan file — the user will review it.',
    '',
    'When you are ready for user review, call ExitPlanMode to submit the plan.',
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
  return /(^|\n)\s*CLARIFY_COMPLETE\s*(\n|$)/.test(agentText)
}

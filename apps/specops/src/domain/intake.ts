import { SpecOpsError } from '../core/errors.js'

export interface IntakeReceipt {
  schema_version: 1
  intake_id: string
  /** `ready` is agent-authored; only the server promotes it to `completed`. */
  status: 'ready' | 'completed'
  primary: string
  documents: string[]
}

/**
 * Instruct the agent to write SpecOps document bodies and titles in the same
 * language as the user request. YAML frontmatter keys stay in English so the
 * server / gate / drift parsers keep working.
 */
export const LANGUAGE_DIRECTIVE = [
  'Match the document language to the user request\'s language.',
  'If the request is in Chinese, write proposal.md / tasks.md / design.md bodies and the frontmatter title in Chinese.',
  'If the request is in English, write them in English.',
  'Keep YAML frontmatter keys (schema_version, id, kind, document_class, spec_type, work_type, targets, workflow_profile, status, verifies, paths) in English — only the title value and body follow the request language.',
  'For bug documents use `kind: bug` with `work_type: bugfix`; `work_type: bug` is invalid.',
  'For schema_version 2, normative documents use status `draft` (or active/deprecated/superseded/archived); work_item documents use status `proposed` (or approved/in_progress/blocked/completed/cancelled/archived). Never use `proposed` for a normative document.',
  'Write the intake receipt with status `ready`; only the SpecOps server may promote a schema-validated receipt to `completed`.',
  'Do not translate the user request; quote it verbatim when referenced.',
].join('\n')

export function buildIntakePrompt(request: string, intakeId: string): string {
  // The full intake workflow + receipt contract lives in the skill file
  // (`.codebuddy/skills/specops.intake.md`, installed by `specops init`).
  // We only inject the dynamic intake_id (which the skill cannot know) and the
  // user request; everything else is the skill's responsibility.
  return [
    'Follow the repository skill `.codebuddy/skills/specops.intake.md`.',
    `Your intake_id for the final receipt is: ${intakeId}`,
    `Write the final receipt to .specops/state/intakes/${intakeId}.json.`,
    'Create one or more canonical change folders or spec documents under `.specops/`.',
    'Do not edit source files, implement code, or create a Git worktree — only write documents under `.specops/`.',
    '',
    LANGUAGE_DIRECTIVE,
    '',
    'User request:',
    request,
  ].join('\n')
}

export function parseIntakeReceipt(text: string, expectedId: string): IntakeReceipt {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new SpecOpsError('invalid_intake_receipt', 'intake receipt is not valid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SpecOpsError('invalid_intake_receipt', 'intake receipt must be an object')
  }
  const item = value as Record<string, unknown>
  if (item.schema_version !== 1 || item.intake_id !== expectedId
      || (item.status !== 'ready' && item.status !== 'completed')) {
    throw new SpecOpsError('invalid_intake_receipt', 'intake receipt identity or status is invalid')
  }
  if (typeof item.primary !== 'string' || !Array.isArray(item.documents)
      || item.documents.length === 0 || item.documents.some((entry) => typeof entry !== 'string')) {
    throw new SpecOpsError('invalid_intake_receipt', 'intake receipt requires primary and documents')
  }
  const documents = item.documents as string[]
  if (!documents.includes(item.primary)) {
    throw new SpecOpsError('invalid_intake_receipt', 'intake receipt primary must be listed in documents')
  }
  if (new Set(documents).size !== documents.length) {
    throw new SpecOpsError('invalid_intake_receipt', 'intake receipt contains duplicate document paths')
  }
  return {
    schema_version: 1,
    intake_id: expectedId,
    status: item.status,
    primary: item.primary,
    documents,
  }
}

export function buildIntakePlanPrompt(request: string, intakeId: string): string {
  return [
    'Follow the repository skill `.codebuddy/skills/specops.intake.md`.',
    'Read `.specops/constitution.md` first if it exists.',
    '',
    'This is a plan-first intake. BEFORE writing any documents:',
    '1. Use EnterPlanMode to explore the codebase in read-only plan mode.',
    '2. Inspect relevant files and existing specs to ground your analysis.',
    '3. Write a draft proposal in the plan file covering:',
    '   - Problem and motivation',
    '   - Scope (in and out)',
    '   - Classification (spec/bug/refactor/feature/investigation)',
    '   - Affected code paths',
    '   - Proposed tasks with verify names',
    '   - Design decisions and trade-offs',
    '4. Call ExitPlanMode when the plan is ready for review.',
    '',
    'The user will review and approve/reject the plan.',
    'After approval, you will be asked to create the canonical SpecOps documents.',
    `Intake id: ${intakeId}`,
    '',
    LANGUAGE_DIRECTIVE,
    '',
    'User request:',
    request,
  ].join('\n')
}

// ── Checklist (proposal quality gate) ──

export interface ChecklistResult {
  ok: boolean
  missing: string[]
}

const REQUIRED_PROPOSAL_SECTIONS = ['## Motivation', '## Scope', '## Acceptance criteria', '## Out of scope'] as const

export function checkProposal(proposalBody: string): ChecklistResult {
  const missing: string[] = []
  for (const section of REQUIRED_PROPOSAL_SECTIONS) {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!new RegExp(`^${escaped}\\b`, 'm').test(proposalBody)) {
      missing.push(section)
    }
  }
  return { ok: missing.length === 0, missing }
}

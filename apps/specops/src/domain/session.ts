import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

import { SpecOpsError } from '../core/errors.js'
import { atomicWrite, pathInside, readText, resolveGitWorkspace } from '../store/workspace.js'

export type SpecOpsPhase =
  | 'analyze_request'
  | 'clarify'
  | 'plan_discussion'
  | 'solution_options'
  | 'plan_approved'
  | 'run_in_worktree'
  | 'verify'
  | 'review'
  | 'apply_patch'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type SpecOpsSessionState = 'created' | 'active' | 'awaiting_user' | 'closed' | 'completed' | 'failed' | 'cancelled'

export type SessionExecutionState = 'live' | 'resumable' | 'restartable' | 'detached' | 'unverified' | 'unavailable' | 'history'
export type SessionResumeMode = 'exact' | 'fresh_context' | 'none'

export interface SessionExecution {
  state: SessionExecutionState
  resume_mode: SessionResumeMode
  last_reconciled_at: string | null
  last_error: string | null
}

export type RequiredAction =
  | { kind: 'answer'; prompt: string; question_id?: string; header?: string; options?: Array<{ label: string; description?: string }>; multi_select?: boolean }
  | { kind: 'promote_intake'; prompt: string }
  | { kind: 'plan_review'; plan_id: string; markdown?: string }
  | { kind: 'cli_error_decision'; title: string; message: string; options: Array<{ id: string; label: string }> }
  | { kind: 'run_in_worktree' }
  | { kind: 'verify' }
  | { kind: 'review'; patch_files: string[]; review_note?: string }
  | { kind: 'apply_patch' }

export type SessionDecisionKind = 'answer' | 'plan_review'
export type SessionDecisionOutcome = 'answered' | 'approved' | 'revision_requested'

/**
 * Durable user decisions made at workflow gates. Transcript text remains useful
 * for conversation replay, but it is not a reliable source of approved scope or
 * plan state; consumers should use this ledger instead.
 */
export interface SessionDecision {
  id: string
  kind: SessionDecisionKind
  outcome: SessionDecisionOutcome
  prompt: string | null
  selections: string[]
  note: string | null
  source: 'user'
  kode_session_id: number | null
  at: string
}

export interface TranscriptEntry {
  role: 'agent' | 'user' | 'system'
  text: string
  at: string
  /**
   * The kode session this message belongs to. A SpecOps session spans multiple
   * kode sessions over its lifetime (intake → plan → implement → repair ...);
   * this lets the UI group the transcript per kode session. Null/absent for
   * legacy entries written before per-agent segmentation existed.
   */
  kode_session_id?: number | null
  /**
   * Entry kind discriminates ordinary chat text from tool invocations:
   * - `text` (default for legacy entries): carries `text`
   * - `tool_use`: agent invoked a tool (Read/Grep/Bash/…); `text` is empty,
   *   `tool`/`tool_call_id`/`summary`/`status` describe the call
   * - `tool_result`: result of a tool call; paired with `tool_use` by
   *   `tool_call_id`, carries `preview` and `status`
   *
   * Protocol-level tools (AskUserQuestion/ExitPlanMode/TaskCreate/TaskUpdate)
   * are never written as transcript entries — they surface as their own cards.
   */
  kind?: 'text' | 'tool_use' | 'tool_result'
  tool?: string
  tool_call_id?: string
  summary?: string
  preview?: string
  status?: 'running' | 'ok' | 'error'
}

export type WorkflowStepState = 'pending' | 'active' | 'awaiting_user' | 'done' | 'failed' | 'skipped'

export interface WorkflowStep {
  id: SpecOpsPhase
  title: string
  state: WorkflowStepState
  started_at: string | null
  completed_at: string | null
}

export interface WorkflowState {
  current_phase: SpecOpsPhase
  failure_count: number
  steps: WorkflowStep[]
}

export type AgentPurpose = 'clarify' | 'plan' | 'intake' | 'implement' | 'repair' | 'review'

export interface SessionAgent {
  kode_session_id: number
  session_uuid: string | null
  backend_key: string
  model: string | null
  purpose: AgentPurpose
  status: string
  started_at: string
  ended_at: string | null
  /**
   * How far this agent's kode history has been synced. Per-agent (not per
   * record) so that switching kode sessions never crosses cursors — each
   * agent pulls its own history from its own offset. Optional for backward
   * compatibility with records written before segmentation; treated as 0 when
   * absent (and backfilled by normalizeRecord on read/write).
   */
  transcript_cursor?: number
}

export interface SpecOpsSessionRecord {
  schema_version: 1
  id: string
  title: string
  workspace_root: string
  backend_key: string
  kode_session_id: number | null
  run_id: string | null
  document_path: string | null
  phase: SpecOpsPhase
  state: SpecOpsSessionState
  execution: SessionExecution
  required_action: RequiredAction | null
  /** question_id / plan_id values already answered, so the monitor won't re-surface them. */
  answered_action_ids: string[]
  decisions: SessionDecision[]
  workflow: WorkflowState
  agents: SessionAgent[]
  transcript_cursor: number
  transcript: TranscriptEntry[]
  created_at: string
  updated_at: string
  closed_at: string | null
}

export interface CreateSpecOpsSessionInput {
  id?: string
  title: string
  backend_key: string
  kode_session_id?: number | null
  run_id?: string | null
  document_path?: string | null
  phase: SpecOpsPhase
  state?: SpecOpsSessionState
  required_action?: RequiredAction | null
  workflow?: WorkflowState
  agents?: SessionAgent[]
  transcript?: TranscriptEntry[]
  decisions?: SessionDecision[]
}

export type SpecOpsSessionSummary = Pick<SpecOpsSessionRecord,
  | 'id'
  | 'title'
  | 'backend_key'
  | 'kode_session_id'
  | 'run_id'
  | 'document_path'
  | 'phase'
  | 'state'
  | 'execution'
  | 'required_action'
  | 'decisions'
  | 'workflow'
  | 'agents'
  | 'created_at'
  | 'updated_at'
  | 'closed_at'
>

function validateSessionId(id: string): void {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new SpecOpsError('invalid_session_id', `invalid SpecOps session id: ${id}`)
}

function sessionsDir(workspace: string): string {
  return pathInside(workspace, '.specops', 'state', 'sessions')
}

function sessionFile(workspace: string, id: string): string {
  validateSessionId(id)
  return path.join(sessionsDir(workspace), `${id}.json`)
}

const WORKFLOW_TITLES: Record<SpecOpsPhase, string> = {
  analyze_request: 'Intake',
  clarify: 'Clarify',
  plan_discussion: 'Plan discussion',
  solution_options: 'Solution options',
  plan_approved: 'Plan approved',
  run_in_worktree: 'Implementation',
  verify: 'Verify',
  review: 'Review',
  apply_patch: 'Apply',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const DEFAULT_FLOW: SpecOpsPhase[] = [
  'clarify',
  'analyze_request',
  'plan_discussion',
  'solution_options',
  'plan_approved',
  'run_in_worktree',
  'verify',
  'review',
  'apply_patch',
  'completed',
]

function createWorkflow(currentPhase: SpecOpsPhase, state: SpecOpsSessionState): WorkflowState {
  const now = new Date().toISOString()
  const phases = DEFAULT_FLOW.includes(currentPhase) ? DEFAULT_FLOW : [...DEFAULT_FLOW, currentPhase]
  const currentIndex = phases.indexOf(currentPhase)
  return {
    current_phase: currentPhase,
    failure_count: state === 'failed' ? 1 : 0,
    steps: phases.map((phase, index) => {
      let stepState: WorkflowStepState = 'pending'
      if (phase === currentPhase) {
        stepState = state === 'awaiting_user' ? 'awaiting_user' : state === 'failed' ? 'failed' : state === 'completed' ? 'done' : 'active'
      } else if (currentIndex >= 0 && index < currentIndex) {
        stepState = 'done'
      }
      return {
        id: phase,
        title: WORKFLOW_TITLES[phase],
        state: stepState,
        started_at: index <= currentIndex ? now : null,
        completed_at: currentIndex >= 0 && index < currentIndex ? now : null,
      }
    }),
  }
}

function syncWorkflow(record: SpecOpsSessionRecord): void {
  const workflow = record.workflow ?? createWorkflow(record.phase, record.state)
  workflow.current_phase = record.phase
  const now = new Date().toISOString()
  if (!workflow.steps.some((step) => step.id === record.phase)) {
    workflow.steps.push({
      id: record.phase,
      title: WORKFLOW_TITLES[record.phase],
      state: 'pending',
      started_at: null,
      completed_at: null,
    })
  }
  const currentIndex = workflow.steps.findIndex((step) => step.id === record.phase)
  for (let index = 0; index < workflow.steps.length; index += 1) {
    const step = workflow.steps[index]!
    if (index < currentIndex) {
      if (step.state === 'pending' || step.state === 'active' || step.state === 'awaiting_user') step.state = 'done'
      if (step.started_at === null) step.started_at = now
      if (step.completed_at === null) step.completed_at = now
    } else if (index === currentIndex) {
      step.state = record.state === 'awaiting_user'
        ? 'awaiting_user'
        : record.state === 'failed'
          ? 'failed'
          : record.state === 'completed'
            ? 'done'
            : 'active'
      if (step.started_at === null) step.started_at = now
      if (record.state === 'completed' && step.completed_at === null) step.completed_at = now
    } else if (step.state !== 'failed' && step.state !== 'skipped') {
      step.state = 'pending'
      step.completed_at = null
    }
  }
  record.workflow = workflow
}

function normalizeRecord(record: SpecOpsSessionRecord): SpecOpsSessionRecord {
  record.agents ??= []
  record.answered_action_ids ??= []
  record.decisions ??= []
  // Backfill per-agent cursor for files written before segmentation existed.
  for (const agent of record.agents) {
    if (typeof agent.transcript_cursor !== 'number') agent.transcript_cursor = 0
  }
  // Backfill kode_session_id on legacy transcript entries (null = unattributed).
  if (Array.isArray(record.transcript)) {
    for (const entry of record.transcript) {
      if (entry.kode_session_id === undefined) entry.kode_session_id = null
      // Legacy entries written before tool_use/tool_result existed have no kind —
      // treat them as ordinary chat text.
      if (entry.kind === undefined) entry.kind = 'text'
    }
  }
  record.workflow ??= createWorkflow(record.phase, record.state)
  const derivedExecution = deriveSessionExecution(record)
  record.execution = {
    ...derivedExecution,
    last_reconciled_at: record.execution?.last_reconciled_at ?? null,
    last_error: record.execution?.last_error ?? null,
  }
  syncWorkflow(record)
  return record
}

function summarize(record: SpecOpsSessionRecord): SpecOpsSessionSummary {
  normalizeRecord(record)
  return {
    id: record.id,
    title: record.title,
    backend_key: record.backend_key,
    kode_session_id: record.kode_session_id,
    run_id: record.run_id,
    document_path: record.document_path,
    phase: record.phase,
    state: record.state,
    execution: record.execution,
    required_action: record.required_action,
    decisions: record.decisions,
    workflow: record.workflow,
    agents: record.agents,
    created_at: record.created_at,
    updated_at: record.updated_at,
    closed_at: record.closed_at,
  }
}

export async function writeSpecOpsSession(record: SpecOpsSessionRecord): Promise<SpecOpsSessionRecord> {
  normalizeRecord(record)
  record.updated_at = new Date().toISOString()
  await atomicWrite(sessionFile(record.workspace_root, record.id), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

export async function createSpecOpsSession(workspaceInput: string, input: CreateSpecOpsSessionInput): Promise<SpecOpsSessionRecord> {
  const workspace = await resolveGitWorkspace(workspaceInput)
  const now = new Date().toISOString()
  const record: SpecOpsSessionRecord = {
    schema_version: 1,
    id: input.id ?? randomUUID(),
    title: input.title,
    workspace_root: workspace,
    backend_key: input.backend_key,
    kode_session_id: input.kode_session_id ?? null,
    run_id: input.run_id ?? null,
    document_path: input.document_path ?? null,
    phase: input.phase,
    state: input.state ?? 'active',
    execution: {
      state: (input.kode_session_id ?? null) === null ? 'restartable' : 'live',
      resume_mode: (input.kode_session_id ?? null) === null ? 'fresh_context' : 'none',
      last_reconciled_at: null,
      last_error: null,
    },
    required_action: input.required_action ?? null,
    answered_action_ids: [],
    decisions: input.decisions ?? [],
    workflow: input.workflow ?? createWorkflow(input.phase, input.state ?? 'active'),
    agents: input.agents ?? [],
    transcript_cursor: 0,
    transcript: input.transcript ?? [],
    created_at: now,
    updated_at: now,
    closed_at: null,
  }
  await writeSpecOpsSession(record)
  return record
}

export async function readSpecOpsSession(workspaceInput: string, id: string): Promise<SpecOpsSessionRecord> {
  const workspace = await resolveGitWorkspace(workspaceInput)
  return normalizeRecord(JSON.parse(await readText(sessionFile(workspace, id))) as SpecOpsSessionRecord)
}

export async function listSpecOpsSessionRecords(workspaceInput: string): Promise<SpecOpsSessionRecord[]> {
  const workspace = await resolveGitWorkspace(workspaceInput)
  let names: string[]
  try {
    names = await readdir(sessionsDir(workspace))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const records = await Promise.all(names
    .filter((name) => /^[0-9a-f-]{36}\.json$/.test(name))
    .map((name) => readSpecOpsSession(workspace, name.slice(0, -5))))
  return records.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

export async function listSpecOpsSessions(workspaceInput: string): Promise<SpecOpsSessionSummary[]> {
  return (await listSpecOpsSessionRecords(workspaceInput)).map(summarize)
}

export async function findSpecOpsSessionByRunId(workspaceInput: string, runId: string): Promise<SpecOpsSessionRecord | null> {
  return (await listSpecOpsSessionRecords(workspaceInput)).find((record) => record.run_id === runId) ?? null
}

export async function findSpecOpsSessionByKodeSessionId(workspaceInput: string, kodeSessionId: number): Promise<SpecOpsSessionRecord | null> {
  return (await listSpecOpsSessionRecords(workspaceInput)).find((record) => record.kode_session_id === kodeSessionId) ?? null
}

/**
 * Canonical key for matching a SpecOps session to a documents-tree entry.
 * Change kinds live in a FOLDER (.specops/changes/<id>, where <id> may itself
 * contain slashes, e.g. `bug/session-filter`); intake stores the folder path,
 * but callers may pass the folder, a trailing slash, or a top-level change file
 * inside it (proposal.md / tasks.md / design.md). Collapse those files to the
 * folder root. Spec kinds — and anything else — pass through unchanged (minus a
 * trailing slash). Returns '' for null/empty so it never matches accidentally.
 */
export function canonicalDocumentKey(docPath: string | null | undefined): string {
  if (!docPath) return ''
  return docPath.replace(/\/+$/, '').replace(/\/(?:proposal|tasks|design)\.md$/, '')
}

/**
 * Find a live (non-terminal) SpecOps session already bound to the given
 * document, so callers can reuse it instead of spawning a duplicate. Both the
 * stored `document_path` and the query are canonicalized so folder/file/
 * trailing-slash variants still match.
 */
export async function findActiveSpecOpsSessionByDocument(
  workspaceInput: string,
  docPath: string,
): Promise<SpecOpsSessionRecord | null> {
  const key = canonicalDocumentKey(docPath)
  if (key === '') return null
  const records = await listSpecOpsSessionRecords(workspaceInput)
  const isTerminal = (s: SpecOpsSessionState): boolean =>
    s === 'closed' || s === 'completed' || s === 'failed' || s === 'cancelled'
  return records.find((r) =>
    !isTerminal(r.state) && canonicalDocumentKey(r.document_path) === key) ?? null
}

export async function updateSpecOpsSession(
  workspaceInput: string,
  id: string,
  update: (record: SpecOpsSessionRecord) => void | Promise<void>,
): Promise<SpecOpsSessionRecord> {
  const record = await readSpecOpsSession(workspaceInput, id)
  await update(record)
  return writeSpecOpsSession(record)
}

export async function appendTranscript(
  workspaceInput: string,
  id: string,
  role: TranscriptEntry['role'],
  text: string,
  kodeSessionId: number | null = null,
): Promise<SpecOpsSessionRecord> {
  return updateSpecOpsSession(workspaceInput, id, (record) => {
    record.transcript.push({ role, text, at: new Date().toISOString(), kode_session_id: kodeSessionId })
  })
}

export async function attachSessionAgent(
  workspaceInput: string,
  id: string,
  agent: Omit<SessionAgent, 'started_at' | 'ended_at'>,
): Promise<SpecOpsSessionRecord> {
  return updateSpecOpsSession(workspaceInput, id, (record) => {
    const existing = record.agents.find((item) => item.kode_session_id === agent.kode_session_id)
    if (existing !== undefined) {
      existing.status = agent.status
      existing.session_uuid = agent.session_uuid
      existing.model = agent.model
      existing.purpose = agent.purpose
      return
    }
    record.agents.push({
      ...agent,
      started_at: new Date().toISOString(),
      ended_at: null,
      transcript_cursor: 0,
    })
  })
}

export async function updateSessionAgentStatus(
  workspaceInput: string,
  id: string,
  kodeSessionId: number,
  status: string,
): Promise<SpecOpsSessionRecord> {
  return updateSpecOpsSession(workspaceInput, id, (record) => {
    const agent = record.agents.find((item) => item.kode_session_id === kodeSessionId)
    if (agent === undefined) return
    agent.status = status
    if ((status === 'exited' || status === 'failed') && agent.ended_at === null) {
      agent.ended_at = new Date().toISOString()
    }
  })
}

/**
 * Maps a SpecOps phase to the agent purpose that drives it. Phases that are
 * terminal or have no associated kode session return undefined.
 */
const PHASE_PURPOSE: Record<SpecOpsPhase, AgentPurpose | undefined> = {
  clarify: 'clarify',
  plan_discussion: 'plan',
  solution_options: 'plan',
  plan_approved: 'plan',
  analyze_request: 'intake',
  run_in_worktree: 'implement',
  verify: undefined,
  review: undefined,
  apply_patch: undefined,
  completed: undefined,
  failed: undefined,
  cancelled: undefined,
}

export const RESUMABLE_SESSION_PHASES = new Set<SpecOpsPhase>([
  'run_in_worktree',
  'analyze_request',
  'clarify',
  'plan_discussion',
  'solution_options',
  'plan_approved',
  'verify',
  'review',
  'apply_patch',
])

export function isTerminalSessionState(state: SpecOpsSessionState): boolean {
  return state === 'closed' || state === 'completed' || state === 'failed' || state === 'cancelled'
}

/** Derive the durable recovery posture without assuming a numeric kode id is still alive. */
export function deriveSessionExecution(record: SpecOpsSessionRecord): SessionExecution {
  if (isTerminalSessionState(record.state)) {
    return { state: 'history', resume_mode: 'none', last_reconciled_at: null, last_error: null }
  }
  if (record.kode_session_id !== null) {
    return { state: 'live', resume_mode: 'none', last_reconciled_at: null, last_error: null }
  }
  if (!RESUMABLE_SESSION_PHASES.has(record.phase)) {
    return { state: 'detached', resume_mode: 'none', last_reconciled_at: null, last_error: null }
  }
  if (resumeUuidForPhase(record) !== null) {
    return { state: 'resumable', resume_mode: 'exact', last_reconciled_at: null, last_error: null }
  }
  return { state: 'restartable', resume_mode: 'fresh_context', last_reconciled_at: null, last_error: null }
}

/** Compact durable context for a replacement agent; deliberately excludes raw chat/tool history. */
export function buildSessionResumeContext(record: SpecOpsSessionRecord): string {
  const decisions = record.decisions.length === 0
    ? '- None recorded.'
    : record.decisions.map((decision) => {
      const answer = [...decision.selections, decision.note].filter((item): item is string => Boolean(item)).join('; ')
      return `- ${decision.kind}/${decision.outcome}: ${decision.prompt ?? 'No prompt'}${answer ? ` => ${answer}` : ''}`
    }).join('\n')
  const requiredAction = record.required_action === null ? 'None' : JSON.stringify(record.required_action)
  const completedSteps = record.workflow.steps.filter((step) => step.state === 'done').map((step) => step.id).join(', ') || 'None'
  return [
    'Continue this existing SpecOps workflow in a new CLI session.',
    'Treat the durable workflow state below as authoritative; do not repeat resolved questions.',
    '',
    `Session: ${record.title} (${record.id})`,
    `Workspace: ${record.workspace_root}`,
    `Phase: ${record.phase}`,
    `Document: ${record.document_path ?? 'None'}`,
    `Run: ${record.run_id ?? 'None'}`,
    `Completed workflow steps: ${completedSteps}`,
    `Workflow failure count: ${record.workflow.failure_count}`,
    `Required action: ${requiredAction}`,
    '',
    'Confirmed decisions:',
    decisions,
    '',
    'Inspect the repository and durable SpecOps documents before continuing.',
  ].join('\n')
}

/**
 * Resolve the codebuddy session UUID to use when resuming a SpecOps session.
 *
 * The `kode_session_id` field on the record is kode bridge's internal numeric
 * primary key, NOT a codebuddy UUID, and is unsuitable for `--resume`. The real
 * UUID lives on `SessionAgent.session_uuid`, written by `recordAgent` when each
 * kode session is created. We pick the most recent agent whose `purpose`
 * matches the current phase; if none matches (e.g. a phase transition left the
 * matching agent without a UUID), we fall back to the most recent agent with
 * any UUID. Returns null when no UUID is available — callers must then start a
 * fresh session without `--resume` rather than passing a numeric id.
 */
export function resumeUuidForPhase(record: SpecOpsSessionRecord): string | null {
  const purpose = PHASE_PURPOSE[record.phase]
  for (let i = record.agents.length - 1; i >= 0; i -= 1) {
    const agent = record.agents[i]!
    if (purpose !== undefined && agent.purpose === purpose && agent.session_uuid !== null) {
      return agent.session_uuid
    }
  }
  // Post-implementation gates must never fall back to an unrelated intake or
  // plan conversation. If the implementation/review execution has no UUID,
  // rebuild from the durable Run + Decision context instead.
  if (record.phase === 'verify' || record.phase === 'review' || record.phase === 'apply_patch') {
    const allowed = new Set<AgentPurpose>(['implement', 'repair', 'review'])
    for (let i = record.agents.length - 1; i >= 0; i -= 1) {
      const agent = record.agents[i]!
      if (allowed.has(agent.purpose) && agent.session_uuid !== null) return agent.session_uuid
    }
    return null
  }
  for (let i = record.agents.length - 1; i >= 0; i -= 1) {
    const agent = record.agents[i]!
    if (agent.session_uuid !== null) return agent.session_uuid
  }
  return null
}

export async function closeSpecOpsSession(workspaceInput: string, id: string): Promise<SpecOpsSessionRecord> {
  return updateSpecOpsSession(workspaceInput, id, (record) => {
    record.state = 'closed'
    record.closed_at = new Date().toISOString()
    record.required_action = null
  })
}

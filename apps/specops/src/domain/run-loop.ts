import type { KodeClient } from '../adapters/kode.js'
import { SpecOpsError } from '../core/errors.js'
import { markChangeCompleted } from './commands.js'
import type { SpecOpsConfig } from './config.js'
import { runVerify, type VerifyResult } from './gate.js'
import {
  applyRunPatch,
  collectRunPatch,
  createRun,
  isRunPatchEmpty,
  isRunAlreadyLanded,
  transitionRun,
  writeRun,
  type ApplyResult,
  type RunRecord,
  type Task,
} from './run.js'
import { trustWorktreeRoot } from './trust.js'

/**
 * Process-wide apply serialization. Keyed by workspace root so that applies
 * against different main repos don't block each other, but two applies against
 * the same repo run strictly one at a time (otherwise their merges would
 * interleave and corrupt the working tree). The queue is per-key: each key has
 * a chain of promises; new apply calls append to the tail and wait for the
 * head to resolve.
 */
const applyLocks = new Map<string, Promise<unknown>>()

function withApplyLock<T>(workspace: string, work: () => Promise<T>): Promise<T> {
  const prev = applyLocks.get(workspace) ?? Promise.resolve()
  const next = prev.then(() => work(), (error) => { throw error })
  // Keep the chain alive even if this caller drops the rejection; the next
  // caller must still run. Swallow the rejection on the stored handle only.
  applyLocks.set(workspace, next.then(() => undefined, () => undefined))
  return next
}

export async function launchRun(
  workspace: string,
  tasks: Task[],
  backendKey: string,
  base: string,
  kode?: KodeClient,
  runCacheRoot?: string,
  model?: string,
  changeId: string | null = null,
): Promise<RunRecord> {
  const run = await createRun(workspace, tasks, backendKey, base, runCacheRoot, changeId)
  if (kode !== undefined) {
    // Pre-trust the worktree cache root so codebuddy won't block on
    // "trust this directory?" when starting in the git worktree.
    await trustWorktreeRoot(runCacheRoot)
    // Pass the prompt before spawn so codebuddy submits it as part of startup.
    try {
      const session = await kode.createSession(backendKey, run.worktree_path, promptForTask(run), undefined, model)
      run.kode_session_id = session.id
      await writeRun(run)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      run.state = 'failed'
      await writeRun(run)
      throw new SpecOpsError('session_create_failed', `Failed to create kode session: ${message}`)
    }
  }
  return run
}

export function promptForTask(run: RunRecord): string {
  const task = run.tasks[run.current_task]
  if (task === undefined) throw new SpecOpsError('task_missing', `Run ${run.run_id} has no current task`)
  const manifest = run.manifest
  return [
    `SpecOps task ${task.id}: ${task.title}`,
    '',
    task.prompt,
    '',
    'Run manifest:',
    `- Workflow: ${manifest.workflow.kind} (${manifest.workflow.stages.join(' -> ')})`,
    `- Project profiles: ${manifest.project_profiles.join(', ') || 'none'}`,
    `- Allowed task ids: ${manifest.scope.task_ids.join(', ')}`,
    `- Required verification: ${manifest.verification.required.join(', ') || 'none'}`,
    `- Max iterations: ${manifest.limits.max_iterations}`,
    '',
    `Work only in this Run worktree: ${run.worktree_path}`,
    'Do not apply changes to another worktree. Report when the task is ready for verification.',
  ].join('\n')
}

export async function verifyRun(run: RunRecord): Promise<{ run: RunRecord; patch: string; files: string[]; results: VerifyResult[] }> {
  if (run.state === 'running') await transitionRun(run, 'awaiting_verify')
  if (run.state !== 'awaiting_verify') throw new SpecOpsError('run_not_verifiable', `Run ${run.run_id} is ${run.state}`)
  const task = run.tasks[run.current_task]
  if (task === undefined) throw new SpecOpsError('task_missing', `Run ${run.run_id} has no current task`)
  const results: VerifyResult[] = []
  for (const name of task.verify) {
    const config = run.verify_snapshot[name]
    if (config === undefined) throw new SpecOpsError('verify_snapshot_missing', `Run snapshot has no verify: ${name}`)
    results.push(await runVerify(run.worktree_path, name, config))
  }
  const patch = await collectRunPatch(run)
  run.verify_results.push({ at: new Date().toISOString(), task_id: task.id, results })
  await transitionRun(run, 'awaiting_review')
  return { run, patch: patch.patch, files: patch.files, results }
}

// ---------------------------------------------------------------------------
// Automated review agent
// ---------------------------------------------------------------------------

export type ReviewSeverity = 'critical' | 'major' | 'minor'

export interface ReviewFinding {
  category: 'spec' | 'quality'
  severity: ReviewSeverity
  note: string
}

export interface ReviewResult {
  at: string
  agent_model: string
  /** True iff any finding is 'critical'. Computed server-side, never trusted from the agent. */
  blocker: boolean
  summary: string
  findings: ReviewFinding[]
  /** Set when the reviewer timed out / never emitted a parseable result. Never auto-retries. */
  inconclusive?: boolean
  transcript?: string
}

const REVIEW_BEGIN = 'REVIEW_RESULT_BEGIN'
const REVIEW_END = 'REVIEW_RESULT_END'

/** Poll cadence + idle settle + hard deadline for the review agent session. */
const REVIEW_POLL_MS = 5_000
const REVIEW_SETTLE_MS = 8_000
const REVIEW_DEADLINE_MS = 180_000

/**
 * Pure parser: extract the sentinel JSON block from a review agent's message and
 * normalize it into a ReviewResult. Returns an inconclusive result if the block
 * is missing or unparseable. `blocker` is recomputed from findings — the agent's
 * self-reported boolean is not trusted (defense in depth).
 */
export function extractReviewResult(text: string, agentModel: string): ReviewResult {
  const at = new Date().toISOString()
  const inconclusive = (summary: string): ReviewResult => ({
    at, agent_model: agentModel, blocker: false, summary, findings: [], inconclusive: true,
  })
  const begin = text.lastIndexOf(REVIEW_BEGIN)
  const end = text.lastIndexOf(REVIEW_END)
  if (begin === -1 || end === -1 || end <= begin) return inconclusive('review inconclusive: no result block')
  const jsonText = text.slice(begin + REVIEW_BEGIN.length, end).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return inconclusive('review inconclusive: unparseable result block')
  }
  if (parsed === null || typeof parsed !== 'object') return inconclusive('review inconclusive: result not an object')
  const obj = parsed as Record<string, unknown>
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : []
  const findings: ReviewFinding[] = []
  for (const f of rawFindings) {
    if (f === null || typeof f !== 'object') continue
    const ff = f as Record<string, unknown>
    const category = ff.category === 'spec' || ff.category === 'quality' ? ff.category : 'quality'
    const severity: ReviewSeverity =
      ff.severity === 'critical' || ff.severity === 'major' || ff.severity === 'minor' ? ff.severity : 'minor'
    const note = typeof ff.note === 'string' ? ff.note : ''
    findings.push({ category, severity, note })
  }
  const summary = typeof obj.summary === 'string' && obj.summary.trim() !== '' ? obj.summary.trim() : 'review complete'
  return { at, agent_model: agentModel, blocker: findings.some((f) => f.severity === 'critical'), summary, findings }
}

/** Render a ReviewResult into a feedback note to send back to the implementing agent. */
export function formatReviewNote(review: ReviewResult): string {
  const lines = ['Automated review found blocking issues. Fix them and report when ready for verification.', '', review.summary, '']
  for (const f of review.findings.filter((x) => x.severity === 'critical')) {
    lines.push(`- [${f.category}/critical] ${f.note}`)
  }
  const others = review.findings.filter((x) => x.severity !== 'critical')
  if (others.length > 0) {
    lines.push('', 'Non-blocking (address if reasonable):')
    for (const f of others) lines.push(`- [${f.category}/${f.severity}] ${f.note}`)
  }
  return lines.join('\n')
}

function buildReviewPrompt(run: RunRecord, task: Task, patch: string): string {
  return [
    'You are an automated SpecOps code reviewer. Review the implementation of one task in an isolated git worktree.',
    `Worktree (read it directly): ${run.worktree_path}`,
    '',
    `Task ${task.id}: ${task.title}`,
    task.prompt,
    '',
    'Read the relevant `.specops/changes/<id>/proposal.md`, `tasks.md`, `design.md`, and any `.specops/specs/*` the task references, then judge the diff against them.',
    'Evaluate two dimensions: (1) spec-compliance — does the change satisfy the proposal/tasks/spec and violate no constitution invariant; (2) code-quality — correctness, safety, clarity.',
    'Mark a finding `critical` ONLY for genuine blockers (spec not met, broken behavior, security/data risk). Use `major`/`minor` otherwise.',
    '',
    'Diff under review:',
    '```diff',
    patch.length > 60_000 ? `${patch.slice(0, 60_000)}\n... [diff truncated]` : patch,
    '```',
    '',
    `When done, output EXACTLY one result block on its own lines, nothing after it:`,
    REVIEW_BEGIN,
    '{ "summary": "<one line>", "findings": [ { "category": "spec|quality", "severity": "critical|major|minor", "note": "<what and where>" } ] }',
    REVIEW_END,
  ].join('\n')
}

/**
 * Run an automated review agent against the current task's diff. Spawns a fresh
 * analysis session in the run's worktree, polls until idle (or deadline), parses
 * the sentinel result, and appends it to `run.review_results`. Never throws on a
 * misbehaving reviewer — returns an inconclusive (non-blocking) result instead.
 * `patch` is reused from verifyRun's output to avoid re-running collectRunPatch
 * (which has a git add/commit side effect).
 */
export async function runReview(
  run: RunRecord,
  kode: KodeClient,
  config: SpecOpsConfig,
  patch: string,
): Promise<ReviewResult> {
  const task = run.tasks[run.current_task]
  if (task === undefined) throw new SpecOpsError('task_missing', `Run ${run.run_id} has no current task`)
  const model = config.review.model
  const agentModel = model ?? run.backend_key
  const prompt = buildReviewPrompt(run, task, patch)

  let sessionId: number | null = null
  let result: ReviewResult
  try {
    // Headless: the review agent is a background reviewer the user never
    // interacts with directly. Suppressing the GUI tab keeps the auto-review
    // loop (up to max_iterations) from flashing a stream of kode tabs.
    const session = await kode.createAnalysisSession(run.backend_key, run.worktree_path, prompt, model, true)
    sessionId = session.id
    const text = await waitForReviewOutput(kode, sessionId)
    result = extractReviewResult(text, agentModel)
  } catch {
    result = { at: new Date().toISOString(), agent_model: agentModel, blocker: false, summary: 'review inconclusive: agent session error', findings: [], inconclusive: true }
  } finally {
    if (sessionId !== null) await kode.killSession(sessionId).catch(() => undefined)
  }
  run.review_results.push(result)
  await writeRun(run)
  return result
}

/** Poll the review session until it settles idle, then return its last agent message. Times out at REVIEW_DEADLINE_MS. */
async function waitForReviewOutput(kode: KodeClient, sessionId: number): Promise<string> {
  const deadline = Date.now() + REVIEW_DEADLINE_MS
  let idleSince: number | null = null
  while (Date.now() < deadline) {
    let status = 'unknown'
    try {
      status = (await kode.getSession(sessionId)).status
    } catch { /* transient — retry */ }
    if (status === 'exited') break
    if (status === 'idle') {
      if (idleSince === null) idleSince = Date.now()
      else if (Date.now() - idleSince >= REVIEW_SETTLE_MS) break
    } else {
      idleSince = null
    }
    await new Promise((r) => setTimeout(r, REVIEW_POLL_MS))
  }
  const { messages } = await kode.transcript(sessionId)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === 'agent' && (m.kind ?? 'text') === 'text') return m.text ?? ''
  }
  return ''
}

export async function decideRun(
  run: RunRecord,
  verdict: 'accept' | 'reject' | 'feedback',
  note: string,
  kode?: KodeClient,
): Promise<RunRecord> {
  if (run.state !== 'awaiting_review') throw new SpecOpsError('run_not_reviewable', `Run ${run.run_id} is ${run.state}`)
  run.decisions.push({ at: new Date().toISOString(), verdict, note })
  if (verdict === 'accept') {
    await transitionRun(run, 'completed')
    return run
  }
  if (verdict === 'reject') {
    await transitionRun(run, 'cancelled')
    return run
  }
  run.iteration += 1
  if (run.iteration >= run.max_iterations) {
    run.state = 'failed'
    await writeRun(run)
    throw new SpecOpsError('max_iterations', `Run ${run.run_id} reached max_iterations`)
  }
  if (kode === undefined || run.kode_session_id === null) {
    throw new SpecOpsError('kode_unavailable', 'feedback requires a connected kode session')
  }
  await transitionRun(run, 'running')
  await kode.waitForReady(run.kode_session_id)
  await kode.sendPrompt(run.kode_session_id, `SpecOps review feedback:\n\n${note}\n\nRevise the same task and report when ready for verification.`)
  return run
}

export async function applyCompletedRun(run: RunRecord): Promise<{ applied: boolean; reason?: string; commit?: string | undefined }> {
  if (run.state !== 'completed') throw new SpecOpsError('run_not_completed', `Run ${run.run_id} is ${run.state}`)
  if (await isRunAlreadyLanded(run)) {
    if (run.change_id !== null) await markChangeCompleted(run.workspace_root, run.change_id)
    return { applied: false, reason: 'already_landed' }
  }
  if (await isRunPatchEmpty(run)) {
    // Outputs already live in the base commit (intake committed them) or the
    // agent produced nothing. Treat as a successful no-op rather than failing.
    // Still mark the change proposal completed — the Run finished successfully,
    // even if there was nothing to merge.
    if (run.change_id !== null) await markChangeCompleted(run.workspace_root, run.change_id)
    return { applied: false, reason: 'no_changes' }
  }
  const result = await withApplyLock(run.workspace_root, () => applyRunPatch(run))
  // The merge succeeded — flip the change proposal from `proposed` to
  // `completed`. Best-effort: markChangeCompleted is a silent no-op when no
  // matching proposal folder is found (quick-runs, already-archived, etc.).
  if (run.change_id !== null) await markChangeCompleted(run.workspace_root, run.change_id)
  return { applied: true, commit: result.commit }
}

export async function applyWithVerify(run: RunRecord): Promise<{ run: RunRecord; verifyResults: VerifyResult[]; allOk: boolean; applied: boolean; reason?: string; commit?: string | undefined }> {
  if (run.state !== 'awaiting_review' && run.state !== 'completed') throw new SpecOpsError('run_not_reviewable', `Run ${run.run_id} is ${run.state}`)
  if (await isRunAlreadyLanded(run)) {
    if (run.state === 'awaiting_review') await transitionRun(run, 'applying')
    await transitionRun(run, 'applied')
    await transitionRun(run, 'completed')
    if (run.change_id !== null) await markChangeCompleted(run.workspace_root, run.change_id)
    return { run, verifyResults: [], allOk: true, applied: false, reason: 'already_landed' }
  }
  if (await isRunPatchEmpty(run)) {
    // Nothing to apply — mark completed as a no-op (outputs already in base).
    await transitionRun(run, 'applying')
    await transitionRun(run, 'applied')
    await transitionRun(run, 'completed')
    if (run.change_id !== null) await markChangeCompleted(run.workspace_root, run.change_id)
    return { run, verifyResults: [], allOk: true, applied: false, reason: 'no_changes' }
  }
  await transitionRun(run, 'applying')
  let applyResult: ApplyResult
  try {
    applyResult = await withApplyLock(run.workspace_root, () => applyRunPatch(run))
  } catch (err) {
    // applyRunPatch failed a pre-merge check (dirty workspace, conflict,
    // empty patch, etc.). Roll the run back to 'awaiting_review' so the
    // review/apply buttons reappear and the user can retry or fix — never
    // leave it stranded in 'applying' (that deadlocked the console before).
    // The change proposal stays `proposed` — the apply never landed.
    await transitionRun(run, 'awaiting_review')
    throw err
  }
  // Run all task verify configs on the main workspace
  const verifyResults: VerifyResult[] = []
  for (const task of run.tasks) {
    for (const name of task.verify) {
      const config = run.verify_snapshot[name]
      if (config === undefined) continue
      verifyResults.push(await runVerify(run.workspace_root, name, config))
    }
  }
  const allOk = verifyResults.length === 0 || verifyResults.every((r) => r.ok)
  if (allOk) {
    await transitionRun(run, 'applied')
    await transitionRun(run, 'completed')
    // Apply landed and verifies passed — flip the change proposal from
    // `proposed` to `completed`. Best-effort: silent no-op if no proposal
    // folder matches (quick-runs, already-archived).
    if (run.change_id !== null) await markChangeCompleted(run.workspace_root, run.change_id)
  } else {
    // Verify failed after a successful merge. The patch IS in the workspace,
    // but we deliberately do NOT mark the proposal `completed` — the change
    // is not in a verifiably-good state. The user can rollback or fix-forward.
    await transitionRun(run, 'applied_failed')
  }
  return { run, verifyResults, allOk, applied: true, commit: applyResult.commit }
}

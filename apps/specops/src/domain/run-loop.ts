import type { KodeClient } from '../adapters/kode.js'
import { SpecOpsError } from '../core/errors.js'
import { markChangeCompleted, scanWorkspace } from './commands.js'
import type { SpecOpsConfig } from './config.js'
import { runVerify, type VerifyResult } from './gate.js'
import {
  applyRunPatch,
  collectRunPatch,
  createRun,
  isRunPatchEmpty,
  isRunAlreadyLanded,
  readRun,
  transitionRun,
  writeRun,
  type ApplyResult,
  type RunRecord,
  type Task,
} from './run.js'
import { trustWorktreeRoot } from './trust.js'
import { buildAssuranceState, evaluatePatchPolicy, recordVerificationEvidence } from './assurance.js'
import { appendHarnessEvent, readHarnessState, recordGateDecision, recordHarnessArtifact, transitionHarnessTask } from './harness-core.js'
import { compileAgentContext } from './agent-runtime.js'
import { BUILTIN_AGENT_PROMPTS, composeRolePrompt } from './agent-prompts.js'
import { parseDocument } from './spec.js'
import { pathInside, readText } from '../store/workspace.js'
import { attachSessionAgent, findSpecOpsSessionByRunId, updateSessionAgentStatus } from './session.js'

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
  const run = await createRun(workspace, tasks, backendKey, base, runCacheRoot, changeId, model)
  if (kode !== undefined) {
    // Pre-trust the worktree cache root so codebuddy won't block on
    // "trust this directory?" when starting in the git worktree.
    await trustWorktreeRoot(runCacheRoot)
    // Pass the prompt before spawn so codebuddy submits it as part of startup.
    try {
      const context = await compileAgentContext(run, 'builder')
      await recordHarnessArtifact(run.workspace_root, run.run_id, {
        kind: 'context', subject: context.task_id, producer: 'context-compiler', uri: null,
        content_hash: context.hash, source_commit: run.base_commit, inputs: [], metadata: { role: context.role, included_paths: context.included_paths, excluded: context.excluded },
      })
      const session = await kode.createSession(run.backend_key, run.worktree_path, promptForTask(run, context.content), undefined, run.model ?? undefined)
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

export function promptForTask(run: RunRecord, compiledContext?: string): string {
  const task = run.tasks[run.current_task]
  if (task === undefined) throw new SpecOpsError('task_missing', `Run ${run.run_id} has no current task`)
  const manifest = run.manifest
  const assignment = [
    `SpecOps task ${task.id}: ${task.title}`,
    '',
    compiledContext ?? task.prompt,
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
  return composeRolePrompt(run.agent_profiles.implementation.prompt ?? BUILTIN_AGENT_PROMPTS.implementation, assignment)
}

export async function verifyRun(
  run: RunRecord,
  options: { deferReviewAction?: boolean } = {},
): Promise<{ run: RunRecord; patch: string; files: string[]; results: VerifyResult[] }> {
  if (run.state === 'running') await transitionRun(run, 'awaiting_verify', { syncSession: !options.deferReviewAction })
  if (run.state !== 'awaiting_verify') throw new SpecOpsError('run_not_verifiable', `Run ${run.run_id} is ${run.state}`)
  const task = run.tasks[run.current_task]
  if (task === undefined) throw new SpecOpsError('task_missing', `Run ${run.run_id} has no current task`)
  const results: VerifyResult[] = []
  const verifyNames = [...new Set(task.verify)]
  for (const name of verifyNames) {
    const config = run.verify_snapshot[name]
    if (config === undefined) throw new SpecOpsError('verify_snapshot_missing', `Run snapshot has no verify: ${name}`)
    results.push(await runVerify(run.worktree_path, name, config))
  }
  const patch = await collectRunPatch(run)
  const verifiedCommit = await worktreeHead(run.worktree_path)
  const policyFindings = evaluatePatchPolicy(patch.files, patch.patch)
  const blockingPolicy = policyFindings.filter((item) => item.severity === 'error')
  const failedVerification = results.filter((item) => !item.ok)
  if (failedVerification.length > 0) {
    run.verify_results.push({ at: new Date().toISOString(), task_id: task.id, results })
    await writeRun(run)
    await recordGateDecision(run.workspace_root, run.run_id, 'task-verification', 'failed', failedVerification.map((item) => `${item.name} failed`).join('; '))
    throw new SpecOpsError('verification_gate_failed', failedVerification.map((item) => `${item.name} failed`).join('; '))
  }
  await recordGateDecision(run.workspace_root, run.run_id, 'task-verification', 'passed', 'All task verification commands passed')
  if (blockingPolicy.length > 0) {
    await recordGateDecision(run.workspace_root, run.run_id, 'patch-policy', 'failed', blockingPolicy.map((item) => item.message).join('; '))
    run.verify_results.push({ at: new Date().toISOString(), task_id: task.id, results, policy_findings: policyFindings })
    await writeRun(run)
    throw new SpecOpsError('policy_gate_failed', blockingPolicy.map((item) => item.message).join('; '))
  }
  await recordGateDecision(run.workspace_root, run.run_id, 'patch-policy', 'passed', 'No blocking patch policy findings')
  let evidenceSubjects = [run.change_id ?? task.id]
  if (run.change_id !== null) {
    try {
      const proposal = parseDocument(
        await readText(pathInside(run.workspace_root, '.specops', 'changes', run.change_id, 'proposal.md')),
        `.specops/changes/${run.change_id}/proposal.md`,
      )
      if ((proposal.frontmatter.targets?.length ?? 0) > 0) evidenceSubjects = proposal.frontmatter.targets!
    } catch { /* legacy or quick-run change without a proposal target */ }
  }
  for (const subject of evidenceSubjects) {
    await recordVerificationEvidence(run.workspace_root, subject, verifiedCommit, results, patch.files, run.worktree_path)
  }
  await recordHarnessArtifact(run.workspace_root, run.run_id, {
    kind: 'patch', subject: task.id, producer: 'run-loop', uri: `.specops/runs/${run.run_id}/output.patch`,
    content_hash: null, source_commit: verifiedCommit, inputs: [], metadata: { files: patch.files },
  })
  await recordHarnessArtifact(run.workspace_root, run.run_id, {
    kind: 'verification', subject: task.id, producer: 'specops-command-verifier', uri: null,
    content_hash: null, source_commit: verifiedCommit, inputs: [], metadata: { results },
  })
  run.verify_results.push({ at: new Date().toISOString(), task_id: task.id, results })
  await transitionRun(run, 'awaiting_review', { syncSession: !options.deferReviewAction })
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
  const assignment = [
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
  return composeRolePrompt(run.agent_profiles.review.prompt ?? BUILTIN_AGENT_PROMPTS.review, assignment)
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
  void config // retained for API compatibility; the Run owns the immutable profile snapshot
  const task = run.tasks[run.current_task]
  if (task === undefined) throw new SpecOpsError('task_missing', `Run ${run.run_id} has no current task`)
  const selection = run.agent_profiles.review
  const model = selection.model ?? undefined
  const agentModel = model ?? selection.backend
  const prompt = buildReviewPrompt(run, task, patch)

  let sessionId: number | null = null
  let result: ReviewResult
  try {
    // Headless: the review agent is a background reviewer the user never
    // interacts with directly. Suppressing the GUI tab keeps the auto-review
    // loop (up to max_iterations) from flashing a stream of kode tabs.
    const session = await kode.createAnalysisSession(selection.backend, run.worktree_path, prompt, model, true)
    sessionId = session.id
    const owner = await findSpecOpsSessionByRunId(run.workspace_root, run.run_id)
    if (owner !== null) {
      await attachSessionAgent(run.workspace_root, owner.id, {
        kode_session_id: session.id,
        session_uuid: session.session_uuid ?? null,
        backend_key: session.backend_key,
        model: model ?? null,
        purpose: 'review',
        status: session.status,
      })
    }
    const text = await waitForReviewOutput(kode, sessionId)
    result = extractReviewResult(text, agentModel)
  } catch {
    result = { at: new Date().toISOString(), agent_model: agentModel, blocker: false, summary: 'review inconclusive: agent session error', findings: [], inconclusive: true }
  } finally {
    if (sessionId !== null) {
      await kode.killSession(sessionId).catch(() => undefined)
      const owner = await findSpecOpsSessionByRunId(run.workspace_root, run.run_id)
      if (owner !== null) await updateSessionAgentStatus(run.workspace_root, owner.id, sessionId, 'exited')
    }
  }
  // Review can take minutes. Re-read before persisting so an old reviewer
  // cannot overwrite a newer accept/cancel/task transition with stale state.
  const latest = await readRun(run.workspace_root, run.run_id)
  latest.review_results.push(result)
  await recordHarnessArtifact(run.workspace_root, run.run_id, {
    kind: 'review', subject: task.id, producer: 'specops-review-agent', uri: null,
    content_hash: null, source_commit: await worktreeHead(run.worktree_path), inputs: [], metadata: { result },
  })
  await writeRun(latest)
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
    if (run.current_task + 1 < run.tasks.length) {
      if (kode === undefined || run.kode_session_id === null) {
        throw new SpecOpsError('kode_unavailable', 'starting the next scheduled task requires a connected kode session')
      }
      const completedTask = run.tasks[run.current_task]!
      await transitionHarnessTask(run.workspace_root, run.run_id, completedTask.id, 'completed', { iteration: run.iteration })
      run.current_task += 1
      run.iteration = 0
      await transitionRun(run, 'running')
      await kode.waitForReady(run.kode_session_id)
      const context = await compileAgentContext(run, 'builder')
      await recordHarnessArtifact(run.workspace_root, run.run_id, {
        kind: 'context', subject: context.task_id, producer: 'context-compiler', uri: null,
        content_hash: context.hash, source_commit: await worktreeHead(run.worktree_path), inputs: [], metadata: { role: context.role, included_paths: context.included_paths, excluded: context.excluded },
      })
      await kode.sendPrompt(run.kode_session_id, promptForTask(run, context.content))
      return run
    }
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
    await appendHarnessEvent(run.workspace_root, run.run_id, 'budget.exhausted', 'loop-orchestrator', {
      task_id: run.tasks[run.current_task]?.id ?? null,
      iteration: run.iteration,
      max_iterations: run.max_iterations,
    })
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

/**
 * Complete one scheduled implementation task and send the next task to the
 * same builder session. Task boundaries are scheduler progress; Run-level
 * verification and review happen only after the final task.
 */
export async function advanceToNextTask(run: RunRecord, kode: KodeClient): Promise<RunRecord> {
  if (run.state !== 'running') throw new SpecOpsError('run_not_running', `Run ${run.run_id} is ${run.state}`)
  if (run.kode_session_id === null) throw new SpecOpsError('kode_unavailable', 'starting the next scheduled task requires a connected kode session')
  if (run.current_task + 1 >= run.tasks.length) throw new SpecOpsError('task_missing', `Run ${run.run_id} has no next scheduled task`)

  const completedTask = run.tasks[run.current_task]!
  await transitionHarnessTask(run.workspace_root, run.run_id, completedTask.id, 'completed', { iteration: run.iteration })
  run.current_task += 1
  run.iteration = 0
  await writeRun(run)

  const nextTask = run.tasks[run.current_task]!
  await transitionHarnessTask(run.workspace_root, run.run_id, nextTask.id, 'running', {
    agent: run.backend_key,
    worktree: run.worktree_path,
    iteration: run.iteration,
  })
  await kode.waitForReady(run.kode_session_id)
  const context = await compileAgentContext(run, 'builder')
  await recordHarnessArtifact(run.workspace_root, run.run_id, {
    kind: 'context', subject: context.task_id, producer: 'context-compiler', uri: null,
    content_hash: context.hash, source_commit: await worktreeHead(run.worktree_path), inputs: [], metadata: { role: context.role, included_paths: context.included_paths, excluded: context.excluded },
  })
  await kode.sendPrompt(run.kode_session_id, promptForTask(run, context.content))
  return run
}

async function worktreeHead(worktree: string): Promise<string> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve, reject) => execFile('git', ['-C', worktree, 'rev-parse', 'HEAD'], (error, stdout) => {
    if (error) reject(error)
    else resolve(stdout.trim())
  }))
}

export async function applyCompletedRun(run: RunRecord): Promise<{ applied: boolean; reason?: string; commit?: string | undefined }> {
  if (run.state !== 'completed') throw new SpecOpsError('run_not_completed', `Run ${run.run_id} is ${run.state}`)
  await enforceSchedulerCompletion(run)
  await enforceRiskApproval(run)
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
  await enforceSchedulerCompletion(run)
  await enforceRiskApproval(run)
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
  for (const name of new Set(run.tasks.flatMap((task) => task.verify))) {
    const config = run.verify_snapshot[name]
    if (config === undefined) continue
    verifyResults.push(await runVerify(run.workspace_root, name, config))
  }
  const allOk = verifyResults.length === 0 || verifyResults.every((r) => r.ok)
  const appliedCommit = await worktreeHead(run.workspace_root)
  for (const subject of [run.change_id ?? run.tasks[run.current_task]?.id ?? run.run_id]) {
    await recordVerificationEvidence(run.workspace_root, subject, appliedCommit, verifyResults, [])
  }
  await recordHarnessArtifact(run.workspace_root, run.run_id, {
    kind: 'evidence', subject: run.change_id ?? run.run_id, producer: 'post-apply-verifier', uri: null,
    content_hash: null, source_commit: appliedCommit, inputs: [], metadata: { results: verifyResults, phase: 'post_apply' },
  })
  await recordGateDecision(run.workspace_root, run.run_id, 'post-apply-verification', allOk ? 'passed' : 'failed', allOk ? 'All post-apply verifies passed' : 'One or more post-apply verifies failed')
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

async function enforceRiskApproval(run: RunRecord): Promise<void> {
  const scan = await scanWorkspace(run.workspace_root)
  if (scan.data === undefined) return
  const assurance = await buildAssuranceState(run.workspace_root, scan.data)
  const proposal = run.change_id === null ? undefined : scan.data.documents.find((document) => document.id === run.change_id)
  const subjects = new Set([...(run.change_id === null ? [] : [run.change_id]), ...(proposal?.targets ?? [])])
  const requiringApproval = assurance.risk.filter((risk) => subjects.has(risk.subject) && risk.required_approval !== 'automatic')
  if (requiringApproval.length === 0) return
  const control = await readHarnessState(run.workspace_root, run.run_id)
  if (control?.gates.some((gate) => gate.id === 'risk-approval' && gate.status === 'passed')) return
  const reason = requiringApproval.map((risk) => `${risk.subject}: ${risk.level} (${risk.required_approval})`).join('; ')
  // `decideRun(..., "accept")` is the durable human review decision made from
  // the Review patch card. Medium-risk changes require exactly that review;
  // requiring a second, unreachable approval action at Apply time strands the
  // session in an endless apply -> 400 -> apply loop. Promote the persisted
  // acceptance to a passed risk gate before applying. Higher risk classes keep
  // their stronger design/plan gates and must not be implicitly approved here.
  if (humanReviewSatisfiesRiskApproval(run.decisions, requiringApproval)) {
    await recordGateDecision(run.workspace_root, run.run_id, 'risk-approval', 'passed', reason, 'human-review')
    return
  }
  await recordGateDecision(run.workspace_root, run.run_id, 'risk-approval', 'approval_required', reason)
  throw new SpecOpsError('risk_approval_required', `Human approval required before apply: ${reason}`)
}

export function humanReviewSatisfiesRiskApproval(
  decisions: Array<{ verdict: string }>,
  risks: Array<{ required_approval: string }>,
): boolean {
  return decisions.some((decision) => decision.verdict === 'accept')
    && risks.length > 0
    && risks.every((risk) => risk.required_approval === 'human_review')
}

async function enforceSchedulerCompletion(run: RunRecord): Promise<void> {
  const control = await readHarnessState(run.workspace_root, run.run_id)
  if (control === null) throw new SpecOpsError('harness_state_missing', `Run ${run.run_id} has no Harness state`)
  const incomplete = control.tasks.filter((task, index) => index < run.current_task && task.state !== 'completed')
  const future = control.tasks.filter((_, index) => index > run.current_task)
  if (incomplete.length > 0 || future.length > 0) {
    await recordGateDecision(run.workspace_root, run.run_id, 'completion-contract', 'failed', 'All scheduled tasks must complete before apply')
    throw new SpecOpsError('completion_contract_failed', 'All scheduled tasks must complete before apply')
  }
  await recordGateDecision(run.workspace_root, run.run_id, 'completion-contract', 'passed', 'All scheduled tasks reached review or completion')
}

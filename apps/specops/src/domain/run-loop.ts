import { randomUUID } from 'node:crypto'

import { SpecOpsError } from '../core/errors.js'
import type { ExecutionRuntime } from '../execution/runtime.js'
import type { ExecutionRequestOutcome, ExecutionTurnResult } from '../execution/types.js'
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
  runChangeEvidence,
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
import { buildSessionResumeContext, findSpecOpsSessionByRunId, readSpecOpsSession, updateSpecOpsSession } from './session.js'

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

export type RunExecutionRuntime = Pick<ExecutionRuntime, 'start' | 'load' | 'prompt' | 'close' | 'get'>

export type StageBoundPurpose = 'implement' | 'repair'

export interface RunTurnBinding {
  run_id: string
  task_id: string
  purpose: StageBoundPurpose
  request_id: string
  execution_id: string
  process_generation: number
  baseline_digest: string
}

export interface RunTurn {
  run: RunRecord
  binding: RunTurnBinding
  completion: Promise<ExecutionRequestOutcome<ExecutionTurnResult>>
}

async function promptStageBoundTurn(
  run: RunRecord,
  runtime: RunExecutionRuntime,
  identity: NonNullable<RunRecord['execution']>,
  purpose: StageBoundPurpose,
  taskId: string,
  text: string,
  freshContext = false,
): Promise<RunTurn> {
  const baseline = await runChangeEvidence(run)
  const requestId = randomUUID()
  const binding: RunTurnBinding = {
    run_id: run.run_id,
    task_id: taskId,
    purpose,
    request_id: requestId,
    execution_id: identity.execution_id,
    process_generation: identity.process_generation,
    baseline_digest: baseline.digest,
  }
  return {
    run,
    binding,
    completion: runtime.prompt(identity.execution_id, {
      requestId,
      text,
      metadata: {
        run_id: run.run_id,
        task_id: taskId,
        purpose,
        may_advance_stage: true,
        process_generation: identity.process_generation,
        fresh_context: freshContext,
      },
    }),
  }
}

export async function launchRun(
  workspace: string,
  tasks: Task[],
  backendKey: string,
  base: string,
  runCacheRoot?: string,
  model?: string,
  changeId: string | null = null,
): Promise<RunRecord> {
  return createRun(workspace, tasks, backendKey, base, runCacheRoot, changeId, model)
}

/** Bind a prepared Run to an existing SpecOps session before starting its first structured turn. */
export async function startRunExecution(
  run: RunRecord,
  runtime: RunExecutionRuntime,
  specopsSessionId: string,
  runCacheRoot?: string,
): Promise<RunTurn> {
  await trustWorktreeRoot(runCacheRoot)
  try {
    const context = await compileAgentContext(run, 'builder')
    await recordContextArtifact(run, context)
    const identity = await runtime.start({
      workspace: run.workspace_root,
      sessionId: specopsSessionId,
      runId: run.run_id,
      purpose: 'implement',
      backendKey: run.backend_key,
      cwd: run.worktree_path,
      ...(run.model === null ? {} : { model: run.model }),
    })
    run.execution = identity
    run.kode_session_id = null
    await writeRun(run)
    return promptStageBoundTurn(
      run,
      runtime,
      identity,
      'implement',
      context.task_id,
      promptForTask(run, context.content),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    run.state = 'failed'
    await writeRun(run)
    throw new SpecOpsError('execution_start_failed', `Failed to start structured execution: ${message}`)
  }
}

async function recordContextArtifact(run: RunRecord, context: Awaited<ReturnType<typeof compileAgentContext>>): Promise<void> {
  await recordHarnessArtifact(run.workspace_root, run.run_id, {
    kind: 'context', subject: context.task_id, producer: 'context-compiler', uri: null,
    content_hash: context.hash, source_commit: await worktreeHead(run.worktree_path), inputs: [],
    metadata: { role: context.role, included_paths: context.included_paths, excluded: context.excluded },
  })
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
  if (run.state !== 'awaiting_verify') throw new SpecOpsError('run_not_verifiable', `Run ${run.run_id} is ${run.state}`)
  if (run.current_task + 1 !== run.tasks.length) {
    throw new SpecOpsError('run_not_verifiable', `Run ${run.run_id} has unfinished scheduled tasks`)
  }
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
 * misbehaving reviewer — returns an explicit inconclusive result that callers
 * must route to a human/retry gate rather than treating as approval.
 * `patch` is reused from verifyRun's output to avoid re-running collectRunPatch
 * (which has a git add/commit side effect).
 */
export async function runReview(
  run: RunRecord,
  runtime: RunExecutionRuntime,
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
  const owner = await findSpecOpsSessionByRunId(run.workspace_root, run.run_id)
  if (owner === null) throw new SpecOpsError('session_missing', `Run ${run.run_id} has no SpecOps session`)

  let executionId: string | null = null
  let result: ReviewResult
  try {
    const identity = await runtime.start({
      workspace: run.workspace_root,
      sessionId: owner.id,
      purpose: 'review',
      backendKey: selection.backend,
      cwd: run.worktree_path,
      ...(model === undefined ? {} : { model }),
    })
    executionId = identity.execution_id
    const outcome = await runtime.prompt(identity.execution_id, {
      requestId: randomUUID(),
      text: prompt,
      metadata: { run_id: run.run_id, task_id: task.id, purpose: 'review' },
    })
    if (outcome.outcome === 'outcome_unknown') {
      result = { at: new Date().toISOString(), agent_model: agentModel, blocker: false, summary: `review inconclusive: outcome unknown (${outcome.error.message})`, findings: [], inconclusive: true }
    } else {
      const session = await readSpecOpsSession(run.workspace_root, owner.id)
      const text = session.transcript
        .filter((entry) => entry.execution_id === identity.execution_id && entry.role === 'agent' && (entry.kind ?? 'text') === 'text')
        .map((entry) => entry.text)
        .join('\n')
      result = extractReviewResult(text, agentModel)
    }
  } catch {
    result = { at: new Date().toISOString(), agent_model: agentModel, blocker: false, summary: 'review inconclusive: agent execution error', findings: [], inconclusive: true }
  } finally {
    if (executionId !== null) await runtime.close(executionId).catch(() => undefined)
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

export interface RunDecisionResult {
  run: RunRecord
  turn?: RunTurn
}

export async function decideRun(
  run: RunRecord,
  verdict: 'accept' | 'reject' | 'feedback',
  note: string,
  runtime?: RunExecutionRuntime,
): Promise<RunDecisionResult> {
  if (run.state !== 'awaiting_review') throw new SpecOpsError('run_not_reviewable', `Run ${run.run_id} is ${run.state}`)
  run.decisions.push({ at: new Date().toISOString(), verdict, note })
  if (verdict === 'accept') {
    if (run.current_task + 1 < run.tasks.length) {
      if (runtime === undefined) throw new SpecOpsError('execution_unavailable', 'starting the next scheduled task requires a structured execution runtime')
      await transitionRun(run, 'running')
      const turn = await advanceToNextTask(run, runtime)
      return { run: turn.run, turn }
    }
    await transitionRun(run, 'completed')
    return { run }
  }
  if (verdict === 'reject') {
    await transitionRun(run, 'cancelled')
    return { run }
  }
  run.iteration += 1
  if (run.iteration >= run.max_iterations) {
    await writeRun(run)
    await appendHarnessEvent(run.workspace_root, run.run_id, 'budget.exhausted', 'loop-orchestrator', {
      task_id: run.tasks[run.current_task]?.id ?? null,
      iteration: run.iteration,
      max_iterations: run.max_iterations,
    })
    throw new SpecOpsError('max_iterations', `Run ${run.run_id} reached max_iterations`)
  }
  if (runtime === undefined) throw new SpecOpsError('execution_unavailable', 'feedback requires a structured execution runtime')
  await transitionRun(run, 'running')
  const owner = await requireRunSession(run)
  const resumed = await ensureRunExecution(run, runtime, owner.id, 'repair')
  const feedback = `SpecOps review feedback:\n\n${note}\n\nRevise the same task and report when ready for verification.`
  const taskId = run.tasks[run.current_task]?.id
  if (taskId === undefined) throw new SpecOpsError('task_missing', `Run ${run.run_id} has no current task`)
  const completion = await promptStageBoundTurn(
    run,
    runtime,
    resumed.identity,
    'repair',
    taskId,
    resumed.freshContext === undefined ? feedback : `${resumed.freshContext}\n\n${feedback}`,
    resumed.freshContext !== undefined,
  )
  return { run: completion.run, turn: completion }
}

/**
 * Complete one scheduled implementation task and send the next task to the
 * same structured execution. Task boundaries are scheduler progress; Run-level
 * verification and review happen only after the final task.
 */
export async function advanceToNextTask(run: RunRecord, runtime: RunExecutionRuntime): Promise<RunTurn> {
  if (run.state !== 'running') throw new SpecOpsError('run_not_running', `Run ${run.run_id} is ${run.state}`)
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
  const context = await compileAgentContext(run, 'builder')
  await recordContextArtifact(run, context)
  const owner = await requireRunSession(run)
  const resumed = await ensureRunExecution(run, runtime, owner.id, 'implement')
  const prompt = promptForTask(run, context.content)
  return promptStageBoundTurn(
    run,
    runtime,
    resumed.identity,
    'implement',
    nextTask.id,
    resumed.freshContext === undefined ? prompt : `${resumed.freshContext}\n\n${prompt}`,
    resumed.freshContext !== undefined,
  )
}

export async function resumeRunExecution(
  run: RunRecord,
  runtime: RunExecutionRuntime,
  specopsSessionId: string,
): Promise<RunTurn> {
  if (run.state !== 'running') throw new SpecOpsError('run_not_running', `Run ${run.run_id} is ${run.state}`)
  const task = run.tasks[run.current_task]
  if (task === undefined) throw new SpecOpsError('task_missing', `Run ${run.run_id} has no current task`)
  const purpose: StageBoundPurpose = run.iteration > 0 ? 'repair' : 'implement'
  const context = await compileAgentContext(run, 'builder')
  await recordContextArtifact(run, context)
  const resumed = await ensureRunExecution(run, runtime, specopsSessionId, purpose)
  const latestFeedback = [...run.decisions].reverse().find((decision) => decision.verdict === 'feedback')?.note
  const assignment = [
    'Resume the interrupted SpecOps stage-bound turn.',
    promptForTask(run, context.content),
    ...(purpose === 'repair' && latestFeedback !== undefined
      ? ['', 'Latest blocking review feedback:', latestFeedback]
      : []),
  ].join('\n')
  return promptStageBoundTurn(
    run,
    runtime,
    resumed.identity,
    purpose,
    task.id,
    resumed.freshContext === undefined ? assignment : `${resumed.freshContext}\n\n${assignment}`,
    resumed.freshContext !== undefined,
  )
}

async function requireRunSession(run: RunRecord) {
  const owner = await findSpecOpsSessionByRunId(run.workspace_root, run.run_id)
  if (owner === null) throw new SpecOpsError('session_missing', `Run ${run.run_id} has no SpecOps session`)
  return owner
}

async function ensureRunExecution(
  run: RunRecord,
  runtime: RunExecutionRuntime,
  sessionId: string,
  purpose: 'implement' | 'repair',
): Promise<{ identity: NonNullable<RunRecord['execution']>; freshContext?: string }> {
  const existing = run.execution
  if (existing !== null && runtime.get(existing.execution_id) !== undefined) return { identity: existing }

  // CodeBuddy advertises ACP session/load but fails it in real sidecar
  // restarts. Its durable Run context is sufficient to continue safely, so
  // start a fresh ACP session instead of exposing that unreliable load path.
  if (existing !== null && existing.transport !== 'legacy_kode_pty'
    && existing.transport !== 'codebuddy_acp' && existing.native_session_id !== null) {
    try {
      const identity = await runtime.load({
        workspace: run.workspace_root,
        sessionId,
        runId: run.run_id,
        purpose,
        backendKey: run.backend_key,
        cwd: run.worktree_path,
        executionId: existing.execution_id,
        nativeSessionId: existing.native_session_id,
        ...(run.model === null ? {} : { model: run.model }),
      })
      run.execution = identity
      run.kode_session_id = null
      await writeRun(run)
      return { identity }
    } catch {
      // Native resume is best-effort. A new structured process receives the
      // durable session/run context below; PTY fallback is intentionally forbidden.
    }
  }

  if (!new Set(['codebuddy', 'codex', 'claude', 'claude-internal']).has(run.backend_key)) {
    throw new SpecOpsError('unsupported_execution_backend', `Backend ${run.backend_key} has no structured execution transport`)
  }
  const session = await readSpecOpsSession(run.workspace_root, sessionId)
  const identity = await runtime.start({
    workspace: run.workspace_root,
    sessionId,
    runId: run.run_id,
    purpose,
    backendKey: run.backend_key,
    cwd: run.worktree_path,
    ...(run.model === null ? {} : { model: run.model }),
    metadata: { resumed_with_fresh_context: true },
  })
  run.execution = identity
  run.kode_session_id = null
  await writeRun(run)
  await updateSpecOpsSession(run.workspace_root, sessionId, (record) => {
    record.execution.last_reconciled_at = new Date().toISOString()
    record.execution.last_error = 'Native session resume was unavailable; execution continued with fresh durable context.'
  })
  return { identity, freshContext: buildSessionResumeContext(session) }
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

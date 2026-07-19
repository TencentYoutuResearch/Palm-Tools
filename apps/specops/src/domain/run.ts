import { execFile as execFileCallback, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { promisify } from 'node:util'

import { SpecOpsError } from '../core/errors.js'
import { loadConfig, resolveAgentSelection, type VerifyConfig } from './config.js'
import {
  resolveAgentBackendProfile,
  workflowKindForDocumentKind,
  workflowKindForWorkType,
  type RunManifest,
} from './harness.js'
import { parseDocument, type DocumentKind } from './spec.js'
import { atomicWrite, exists, pathInside, resolveGitWorkspace } from '../store/workspace.js'
import {
  findSpecOpsSessionByRunId,
  legacyExecutionIdentity,
  updateSpecOpsSession,
  type ExecutionIdentity,
  type RequiredAction,
  type SpecOpsPhase,
  type SpecOpsSessionState,
} from './session.js'
import { appendHarnessEvent, initializeHarnessRun, readHarnessState, transitionHarnessLoop, transitionHarnessTask } from './harness-core.js'
import { captureEnvironment } from './environment.js'
import { cancelActionableInteractions, enqueueInteraction } from './interactions.js'
import { resolveAgentPrompt } from './agent-prompts.js'

const execFile = promisify(execFileCallback)

export type RunState = 'created' | 'preparing' | 'running' | 'awaiting_verify' | 'awaiting_review' | 'applying' | 'applied' | 'applied_failed' | 'failed' | 'completed' | 'cancelled'

export interface Task {
  id: string
  title: string
  prompt: string
  verify: string[]
  /** Dependency ids form a DAG; tasks are topologically ordered before launch. */
  depends_on?: string[]
}

export interface RunDecision {
  at: string
  verdict: 'accept' | 'reject' | 'feedback'
  note: string
}

export interface RunRecord {
  schema_version: 1
  run_id: string
  state: RunState
  workspace_root: string
  worktree_path: string
  base_commit: string
  /** Branch name created for this Run's worktree (`specops/run-<id8>`). Empty for legacy Runs created before branch-based apply. */
  branch: string
  /** HEAD of the main workspace right before the apply merge. Null until a merge has been performed. */
  pre_apply_commit: string | null
  /**
   * id of the SpecOps change proposal this Run implements, if any. Mirrors the
   * `id` field in `.specops/changes/<id>/proposal.md` frontmatter. Null for
   * quick-runs and legacy Runs created before this field existed — apply
   * paths skip proposal-status updates when null.
   */
  change_id: string | null
  backend_key: string
  /** Immutable model selection for implementation/repair. Null uses backend default. */
  model: string | null
  /** Immutable role selections. Existing runs do not drift when specops.toml changes. */
  agent_profiles: {
    implementation: { backend: string; model: string | null; prompt?: string; prompt_source?: string }
    review: { backend: string; model: string | null; prompt?: string; prompt_source?: string }
  }
  /** Current implementation attachment; kode_session_id remains a legacy mirror. */
  execution: ExecutionIdentity | null
  kode_session_id: number | null
  tasks: Task[]
  current_task: number
  iteration: number
  max_iterations: number
  verify_snapshot: Record<string, VerifyConfig>
  verify_results: unknown[]
  review_results: unknown[]
  decisions: RunDecision[]
  manifest: RunManifest
  started_at: string
  updated_at: string
}

const TRANSITIONS: Record<RunState, RunState[]> = {
  created: ['preparing', 'cancelled'],
  preparing: ['running', 'failed', 'cancelled'],
  running: ['awaiting_verify', 'failed', 'cancelled'],
  awaiting_verify: ['awaiting_review', 'running', 'failed', 'cancelled'],
  awaiting_review: ['running', 'applying', 'completed', 'cancelled'],
  // 'awaiting_review' is a legal fallback: when applyRunPatch throws during a
  // pre-merge check (dirty workspace, conflict, empty patch) the run must
  // return to a reviewable state instead of being stranded in 'applying'.
  applying: ['applied', 'applied_failed', 'failed', 'cancelled', 'awaiting_review'],
  applied: ['completed', 'applied_failed', 'cancelled'],
  // 'awaiting_review' lets the user retry apply+verify after a verify failure.
  applied_failed: ['running', 'applied', 'cancelled', 'awaiting_review'],
  failed: ['running', 'cancelled'],
  // Accepted Runs sit in 'completed' while the UI waits for apply_patch.
  // Apply-with-verify must still be able to enter the apply pipeline from there.
  completed: ['applying'],
  cancelled: [],
}

function cacheRoot(): string {
  if (process.env.SPECOPS_CACHE_ROOT) return path.resolve(process.env.SPECOPS_CACHE_ROOT)
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'kode', 'specops')
  return path.join(os.homedir(), '.cache', 'kode', 'specops')
}

function runFile(workspace: string, runId: string): string {
  return pathInside(workspace, '.specops', 'runs', runId, 'run.json')
}

async function git(workspace: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', ['-C', workspace, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return stdout.trim()
}

async function gitOk(workspace: string, args: string[]): Promise<boolean> {
  try {
    await execFile('git', ['-C', workspace, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return true
  } catch {
    return false
  }
}

/**
 * Write potentially large git output directly to disk. `execFile` buffers all
 * stdout and aborts once maxBuffer is reached, which made valid Runs with a
 * large binary/generated diff impossible to review or apply.
 */
async function gitToFile(workspace: string, args: string[], destination: string): Promise<void> {
  const temp = `${destination}.${process.pid}.${randomUUID()}.tmp`
  const child = spawn('git', ['-C', workspace, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  const output = createWriteStream(temp, { encoding: 'utf8', mode: 0o600 })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 64 * 1024) stderr += chunk.slice(0, 64 * 1024 - stderr.length)
  })
  child.stdout.pipe(output)

  try {
    const exit = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (code === 0) resolve()
        else reject(new SpecOpsError(
          'git_failed',
          `git ${args[0] ?? ''} failed${signal === null ? ` with exit code ${code}` : ` from signal ${signal}`}: ${stderr.trim()}`,
        ))
      })
    })
    await Promise.all([exit, finished(output)])
    await rename(temp, destination)
  } catch (error) {
    child.kill()
    output.destroy()
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Short, git-safe branch name for a Run: `specops/run-<first 8 hex of uuid>`. */
function branchNameFor(runId: string): string {
  const short = runId.replace(/-/g, '').slice(0, 8)
  return `specops/run-${short}`
}

/** Conventional Commits type for a proposal kind. Unknown/spec/change → chore. */
function commitTypeForKind(kind: DocumentKind | undefined): string {
  switch (kind) {
    case 'feature': return 'feat'
    case 'bug': return 'fix'
    case 'refactor': return 'refactor'
    case 'investigation': return 'docs'
    default: return 'chore'
  }
}

/** Short id for trailers/logs: first 8 hex of the uuid (no dashes). */
function shortRunId(runId: string): string {
  return runId.replace(/-/g, '').slice(0, 8)
}

/** Truncate to fit Conventional Commits subject line (≤72 chars), appending `…` when cut. */
function truncateHeader(header: string, max = 72): string {
  if (header.length <= max) return header
  return `${header.slice(0, max - 1)}…`
}

/**
 * Build a human-readable Conventional Commits message for a Run's worktree
 * commit. Prefers the linked proposal's title; falls back to the current task
 * title; finally to a literal `specops run <short-id>`. Body carries
 * machine-parseable trailers (Run-Id, Change-Id, Task).
 */
async function runCommitMessage(run: RunRecord): Promise<string> {
  const shortId = shortRunId(run.run_id)
  const currentTask = run.tasks[run.current_task]?.title
  let type = 'chore'
  let subject = ''
  let changeId = 'quick-run'

  if (run.change_id) {
    changeId = run.change_id
    const proposalPath = pathInside(
      run.workspace_root,
      '.specops',
      'changes',
      run.change_id,
      'proposal.md',
    )
    try {
      const content = await readFile(proposalPath, 'utf8')
      const doc = parseDocument(content, proposalPath)
      type = commitTypeForKind(doc.frontmatter.kind)
      subject = doc.frontmatter.title
    } catch {
      // Proposal file missing or unparseable — fall through to subject fallback.
    }
  }

  if (!subject) {
    subject = currentTask
      ? `specops run ${shortId} — ${currentTask}`
      : `specops run ${shortId}`
  }

  const header = truncateHeader(`${type}: ${subject}`)
  const taskLine = currentTask ?? ''
  return `${header}\n\nRun-Id: ${run.run_id}\nChange-Id: ${changeId}\nTask: ${taskLine}`
}

function normalizeRunExecution(run: RunRecord): void {
  if (typeof run.kode_session_id !== 'number') run.kode_session_id = null
  if (run.execution == null || run.execution.transport === 'legacy_kode_pty') {
    run.execution = run.kode_session_id === null
      ? null
      : legacyExecutionIdentity(run.kode_session_id, run.backend_key)
  }
}

export async function readRun(workspaceInput: string, runId: string): Promise<RunRecord> {
  const workspace = await resolveGitWorkspace(workspaceInput)
  if (!/^[0-9a-f-]{36}$/.test(runId)) throw new SpecOpsError('invalid_run_id', `invalid run id: ${runId}`)
  const run = JSON.parse(await readFile(runFile(workspace, runId), 'utf8')) as RunRecord
  normalizeRunExecution(run)
  // Backfill review_results for runs created before auto-review existed, so
  // callers can always `.push()` without an undefined guard.
  if (!Array.isArray(run.review_results)) run.review_results = []
  if (run.model === undefined) run.model = null
  if (run.agent_profiles === undefined) {
    const config = await loadConfig(workspace)
    const review = resolveAgentSelection(config, 'review')
    const [implementationPrompt, reviewPrompt] = await Promise.all([
      resolveAgentPrompt(workspace, config, 'implementation'),
      resolveAgentPrompt(workspace, config, 'review'),
    ])
    run.agent_profiles = {
      implementation: { backend: run.backend_key, model: run.model, prompt: implementationPrompt.content, prompt_source: implementationPrompt.source },
      review: { backend: review.backend, model: review.model ?? null, prompt: reviewPrompt.content, prompt_source: reviewPrompt.source },
    }
  }
  for (const role of ['implementation', 'review'] as const) {
    const profile = run.agent_profiles[role]
    if (profile.prompt === undefined || profile.prompt_source === undefined) {
      const config = await loadConfig(workspace)
      const prompt = await resolveAgentPrompt(workspace, config, role)
      profile.prompt = prompt.content
      profile.prompt_source = prompt.source
    }
  }
  // Backfill change_id for runs created before this field existed (legacy
  // run.json files have no change_id — they behave as quick-runs: apply paths
  // skip proposal-status updates for them).
  if (run.change_id === undefined) run.change_id = null
  if (run.manifest === undefined) {
    const config = await loadConfig(workspace)
    run.manifest = await buildRunManifest(run, config)
  }
  await initializeHarnessRun(workspace, run.run_id, run.tasks, run.max_iterations)
  return run
}

export async function writeRun(run: RunRecord): Promise<void> {
  normalizeRunExecution(run)
  run.updated_at = new Date().toISOString()
  await atomicWrite(runFile(run.workspace_root, run.run_id), `${JSON.stringify(run, null, 2)}\n`)
}

export async function createRun(
  workspaceInput: string,
  tasks: Task[],
  backendKey: string,
  base = 'HEAD',
  runCacheRoot = cacheRoot(),
  changeId: string | null = null,
  model?: string,
): Promise<RunRecord> {
  if (tasks.length === 0) throw new SpecOpsError('invalid_tasks', 'a Run requires at least one task')
  tasks = orderTaskDag(tasks)
  const workspace = await resolveGitWorkspace(workspaceInput)
  const config = await loadConfig(workspace)
  // The proposal is the authoritative verification contract. UI-created tasks
  // may omit their per-task verify arrays (the document-to-task conversion used
  // to do exactly that), but that must not silently turn a verified work item
  // into a Run whose manifest says "Required verification: none". Run-level
  // verification happens after the final task, so inherit proposal verifies
  // there while preserving any explicitly requested task checks.
  if (changeId !== null) {
    const proposal = pathInside(workspace, '.specops', 'changes', changeId, 'proposal.md')
    if (await exists(proposal)) {
      const document = parseDocument(await readFile(proposal, 'utf8'), proposal)
      const required = document.frontmatter.verifies ?? []
      if (required.length > 0) {
        const last = tasks.at(-1)!
        last.verify = [...new Set([...last.verify, ...required])]
      }
    }
  }
  let baseCommit: string
  try {
    baseCommit = await git(workspace, ['rev-parse', '--verify', `${base}^{commit}`])
  } catch {
    // Empty repo (no commits yet) — git worktree add requires a base commit.
    throw new SpecOpsError(
      'no_base_commit',
      `Cannot start a Run: '${base}' does not resolve to a commit in ${workspace}. ` +
        'The repository has no commits yet — make an initial commit first (e.g. `git add -A && git commit -m "init"`).',
    )
  }
  const runId = randomUUID()
  const repoHash = createHash('sha256').update(workspace).digest('hex').slice(0, 16)
  const worktreePath = path.join(runCacheRoot, 'worktrees', repoHash, runId)
  await mkdir(path.dirname(worktreePath), { recursive: true })
  const branch = branchNameFor(runId)
  const now = new Date().toISOString()
  const verifyNames = new Set(tasks.flatMap((task) => task.verify))
  const verifySnapshot: Record<string, VerifyConfig> = {}
  for (const name of verifyNames) {
    const entry = config.verify[name]
    if (entry === undefined) {
      const defined = Object.keys(config.verify)
      const available = defined.length > 0 ? `Defined verifies: ${defined.join(', ')}.` : 'No verifies are defined yet.'
      throw new SpecOpsError(
        'unknown_verify',
        `Task references verify "${name}" which is not defined in specops.toml. ${available} ` +
          `Add a [verify.${name}] section to specops.toml (with a command array), or remove "${name}" from the task's verify list.`,
      )
    }
    verifySnapshot[name] = entry
  }
  const backend = await resolveAgentBackendProfile(workspace, backendKey, config.agent_backends[backendKey])
  const reviewAgent = resolveAgentSelection(config, 'review')
  const [implementationPrompt, reviewPrompt] = await Promise.all([
    resolveAgentPrompt(workspace, config, 'implementation'),
    resolveAgentPrompt(workspace, config, 'review'),
  ])
  const workflowKind = await workflowKindForChange(workspace, changeId)
  const manifest: RunManifest = {
    schema_version: 1,
    run_id: runId,
    created_at: now,
    workflow: { kind: workflowKind, stages: [...config.workflows[workflowKind].stages] },
    project_profiles: [...config.project.profiles],
    backend: { key: backendKey, plugin: backend.plugin, capabilities: [...backend.capabilities] },
    scope: {
      base_commit: baseCommit,
      change_id: changeId,
      task_ids: tasks.map((task) => task.id),
    },
    verification: { required: [...verifyNames].sort() },
    limits: { max_iterations: 8 },
    environment: await captureEnvironment(workspace, baseCommit),
  }
  const run: RunRecord = {
    schema_version: 1,
    run_id: runId,
    state: 'created',
    workspace_root: workspace,
    worktree_path: worktreePath,
    base_commit: baseCommit,
    branch,
    pre_apply_commit: null,
    change_id: changeId,
    backend_key: backendKey,
    model: model ?? null,
    agent_profiles: {
      implementation: { backend: backendKey, model: model ?? null, prompt: implementationPrompt.content, prompt_source: implementationPrompt.source },
      review: { backend: reviewAgent.backend, model: reviewAgent.model ?? null, prompt: reviewPrompt.content, prompt_source: reviewPrompt.source },
    },
    execution: null,
    kode_session_id: null,
    tasks,
    current_task: 0,
    iteration: 0,
    max_iterations: 8,
    verify_snapshot: verifySnapshot,
    verify_results: [],
    review_results: [],
    decisions: [],
    manifest,
    started_at: now,
    updated_at: now,
  }
  await writeRun(run)
  await initializeHarnessRun(workspace, runId, tasks, run.max_iterations)
  await transitionRun(run, 'preparing')
  try {
    // Branch-based worktree: one Run = one branch. apply later merges this
    // branch into the main workspace instead of dribbling a patch through.
    await execFile('git', ['-C', workspace, 'worktree', 'add', '-b', branch, worktreePath, baseCommit])
    await transitionRun(run, 'running')
    return run
  } catch (error) {
    run.state = 'failed'
    await writeRun(run)
    throw error
  }
}

export function orderTaskDag(tasks: Task[]): Task[] {
  const byId = new Map<string, Task>()
  for (const task of tasks) {
    if (byId.has(task.id)) throw new SpecOpsError('invalid_tasks', `duplicate task id: ${task.id}`)
    byId.set(task.id, task)
  }
  for (const task of tasks) for (const dependency of task.depends_on ?? []) {
    if (!byId.has(dependency)) throw new SpecOpsError('invalid_tasks', `task ${task.id} depends on unknown task: ${dependency}`)
  }
  const ordered: Task[] = []
  const visiting = new Set<string>(); const visited = new Set<string>()
  const visit = (task: Task): void => {
    if (visited.has(task.id)) return
    if (visiting.has(task.id)) throw new SpecOpsError('invalid_tasks', `task dependency cycle includes: ${task.id}`)
    visiting.add(task.id)
    for (const dependency of task.depends_on ?? []) visit(byId.get(dependency)!)
    visiting.delete(task.id); visited.add(task.id); ordered.push(task)
  }
  for (const task of tasks) visit(task)
  return ordered
}

async function workflowKindForChange(workspace: string, changeId: string | null) {
  if (changeId === null) return 'feature' as const
  try {
    const proposal = pathInside(workspace, '.specops', 'changes', changeId, 'proposal.md')
    const document = parseDocument(await readFile(proposal, 'utf8'), proposal)
    if (document.frontmatter.document_class === 'normative') return workflowKindForDocumentKind('spec')
    return workflowKindForWorkType(document.frontmatter.workflow_profile ?? document.frontmatter.work_type ?? document.frontmatter.kind)
  } catch (error) {
    if (error instanceof SpecOpsError && error.code === 'workflow_not_applicable') throw error
    return 'feature' as const
  }
}

async function buildRunManifest(run: RunRecord, config: Awaited<ReturnType<typeof loadConfig>>): Promise<RunManifest> {
  const backend = await resolveAgentBackendProfile(run.workspace_root, run.backend_key, config.agent_backends[run.backend_key])
  const workflowKind = await workflowKindForChange(run.workspace_root, run.change_id)
  return {
    schema_version: 1,
    run_id: run.run_id,
    created_at: run.started_at,
    workflow: { kind: workflowKind, stages: [...config.workflows[workflowKind].stages] },
    project_profiles: [...config.project.profiles],
    backend: { key: run.backend_key, plugin: backend.plugin, capabilities: [...backend.capabilities] },
    scope: {
      base_commit: run.base_commit,
      change_id: run.change_id,
      task_ids: run.tasks.map((task) => task.id),
    },
    verification: { required: Object.keys(run.verify_snapshot).sort() },
    limits: { max_iterations: run.max_iterations },
    environment: await captureEnvironment(run.workspace_root, run.base_commit),
  }
}

export async function transitionRun(run: RunRecord, next: RunState, options: { syncSession?: boolean } = {}): Promise<void> {
  if (!TRANSITIONS[run.state].includes(next)) {
    throw new SpecOpsError('invalid_run_transition', `cannot transition Run ${run.run_id} from ${run.state} to ${next}`)
  }
  run.state = next
  await writeRun(run)
  await appendHarnessEvent(run.workspace_root, run.run_id, 'run.transitioned', 'run-state-machine', {
    state: next,
    task_id: run.tasks[run.current_task]?.id ?? null,
    iteration: run.iteration,
  })
  const task = run.tasks[run.current_task]
  if (task !== undefined) {
    if (next === 'running') {
      await transitionHarnessTask(run.workspace_root, run.run_id, task.id, 'running', { agent: run.backend_key, worktree: run.worktree_path, iteration: run.iteration })
      await transitionHarnessLoop(run.workspace_root, run.run_id, 'build', 'running', task.id)
    } else if (next === 'awaiting_verify') {
      await transitionHarnessTask(run.workspace_root, run.run_id, task.id, 'verifying', { iteration: run.iteration })
      await transitionHarnessLoop(run.workspace_root, run.run_id, 'build', 'completed', task.id)
      await transitionHarnessLoop(run.workspace_root, run.run_id, 'verify_repair', 'running', task.id)
    } else if (next === 'awaiting_review') {
      // Apply failures legally return a Run from `applying` to
      // `awaiting_review`. The scheduler task may already be completed after
      // the user accepted it; never regress that terminal task state merely
      // to restore the Run-level review/apply controls.
      const harness = await readHarnessState(run.workspace_root, run.run_id)
      const scheduledTask = harness?.tasks.find((item) => item.id === task.id)
      if (scheduledTask?.state !== 'completed') {
        await transitionHarnessTask(run.workspace_root, run.run_id, task.id, 'reviewing', { iteration: run.iteration })
      }
      await transitionHarnessLoop(run.workspace_root, run.run_id, 'verify_repair', 'waiting', task.id)
    } else if (next === 'completed') {
      await transitionHarnessTask(run.workspace_root, run.run_id, task.id, 'completed', { iteration: run.iteration })
      await transitionHarnessLoop(run.workspace_root, run.run_id, 'verify_repair', 'completed', task.id)
    } else if (next === 'failed' || next === 'applied_failed') {
      await transitionHarnessTask(run.workspace_root, run.run_id, task.id, 'failed', { iteration: run.iteration })
      await transitionHarnessLoop(run.workspace_root, run.run_id, 'verify_repair', 'failed', task.id)
    } else if (next === 'cancelled') {
      await transitionHarnessTask(run.workspace_root, run.run_id, task.id, 'cancelled', { iteration: run.iteration })
    }
  }
  // Best-effort: keep the linked SpecOps session's phase/state in sync with
  // the Run. Session metadata must never block the Run state machine — any
  // failure (no linked session, disk error, terminal session) is swallowed.
  if (options.syncSession !== false) {
    await syncSessionPhaseForRun(run).catch((error) => {
      console.warn(`[specops] session phase sync failed for run ${run.run_id}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}

/**
 * Map a Run's new state to the SpecOps session phase/state/required_action
 * and apply that update to the linked session (if any).
 *
 * - `created`/`preparing` are pre-launch — sessions are normally bound after
 *   `createRun` returns, so there is nothing to sync yet.
 * - `applying`/`applied` are transient apply-pipeline states. The session
 *   stays in its pre-apply phase (`review` or `apply_patch`) while the merge
 *   is in flight; the visible end states (`completed`/`applied_failed`) carry
 *   their own mapping below.
 * - Terminal sessions (`closed`/`completed`/`failed`/`cancelled`) are never
 *   resurrected by a Run transition — this prevents regressing an already-
 *   finished session when a Run's terminal state is reached after the session
 *   was closed (e.g. `applied → cancelled`).
 */
async function syncSessionPhaseForRun(run: RunRecord): Promise<void> {
  const update = await sessionUpdateForRunState(run)
  if (update === null) return
  const session = await findSpecOpsSessionByRunId(run.workspace_root, run.run_id)
  if (session === null) return
  if (isTerminalSessionState(session.state)) return
  await updateSpecOpsSession(run.workspace_root, session.id, (record) => {
    record.phase = update.phase
    record.state = update.state
    if (run.state === 'running') {
      cancelActionableInteractions(record, ['run_verify', 'human_review', 'resume'], { reason: 'run_resumed' })
      return
    }
    if (run.state === 'awaiting_verify') {
      cancelActionableInteractions(record, ['human_review', 'apply', 'resume'], { reason: 'verification_required' })
      const task = run.tasks[run.current_task]
      enqueueInteraction(record, {
        kind: 'run_verify',
        source: 'system',
        idempotency_key: `run_verify:${run.run_id}:${task?.id ?? 'unknown'}:${run.iteration}`,
        payload: { run_id: run.run_id },
      })
      return
    }
    if (run.state === 'awaiting_review') {
      cancelActionableInteractions(record, ['run_verify', 'apply', 'resume'], { reason: 'verification_completed' })
      enqueueInteraction(record, {
        kind: 'human_review',
        source: 'system',
        idempotency_key: `human_review:${run.run_id}:${run.current_task}:${run.review_results.length}`,
        payload: {
          run_id: run.run_id,
          patch_files: update.required_action?.kind === 'review' ? update.required_action.patch_files : [],
          review_note: update.required_action?.kind === 'review' ? update.required_action.review_note ?? null : null,
        },
      })
      return
    }
    if (run.state === 'completed' || run.state === 'applied_failed') {
      cancelActionableInteractions(record, ['run_verify', 'human_review', 'resume'], { reason: 'review_completed' })
      enqueueInteraction(record, {
        kind: 'apply',
        source: 'system',
        idempotency_key: `apply:${run.run_id}:${run.state}`,
        payload: { run_id: run.run_id },
      })
      return
    }
    record.required_action = update.required_action
  })
}

function isTerminalSessionState(state: SpecOpsSessionState): boolean {
  return state === 'closed' || state === 'completed' || state === 'failed' || state === 'cancelled'
}

/**
 * Compute the SpecOps session phase/state/required_action that should follow
 * a Run state transition. Returns null when the transition should leave the
 * session untouched (pre-launch or transient apply-pipeline states).
 */
async function sessionUpdateForRunState(run: RunRecord): Promise<{
  phase: SpecOpsPhase
  state: SpecOpsSessionState
  required_action: RequiredAction | null
} | null> {
  switch (run.state) {
    case 'created':
    case 'preparing':
      return null
    case 'running':
      return { phase: 'run_in_worktree', state: 'active', required_action: null }
    case 'awaiting_verify':
      return { phase: 'verify', state: 'awaiting_user', required_action: { kind: 'verify' } }
    case 'awaiting_review': {
      const files = await changedFilesForRun(run)
      return { phase: 'review', state: 'awaiting_user', required_action: { kind: 'review', patch_files: files } }
    }
    case 'completed':
    case 'applied_failed':
      // `completed` is "accepted, awaiting apply" — the user still needs to
      // confirm the apply. `applied_failed` means apply landed but post-apply
      // verifies failed; the user can retry apply or rollback. Both surface
      // the same `apply_patch` action to the UI.
      return { phase: 'apply_patch', state: 'awaiting_user', required_action: { kind: 'apply_patch' } }
    case 'failed':
      return { phase: 'failed', state: 'failed', required_action: null }
    case 'cancelled':
      return { phase: 'cancelled', state: 'cancelled', required_action: null }
    case 'applying':
    case 'applied':
      return null
  }
}

/**
 * List the files changed in a Run's worktree relative to its base_commit.
 * Used to populate `required_action.patch_files` when surfacing review.
 *
 * Unlike `collectRunPatch`, this does NOT run `git add -N .` (which would
 * mutate the index). Instead we combine two porcelain views: tracked changes
 * via `git diff --name-only <base>` and untracked files via
 * `git status --porcelain`. This matches `collectRunPatch`'s view of what the
 * eventual patch will contain, without the side effect.
 *
 * Side-effect-free: never modifies the index or working tree.
 */
export async function changedFilesForRun(run: RunRecord): Promise<string[]> {
  const files = new Set<string>()
  try {
    const { stdout } = await execFile('git', ['-C', run.worktree_path, 'diff', '--name-only', run.base_commit, '--'])
    for (const line of stdout.split(/\r?\n/)) {
      const file = line.trim()
      if (file !== '') files.add(file)
    }
  } catch {
    // Fall through to the patch-file fallback below.
  }
  try {
    // `--untracked-files=all` surfaces untracked files that `git diff` misses
    // (collectRunPatch would otherwise register them via `git add -N`).
    const { stdout } = await execFile('git', ['-C', run.worktree_path, 'status', '--porcelain=v1', '-z', '--untracked-files=all'])
    for (const entry of stdout.split('\0').filter(Boolean)) {
      // porcelain v1: "XY path" — strip the 2 status chars + 1 space.
      const file = entry.slice(3).trim()
      if (file !== '') files.add(file)
    }
  } catch {
    // Ignore — the diff view above (or the patch fallback below) covers us.
  }
  if (files.size > 0) return [...files].sort()
  try {
    const patchPath = pathInside(run.workspace_root, '.specops', 'runs', run.run_id, 'output.patch')
    const patch = await readFile(patchPath, 'utf8')
    const patchFiles = [...patch.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)]
      .map((match) => match[1]?.trim())
      .filter((file): file is string => Boolean(file))
    return [...new Set(patchFiles)].sort()
  } catch {
    return []
  }
}

export interface RunChangeEvidence {
  files: string[]
  digest: string
}

/**
 * Side-effect-free snapshot used to prove that one stage-bound turn changed the
 * Run worktree. Hashing the current contents (or a deletion marker) catches
 * edits to a file that was already dirty before a later task/repair turn.
 */
export async function runChangeEvidence(run: RunRecord): Promise<RunChangeEvidence> {
  const files = await changedFilesForRun(run)
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file)
    hash.update('\0')
    try {
      hash.update(await readFile(path.join(run.worktree_path, file)))
    } catch {
      hash.update('<deleted>')
    }
    hash.update('\0')
  }
  return { files, digest: hash.digest('hex') }
}

export async function collectRunPatch(run: RunRecord): Promise<{ patch: string; files: string[] }> {
  if (!await exists(run.worktree_path)) throw new SpecOpsError('worktree_missing', `Run worktree is missing: ${run.worktree_path}`)
  await execFile('git', ['-C', run.worktree_path, 'add', '-N', '.'])
  const patchPath = pathInside(run.workspace_root, '.specops', 'runs', run.run_id, 'output.patch')
  await gitToFile(run.worktree_path, ['diff', '--full-index', '--binary', run.base_commit, '--'], patchPath)
  const patch = await readFile(patchPath, 'utf8')
  const status = await git(run.worktree_path, ['status', '--porcelain=v1', '-z'])
  const files = status.split('\0').filter(Boolean).map((entry) => entry.slice(2).trimStart()).sort()
  // Commit the agent's work onto the Run branch so `git merge <branch>` (the
  // apply path) actually carries these changes. Without this, the branch tip
  // still points at base_commit and the merge would be a no-op. We use --allow-empty
  // so a re-collect on an unchanged tree doesn't fail; the empty-patch check
  // upstream still rejects Runs that produced no real diff.
  if (run.branch) {
    await execFile('git', ['-C', run.worktree_path, 'add', '-A'])
    const message = await runCommitMessage(run)
    await execFile('git', ['-C', run.worktree_path, 'commit', '-q', '--allow-empty', '-m', message], { encoding: 'utf8' }).catch(() => undefined)
  }
  return { patch, files }
}

/**
 * Returns true when the Run's worktree has no changes relative to its base
 * commit — i.e. applying it would be a no-op. This happens when intake already
 * committed the outputs (so the worktree base already contains them) or the
 * agent wrote nothing. Callers use this to mark the Run completed instead of
 * failing on an empty `git apply`.
 *
 * Note: once collectRunPatch commits the agent's work onto the Run branch, the
 * working tree is clean (porcelain is empty) but the diff against base_commit
 * still carries the changes — so we check the patch content, not the porcelain
 * status.
 */
export async function isRunPatchEmpty(run: RunRecord): Promise<boolean> {
  if (await exists(run.worktree_path)) {
    const { patch } = await collectRunPatch(run)
    return patch.trim().length === 0
  }
  const patchPath = pathInside(run.workspace_root, '.specops', 'runs', run.run_id, 'output.patch')
  if (!await exists(patchPath)) return true
  return (await readFile(patchPath, 'utf8')).trim().length === 0
}

/**
 * Detect a stale Run whose implementation is already present in the current
 * HEAD through another commit path. This is intentionally conservative:
 *
 * - at least one non-SpecOps implementation file must have changed;
 * - every implementation delta must reverse-apply cleanly to the HEAD index;
 * - changed change-doc files must already exist under the same canonical
 *   change id in HEAD.
 *
 * The check uses a temporary index, so it neither reads nor mutates the user's
 * working tree. It prevents an old branch from overwriting newer canonical
 * documents merely because its code change has already landed.
 */
export async function isRunAlreadyLanded(run: RunRecord): Promise<boolean> {
  if (!run.branch || run.change_id === null) return false
  const changed = (await git(run.workspace_root, ['diff', '--name-only', run.base_commit, run.branch, '--']))
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean)
  if (changed.length === 0) return false

  const documentPrefix = `.specops/changes/${run.change_id}/`
  const implementationFiles = changed.filter((file) => !file.startsWith(documentPrefix))
  if (implementationFiles.length === 0) return false

  const proposalPath = `${documentPrefix}proposal.md`
  try {
    const proposal = parseDocument(await git(run.workspace_root, ['show', `HEAD:${proposalPath}`]), proposalPath)
    if (proposal.frontmatter.id !== run.change_id) return false
    for (const file of changed.filter((item) => item.startsWith(documentPrefix))) {
      await execFile('git', ['-C', run.workspace_root, 'cat-file', '-e', `HEAD:${file}`])
    }
  } catch {
    return false
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'specops-landed-check-'))
  const indexFile = path.join(scratch, 'index')
  const env = { ...process.env, GIT_INDEX_FILE: indexFile }
  try {
    await execFile('git', ['-C', run.workspace_root, 'read-tree', 'HEAD'], { env })
    for (let index = 0; index < implementationFiles.length; index += 1) {
      const file = implementationFiles[index]!
      const patch = await git(run.workspace_root, ['diff', '--binary', run.base_commit, run.branch, '--', file])
      if (patch.trim() === '') continue
      const patchFile = path.join(scratch, `${index}.patch`)
      await writeFile(patchFile, patch.endsWith('\n') ? patch : `${patch}\n`, 'utf8')
      try {
        await execFile('git', ['-C', run.workspace_root, 'apply', '--cached', '--reverse', '--check', patchFile], { env })
      } catch {
        return false
      }
    }
    return true
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export interface ApplyResult {
  /** Short merge commit hash the Run's branch was merged into, when applicable. */
  commit?: string
}

/**
 * Returns the list of dirty paths in the main workspace, ignoring anything
 * under `.specops/` (those are SpecOps-managed docs/state and don't count as
 * user changes we need to protect). Empty array means the tree is clean enough
 * to merge into.
 */
async function dirtyNonSpecopsPaths(workspace: string): Promise<string[]> {
  const status = await git(workspace, ['status', '--porcelain=v1', '-z'])
  const paths: string[] = []
  for (const entry of status.split('\0').filter(Boolean)) {
    // porcelain v1: "XY path" — strip the 2 status chars + space.
    const filePath = entry.slice(2).trimStart()
    if (!filePath.startsWith('.specops/')) paths.push(filePath)
  }
  return paths
}

async function stashWorkspacePaths(workspace: string, runId: string, paths: string[]): Promise<string | null> {
  if (paths.length === 0) return null
  await execFile('git', [
    '-C', workspace, 'stash', 'push', '--include-untracked',
    '-m', `specops:auto-stash:${runId}`, '--', ...paths,
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  try {
    return await git(workspace, ['rev-parse', '--verify', 'refs/stash'])
  } catch {
    return null
  }
}

async function restoreWorkspaceStash(workspace: string, stashCommit: string | null): Promise<string[]> {
  if (stashCommit === null) return []
  const restored = await gitOk(workspace, ['stash', 'apply', '--index', stashCommit])
  if (restored) {
    // Drop only when refs/stash still points to the entry we created. Keeping a
    // mismatched/newer stash is safer than deleting someone else's work.
    const current = await git(workspace, ['rev-parse', '--verify', 'refs/stash']).catch(() => '')
    if (current === stashCommit) await gitOk(workspace, ['stash', 'drop', 'stash@{0}'])
    return []
  }
  return dirtyNonSpecopsPaths(workspace)
}

/**
 * Upfront conflict detection using `git merge-tree --write-tree --name-only`.
 * Returns the list of paths that would conflict if we merged <branch> into HEAD.
 * Empty array means the merge is clean (fast-forward or auto-mergeable).
 *
 * --write-tree exits non-zero on conflict and prints conflicted paths to stdout
 * (one per line). On a clean merge it prints the resulting tree OID.
 */
async function mergeTreeConflicts(workspace: string, branch: string): Promise<string[]> {
  let stdout = ''
  try {
    const result = await execFile('git', ['-C', workspace, 'merge-tree', '--write-tree', '--name-only', 'HEAD', branch], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    stdout = result.stdout
  } catch (error) {
    // merge-tree exits 1 on conflict; the conflicted paths are on stdout.
    const err = error as { stdout?: string }
    stdout = err.stdout ?? ''
  }
  // First line is the tree OID when clean; on conflict the lines after the OID
  // (or the whole output) are conflicted paths. Filter to plausible paths.
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return []
  // If only one line and it looks like a 40-hex OID, it's a clean merge tree.
  if (lines.length === 1 && /^[0-9a-f]{40}$/.test(lines[0]!)) return []
  // Otherwise: drop a leading OID line, the rest are conflicted paths.
  const paths = lines.filter((line) => !/^[0-9a-f]{40}$/.test(line))
  return paths
}

export async function applyRunPatch(run: RunRecord): Promise<ApplyResult> {
  // 'applying' is accepted because applyWithVerify transitions the run to
  // 'applying' *before* calling this function; rejecting it here is what
  // deadlocked runs in the 'applying' state (the merge never ran, yet the
  // run could never return to 'awaiting_review').
  if (run.state !== 'awaiting_review' && run.state !== 'completed' && run.state !== 'applying') {
    throw new SpecOpsError('run_not_reviewable', `Run ${run.run_id} is ${run.state}`)
  }
  // Always re-collect the patch from the worktree if it still exists,
  // since earlier verify may have captured an incomplete snapshot. The patch
  // file stays the data source for the review UI; apply reads the git branch.
  if (await exists(run.worktree_path)) {
    const { patch } = await collectRunPatch(run)
    if (patch.trim().length === 0) {
      throw new SpecOpsError(
        'empty_patch',
        `Run ${run.run_id} produced no changes in its worktree (${run.worktree_path}). ` +
          'The agent may not have written any files, or wrote them outside the worktree. ' +
          'Nothing to apply — re-run the task or check the agent session output.',
      )
    }
  }

  // Backward compatibility: legacy Runs (created before branch-based apply)
  // have no `branch` field. Fall back to the old `git apply --3way` path so
  // historical Runs remain applyable.
  if (!run.branch) {
    const patchPath = pathInside(run.workspace_root, '.specops', 'runs', run.run_id, 'output.patch')
    if (!await exists(patchPath)) throw new SpecOpsError('patch_missing', `No patch file found for run ${run.run_id}`)
    const patchContent = await readFile(patchPath, 'utf8')
    if (patchContent.trim().length === 0) {
      throw new SpecOpsError('empty_patch', `Run ${run.run_id} has an empty patch — nothing to apply.`)
    }
    await execFile('git', ['-C', run.workspace_root, 'apply', '--3way', patchPath])
    return {}
  }

  const workspace = run.workspace_root

  // 1. Protect local edits transactionally. They are restored after the Run
  //    merge, so an unrelated dirty workspace no longer blocks apply.
  const dirty = await dirtyNonSpecopsPaths(workspace)
  const autoStash = await stashWorkspacePaths(workspace, run.run_id, dirty)

  // 2. Upfront conflict detection — tell the user *before* touching the tree.
  const conflicts = await mergeTreeConflicts(workspace, run.branch)
  if (conflicts.length > 0) {
    await restoreWorkspaceStash(workspace, autoStash)
    throw new SpecOpsError(
      'merge_will_conflict',
      `Merge of branch '${run.branch}' into HEAD would conflict in:\n  ${conflicts.slice(0, 10).join('\n  ')}${conflicts.length > 10 ? `\n  ...and ${conflicts.length - 10} more` : ''}\nRe-run this Run from the current HEAD, or manually resolve after merging.`,
    )
  }

  // 3. Record pre-merge HEAD so rollback can return here.
  const preApply = await git(workspace, ['rev-parse', 'HEAD'])

  // 4. Merge with --no-ff so a merge commit always records "Run X landed here".
  const mergeOk = await gitOk(workspace, ['merge', '--no-ff', '--no-edit', run.branch])
  if (!mergeOk) {
    // Conflict surfaced despite upfront detection (race, or merge-tree missed
    // something). Abort and leave the tree as we found it.
    await gitOk(workspace, ['merge', '--abort'])
    await restoreWorkspaceStash(workspace, autoStash)
    throw new SpecOpsError(
      'merge_conflict',
      `Merge of branch '${run.branch}' failed with conflicts. The workspace has been rolled back to its pre-merge state.\nResolve manually with \`git merge ${run.branch}\`, or run \`git merge --abort\` and re-apply from the new HEAD.`,
    )
  }

  // 5. Persist pre_apply_commit so rollback can `git reset --hard` back here.
  run.pre_apply_commit = preApply
  await writeRun(run)

  const restoreConflicts = await restoreWorkspaceStash(workspace, autoStash)
  if (restoreConflicts.length > 0) {
    throw new SpecOpsError(
      'workspace_restore_conflict',
      `Run ${run.run_id} was merged, but restoring the main workspace edits conflicted in:\n  ${restoreConflicts.slice(0, 10).join('\n  ')}${restoreConflicts.length > 10 ? `\n  ...and ${restoreConflicts.length - 10} more` : ''}\nThe original edits remain backed up in git stash ${autoStash}. Resolve the working-tree conflicts, then continue.`,
    )
  }

  const newHead = await git(workspace, ['rev-parse', 'HEAD'])
  return { commit: newHead.slice(0, 12) }
}

export async function cleanupRun(run: RunRecord): Promise<void> {
  if (await exists(run.worktree_path)) {
    await execFile('git', ['-C', run.workspace_root, 'worktree', 'remove', '--force', run.worktree_path])
  }
  await rm(path.dirname(run.worktree_path), { recursive: false, force: true }).catch(() => undefined)
  // Best-effort: delete the Run's branch. -D (force) because the branch may
  // not have been merged if the Run was cancelled or never applied.
  if (run.branch) {
    await gitOk(run.workspace_root, ['branch', '-D', run.branch])
  }
}

export async function rollbackRunPatch(run: RunRecord): Promise<void> {
  if (run.pre_apply_commit !== null) {
    // Branch-based rollback: reset HEAD back to the pre-merge commit.
    const workspace = run.workspace_root
    const ok = await gitOk(workspace, ['reset', '--hard', run.pre_apply_commit])
    if (!ok) {
      throw new SpecOpsError(
        'rollback_failed',
        `Could not reset workspace to pre-apply commit ${run.pre_apply_commit}. Resolve manually with \`git reset --hard ${run.pre_apply_commit}\` or \`git reset --hard HEAD@{1}\`.`,
      )
    }
    run.pre_apply_commit = null
    await writeRun(run)
    return
  }
  // Legacy rollback (Run applied via `git apply --3way`): reverse the patch.
  const patchPath = pathInside(run.workspace_root, '.specops', 'runs', run.run_id, 'output.patch')
  if (!await exists(patchPath)) throw new SpecOpsError('patch_missing', `No patch file found for run ${run.run_id}`)
  await execFile('git', ['-C', run.workspace_root, 'apply', '--3way', '-R', patchPath])
}

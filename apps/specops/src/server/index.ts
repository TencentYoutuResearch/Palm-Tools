import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { promisify } from 'node:util'

import { scanWorkspace, archiveChange } from '../domain/commands.js'
import { SpecOpsError } from '../core/errors.js'
import { driftWorkspace, analyzeWorkspace } from '../domain/gate.js'
import { parseDocument, serializeDocument, defaultStatusForKind, isNormative } from '../domain/spec.js'
import {
  applyCompletedRun,
  applyWithVerify,
  decideRun,
  formatReviewNote,
  launchRun,
  resumeRunExecution,
  runReview,
  startRunExecution,
  verifyRun,
} from '../domain/run-loop.js'
import { changedFilesForRun, readRun, rollbackRunPatch, transitionRun, type RunRecord, type Task } from '../domain/run.js'
import { hasRunMonitor, initRunMonitor, shutdownMonitor, unwatchRun, watchRun } from '../domain/run-monitor.js'
import { buildIntakePrompt, parseIntakeReceipt, checkProposal, buildIntakePlanPrompt } from '../domain/intake.js'
import { buildClarifyPrompt } from '../domain/clarify.js'
import { createDocumentNote, listDocumentNotes, setDocumentNoteStatus, type DocumentNoteSource } from '../domain/notes.js'
import { loadConfig, resolveAgentSelection, saveAgentConfig, type AgentConfig, type AgentRole, type AgentSelection, type ResolvedAgentSelection } from '../domain/config.js'
import { KNOWN_CAPABILITIES, loadPluginManifests, resolveAgentBackendProfile } from '../domain/harness.js'
import { buildAssuranceState, recordRuntimeEvidence, type RuntimeEvidenceKind } from '../domain/assurance.js'
import { listHarnessStates, readHarnessEvents, readHarnessState, recordGateDecision, recordHarnessArtifact } from '../domain/harness-core.js'
import { readLatestDriftReport, runDriftLoop } from '../domain/drift-loop.js'
import { buildHarnessHealth, loadHarnessRules, runBenchmarks, saveHarnessRules, type HarnessRules } from '../domain/harness-evolution.js'
import {
  appendTranscript,
  canonicalDocumentKey,
  closeSpecOpsSession,
  createSpecOpsSession,
  findActiveSpecOpsSessionByDocument,
  findSpecOpsSessionByRunId,
  listSpecOpsSessionRecords,
  listSpecOpsSessions,
  readSpecOpsSession,
  buildSessionResumeContext,
  RESUMABLE_SESSION_PHASES,
  updateSpecOpsSession,
  type SpecOpsSessionRecord,
} from '../domain/session.js'
import { specOpsSessionEvents } from '../domain/session-events.js'
import { unwatchSpecOpsSessionTranscript, watchSpecOpsSessionTranscript } from '../domain/session-monitor.js'
import { KodeClient, KodeRequestError } from '../adapters/kode.js'
import { ExecutionManager } from '../execution/manager.js'
import { ExecutionRuntime } from '../execution/runtime.js'
import { createExecutionTransportFactory, executionTransportCapabilities, hasStructuredExecutionTransport } from '../execution/transports.js'
import { missingWorkflowCapabilities, type StructuredWorkflow } from '../execution/capabilities.js'
import type { ExecutionRequestOutcome, ExecutionTurnResult } from '../execution/types.js'
import { composeRolePrompt, resolveAgentPrompt } from '../domain/agent-prompts.js'
import { loadAvatarLibrary } from '../domain/avatar-library.js'
import { recordClarifyProtocolMiss, reconcileMissingStructuredExecution, setClarificationSubstate } from '../domain/workflow-state.js'
import { enqueueInteraction, resolveActionableInteraction, resolveInteraction, type InteractionResponse } from '../domain/interactions.js'
import {
  blockingInteraction,
  claimInteractionResponse,
  interactionForAction,
  markClaimDeliveryUnknown,
  resolvePermissionCommand,
  resolvePlanCommand,
  resolveQuestionsCommand,
} from './workflow-commands.js'
import appScript from './public/app.js' with { type: 'text' }
import indexHtml from './public/index.html' with { type: 'text' }
import styles from './public/styles.css' with { type: 'text' }
import { atomicWrite, exists, pathInside, readText, resolveGitWorkspace } from '../store/workspace.js'

const execFile = promisify(execFileCallback)

async function localNoteIdentity(workspace: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['-C', workspace, 'config', '--get', 'user.name'])
    const name = stdout.trim()
    if (name !== '') return name
  } catch { /* fall through to the local process identity */ }
  const fallback = process.env.USER?.trim() || process.env.USERNAME?.trim()
  return fallback === undefined || fallback === '' ? null : fallback
}

async function noteCreator(workspace: string, raw: Record<string, unknown>): Promise<string | null> {
  if (typeof raw.created_by === 'string' && raw.created_by.trim() !== '') return raw.created_by.trim()
  return localNoteIdentity(workspace)
}

const MAX_BODY_BYTES = 1_048_576
export const SPECOPS_PROTOCOL_VERSION = 1

export type SpecOpsExecutionRuntime = Pick<ExecutionRuntime, 'start' | 'load' | 'prompt' | 'respond' | 'cancel' | 'close' | 'get' | 'shutdown'>

export interface ServeOptions {
  workspace: string
  host?: string
  port?: number
  token?: string
  /** Legacy bridge access is limited to backend discovery, history, focus, and closing old numeric attachments. */
  kodeClient?: KodeClient
  /** Test seam; production creates ExecutionManager + ExecutionRuntime below. */
  executionRuntime?: SpecOpsExecutionRuntime
  runCacheRoot?: string
}

export interface ServeHandle {
  origin: string
  token: string
  close: () => Promise<void>
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(payload)
}

function equalToken(actual: string, expected: string): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function requestOriginAllowed(request: IncomingMessage, expectedOrigin: string): boolean {
  const origin = request.headers.origin
  if (origin !== undefined && origin !== expectedOrigin) return false

  // Browser requests must originate in the SpecOps document itself. Requests
  // from CLI clients do not send Fetch Metadata headers and remain supported.
  const fetchSite = request.headers['sec-fetch-site']
  return fetchSite === undefined || fetchSite === 'same-origin'
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function contentType(file: string): string {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8'
  if (file.endsWith('.css')) return 'text/css; charset=utf-8'
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8'
  return 'application/octet-stream'
}

async function resolveDocumentPath(workspace: string, relativePath: string): Promise<string> {
  const target = pathInside(workspace, relativePath)
  const canonical = await realpath(target)
  const allowedRoots = await Promise.all(['specs', 'changes'].map((part) => realpath(pathInside(workspace, '.specops', part))))
  if (!allowedRoots.some((root) => canonical.startsWith(`${root}${path.sep}`))) {
    throw new Error('document path is outside canonical SpecOps directories')
  }
  return canonical
}

async function resolveNewDocumentPath(workspace: string, relativePath: string): Promise<string> {
  const target = pathInside(workspace, relativePath)
  const allowedRoots = await Promise.all(['specs', 'changes'].map((part) => realpath(pathInside(workspace, '.specops', part))))
  const normalized = path.normalize(target)
  if (!allowedRoots.some((root) => normalized.startsWith(`${root}${path.sep}`))) {
    throw new Error('document path is outside canonical SpecOps directories')
  }
  return normalized
}

function version(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Returns true if the file is a SpecOps document with YAML frontmatter (proposal.md or delta spec). */
function isSpecDocumentPath(filePath: string): boolean {
  return path.basename(filePath) === 'proposal.md' || filePath.includes('/specs/')
}

function titleFromRequest(request: string): string {
  const normalized = request.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 64) return normalized || 'Untitled SpecOps session'
  return `${normalized.slice(0, 61)}…`
}

async function agentSelection(
  workspace: string,
  role: AgentRole,
  raw: Record<string, unknown>,
): Promise<ResolvedAgentSelection> {
  const config = await loadConfig(workspace)
  return resolveAgentSelection(config, role, {
    ...(typeof raw.backend_key === 'string' && raw.backend_key.trim() !== '' ? { backend: raw.backend_key.trim() } : {}),
    ...(typeof raw.model === 'string' && raw.model.trim() !== '' ? { model: raw.model.trim() } : {}),
  })
}

const AGENT_PROFILE_NAMES = ['default', 'analysis', 'implementation', 'review'] as const

function parseAgentProfiles(value: unknown): AgentConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SpecOpsError('invalid_agent_profiles', 'profiles must be an object')
  }
  const raw = value as Record<string, unknown>
  const result = {} as AgentConfig
  for (const name of AGENT_PROFILE_NAMES) {
    const entry = raw[name]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new SpecOpsError('invalid_agent_profiles', `profiles.${name} must be an object`)
    }
    const profile = entry as Record<string, unknown>
    const parsed: AgentSelection = {}
    for (const key of ['backend', 'model', 'avatar', 'prompt_file'] as const) {
      if (profile[key] === undefined || profile[key] === null || profile[key] === '') continue
      if (typeof profile[key] !== 'string' || profile[key].trim() === '') {
        throw new SpecOpsError('invalid_agent_profiles', `profiles.${name}.${key} must be a string`)
      }
      parsed[key] = profile[key].trim()
    }
    result[name] = parsed
  }
  return result
}

async function agentSettingsPayload(workspace: string, kode?: KodeClient) {
  const config = await loadConfig(workspace)
  const [backends, analysisPrompt, implementationPrompt, reviewPrompt] = await Promise.all([
    kode === undefined || typeof kode.listBackends !== 'function' ? [] : kode.listBackends().catch(() => []),
    resolveAgentPrompt(workspace, config, 'analysis'),
    resolveAgentPrompt(workspace, config, 'implementation'),
    resolveAgentPrompt(workspace, config, 'review'),
  ])
  return {
    profiles: config.agents,
    resolved: {
      default: resolveAgentSelection(config, 'analysis', config.agents.default),
      analysis: resolveAgentSelection(config, 'analysis'),
      implementation: resolveAgentSelection(config, 'implementation'),
      review: resolveAgentSelection(config, 'review'),
    },
    prompts: { analysis: analysisPrompt, implementation: implementationPrompt, review: reviewPrompt },
    backends,
  }
}

async function withAgentPrompt(workspace: string, role: AgentRole, assignment: string): Promise<string> {
  const config = await loadConfig(workspace)
  const prompt = await resolveAgentPrompt(workspace, config, role)
  return composeRolePrompt(prompt.content, assignment)
}

/** Close every backend session owned by one completed SpecOps workflow. */
async function terminateSpecOpsExecution(
  runtime: SpecOpsExecutionRuntime,
  kode: KodeClient | undefined,
  workspace: string,
  specopsSessionId: string,
  runId: string | null,
): Promise<void> {
  unwatchSpecOpsSessionTranscript(specopsSessionId)
  if (runId !== null) unwatchRun(runId)
  const session = await readSpecOpsSession(workspace, specopsSessionId)
  if (session.current_execution !== null && session.current_execution.transport !== 'legacy_kode_pty') {
    await runtime.close(session.current_execution.execution_id).catch(() => undefined)
  }
  const ids = new Set(session.agents.flatMap((agent) => agent.kode_session_id === null ? [] : [agent.kode_session_id]))
  if (session.kode_session_id !== null) ids.add(session.kode_session_id)
  if (kode !== undefined) await Promise.all([...ids].map((id) => kode.killSession(id).catch(() => undefined)))
  await updateSpecOpsSession(workspace, specopsSessionId, (record) => {
    const now = new Date().toISOString()
    record.kode_session_id = null
    for (const agent of record.agents) {
      if (agent.kode_session_id === null || !ids.has(agent.kode_session_id)) continue
      agent.status = 'exited'
      agent.ended_at ??= now
    }
  })
}

async function titleFromDocument(workspace: string, relativePath: string, fallback: string): Promise<string> {
  try {
    const file = await resolveDocumentPath(workspace, relativePath)
    const stat = await import('node:fs/promises').then((m) => m.stat(file))
    const content = stat.isDirectory() ? await readText(path.join(file, 'proposal.md')) : await readText(file)
    return parseDocument(content, relativePath).frontmatter.title
  } catch {
    return fallback
  }
}

/**
 * Best-effort commit of SpecOps documents (`.specops/changes/` and
 * `.specops/state/intakes/`) right after intake wrote them. Without this, the
 * `git worktree add HEAD` that launches the Run branch is based on a commit
 * that predates the docs — so the agent's worktree can't see proposal.md /
 * tasks.md and the Run has to inline them in the prompt instead.
 *
 * Failure here is logged but not fatal: if the user has unrelated staged
 * conflicts, or git refuses for any reason, we fall back to the current
 * behavior (worktree without docs; the Run prompt carries the doc content).
 */
async function commitPlanDocs(workspace: string, title: string): Promise<void> {
  try {
    // `.specops/changes/` holds the freshly-written proposal.md/tasks.md the
    // Run worktree needs to see. `.specops/state/intakes/` holds the receipt
    // (gitignored by default — force-add it so the worktree can read it too).
    await execFile('git', ['-C', workspace, 'add', '.specops/changes/'])
    await execFile('git', ['-C', workspace, 'add', '-f', '.specops/state/intakes/'])
    // `git commit` exits 1 when there's nothing to commit — that's fine here
    // (intake may not have written anything new since the last commit).
    try {
      await execFile('git', ['-C', workspace, 'commit', '-q', '-m', `specops(plan): ${title}`])
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? ''
      // nothing to commit is not an error for our purposes
      if (!/nothing to commit|no changes added/.test(stderr)) throw error
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[specops] commitPlanDocs failed (continuing without doc commit): ${message}`)
  }
}

/**
 * Resolve the document kind of an intake's primary output. For a change folder
 * the kind lives in `proposal.md`; for a spec file it is the file's frontmatter.
 * Returns null when the kind cannot be determined (caller falls back to the
 * worktree Run path, the safer default).
 */
async function readPrimaryKind(workspace: string, relativePath: string, fileContent: string | null): Promise<string | null> {
  try {
    if (fileContent !== null) return parseDocument(fileContent, relativePath).frontmatter.kind
    const file = await resolveDocumentPath(workspace, relativePath)
    const proposal = await readText(path.join(file, 'proposal.md'))
    return parseDocument(proposal, relativePath).frontmatter.kind
  } catch {
    return null
  }
}

interface FinalizedIntake {
  primary: string
  documents: string[]
  version: string
  checklistError: string | null
  isDocOnly: boolean
}

const intakeFinalizers = new Map<string, Promise<FinalizedIntake>>()

/** Idempotently turn a completed receipt into the durable SpecOps session gate. */
async function finalizeCompletedIntake(
  workspace: string,
  sessionId: string,
  receiptId: string,
  fallbackTitle: string,
): Promise<FinalizedIntake> {
  const key = `${workspace}:${sessionId}:${receiptId}`
  const active = intakeFinalizers.get(key)
  if (active !== undefined) return active
  const work = (async () => {
    const receiptPath = pathInside(workspace, '.specops', 'state', 'intakes', `${receiptId}.json`)
    const receipt = parseIntakeReceipt(await readText(receiptPath), receiptId)
    for (const documentPath of receipt.documents) {
      const file = await resolveDocumentPath(workspace, documentPath)
      const stat = await import('node:fs/promises').then((m) => m.stat(file))
      if (stat.isFile() && isSpecDocumentPath(file)) parseDocument(await readText(file), documentPath)
    }
    const primaryFilePath = await resolveDocumentPath(workspace, receipt.primary)
    const primaryStat = await import('node:fs/promises').then((m) => m.stat(primaryFilePath))
    const primaryContent = primaryStat.isFile() ? await readText(primaryFilePath) : `Change folder: ${receipt.primary}`
    const completedTitle = await titleFromDocument(workspace, receipt.primary, fallbackTitle)
    await commitPlanDocs(workspace, completedTitle)
    const docKind = await readPrimaryKind(workspace, receipt.primary, primaryStat.isFile() ? primaryContent : null)
    const isDocOnly = docKind === 'spec' || docKind === 'investigation'
    await updateSpecOpsSession(workspace, sessionId, (record) => {
      record.title = completedTitle
      record.document_path = canonicalDocumentKey(receipt.primary)
      record.execution.last_error = null
      record.execution.last_reconciled_at = new Date().toISOString()
      if (isDocOnly) {
        record.workflow_applicable = false
        record.phase = 'completed'
        record.state = 'completed'
        record.required_action = null
      } else {
        record.phase = 'run_in_worktree'
        record.state = 'awaiting_user'
        record.required_action = { kind: 'run_in_worktree' }
      }
    })
    const checklist = primaryStat.isFile() && isSpecDocumentPath(primaryFilePath)
      ? checkProposal(parseDocument(primaryContent, receipt.primary).body)
      : { ok: true, missing: [] }
    return {
      primary: receipt.primary,
      documents: receipt.documents,
      version: version(primaryContent),
      checklistError: checklist.ok ? null : `proposal.md missing required sections: ${checklist.missing.join(', ')}`,
      isDocOnly,
    }
  })().finally(() => { intakeFinalizers.delete(key) })
  intakeFinalizers.set(key, work)
  return work
}

async function reconcileCompletedIntakeSessions(workspace: string): Promise<void> {
  const records = await listSpecOpsSessionRecords(workspace)
  for (const record of records) {
    if (record.document_path !== null) continue
    if (record.phase !== 'plan_approved' && record.phase !== 'analyze_request' && record.phase !== 'failed') continue

    const receiptId = findLatestReceiptId(record.transcript.map((entry) => [
      entry.text,
      entry.summary,
      entry.preview,
    ].filter(Boolean).join('\n')).join('\n'))
    if (receiptId === null) continue

    const receiptPath = pathInside(workspace, '.specops', 'state', 'intakes', `${receiptId}.json`)
    if (!await exists(receiptPath)) continue

    try {
      await finalizeCompletedIntake(workspace, record.id, receiptId, record.title)
    } catch (error) {
      // Best-effort recovery. If any candidate receipt is stale or malformed,
      // preserve the receipt-backed session and persist a useful diagnostic.
      await updateSpecOpsSession(workspace, record.id, (current) => {
        current.execution.last_error = error instanceof Error ? error.message : String(error)
        current.execution.last_reconciled_at = new Date().toISOString()
      }).catch(() => undefined)
    }
  }
}

function isTerminalSessionState(state: string): boolean {
  return state === 'closed' || state === 'completed' || state === 'failed' || state === 'cancelled'
}

function latestReviewSummary(run: RunRecord): string | undefined {
  for (let i = run.review_results.length - 1; i >= 0; i -= 1) {
    const item = run.review_results[i] as { summary?: unknown } | undefined
    if (typeof item?.summary === 'string' && item.summary.trim().length > 0) return item.summary
  }
  return undefined
}

async function resolveRunInteraction(
  workspace: string,
  sessionId: string,
  kinds: Array<'run_verify' | 'human_review' | 'apply' | 'launch_run' | 'resume'>,
  response: InteractionResponse,
): Promise<SpecOpsSessionRecord> {
  return updateSpecOpsSession(workspace, sessionId, (record) => {
    resolveActionableInteraction(record, kinds, response)
  })
}

async function publishHumanReview(
  workspace: string,
  sessionId: string,
  run: RunRecord,
  files: string[],
  reviewNote: string | null,
): Promise<SpecOpsSessionRecord> {
  return updateSpecOpsSession(workspace, sessionId, (record) => {
    record.phase = 'review'
    record.state = 'awaiting_user'
    enqueueInteraction(record, {
      kind: 'human_review',
      source: 'system',
      idempotency_key: `human_review:${run.run_id}:${run.current_task}:${run.review_results.length}`,
      payload: { run_id: run.run_id, patch_files: files, review_note: reviewNote },
    })
  })
}

async function verifyAndRouteReview(
  runtime: SpecOpsExecutionRuntime,
  workspace: string,
  run: RunRecord,
  sessionId: string | null,
) {
  const verified = await verifyRun(run, { deferReviewAction: true })
  const config = await loadConfig(workspace)
  let review: Awaited<ReturnType<typeof runReview>> | undefined
  if (config.review.enabled) review = await runReview(run, runtime, config, verified.patch)

  if (sessionId === null) return { ...verified, review, repairing: false }
  await resolveRunInteraction(workspace, sessionId, ['run_verify'], { verified: true })

  if (review !== undefined && review.blocker && review.inconclusive !== true) {
    const latest = await readRun(workspace, run.run_id)
    try {
      const decision = await decideRun(latest, 'feedback', formatReviewNote(review), runtime)
      if (decision.turn === undefined) throw new SpecOpsError('execution_turn_missing', 'Blocking review did not start a repair turn')
      watchRun(run.run_id, workspace, decision.turn)
      const updated = await readSpecOpsSession(workspace, sessionId)
      specOpsSessionEvents.publish('session.updated', sessionId, { phase: updated.phase, state: updated.state })
      return { ...verified, review, repairing: true }
    } catch (error) {
      if (!(error instanceof SpecOpsError && error.code === 'max_iterations')) throw error
      const latestAtLimit = await readRun(workspace, run.run_id)
      const note = `Repair limit reached; human review or an explicit retry is required. ${review.summary}`
      const updated = await publishHumanReview(workspace, sessionId, latestAtLimit, verified.files, note)
      specOpsSessionEvents.publish('session.action_required', sessionId, updated.required_action)
      return { ...verified, review, repairing: false }
    }
  }

  const latest = await readRun(workspace, run.run_id)
  const reviewNote = review?.inconclusive === true
    ? `Automated review was inconclusive; do not treat it as approval. ${review.summary}`
    : review?.summary ?? null
  const updated = await publishHumanReview(workspace, sessionId, latest, verified.files, reviewNote)
  specOpsSessionEvents.publish('session.action_required', sessionId, updated.required_action)
  return { ...verified, review, repairing: false }
}

async function reconcileRunBackedSessions(workspace: string, runtime: SpecOpsExecutionRuntime): Promise<void> {
  const records = await listSpecOpsSessionRecords(workspace)
  for (const record of records) {
    if (record.run_id === null) continue
    if (isTerminalSessionState(record.state)) continue

    let run: RunRecord
    try {
      run = await readRun(workspace, record.run_id)
    } catch {
      continue
    }

    if (run.state === 'running') {
      const execution = record.current_execution
      const liveExecution = execution !== null
        && execution.transport !== 'legacy_kode_pty'
        && runtime.get(execution.execution_id) !== undefined
      // A monitor can be attached a few ticks after a live execution is
      // registered (especially while a Resume request is being processed).
      // Never close a live agent merely because that bookkeeping has not
      // caught up: doing so races its prompt and produces "client is closed".
      // Only a genuinely absent runtime execution requires durable recovery.
      if (liveExecution) continue
      const task = run.tasks[run.current_task]
      await updateSpecOpsSession(workspace, record.id, (current) => {
        if (isTerminalSessionState(current.state)) return
        current.phase = 'run_in_worktree'
        current.state = 'awaiting_user'
        current.current_execution = null
        current.execution.last_error = 'Running Run has no live stage monitor/execution; explicit resume is required.'
        current.execution.last_reconciled_at = new Date().toISOString()
        enqueueInteraction(current, {
          kind: 'resume',
          source: 'reconciliation',
          idempotency_key: `resume:${run.run_id}:${task?.id ?? 'unknown'}:${run.iteration}:monitor_missing`,
          payload: {
            reason: 'run_monitor_missing',
            prompt: `Resume the current Run task ${task?.id ?? 'unknown'} from durable task and repair context.`,
          },
        })
      })
      continue
    }

    if (run.state === 'awaiting_review') {
      const files = await changedFilesForRun(run)
      const reviewNote = latestReviewSummary(run)
      await updateSpecOpsSession(workspace, record.id, (current) => {
        if (isTerminalSessionState(current.state)) return
        current.phase = 'review'
        current.state = 'awaiting_user'
        enqueueInteraction(current, {
          kind: 'human_review',
          source: 'reconciliation',
          idempotency_key: `human_review:${run.run_id}:${run.current_task}:${run.review_results.length}:reconcile:${run.updated_at}`,
          payload: {
            run_id: run.run_id,
            patch_files: files,
            review_note: reviewNote ?? null,
          },
        })
      })
      continue
    }

    if (run.state === 'awaiting_verify') {
      await updateSpecOpsSession(workspace, record.id, (current) => {
        if (isTerminalSessionState(current.state)) return
        current.phase = 'verify'
        current.state = 'awaiting_user'
        enqueueInteraction(current, {
          kind: 'run_verify',
          source: 'reconciliation',
          idempotency_key: `run_verify:${run.run_id}:${run.tasks[run.current_task]?.id ?? 'unknown'}:${run.iteration}`,
          payload: { run_id: run.run_id },
        })
      })
      continue
    }

    if (run.state === 'completed') {
      await updateSpecOpsSession(workspace, record.id, (current) => {
        if (isTerminalSessionState(current.state)) return
        current.phase = 'apply_patch'
        current.state = 'awaiting_user'
        current.required_action = { kind: 'apply_patch' }
      })
      continue
    }

    if (run.state === 'applied_failed') {
      await updateSpecOpsSession(workspace, record.id, (current) => {
        if (isTerminalSessionState(current.state)) return
        current.phase = 'apply_patch'
        current.state = 'awaiting_user'
        current.required_action = { kind: 'apply_patch' }
      })
      continue
    }

    if (run.state === 'failed' || run.state === 'cancelled') {
      const terminalState = run.state
      await updateSpecOpsSession(workspace, record.id, (current) => {
        if (isTerminalSessionState(current.state)) return
        current.phase = terminalState
        current.state = terminalState
        current.required_action = null
      })
    }
  }
}

async function detachKodeSessionAttachment(workspace: string, recordId: string, kodeSessionId: number): Promise<void> {
  await updateSpecOpsSession(workspace, recordId, (current) => {
    if (current.kode_session_id !== kodeSessionId) return
    current.kode_session_id = null
    const agent = current.agents.find((item) => item.kode_session_id === kodeSessionId)
    if (agent !== undefined) {
      agent.status = 'exited'
      agent.ended_at ??= new Date().toISOString()
    }
    current.execution.last_reconciled_at = new Date().toISOString()
    current.execution.last_error = null
  })
  specOpsSessionEvents.publish('session.updated', recordId, { kode_session_id: null })
}

async function reconcileKodeSessionAttachments(kode: KodeClient, workspace: string): Promise<void> {
  const records = await listSpecOpsSessionRecords(workspace)
  await Promise.all(records.map(async (record) => {
    // A SpecOps session has one current kode execution attachment. Older
    // numeric sessions are durable history, not concurrently active agents.
    // Backfill lifecycle metadata for records written before recordAgent began
    // retiring the previous attachment.
    await updateSpecOpsSession(workspace, record.id, (current) => {
      const now = new Date().toISOString()
      for (const agent of current.agents) {
        if (agent.kode_session_id === current.kode_session_id || agent.ended_at !== null) continue
        agent.status = 'exited'
        agent.ended_at = now
      }
    })
    if (record.kode_session_id === null || isTerminalSessionState(record.state)) return
    const kodeSessionId = record.kode_session_id
    try {
      // Session listing must remain available even when the GUI bridge is
      // temporarily wedged. Liveness reconciliation is best-effort and must
      // never hold /api/sessions in a permanent Loading state.
      const session = await withTimeout(kode.getSession(kodeSessionId), 2_000, 'kode session reconciliation timed out')
      if (session.status !== 'exited') return
    } catch (error) {
      // Network/auth failures are not proof that a session was destroyed.
      // Detach only when the bridge definitively says this numeric id is gone.
      if (!(error instanceof KodeRequestError) || error.status !== 404) return
    }
    await detachKodeSessionAttachment(workspace, record.id, kodeSessionId)
  }))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function reconcileSessions(
  workspace: string,
  runtime: SpecOpsExecutionRuntime,
  kode?: KodeClient,
): Promise<void> {
  await reconcileCompletedIntakeSessions(workspace)
  await reconcileRunBackedSessions(workspace, runtime)
  if (kode !== undefined) await reconcileKodeSessionAttachments(kode, workspace)
  const records = await listSpecOpsSessionRecords(workspace)
  for (const record of records) {
    const execution = record.current_execution
    if (execution === null || execution.transport === 'legacy_kode_pty' || isTerminalSessionState(record.state)) continue
    if (runtime.get(execution.execution_id) !== undefined) continue
    await updateSpecOpsSession(workspace, record.id, (current) => {
      reconcileMissingStructuredExecution(current, execution)
    })
  }
}

function withUnverifiedExecution<T extends {
  kode_session_id: number | null
  state: string
  execution: { state: string; resume_mode: string; last_error: string | null }
}>(session: T, kode: KodeClient | undefined): T {
  if (kode !== undefined || session.kode_session_id === null || isTerminalSessionState(session.state)) return session
  return {
    ...session,
    execution: {
      ...session.execution,
      state: 'unverified',
      resume_mode: 'none',
      last_error: 'Kode bridge unavailable; execution liveness was not checked.',
    },
  } as T
}

async function reattachLiveSessionMonitors(kode: KodeClient, workspace: string): Promise<void> {
  const records = await listSpecOpsSessionRecords(workspace)
  for (const record of records) {
    if (record.kode_session_id === null || isTerminalSessionState(record.state)) continue
    try {
      const session = await kode.getSession(record.kode_session_id)
      if (session.status === 'exited') {
        await detachKodeSessionAttachment(workspace, record.id, record.kode_session_id)
        continue
      }
      // Legacy Kode attachments are history-only during the structured-runtime
      // migration. Keep transcript recovery, but never drive a new Run turn.
      watchSpecOpsSessionTranscript(kode, workspace, record.id, record.kode_session_id)
    } catch (error) {
      // Stale numeric kode_session_id after a GUI restart. The explicit Resume
      // action can rebuild the session from the stored backend UUID.
      if (error instanceof KodeRequestError && error.status === 404) {
        await detachKodeSessionAttachment(workspace, record.id, record.kode_session_id)
      }
    }
  }
}

function purposeForPhase(phase: SpecOpsSessionRecord['phase']): 'clarify' | 'plan' | 'intake' | 'implement' | 'repair' {
  if (phase === 'clarify') return 'clarify'
  if (phase === 'plan_discussion' || phase === 'solution_options' || phase === 'plan_approved') return 'plan'
  if (phase === 'analyze_request') return 'intake'
  if (phase === 'run_in_worktree') return 'implement'
  return 'repair'
}

function structuredBackendSupported(backendKey: string): boolean {
  return hasStructuredExecutionTransport(backendKey)
}

async function workflowCapabilityGap(
  workspace: string,
  backendKey: string,
  workflow: StructuredWorkflow,
): Promise<string[]> {
  const config = await loadConfig(workspace)
  const profile = await resolveAgentBackendProfile(workspace, backendKey, config.agent_backends[backendKey])
  return missingWorkflowCapabilities(workflow, profile.capabilities, executionTransportCapabilities(backendKey))
}

async function markStructuredOutcomeUnknown(
  runtime: SpecOpsExecutionRuntime,
  workspace: string,
  sessionId: string,
  message: string,
): Promise<void> {
  const session = await readSpecOpsSession(workspace, sessionId)
  if (session.current_execution !== null && session.current_execution.transport !== 'legacy_kode_pty') {
    await runtime.close(session.current_execution.execution_id).catch(() => undefined)
  }
  const updated = await updateSpecOpsSession(workspace, sessionId, (record) => {
    const execution = record.current_execution
    record.current_execution = null
    record.state = 'awaiting_user'
    record.execution.last_error = `Structured execution outcome is unknown: ${message}`
    record.execution.last_reconciled_at = new Date().toISOString()
    enqueueInteraction(record, {
      kind: 'resume',
      source: 'reconciliation',
      idempotency_key: `resume:${record.id}:outcome_unknown:${execution?.execution_id ?? 'detached'}:${execution?.process_generation ?? 0}`,
      payload: {
        reason: 'outcome_unknown',
        prompt: 'Resume from durable workflow state; do not assume the uncertain turn completed.',
      },
    })
  })
  specOpsSessionEvents.publish('session.action_required', sessionId, {
    state: updated.state,
    error: updated.execution.last_error,
    outcome_unknown: true,
    required_action: updated.required_action,
  })
}

async function observeSessionTurn(
  runtime: SpecOpsExecutionRuntime,
  workspace: string,
  session: SpecOpsSessionRecord,
  completion: Promise<ExecutionRequestOutcome<ExecutionTurnResult>>,
): Promise<void> {
  try {
    const outcome = await completion
    if (outcome.outcome === 'outcome_unknown') await markStructuredOutcomeUnknown(runtime, workspace, session.id, outcome.error.message)
  } catch (error) {
    await updateSpecOpsSession(workspace, session.id, (record) => {
      record.state = 'failed'
      record.execution.last_error = error instanceof Error ? error.message : String(error)
      record.execution.last_reconciled_at = new Date().toISOString()
    }).catch(() => undefined)
  }
}

function promptStructuredExecution(
  runtime: SpecOpsExecutionRuntime,
  workspace: string,
  session: SpecOpsSessionRecord,
  text: string,
  options: { userText?: string; purpose?: string; freshContext?: boolean } = {},
): Promise<ExecutionRequestOutcome<ExecutionTurnResult>> {
  const execution = session.current_execution
  if (execution === null || execution.transport === 'legacy_kode_pty') {
    throw new SpecOpsError('structured_execution_missing', 'Session has no structured execution attachment')
  }
  const completion = runtime.prompt(execution.execution_id, {
    requestId: randomUUID(),
    text,
    metadata: {
      specops_session_id: session.id,
      ...(session.run_id === null ? {} : { run_id: session.run_id }),
      purpose: options.purpose ?? 'user_chat',
      may_advance_stage: false,
      ...(options.freshContext === undefined ? {} : { fresh_context: options.freshContext }),
    },
  })
  if (options.userText !== undefined) {
    // Persisting the user message must not hold the request open for a model
    // turn. The client only needs delivery acknowledgement; transcript and
    // model events arrive through the normal realtime stream.
    void appendTranscript(workspace, session.id, 'user', options.userText, null, execution.execution_id)
      .then((updated) => {
        const entry = updated.transcript.at(-1)
        specOpsSessionEvents.publish('session.transcript_appended', session.id, entry === undefined ? { role: 'user' } : { entries: [entry] })
      })
      .catch(() => undefined)
  }
  // The ACP prompt resolves only after the agent finishes a complete turn.
  // Observe that outcome in the background so /input can acknowledge delivery
  // immediately instead of hitting the browser's request timeout.
  void observeSessionTurn(runtime, workspace, session, completion)
  return completion
}

function questionAnswersPrompt(
  questions: readonly { id: string; prompt: string }[],
  answers: readonly { questionId: string; labels: readonly string[]; freeText?: string | undefined }[],
): string {
  const byId = new Map(answers.map((answer) => [answer.questionId, answer]))
  return [
    'The user answered the pending structured questions. Treat these answers as authoritative decisions:',
    ...questions.map((question, index) => {
      const answer = byId.get(question.id)
      const selected = answer?.labels.join(', ') || '(no selection)'
      const details = answer?.freeText?.trim()
      return `${index + 1}. ${question.prompt}\n   Answer: ${selected}${details ? `\n   Details: ${details}` : ''}`
    }),
    '',
    'Continue clarification from these decisions. Do not reuse a plan that was produced before these answers.',
  ].join('\n')
}

function planRevisionPrompt(note: string | undefined): string {
  return [
    'The user rejected the proposed plan.',
    `Feedback: ${note?.trim() || 'Revise the plan and address the unresolved scope.'}`,
    'Continue clarification and submit a new complete plan for review.',
  ].join('\n')
}

async function rebuildSpecOpsExecution(
  runtime: SpecOpsExecutionRuntime,
  workspace: string,
  session: SpecOpsSessionRecord,
  continuationPrompt?: string,
): Promise<{ session: SpecOpsSessionRecord; promptDelivered: boolean }> {
  if (!RESUMABLE_SESSION_PHASES.has(session.phase)) {
    throw new SpecOpsError('session_not_recoverable', `Session phase ${session.phase} does not own a structured execution`)
  }
  if (!structuredBackendSupported(session.backend_key)) {
    throw new SpecOpsError('unsupported_execution_backend', `Backend ${session.backend_key} has no structured execution transport`)
  }
  if (session.current_execution !== null && session.current_execution.transport !== 'legacy_kode_pty'
    && runtime.get(session.current_execution.execution_id) !== undefined) {
    if (continuationPrompt !== undefined) {
      void promptStructuredExecution(runtime, workspace, session, continuationPrompt, { purpose: 'resume' })
    }
    return { session: await readSpecOpsSession(workspace, session.id), promptDelivered: continuationPrompt !== undefined }
  }

  let cwd = workspace
  let backendKey = session.backend_key
  let model = [...session.agents].reverse().find((agent) => agent.ended_at === null)?.model ?? undefined
  let runContext = ''
  if (session.run_id !== null) {
    const run = await readRun(workspace, session.run_id)
    cwd = run.worktree_path
    backendKey = run.backend_key
    model = run.model ?? undefined
    const task = run.tasks[run.current_task]
    runContext = [
      '', 'Current run state:', `- State: ${run.state}`, `- Iteration: ${run.iteration}/${run.max_iterations}`,
      `- Current task: ${task?.title ?? 'None'}`, `- Task prompt: ${task?.prompt ?? 'None'}`,
      `- Required verification: ${task?.verify.join(', ') || 'None'}`,
      `- Latest verification evidence: ${JSON.stringify(run.verify_results).slice(-4000) || 'None'}`,
    ].join('\n')
  }

  const previous = session.current_execution?.transport === 'legacy_kode_pty'
    ? [...session.agents].reverse().find((agent) => agent.transport !== 'legacy_kode_pty' && agent.native_session_id)?.execution_id
      ? [...session.agents].reverse().find((agent) => agent.transport !== 'legacy_kode_pty' && agent.native_session_id)
      : undefined
    : session.current_execution ?? undefined
  let exact = false
  // CodeBuddy ACP's advertised session/load is not reliable across a new
  // sidecar process. Resume it from the durable session context in a new ACP
  // session; other structured transports keep their exact native resume.
  if (previous?.execution_id !== undefined && previous.transport !== 'codebuddy_acp'
    && previous.native_session_id != null) {
    try {
      await runtime.load({
        workspace,
        sessionId: session.id,
        ...(session.run_id === null ? {} : { runId: session.run_id }),
        purpose: purposeForPhase(session.phase),
        backendKey,
        cwd,
        executionId: previous.execution_id,
        nativeSessionId: previous.native_session_id,
        ...(model === undefined ? {} : { model }),
      })
      exact = true
    } catch {
      // Start below with durable context; never fall back to a PTY transport.
    }
  }
  if (!exact) {
    await runtime.start({
      workspace,
      sessionId: session.id,
      ...(session.run_id === null ? {} : { runId: session.run_id }),
      purpose: purposeForPhase(session.phase),
      backendKey,
      cwd,
      ...(model === undefined ? {} : { model }),
      metadata: { resumed_with_fresh_context: true },
    })
  }
  let updated = await readSpecOpsSession(workspace, session.id)
  const freshContext = exact ? undefined : `${buildSessionResumeContext(session)}${runContext}`
  const prompt = freshContext === undefined
    ? continuationPrompt
    : `${freshContext}${continuationPrompt === undefined ? '' : `\n\nNew user message:\n${continuationPrompt}`}`
  if (!exact) {
    updated = await updateSpecOpsSession(workspace, session.id, (record) => {
      record.execution.last_reconciled_at = new Date().toISOString()
      record.execution.last_error = 'Native session resume was unavailable; execution continued with fresh durable context.'
    })
  }
  if (prompt !== undefined) {
    void promptStructuredExecution(runtime, workspace, updated, prompt, {
      purpose: 'resume',
      freshContext: freshContext !== undefined,
    })
  }
  updated = await readSpecOpsSession(workspace, session.id)
  specOpsSessionEvents.publish('session.updated', session.id, {
    phase: updated.phase,
    state: updated.state,
    current_execution: updated.current_execution,
    resume_mode: exact ? 'exact' : 'fresh_context',
  })
  return { session: updated, promptDelivered: continuationPrompt !== undefined }
}

interface DurablePromotionResult {
  session: SpecOpsSessionRecord
  execution: NonNullable<SpecOpsSessionRecord['current_execution']>
  completion?: Promise<ExecutionRequestOutcome<ExecutionTurnResult>>
  receiptId: string
}

async function promoteDurableClarify(
  runtime: SpecOpsExecutionRuntime,
  workspace: string,
  sessionId: string,
  cas: Record<string, unknown> = {},
): Promise<DurablePromotionResult | null> {
  const before = await readSpecOpsSession(workspace, sessionId)
  const approvedPlan = before.clarification!.approved_plan
  const startInteraction = before.interactions?.find((interaction) => interaction.kind === 'start_intake')
  if (approvedPlan === null || startInteraction === undefined) return null
  if (before.phase === 'analyze_request') {
    const execution = before.current_execution
    if (execution === null || execution.transport === 'legacy_kode_pty') return null
    return { session: before, execution, receiptId: startInteraction.payload.receipt_id }
  }
  const claimed = await claimInteractionResponse(workspace, sessionId, 'start_intake', cas)
  if (claimed === null || claimed.interaction.kind !== 'start_intake') return null
  const startInteractionClaim = claimed.interaction
  await updateSpecOpsSession(workspace, sessionId, (record) => {
    setClarificationSubstate(record, 'promoting')
    record.state = 'active'
  })
  const decisions = before.decisions.length === 0
    ? '- None.'
    : before.decisions.map((decision) => {
      const value = [...decision.selections, decision.note].filter((item): item is string => Boolean(item)).join('; ')
      return `- ${decision.prompt ?? decision.kind}: ${value || decision.outcome}`
    }).join('\n')
  const clarifiedContext = [
    '## Initial request', before.clarification!.initial_request,
    '', '## Approved plan', approvedPlan.markdown,
    '', '## Confirmed decisions', decisions,
  ].join('\n')
  const combinedPrompt = await withAgentPrompt(
    workspace,
    'analysis',
    buildIntakePrompt(clarifiedContext, startInteractionClaim.payload.receipt_id),
  )
  const model = [...before.agents].reverse().find((agent) => agent.model !== null)?.model ?? undefined
  let execution: NonNullable<SpecOpsSessionRecord['current_execution']>
  try {
    execution = await runtime.start({
      workspace,
      sessionId,
      purpose: 'intake',
      backendKey: before.backend_key,
      cwd: workspace,
      mode: 'acceptEdits',
      ...(model === undefined ? {} : { model }),
    })
  } catch (error) {
    await markClaimDeliveryUnknown(workspace, sessionId, claimed.interaction.id, {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  const promoted = await updateSpecOpsSession(workspace, sessionId, (record) => {
    record.phase = 'analyze_request'
    record.state = 'active'
    record.intake_receipt_id = startInteractionClaim.payload.receipt_id
    record.kode_session_id = null
    resolveInteraction(record, claimed.interaction.id, {
      promoted: true,
      receipt_id: startInteractionClaim.payload.receipt_id,
      execution_id: execution.execution_id,
    })
    setClarificationSubstate(record, 'promoted')
  })
  const completion = runtime.prompt(execution.execution_id, {
    requestId: randomUUID(),
    text: combinedPrompt,
    metadata: { specops_session_id: sessionId, purpose: 'intake', receipt_id: startInteractionClaim.payload.receipt_id },
  })
  return {
    session: promoted,
    execution,
    completion,
    receiptId: startInteractionClaim.payload.receipt_id,
  }
}

function findLatestReceiptId(text: string): string | null {
  const matches = [...text.matchAll(/\.specops\/state\/intakes\/([0-9a-f-]{36})\.json/g)]
  return matches.length === 0 ? null : matches[matches.length - 1]?.[1] ?? null
}

/**
 * Best-effort reverse-resolve of a change proposal's `id` from a session's
 * document_path. The document_path may be a folder (`.specops/changes/<id>`)
 * or point at proposal.md / tasks.md / design.md inside one. Returns null when
 * the path is not under `.specops/changes/`, or the proposal.md can't be
 * read/parsed — callers treat null as "no linked change" (quick-run semantics).
 */
async function readChangeIdFromDocumentPath(workspace: string, documentPath: string): Promise<string | null> {
  const key = canonicalDocumentKey(documentPath)
  if (!key.startsWith('.specops/changes/')) return null
  const proposalPath = `${key}/proposal.md`
  try {
    const file = pathInside(workspace, proposalPath)
    if (!await exists(file)) return null
    return parseDocument(await readText(file), proposalPath).frontmatter.id
  } catch {
    return null
  }
}

export async function startServer(options: ServeOptions): Promise<ServeHandle> {
  const workspace = await resolveGitWorkspace(options.workspace)
  const host = options.host ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('SpecOps server only accepts loopback hosts')
  const token = options.token ?? randomBytes(32).toString('hex')
  const assets: Record<string, string> = {
    'index.html': indexHtml,
    'app.js': appScript,
    'styles.css': styles,
  }
  const kode = options.kodeClient ?? (
    process.env.KODE_BRIDGE_URL && process.env.KODE_BRIDGE_TOKEN
      ? new KodeClient(process.env.KODE_BRIDGE_URL, process.env.KODE_BRIDGE_TOKEN)
      : undefined
  )
  const runtime = options.executionRuntime ?? new ExecutionRuntime(
    new ExecutionManager(createExecutionTransportFactory()),
    { projectorOptions: { onError: (error) => console.error('[specops] execution projection failed', error) } },
  )
  initRunMonitor(runtime, workspace)
  if (kode !== undefined) await reattachLiveSessionMonitors(kode, workspace)
  const backgroundTasks = new Set<Promise<void>>()
  const activeActions = new Set<string>()
  let closing = false
  const trackBackground = (task: Promise<void>): void => {
    backgroundTasks.add(task)
    void task.then(
      () => backgroundTasks.delete(task),
      () => backgroundTasks.delete(task),
    )
  }
  const trackClarifyTurn = (
    sessionId: string,
    completion: Promise<ExecutionRequestOutcome<ExecutionTurnResult>>,
  ): void => {
    const task = completion.then(async (outcome) => {
      if (closing) return
      if (outcome.outcome === 'outcome_unknown') {
        await markStructuredOutcomeUnknown(runtime, workspace, sessionId, outcome.error.message)
        return
      }
      const session = await readSpecOpsSession(workspace, sessionId)
      if (session.phase !== 'clarify' || blockingInteraction(session) !== undefined) return
      const turnId = outcome.value.turnId ?? `turn:${session.id}:${session.clarification!.protocol_violations.length + 1}`
      const assistantText = [...session.transcript].reverse().find((entry) => entry.role === 'agent')?.text ?? ''
      let correctivePrompt: string | null = null
      const updated = await updateSpecOpsSession(workspace, sessionId, (record) => {
        const result = recordClarifyProtocolMiss(record, {
          turn_id: turnId,
          assistant_text: assistantText,
        })
        correctivePrompt = result.corrective_prompt
      })
      if (correctivePrompt === null) {
        specOpsSessionEvents.publish('session.action_required', sessionId, updated.required_action)
        return
      }
      const execution = updated.current_execution
      if (execution === null || execution.transport === 'legacy_kode_pty') return
      const correction = runtime.prompt(execution.execution_id, {
        requestId: randomUUID(),
        text: correctivePrompt,
        metadata: { specops_session_id: sessionId, purpose: 'clarify_protocol_correction' },
      })
      trackClarifyTurn(sessionId, correction)
    }).catch(async (error) => {
      if (closing) return
      await updateSpecOpsSession(workspace, sessionId, (record) => {
        record.state = 'failed'
        record.execution.last_error = error instanceof Error ? error.message : String(error)
        setClarificationSubstate(record, 'failed')
      }).catch(() => undefined)
    })
    trackBackground(task)
  }
  let expectedOrigin = ''

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', expectedOrigin || `http://${host}`)
      if (url.pathname === '/healthz') return json(response, 200, { ok: true })
      if (url.pathname.startsWith('/api/')) {
        const authorization = request.headers.authorization ?? ''
        const queryToken = url.pathname === '/api/events' ? url.searchParams.get('token') : null
        const authorized = authorization.startsWith('Bearer ')
          ? equalToken(authorization.slice(7), token)
          : queryToken !== null && equalToken(queryToken, token)
        if (!authorized) {
          return json(response, 401, { error: 'unauthorized' })
        }
        if (!requestOriginAllowed(request, expectedOrigin)) {
          return json(response, 403, { error: 'origin_rejected' })
        }

        if (request.method === 'GET' && url.pathname === '/api/state') {
          const [scan, drift, analyze, harnessHealth] = await Promise.all([scanWorkspace(workspace), driftWorkspace(workspace), analyzeWorkspace(workspace), buildHarnessHealth(workspace)])
          if (scan.data === undefined) throw new SpecOpsError('scan_failed', 'scan returned no registry state')
          const assurance = await buildAssuranceState(workspace, scan.data)
          return json(response, 200, { workspace, scan, drift, drift_report: await readLatestDriftReport(workspace), analyze, assurance, harness_health: harnessHealth })
        }
        if (request.method === 'GET' && url.pathname === '/api/settings/agents') {
          return json(response, 200, await agentSettingsPayload(workspace, kode))
        }
        if (request.method === 'GET' && url.pathname === '/api/settings/avatars') {
          return json(response, 200, await loadAvatarLibrary())
        }
        if (request.method === 'PUT' && url.pathname === '/api/settings/agents') {
          const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
          const profiles = parseAgentProfiles(raw.profiles)
          if (kode !== undefined) {
            const available = typeof kode.listBackends === 'function' ? await kode.listBackends().catch(() => []) : []
            if (available.length > 0) {
              const keys = new Set(available.map((backend) => backend.key))
              for (const name of AGENT_PROFILE_NAMES) {
                const backend = profiles[name].backend
                if (backend !== undefined && !keys.has(backend)) {
                  return json(response, 400, { error: 'backend_unavailable', profile: name, backend })
                }
              }
            }
          }
          await saveAgentConfig(workspace, profiles)
          return json(response, 200, await agentSettingsPayload(workspace, kode))
        }
        if (request.method === 'GET' && url.pathname === '/api/assurance') {
          const scan = await scanWorkspace(workspace)
          if (scan.data === undefined) throw new SpecOpsError('scan_failed', 'scan returned no registry state')
          return json(response, 200, await buildAssuranceState(workspace, scan.data))
        }
        if (request.method === 'GET' && url.pathname === '/api/harness') {
          const [config, plugins, runs, health, rules] = await Promise.all([loadConfig(workspace), loadPluginManifests(workspace), listHarnessStates(workspace), buildHarnessHealth(workspace), loadHarnessRules(workspace)])
          return json(response, 200, {
            project: config.project,
            workflows: config.workflows,
            agent_backends: config.agent_backends,
            plugins,
            known_capabilities: KNOWN_CAPABILITIES,
            runs,
            health,
            rules,
          })
        }
        if (request.method === 'GET' && url.pathname === '/api/harness/health') return json(response, 200, await buildHarnessHealth(workspace))
        if (request.method === 'GET' && url.pathname === '/api/harness/rules') return json(response, 200, await loadHarnessRules(workspace))
        if (request.method === 'PUT' && url.pathname === '/api/harness/rules') {
          const rules = JSON.parse((await requestBody(request)).toString('utf8')) as HarnessRules
          await saveHarnessRules(workspace, rules)
          return json(response, 200, rules)
        }
        if (request.method === 'POST' && url.pathname === '/api/harness/benchmarks/run') return json(response, 200, { results: await runBenchmarks(workspace) })
        if (request.method === 'GET' && url.pathname === '/api/notes') {
          const documentPath = url.searchParams.get('path') ?? undefined
          const identity = await localNoteIdentity(workspace)
          const notes = (await listDocumentNotes(workspace, documentPath)).map((note) => ({ ...note, created_by: note.created_by ?? identity }))
          return json(response, 200, { notes })
        }
        if (request.method === 'POST' && url.pathname === '/api/notes') {
          const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
          if (typeof raw.document_path !== 'string' || typeof raw.block_id !== 'string' || typeof raw.block_kind !== 'string' || typeof raw.quote !== 'string' || typeof raw.body !== 'string') {
            return json(response, 400, { error: 'document_path, block_id, block_kind, quote, and body are required' })
          }
          await resolveDocumentPath(workspace, raw.document_path)
          const note = await createDocumentNote(workspace, {
            document_path: raw.document_path, block_id: raw.block_id, block_kind: raw.block_kind,
            line_start: typeof raw.line_start === 'number' ? raw.line_start : null,
            line_end: typeof raw.line_end === 'number' ? raw.line_end : null,
            quote: raw.quote, body: raw.body,
            created_by: await noteCreator(workspace, raw),
            source: raw.source === 'agent' || raw.source === 'api' ? raw.source : 'ui',
          })
          return json(response, 201, { note })
        }
        const noteActionMatch = /^\/api\/notes\/([0-9a-f-]{36})\/(resolve|deprecate)$/.exec(url.pathname)
        if (request.method === 'POST' && noteActionMatch !== null) {
          const note = await setDocumentNoteStatus(workspace, noteActionMatch[1]!, noteActionMatch[2] === 'resolve' ? 'resolved' : 'deprecated')
          return json(response, 200, { note })
        }
        if (request.method === 'POST' && url.pathname === '/api/analyze') {
          return json(response, 200, await analyzeWorkspace(workspace))
        }
        if (request.method === 'POST' && url.pathname === '/api/scan') {
          return json(response, 200, await scanWorkspace(workspace))
        }
        if (request.method === 'GET' && url.pathname === '/api/drift') {
          return json(response, 200, { report: await readLatestDriftReport(workspace) })
        }
        if (request.method === 'POST' && url.pathname === '/api/drift/run') {
          return json(response, 200, await runDriftLoop(workspace, 'manual'))
        }
        if (request.method === 'GET' && url.pathname === '/api/events') {
          response.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
          })
          response.write(': ok\n\n')
          const unsubscribe = specOpsSessionEvents.subscribe((event) => {
            response.write(`event: ${event.type}\n`)
            response.write(`data: ${JSON.stringify(event)}\n\n`)
          })
          request.on('close', unsubscribe)
          return
        }
        if (request.method === 'GET' && url.pathname === '/api/sessions') {
          await reconcileSessions(workspace, runtime, kode)
          const sessions = (await listSpecOpsSessions(workspace)).map((session) => withUnverifiedExecution(session, kode))
          return json(response, 200, { sessions })
        }
        const sessionMatch = /^\/api\/sessions\/([0-9a-f-]{36})(?:\/(input|action|interrupt|answer|plan_response))?$/.exec(url.pathname)
        if (sessionMatch !== null) {
          const sessionId = sessionMatch[1] as string
          const action = sessionMatch[2]
          if (request.method === 'GET' && action === undefined) {
            await reconcileSessions(workspace, runtime, kode)
            return json(response, 200, { session: withUnverifiedExecution(await readSpecOpsSession(workspace, sessionId), kode) })
          }
          if (request.method === 'POST' && action === 'interrupt') {
            await reconcileSessions(workspace, runtime, kode)
            const session = await readSpecOpsSession(workspace, sessionId)
            if (session.current_execution === null || session.current_execution.transport === 'legacy_kode_pty'
              || runtime.get(session.current_execution.execution_id) === undefined) {
              return json(response, 409, {
                error: 'resume_required',
                message: 'The previous execution is no longer attached. Resume the durable workflow before interrupting it.',
                required_action: session.required_action,
              })
            }
            const outcome = await runtime.cancel(session.current_execution.execution_id, { requestId: randomUUID(), reason: 'user_interrupt' })
            if (outcome.outcome === 'outcome_unknown') {
              await markStructuredOutcomeUnknown(runtime, workspace, sessionId, outcome.error.message)
              return json(response, 409, { error: 'outcome_unknown', message: outcome.error.message })
            }
            return json(response, 200, { ok: true })
          }
          if (request.method === 'POST' && action === 'input') {
            const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
            if (typeof raw.text !== 'string' || raw.text.trim() === '') return json(response, 400, { error: 'text is required' })
            const prompt = raw.text.trim()
            let session = await readSpecOpsSession(workspace, sessionId)
            if (blockingInteraction(session) !== undefined) {
              return json(response, 409, { error: 'action_required', required_action: session.required_action })
            }
            const sessionBeforeInput = session
            const targetExecutionId = session.current_execution !== null
              && session.current_execution.transport !== 'legacy_kode_pty'
              && runtime.get(session.current_execution.execution_id) !== undefined
              ? session.current_execution.execution_id
              : null
            session = await appendTranscript(workspace, sessionId, 'user', prompt, null, targetExecutionId)
            const userEntry = session.transcript.at(-1)
            specOpsSessionEvents.publish(
              'session.transcript_appended',
              sessionId,
              userEntry === undefined ? { role: 'user' } : { entries: [userEntry] },
            )
            if (session.current_execution === null || session.current_execution.transport === 'legacy_kode_pty'
              || runtime.get(session.current_execution.execution_id) === undefined) {
              const rebuilt = await rebuildSpecOpsExecution(runtime, workspace, sessionBeforeInput, prompt)
              session = rebuilt.session
            } else {
              void promptStructuredExecution(runtime, workspace, session, prompt, { purpose: 'user_chat' })
              session = await readSpecOpsSession(workspace, sessionId)
            }
            return json(response, 200, { accepted: true, session })
          }
          if (request.method === 'POST' && action === 'answer') {
            const session = await readSpecOpsSession(workspace, sessionId)
            const pending = interactionForAction(session)
            if (pending === undefined || pending.kind !== 'questions') {
              return json(response, 409, { error: 'questions_not_pending' })
            }
            const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
            const submitted = Array.isArray(raw.answers) ? raw.answers as Array<Record<string, unknown>> : [raw]
            const answers = submitted.map((item) => ({
              questionId: typeof item.question_id === 'string' ? item.question_id : '',
              choiceIndices: Array.isArray(item.choice_indices)
                ? item.choice_indices.every((value) => typeof value === 'number' && Number.isInteger(value))
                  ? item.choice_indices as number[]
                  : []
                : typeof item.choice_index === 'number' && Number.isInteger(item.choice_index)
                  ? [item.choice_index]
                  : [],
              freeText: typeof item.free_text === 'string' ? item.free_text : undefined,
            }))
            if (answers.length === 0 || answers.some((item) => item.questionId === '' || item.choiceIndices.length === 0)) {
              return json(response, 400, { error: 'answers require question_id and at least one choice index' })
            }
            const expectedIds = pending.payload.questions.map((question) => question.id)
            if (answers.length !== expectedIds.length || answers.some((item, index) => item.questionId !== expectedIds[index])) {
              return json(response, 409, { error: 'answers_do_not_match_pending_questions' })
            }
            const normalizedAnswers = answers.map((answer, index) => {
              const question = pending.payload.questions[index]!
              const uniqueIndices = [...new Set(answer.choiceIndices)]
              if ((!question.multi_select && uniqueIndices.length !== 1)
                || uniqueIndices.some((choiceIndex) => choiceIndex < 0 || choiceIndex >= question.options.length)) return null
              return {
                questionId: answer.questionId,
                choiceIndices: uniqueIndices,
                labels: uniqueIndices.map((choiceIndex) => question.options[choiceIndex]!.label),
                freeText: answer.freeText,
                multiSelect: question.multi_select,
              }
            })
            if (normalizedAnswers.some((answer) => answer === null)) {
              return json(response, 400, { error: 'answer_choices_invalid' })
            }
            const validAnswers = normalizedAnswers.filter((answer): answer is NonNullable<typeof answer> => answer !== null)
            const claimed = await claimInteractionResponse(workspace, sessionId, 'questions', raw)
            if (claimed === null) return json(response, 409, { error: 'interaction_conflict' })
            const execution = claimed.session.current_execution
            if (execution === null || execution.transport === 'legacy_kode_pty' || runtime.get(execution.execution_id) === undefined) {
              await markClaimDeliveryUnknown(workspace, sessionId, claimed.interaction.id, { error: 'structured_execution_missing' })
              return json(response, 409, { error: 'structured_execution_missing' })
            }
            if (pending.payload.response_mode === 'prompt') {
              void promptStructuredExecution(runtime, workspace, claimed.session, questionAnswersPrompt(
                pending.payload.questions,
                validAnswers,
              ), { purpose: 'question_answers' })
            } else {
              try {
                const outcome = await runtime.respond(execution.execution_id, {
                  kind: 'questions',
                  requestId: pending.payload.request_id,
                  answers: Object.fromEntries(validAnswers.map((item) => [
                    item.questionId,
                    item.multiSelect
                      ? [...item.labels, ...(item.freeText?.trim() ? [`Additional details: ${item.freeText.trim()}`] : [])]
                      : item.freeText?.trim() ? `${item.labels[0]} — ${item.freeText.trim()}` : item.labels[0]!,
                  ])),
                })
                if (outcome.outcome === 'outcome_unknown') {
                  await markClaimDeliveryUnknown(workspace, sessionId, claimed.interaction.id, { error: outcome.error.message })
                  return json(response, 409, { error: 'outcome_unknown', message: outcome.error.message })
                }
              } catch (error) {
                await markClaimDeliveryUnknown(workspace, sessionId, claimed.interaction.id, { error: error instanceof Error ? error.message : String(error) })
                return json(response, 409, { error: 'delivery_unknown' })
              }
            }
            const labels = validAnswers.map((item) => {
              const selections = item.labels.join(', ')
              return item.freeText?.trim() ? `${selections} — ${item.freeText.trim()}` : selections
            })
            await appendTranscript(workspace, sessionId, 'user', `(answered: ${labels.join('; ')})`, null, execution.execution_id)
            const updated = await resolveQuestionsCommand(workspace, sessionId, claimed.interaction.id, validAnswers, execution)
            specOpsSessionEvents.publish('session.updated', sessionId, { required_action: updated.required_action })
            return json(response, 200, { session: updated })
          }
          if (request.method === 'POST' && action === 'plan_response') {
            const session = await readSpecOpsSession(workspace, sessionId)
            const pending = interactionForAction(session)
            const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
            const planId = typeof raw.plan_id === 'string' ? raw.plan_id : ''
            const accept = raw.accept === true
            const note = typeof raw.note === 'string' ? raw.note : undefined
            if (planId === '') return json(response, 400, { error: 'plan_id is required' })
            if (pending === undefined || pending.kind !== 'plan_review' || pending.payload.plan_id !== planId) {
              return json(response, 409, { error: 'plan_not_pending' })
            }
            const claimed = await claimInteractionResponse(workspace, sessionId, 'plan_review', raw)
            if (claimed === null) return json(response, 409, { error: 'interaction_conflict' })
            const execution = claimed.session.current_execution
            if (execution === null || execution.transport === 'legacy_kode_pty' || runtime.get(execution.execution_id) === undefined) {
              await markClaimDeliveryUnknown(workspace, sessionId, claimed.interaction.id, { error: 'structured_execution_missing' })
              return json(response, 409, { error: 'structured_execution_missing' })
            }
            if (pending.payload.response_mode === 'prompt') {
              if (!accept) {
                void promptStructuredExecution(runtime, workspace, claimed.session, planRevisionPrompt(note), { purpose: 'plan_revision' })
              }
            } else {
              try {
                const outcome = await runtime.respond(execution.execution_id, {
                  kind: 'plan',
                  requestId: pending.payload.request_id,
                  decision: accept ? 'approve' : 'reject',
                  ...(note === undefined ? {} : { feedback: note }),
                })
                if (outcome.outcome === 'outcome_unknown') {
                  await markClaimDeliveryUnknown(workspace, sessionId, claimed.interaction.id, { error: outcome.error.message })
                  return json(response, 409, { error: 'outcome_unknown', message: outcome.error.message })
                }
              } catch (error) {
                await markClaimDeliveryUnknown(workspace, sessionId, claimed.interaction.id, { error: error instanceof Error ? error.message : String(error) })
                return json(response, 409, { error: 'delivery_unknown' })
              }
            }
            if (accept) await appendTranscript(workspace, sessionId, 'system', 'Plan approved.', null, execution.execution_id)
            else await appendTranscript(workspace, sessionId, 'user', note?.trim() || 'Plan rejected. Please revise.', null, execution.execution_id)
            const updated = await resolvePlanCommand(workspace, sessionId, claimed.interaction.id, accept, note, execution)
            specOpsSessionEvents.publish('session.action_required', sessionId, updated.required_action)
            return json(response, 200, { ok: true, session: updated, plan_approved: accept })
          }
          if (request.method === 'POST' && action === 'action') {
            const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
            const kind = typeof raw.kind === 'string' ? raw.kind : ''
            // Executions are process-local while sessions and Runs are
            // durable. A sidecar restart (or a replaced stage agent) can leave
            // an old execution id in the record. Reconcile before dispatching
            // any user action so we surface a resumable workflow state instead
            // of passing an unknown id to the runtime manager.
            await reconcileSessions(workspace, runtime, kode)
            const session = await readSpecOpsSession(workspace, sessionId)
            const serializedKinds = new Set(['run_in_worktree', 'verify', 'accept', 'feedback', 'apply', 'apply_with_verify', 'rollback', 'resume'])
            if (serializedKinds.has(kind)) {
              const key = `${sessionId}:${kind}`
              if (activeActions.has(key)) return json(response, 409, { error: 'action_in_progress', kind })
              activeActions.add(key)
              const release = (): void => { activeActions.delete(key) }
              response.once('finish', release)
              response.once('close', release)
            }
            if (kind === 'close') {
              if (session.current_execution !== null && session.current_execution.transport !== 'legacy_kode_pty') {
                await runtime.close(session.current_execution.execution_id).catch(() => undefined)
              }
              if (kode !== undefined) {
                const ids = new Set(session.agents.flatMap((agent) => agent.kode_session_id === null ? [] : [agent.kode_session_id]))
                if (session.kode_session_id !== null) ids.add(session.kode_session_id)
                for (const id of ids) await kode.killSession(id).catch(() => undefined)
              }
              if (session.run_id !== null) {
                try {
                  const run = await readRun(workspace, session.run_id)
                  if (run.state !== 'cancelled' && run.state !== 'completed' && run.state !== 'applied') await transitionRun(run, 'cancelled')
                } catch { /* closing the session must still succeed */ }
              }
              const closed = await closeSpecOpsSession(workspace, sessionId)
              specOpsSessionEvents.publish('session.closed', sessionId)
              return json(response, 200, { session: closed })
            }
            if (kind === 'reopen') {
              if (session.state !== 'completed' && session.state !== 'failed' && session.state !== 'cancelled') {
                return json(response, 409, { error: 'session_not_reopenable', state: session.state })
              }
              if (session.document_path === null || session.workflow_applicable === false) {
                return json(response, 409, { error: 'workflow_not_applicable', message: 'Only implementation work items with an existing document can be reopened.' })
              }
              const reopened = await updateSpecOpsSession(workspace, sessionId, (record) => {
                // Keep the original document, transcript, decisions, and agent
                // history. A completed Run is immutable history; the next loop
                // receives a fresh Run when the user launches implementation.
                record.run_id = null
                record.kode_session_id = null
                record.phase = 'run_in_worktree'
                record.state = 'awaiting_user'
                record.required_action = { kind: 'run_in_worktree' }
                record.execution.last_error = null
                record.execution.last_reconciled_at = new Date().toISOString()
              })
              specOpsSessionEvents.publish('session.action_required', sessionId, reopened.required_action)
              return json(response, 200, { session: reopened })
            }
            if (kind === 'focus') {
              if (session.current_execution !== null && session.current_execution.transport !== 'legacy_kode_pty') {
                return json(response, 409, { error: 'focus_not_supported', capability: false })
              }
              if (kode === undefined || session.kode_session_id === null) return json(response, 409, { error: 'legacy_kode_session_missing' })
              await kode.focusSession(session.kode_session_id)
              return json(response, 200, { ok: true, capability: true })
            }
            if (kind === 'permission_allow' || kind === 'permission_deny') {
              const pending = interactionForAction(session)
              if (pending === undefined || pending.kind !== 'permission') {
                return json(response, 409, { error: 'permission_not_pending' })
              }
              const claimed = await claimInteractionResponse(workspace, sessionId, 'permission', raw)
              if (claimed === null) return json(response, 409, { error: 'interaction_conflict' })
              const execution = claimed.session.current_execution
              if (execution === null || execution.transport === 'legacy_kode_pty' || runtime.get(execution.execution_id) === undefined) {
                const recovered = await markClaimDeliveryUnknown(workspace, sessionId, claimed.interaction.id, { error: 'structured_execution_missing' })
                specOpsSessionEvents.publish('session.action_required', sessionId, recovered.required_action)
                return json(response, 409, { error: 'structured_execution_missing' })
              }
              const decision = kind === 'permission_allow' ? 'allow' : 'deny'
              try {
                const outcome = await runtime.respond(execution.execution_id, {
                  kind: 'permission', requestId: pending.payload.request_id, decision, remember: raw.remember === true,
                })
                if (outcome.outcome === 'outcome_unknown') {
                  const recovered = await markClaimDeliveryUnknown(workspace, sessionId, claimed.interaction.id, { error: outcome.error.message })
                  specOpsSessionEvents.publish('session.action_required', sessionId, recovered.required_action)
                  return json(response, 409, { error: 'outcome_unknown', message: outcome.error.message })
                }
              } catch (error) {
                const recovered = await markClaimDeliveryUnknown(workspace, sessionId, claimed.interaction.id, { error: error instanceof Error ? error.message : String(error) })
                specOpsSessionEvents.publish('session.action_required', sessionId, recovered.required_action)
                return json(response, 409, { error: 'delivery_unknown' })
              }
              const updated = await resolvePermissionCommand(workspace, sessionId, claimed.interaction.id, decision, raw.remember === true)
              // The action endpoint does not optimistically update the client
              // store. Publish the resolved queue head so an answered
              // permission card is removed immediately, just like answers.
              specOpsSessionEvents.publish('session.updated', sessionId, {
                required_action: updated.required_action,
                state: updated.state,
              })
              return json(response, 200, { session: updated })
            }
            if (kind === 'resume') {
              if (!RESUMABLE_SESSION_PHASES.has(session.phase)) {
                return json(response, 400, { error: 'unsupported_resume_phase', phase: session.phase })
              }
              if (session.run_id !== null) {
                const run = await readRun(workspace, session.run_id)
                if (run.state !== 'running') return json(response, 409, { error: 'run_not_running', state: run.state })
                const attachedExecution = session.current_execution
                if (hasRunMonitor(run.run_id) && attachedExecution !== null
                  && attachedExecution.transport !== 'legacy_kode_pty'
                  && runtime.get(attachedExecution.execution_id) !== undefined) {
                  return json(response, 200, { session, run, already_resumed: true })
                }
                unwatchRun(run.run_id)
                const turn = await resumeRunExecution(run, runtime, session.id)
                await resolveRunInteraction(workspace, session.id, ['resume'], { resumed: true, request_id: turn.binding.request_id })
                watchRun(run.run_id, workspace, turn)
                const updated = await readSpecOpsSession(workspace, session.id)
                return json(response, 200, { session: updated, run: turn.run })
              }
              await rebuildSpecOpsExecution(runtime, workspace, session)
              await resolveRunInteraction(workspace, session.id, ['resume'], { resumed: true })
              return json(response, 200, { session: await readSpecOpsSession(workspace, session.id) })
            }
            if (kind === 'promote_intake') {
              const promoted = await promoteDurableClarify(runtime, workspace, sessionId, raw)
              if (promoted === null) return json(response, 409, { error: 'clarify_not_ready' })
              if (promoted.completion !== undefined) {
                trackBackground(observeSessionTurn(runtime, workspace, promoted.session, promoted.completion))
              }
              specOpsSessionEvents.publish('session.updated', sessionId, {
                phase: promoted.session.phase,
                current_execution: promoted.execution,
              })
              return json(response, promoted.completion === undefined ? 200 : 201, {
                intake_id: sessionId,
                session: promoted.execution,
                specops_session: promoted.session,
              })
            }
            if (kind === 'run_in_worktree') {
              if (session.run_id !== null) {
                const existingRun = await readRun(workspace, session.run_id)
                return json(response, 200, { session, run: existingRun, already_launched: true })
              }
              if (!Array.isArray(raw.tasks)) return json(response, 400, { error: 'tasks are required' })
              const tasks = raw.tasks as Task[]
              if (tasks.some((task) => typeof task.id !== 'string' || typeof task.title !== 'string' || typeof task.prompt !== 'string' || !Array.isArray(task.verify))) {
                return json(response, 400, { error: 'invalid task' })
              }
              const selected = await agentSelection(workspace, 'implementation', raw)
              const backendKey = selected.backend
              const model = selected.model
              if (!structuredBackendSupported(backendKey)) {
                return json(response, 409, { error: 'unsupported_execution_backend', backend_key: backendKey })
              }
              // Resolve the change proposal id this Run should be linked to.
              // Priority: explicit `change_id` in the request body > reverse-resolve
              // from the session's document_path (read the proposal.md frontmatter).
              // Null when neither is available (quick-runs, spec-only sessions).
              let changeId: string | null = typeof raw.change_id === 'string' && raw.change_id.trim() !== '' ? raw.change_id : null
              if (changeId === null && session.document_path !== null) {
                changeId = await readChangeIdFromDocumentPath(workspace, session.document_path)
              }
              const run = await launchRun(workspace, tasks, backendKey, typeof raw.base === 'string' ? raw.base : 'HEAD', options.runCacheRoot, model, changeId)
              await updateSpecOpsSession(workspace, sessionId, (record) => {
                record.backend_key = backendKey
                record.kode_session_id = null
                record.run_id = run.run_id
                record.phase = 'run_in_worktree'
                record.state = 'active'
                record.required_action = null
              })
              const started = await startRunExecution(run, runtime, sessionId, options.runCacheRoot)
              watchRun(run.run_id, workspace, started)
              const updated = await readSpecOpsSession(workspace, sessionId)
              specOpsSessionEvents.publish('session.updated', sessionId, { run_id: run.run_id, current_execution: updated.current_execution })
              return json(response, 201, { session: updated, run: started.run })
            }
            if (session.run_id !== null && (kind === 'verify' || kind === 'accept' || kind === 'reject' || kind === 'feedback' || kind === 'apply' || kind === 'apply_with_verify' || kind === 'rollback')) {
              const run = await readRun(workspace, session.run_id)
              if (kind === 'verify') {
                if (run.state === 'awaiting_review') {
                  return json(response, 200, { session, run, already_verified: true })
                }
                if (run.state !== 'awaiting_verify') {
                  return json(response, 409, { error: 'run_not_verifiable', state: run.state })
                }
                const result = await verifyAndRouteReview(runtime, workspace, run, sessionId)
                return json(response, 200, { session: await readSpecOpsSession(workspace, sessionId), ...result })
              }
              if (kind === 'apply') {
                const outcome = await applyCompletedRun(run)
                const updated = await updateSpecOpsSession(workspace, sessionId, (record) => {
                  record.phase = 'completed'
                  record.state = 'completed'
                  record.required_action = null
                })
                await terminateSpecOpsExecution(runtime, kode, workspace, sessionId, run.run_id)
                specOpsSessionEvents.publish('session.updated', sessionId, { phase: updated.phase, state: updated.state })
                return json(response, 200, { session: updated, ok: true, applied: outcome.applied, reason: outcome.reason, commit: outcome.commit })
              }
              if (kind === 'apply_with_verify') {
                // Recovery path: a run stranded in 'applying' (interrupted apply)
                // or sitting in 'applied_failed' (verify failed after merge) must
                // be reset to 'awaiting_review' before applyWithVerify will accept
                // it — otherwise the retry button would just throw run_not_reviewable.
                if (run.state === 'applying' || run.state === 'applied_failed') {
                  await transitionRun(run, 'awaiting_review')
                }
                const result = await applyWithVerify(run)
                const updated = await updateSpecOpsSession(workspace, sessionId, (record) => {
                  if (result.allOk) {
                    record.phase = 'completed'
                    record.state = 'completed'
                    record.required_action = null
                  } else {
                    record.phase = 'apply_patch'
                    record.state = 'awaiting_user'
                    record.required_action = { kind: 'apply_patch' }
                  }
                })
                if (result.allOk) await terminateSpecOpsExecution(runtime, kode, workspace, sessionId, run.run_id)
                specOpsSessionEvents.publish('session.updated', sessionId, {
                  phase: updated.phase,
                  state: updated.state,
                  verify_results: result.verifyResults,
                  all_ok: result.allOk,
                })
                return json(response, 200, { session: updated, verify_results: result.verifyResults, all_ok: result.allOk, applied: result.applied, reason: result.reason, commit: result.commit })
              }
              if (kind === 'rollback') {
                await rollbackRunPatch(run)
                const updated = await updateSpecOpsSession(workspace, sessionId, (record) => {
                  record.phase = 'failed'
                  record.state = 'failed'
                  record.required_action = null
                })
                specOpsSessionEvents.publish('session.updated', sessionId, { phase: updated.phase, state: updated.state })
                return json(response, 200, { session: updated, ok: true })
              }
              if (kind === 'accept' && run.state === 'completed') {
                return json(response, 200, { session, run, already_accepted: true })
              }
              const verdict = kind === 'accept' ? 'accept' : kind === 'reject' ? 'reject' : 'feedback'
              await resolveRunInteraction(workspace, sessionId, ['human_review'], {
                verdict,
                note: typeof raw.note === 'string' ? raw.note : '',
              })
              const decision = await decideRun(run, verdict, typeof raw.note === 'string' ? raw.note : '', runtime)
              const decided = decision.run
              const updated = await updateSpecOpsSession(workspace, sessionId, (record) => {
                if (decided.state === 'running') {
                  record.phase = 'run_in_worktree'
                  record.state = 'active'
                } else if (decided.state === 'completed') {
                  record.phase = 'apply_patch'
                  record.state = 'awaiting_user'
                } else if (decided.state === 'cancelled') {
                  record.phase = 'cancelled'
                  record.state = 'cancelled'
                }
              })
              if (decided.state === 'running' && decision.turn !== undefined) watchRun(decided.run_id, workspace, decision.turn)
              specOpsSessionEvents.publish(updated.required_action === null ? 'session.updated' : 'session.action_required', sessionId, updated.required_action)
              return json(response, 200, { session: updated, run: decided })
            }
            return json(response, 400, { error: 'unsupported_session_action' })
          }
        }
        if (request.method === 'POST' && url.pathname === '/api/intakes') {
          const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
          if (typeof raw.request !== 'string' || raw.request.trim() === '') {
            return json(response, 400, { error: 'request is required' })
          }
          const selected = await agentSelection(workspace, 'analysis', raw)
          const backendKey = selected.backend
          const intakeModel = selected.model
          const prePlan = raw.pre_plan === true
          const receiptId = randomUUID()
          if (prePlan) {
            const missing = await workflowCapabilityGap(workspace, backendKey, 'pre_plan')
            if (missing.length > 0) {
              return json(response, 422, { error: 'capability_missing', backend_key: backendKey, required: missing })
            }
            const requestText = raw.request.trim()
            const created = await createSpecOpsSession(workspace, {
              title: titleFromRequest(requestText), backend_key: backendKey, phase: 'plan_discussion', state: 'created',
              intake_receipt_id: receiptId,
              transcript: [{ role: 'user', text: requestText, at: new Date().toISOString() }],
            })
            const execution = await runtime.start({
              workspace, sessionId: created.id, purpose: 'plan', backendKey, cwd: workspace, mode: 'plan',
              ...(intakeModel === undefined ? {} : { model: intakeModel }),
            })
            const specopsSession = await readSpecOpsSession(workspace, created.id)
            const completion = runtime.prompt(execution.execution_id, {
              requestId: randomUUID(),
              text: await withAgentPrompt(workspace, 'analysis', buildIntakePlanPrompt(requestText, receiptId)),
              metadata: { specops_session_id: created.id, purpose: 'plan', receipt_id: receiptId },
            })
            trackBackground(observeSessionTurn(runtime, workspace, specopsSession, completion))
            specOpsSessionEvents.publish('session.created', specopsSession.id, { current_execution: execution })
            return json(response, 201, { intake_id: specopsSession.id, session: execution, specops_session: specopsSession, plan_phase: true })
          }
          const requestText = raw.request.trim()
          const created = await createSpecOpsSession(workspace, {
            title: titleFromRequest(requestText), backend_key: backendKey, phase: 'analyze_request', state: 'created',
            intake_receipt_id: receiptId,
            transcript: [{ role: 'user', text: requestText, at: new Date().toISOString() }],
          })
          const execution = await runtime.start({
            workspace, sessionId: created.id, purpose: 'intake', backendKey, cwd: workspace, mode: 'acceptEdits',
            ...(intakeModel === undefined ? {} : { model: intakeModel }),
          })
          const specopsSession = await readSpecOpsSession(workspace, created.id)
          const completion = runtime.prompt(execution.execution_id, {
            requestId: randomUUID(),
            text: await withAgentPrompt(workspace, 'analysis', buildIntakePrompt(requestText, receiptId)),
            metadata: { specops_session_id: created.id, purpose: 'intake', receipt_id: receiptId },
          })
          trackBackground(observeSessionTurn(runtime, workspace, specopsSession, completion))
          specOpsSessionEvents.publish('session.created', specopsSession.id, { current_execution: execution })
          return json(response, 201, { intake_id: specopsSession.id, session: execution, specops_session: specopsSession })
        }
        // Compatibility wrapper for the durable session plan command.
        const intakePlanMatch = /^\/api\/intakes\/([0-9a-f-]{36})\/plan_response$/.exec(url.pathname)
        if (request.method === 'POST' && intakePlanMatch !== null) {
          const id = intakePlanMatch[1] as string
          const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
          const current = await readSpecOpsSession(workspace, id)
          const pending = interactionForAction(current)
          const planId = typeof raw.plan_id === 'string' ? raw.plan_id : ''
          if (pending === undefined || pending.kind !== 'plan_review' || pending.payload.plan_id !== planId) {
            return json(response, 409, { error: 'plan_not_pending' })
          }
          const claimed = await claimInteractionResponse(workspace, id, 'plan_review', raw)
          if (claimed === null) return json(response, 409, { error: 'interaction_conflict' })
          const execution = claimed.session.current_execution
          if (execution === null || execution.transport === 'legacy_kode_pty' || runtime.get(execution.execution_id) === undefined) {
            await markClaimDeliveryUnknown(workspace, id, claimed.interaction.id, { error: 'structured_execution_missing' })
            return json(response, 409, { error: 'structured_execution_missing' })
          }
          const accept = raw.accept === true
          const note = typeof raw.note === 'string' ? raw.note : undefined
          if (pending.payload.response_mode === 'prompt') {
            if (!accept) void promptStructuredExecution(runtime, workspace, claimed.session, planRevisionPrompt(note), { purpose: 'plan_revision' })
          } else {
            const outcome = await runtime.respond(execution.execution_id, {
              kind: 'plan', requestId: pending.payload.request_id, decision: accept ? 'approve' : 'reject',
              ...(note === undefined ? {} : { feedback: note }),
            })
            if (outcome.outcome === 'outcome_unknown') {
              await markClaimDeliveryUnknown(workspace, id, claimed.interaction.id, { error: outcome.error.message })
              return json(response, 409, { error: 'outcome_unknown', message: outcome.error.message })
            }
          }
          const updated = await resolvePlanCommand(workspace, id, claimed.interaction.id, accept, note, execution)
          specOpsSessionEvents.publish('session.action_required', id, updated.required_action)
          return json(response, 200, { ok: true, plan_approved: accept, session: updated })
        }
        const intakeMatch = /^\/api\/intakes\/([0-9a-f-]{36})$/.exec(url.pathname)
        if (request.method === 'GET' && intakeMatch !== null) {
          const intakeId = intakeMatch[1] as string
          let session = await readSpecOpsSession(workspace, intakeId)
          const receiptId = session.intake_receipt_id
            ?? session.interactions?.find((interaction) => interaction.kind === 'start_intake')?.payload.receipt_id
            ?? findLatestReceiptId(session.transcript.map((entry) => entry.text).join('\n'))
          if (receiptId === null || receiptId === undefined) return json(response, 404, { error: 'intake_not_found' })
          const planPhase = session.phase === 'plan_discussion' || session.phase === 'solution_options'
            || session.phase === 'plan_approved'
          const planApproved = session.clarification!.approved_plan !== null
          let document: { path: string; version: string } | null = null
          let documents: string[] = []
          let error = session.execution.last_error
          const receiptPath = pathInside(workspace, '.specops', 'state', 'intakes', `${receiptId}.json`)
          if (await exists(receiptPath)) {
            try {
              const finalized = await finalizeCompletedIntake(workspace, session.id, receiptId, session.title)
              documents = finalized.documents
              document = { path: finalized.primary, version: finalized.version }
              error = finalized.checklistError
              specOpsSessionEvents.publish(
                finalized.isDocOnly ? 'session.updated' : 'session.action_required',
                session.id,
                finalized.isDocOnly ? { phase: 'completed' } : { phase: 'run_in_worktree', document_path: finalized.primary },
              )
              session = await readSpecOpsSession(workspace, session.id)
            } catch (caught) {
              error = caught instanceof Error ? caught.message : String(caught)
              session = await updateSpecOpsSession(workspace, session.id, (record) => {
                record.execution.last_error = error
                record.execution.last_reconciled_at = new Date().toISOString()
              })
              specOpsSessionEvents.publish('session.updated', session.id, { intake_finalize_error: error })
            }
          }
          return json(response, 200, {
            intake_id: intakeId,
            session,
            document,
            documents,
            error,
            specops_session_id: session.id,
            ...(planPhase ? { plan_phase: true, plan_approved: planApproved } : {}),
          })
        }
        // ── Clarify routes ──
        if (request.method === 'POST' && url.pathname === '/api/clarifies') {
          const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
          if (typeof raw.request !== 'string' || raw.request.trim() === '') {
            return json(response, 400, { error: 'request is required' })
          }
          const selected = await agentSelection(workspace, 'analysis', raw)
          const backendKey = selected.backend
          const clarifyModel = selected.model
          const missing = await workflowCapabilityGap(workspace, backendKey, 'clarify')
          if (missing.length > 0) {
            return json(response, 422, { error: 'capability_missing', backend_key: backendKey, required: missing })
          }
          const requestText = raw.request.trim()
          const documentPath = typeof raw.document_path === 'string' && raw.document_path.trim() !== '' ? raw.document_path.trim() : null
          if (documentPath !== null) {
            const existing = await findActiveSpecOpsSessionByDocument(workspace, documentPath)
            if (existing !== null) {
              if (blockingInteraction(existing) !== undefined || existing.state === 'awaiting_user') {
                return json(response, 409, { error: 'document_session_awaiting_action', specops_session: existing })
              }
              const execution = existing.current_execution
              if (execution === null || execution.transport === 'legacy_kode_pty'
                || runtime.get(execution.execution_id) === undefined) {
                return json(response, 409, { error: 'resume_required', specops_session: existing })
              }
              const completion = runtime.prompt(execution.execution_id, {
                requestId: randomUUID(), text: requestText,
                metadata: { specops_session_id: existing.id, purpose: 'clarify' },
              })
              const updated = await appendTranscript(workspace, existing.id, 'user', requestText, null, execution.execution_id)
              const entry = updated.transcript.at(-1)
              specOpsSessionEvents.publish('session.transcript_appended', existing.id, entry === undefined ? { role: 'user' } : { entries: [entry] })
              trackClarifyTurn(existing.id, completion)
              return json(response, 200, {
                clarify_id: existing.id,
                session: execution,
                specops_session: updated,
                reused: true,
              })
            }
          }
          const created = await createSpecOpsSession(workspace, {
            title: titleFromRequest(requestText), backend_key: backendKey, document_path: documentPath,
            phase: 'clarify', state: 'created',
            transcript: [{ role: 'user', text: requestText, at: new Date().toISOString() }],
          })
          const execution = await runtime.start({
            workspace, sessionId: created.id, purpose: 'clarify', backendKey, cwd: workspace, mode: 'plan',
            ...(clarifyModel === undefined ? {} : { model: clarifyModel }),
          })
          const specopsSession = await readSpecOpsSession(workspace, created.id)
          const completion = runtime.prompt(execution.execution_id, {
            requestId: randomUUID(),
            text: await withAgentPrompt(workspace, 'analysis', buildClarifyPrompt(requestText, created.id)),
            metadata: { specops_session_id: created.id, purpose: 'clarify', clarify_id: created.id },
          })
          trackClarifyTurn(created.id, completion)
          specOpsSessionEvents.publish('session.created', specopsSession.id, { current_execution: execution })
          return json(response, 201, { clarify_id: specopsSession.id, session: execution, specops_session: specopsSession })
        }
        const clarifyPollMatch = /^\/api\/clarifies\/([0-9a-f-]{36})$/.exec(url.pathname)
        if (request.method === 'GET' && clarifyPollMatch !== null) {
          const id = clarifyPollMatch[1] as string
          await reconcileSessions(workspace, runtime, kode)
          const specopsSession = await readSpecOpsSession(workspace, id)
          const pendingAction = specopsSession.required_action
          const status = pendingAction?.kind === 'plan_review'
            ? 'plan_proposed'
            : pendingAction?.kind === 'promote_intake'
              ? 'ready'
              : pendingAction?.kind === 'resume' || specopsSession.state === 'failed'
                ? 'error'
                : 'asking'
          const execution = specopsSession.current_execution
          return json(response, 200, {
            clarify_id: id,
            session: execution === null ? null : runtime.get(execution.execution_id) ?? execution,
            status,
            transcript: specopsSession.transcript.filter((entry) => entry.role === 'agent' || entry.role === 'user'),
            error: specopsSession.execution.last_error,
            specops_session: specopsSession,
          })
        }
        const clarifyAnswerMatch = /^\/api\/clarifies\/([0-9a-f-]{36})\/answer$/.exec(url.pathname)
        if (request.method === 'POST' && clarifyAnswerMatch !== null) {
          const id = clarifyAnswerMatch[1] as string
          const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
          if (typeof raw.answer !== 'string' || raw.answer.trim() === '') return json(response, 400, { error: 'answer is required' })
          const answer = raw.answer.trim()
          const current = await readSpecOpsSession(workspace, id)
          const pending = interactionForAction(current)
          const execution = current.current_execution
          if (execution === null || execution.transport === 'legacy_kode_pty'
            || runtime.get(execution.execution_id) === undefined) {
            return json(response, 409, { error: 'structured_execution_missing' })
          }
          if (pending?.kind === 'plan_review') {
            return json(response, 409, { error: 'plan_review_required', required_action: current.required_action })
          }
          if (pending !== undefined && pending.kind !== 'questions') {
            return json(response, 409, { error: 'action_required', required_action: current.required_action })
          }
          if (pending?.kind === 'questions') {
            if (pending.payload.questions.length !== 1) {
              return json(response, 409, { error: 'structured_answers_required', required_action: current.required_action })
            }
            const claimed = await claimInteractionResponse(workspace, id, 'questions', raw)
            if (claimed === null) return json(response, 409, { error: 'interaction_conflict' })
            const question = pending.payload.questions[0]!
            if (pending.payload.response_mode === 'prompt') {
              void promptStructuredExecution(runtime, workspace, claimed.session, questionAnswersPrompt(
                pending.payload.questions,
                [{ questionId: question.id, labels: [answer] }],
              ), { purpose: 'question_answers' })
            } else {
              try {
                const outcome = await runtime.respond(execution.execution_id, {
                  kind: 'questions', requestId: pending.payload.request_id, answers: { [question.id]: answer },
                })
                if (outcome.outcome === 'outcome_unknown') {
                  await markClaimDeliveryUnknown(workspace, id, claimed.interaction.id, { error: outcome.error.message })
                  return json(response, 409, { error: 'outcome_unknown', message: outcome.error.message })
                }
              } catch (error) {
                await markClaimDeliveryUnknown(workspace, id, claimed.interaction.id, { error: error instanceof Error ? error.message : String(error) })
                return json(response, 409, { error: 'delivery_unknown' })
              }
            }
            await appendTranscript(workspace, id, 'user', answer, null, execution.execution_id)
            const updated = await resolveQuestionsCommand(workspace, id, claimed.interaction.id, [{
              questionId: question.id, labels: [answer],
            }], execution)
            return json(response, 200, { ok: true, status: 'asking', specops_session: updated })
          }
          const completion = runtime.prompt(execution.execution_id, {
            requestId: randomUUID(), text: answer,
            metadata: { specops_session_id: current.id, purpose: 'clarify' },
          })
          const updated = await appendTranscript(workspace, id, 'user', answer, null, execution.execution_id)
          const entry = updated.transcript.at(-1)
          specOpsSessionEvents.publish('session.transcript_appended', id, entry === undefined ? { role: 'user' } : { entries: [entry] })
          trackClarifyTurn(id, completion)
          return json(response, 200, { ok: true, status: 'asking', specops_session: updated })
        }
        const clarifyPromoteMatch = /^\/api\/clarifies\/([0-9a-f-]{36})\/promote$/.exec(url.pathname)
        if (request.method === 'POST' && clarifyPromoteMatch !== null) {
          const id = clarifyPromoteMatch[1] as string
          const rawBody = (await requestBody(request)).toString('utf8')
          const raw = rawBody.trim() === '' ? {} : JSON.parse(rawBody) as Record<string, unknown>
          const promoted = await promoteDurableClarify(runtime, workspace, id, raw)
          if (promoted === null) return json(response, 409, { error: 'clarify_not_ready' })
          if (promoted.completion !== undefined) {
            trackBackground(observeSessionTurn(runtime, workspace, promoted.session, promoted.completion))
          }
          specOpsSessionEvents.publish('session.updated', id, { phase: promoted.session.phase, current_execution: promoted.execution })
          return json(response, promoted.completion === undefined ? 200 : 201, {
            intake_id: id,
            session: promoted.execution,
            specops_session: promoted.session,
          })
        }
        if (request.method === 'GET' && url.pathname === '/api/document') {
          let relativePath = url.searchParams.get('path') ?? ''
          let file = await resolveDocumentPath(workspace, relativePath)
          // Change folder paths resolve to directories — redirect to proposal.md
          try {
            const fileStat = await import('node:fs/promises').then((m) => m.stat(file))
            if (fileStat.isDirectory()) {
              relativePath = `${relativePath.replace(/\/$/, '')}/proposal.md`
              file = path.join(file, 'proposal.md')
              if (!await exists(file)) return json(response, 404, { error: 'proposal_not_found' })
            }
          } catch { /* stat failed — let readText throw its own error */ }
          const content = await readText(file)
          const document = isSpecDocumentPath(file) ? parseDocument(content, relativePath) : null
          return json(response, 200, { document, content, version: version(content) })
        }
        if (request.method === 'PUT' && url.pathname === '/api/document') {
          const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
          if (typeof raw.path !== 'string' || typeof raw.content !== 'string' || typeof raw.version !== 'string') {
            return json(response, 400, { error: 'path, content, and version are required' })
          }
          const file = await resolveDocumentPath(workspace, raw.path)
          const before = await readText(file)
          if (version(before) !== raw.version) return json(response, 409, { error: 'document_changed' })
          if (isSpecDocumentPath(file)) parseDocument(raw.content, raw.path)
          await atomicWrite(file, raw.content)
          return json(response, 200, { ok: true, version: version(raw.content) })
        }
        if (request.method === 'POST' && url.pathname === '/api/document/deprecate') {
          const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
          if (typeof raw.path !== 'string') return json(response, 400, { error: 'path is required' })
          let relativePath = raw.path
          let file = await resolveDocumentPath(workspace, relativePath)
          const fileStat = await import('node:fs/promises').then((module) => module.stat(file))
          if (fileStat.isDirectory()) {
            relativePath = `${relativePath.replace(/\/$/, '')}/proposal.md`
            file = path.join(file, 'proposal.md')
          }
          const document = parseDocument(await readText(file), relativePath)
          document.frontmatter.schema_version = 2
          document.frontmatter.status = isNormative(document.frontmatter) ? 'deprecated' : 'cancelled'
          const content = serializeDocument(document)
          await atomicWrite(file, content)

          const documentKey = canonicalDocumentKey(raw.path)
          const closedSessions: string[] = []
          const killedKodeSessions = new Set<number>()
          for (const session of await listSpecOpsSessionRecords(workspace)) {
            if (canonicalDocumentKey(session.document_path) !== documentKey || isTerminalSessionState(session.state)) continue
            if (session.current_execution !== null && session.current_execution.transport !== 'legacy_kode_pty') {
              await runtime.close(session.current_execution.execution_id).catch(() => undefined)
            }
            if (kode !== undefined) {
              for (const agent of session.agents) {
                if (agent.kode_session_id === null || killedKodeSessions.has(agent.kode_session_id)) continue
                await kode.killSession(agent.kode_session_id).catch(() => undefined)
                killedKodeSessions.add(agent.kode_session_id)
              }
              if (session.kode_session_id !== null && !killedKodeSessions.has(session.kode_session_id)) {
                await kode.killSession(session.kode_session_id).catch(() => undefined)
                killedKodeSessions.add(session.kode_session_id)
              }
            }
            if (session.run_id !== null) {
              try {
                const run = await readRun(workspace, session.run_id)
                if (run.state !== 'cancelled' && run.state !== 'completed' && run.state !== 'applied') await transitionRun(run, 'cancelled')
              } catch { /* best-effort: session closure remains authoritative */ }
            }
            await closeSpecOpsSession(workspace, session.id)
            closedSessions.push(session.id)
            specOpsSessionEvents.publish('session.updated', session.id, { state: 'closed', reason: 'document_deprecated' })
          }
          return json(response, 200, {
            ok: true,
            status: document.frontmatter.status,
            version: version(content),
            closed_sessions: closedSessions,
            killed_kode_sessions: [...killedKodeSessions],
          })
        }
        if (request.method === 'POST' && url.pathname === '/api/document') {
          const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
          if (typeof raw.path !== 'string' || typeof raw.content !== 'string') {
            return json(response, 400, { error: 'path and content are required' })
          }
          const file = await resolveNewDocumentPath(workspace, raw.path)
          if (await exists(file)) return json(response, 409, { error: 'document_already_exists' })
          parseDocument(raw.content, raw.path)  // 验证格式
          await atomicWrite(file, raw.content)
          return json(response, 201, { ok: true, path: raw.path, version: version(raw.content) })
        }
        // --- git document history (phase D) ---
        // Returns the commit history of a single canonical document file.
        // Uses `git log --follow` so renames are tracked. Only the subject line
        // is returned; the full diff for a given commit is a separate endpoint
        // (/api/document/diff) so list rendering stays cheap.
        if (request.method === 'GET' && url.pathname === '/api/document/history') {
          const relPath = url.searchParams.get('path') ?? ''
          const limitRaw = url.searchParams.get('limit')
          const limit = limitRaw === null ? 50 : Math.min(500, Math.max(1, Number(limitRaw) || 50))
          let absFile: string
          try {
            absFile = await resolveDocumentPath(workspace, relPath)
          } catch {
            return json(response, 400, { error: 'invalid_path' })
          }
          const gitRel = path.relative(workspace, absFile)
          try {
            const { stdout } = await execFile(
              'git',
              [
                '-C', workspace,
                'log',
                '--follow',
                `--max-count=${limit}`,
                `--format=%H%x00%an%x00%aI%x00%s`,
                '--',
                gitRel,
              ],
              { maxBuffer: 8 * 1024 * 1024, timeout: 10_000 },
            )
            const commits = stdout
              .split('\n')
              .filter((line) => line.length > 0)
              .map((line) => {
                const [hash, author, date, message] = line.split('\x00')
                return {
                  hash: hash ?? '',
                  short: (hash ?? '').slice(0, 8),
                  author: author ?? '',
                  date: date ?? '',
                  message: message ?? '',
                }
              })
            return json(response, 200, { commits })
          } catch (error) {
            // Non-git or file never committed: return empty history, not a 500.
            const message = error instanceof Error ? error.message : String(error)
            return json(response, 200, { commits: [], warning: message })
          }
        }
        // Returns the unified diff for a single commit touching the file.
        // Hash is validated against a strict hex regex to prevent injection.
        if (request.method === 'GET' && url.pathname === '/api/document/diff') {
          const relPath = url.searchParams.get('path') ?? ''
          const hash = url.searchParams.get('hash') ?? ''
          if (!/^[0-9a-f]{7,40}$/.test(hash)) {
            return json(response, 400, { error: 'invalid_hash' })
          }
          let absFile: string
          try {
            absFile = await resolveDocumentPath(workspace, relPath)
          } catch {
            return json(response, 400, { error: 'invalid_path' })
          }
          const gitRel = path.relative(workspace, absFile)
          try {
            const { stdout } = await execFile(
              'git',
              [
                '-C', workspace,
                'log',
                '-1',
                '-p',
                '--full-index',
                '--format=',
                hash,
                '--',
                gitRel,
              ],
              { maxBuffer: 32 * 1024 * 1024, timeout: 15_000 },
            )
            return json(response, 200, { hash, diff: stdout })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return json(response, 200, { hash, diff: '', warning: message })
          }
        }
        // --- document notes ---
        if (request.method === 'GET' && url.pathname === '/api/notes') {
          const documentPath = url.searchParams.get('document_path') ?? undefined
          const identity = await localNoteIdentity(workspace)
          const notes = (await listDocumentNotes(workspace, documentPath)).map((note) => ({ ...note, created_by: note.created_by ?? identity }))
          return json(response, 200, { notes })
        }
        if (request.method === 'POST' && url.pathname === '/api/notes') {
          const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
          if (typeof raw.document_path !== 'string' || typeof raw.block_id !== 'string' || typeof raw.block_kind !== 'string') {
            return json(response, 400, { error: 'document_path, block_id, and block_kind are required' })
          }
          if (typeof raw.quote !== 'string' || typeof raw.body !== 'string') {
            return json(response, 400, { error: 'quote and body are required' })
          }
          const createdBy = await noteCreator(workspace, raw)
          const source: DocumentNoteSource = (typeof raw.source === 'string' && (raw.source === 'ui' || raw.source === 'agent' || raw.source === 'api')) ? raw.source : 'ui'
          const note = await createDocumentNote(workspace, {
            document_path: raw.document_path,
            block_id: raw.block_id,
            block_kind: raw.block_kind,
            line_start: typeof raw.line_start === 'number' ? raw.line_start : null,
            line_end: typeof raw.line_end === 'number' ? raw.line_end : null,
            quote: raw.quote,
            body: raw.body,
            created_by: createdBy,
            source,
          })
          return json(response, 201, { note })
        }
        const notesActionMatch = /^\/api\/notes\/([0-9a-f-]{36})\/(resolve|deprecate)$/.exec(url.pathname)
        if (notesActionMatch !== null) {
          const noteId = notesActionMatch[1]!
          const action = notesActionMatch[2]!
          if (request.method !== 'POST') return json(response, 405, { error: 'method_not_allowed' })
          const status = action === 'resolve' ? 'resolved' as const : 'deprecated' as const
          const note = await setDocumentNoteStatus(workspace, noteId, status)
          return json(response, 200, { note })
        }
        if (request.method === 'POST' && url.pathname === '/api/runs') {
          const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
          if (!Array.isArray(raw.tasks)) {
            return json(response, 400, { error: 'tasks are required' })
          }
          const tasks = raw.tasks as Task[]
          if (tasks.some((task) => typeof task.id !== 'string' || typeof task.title !== 'string' || typeof task.prompt !== 'string' || !Array.isArray(task.verify))) {
            return json(response, 400, { error: 'invalid task' })
          }
          const selected = await agentSelection(workspace, 'implementation', raw)
          const runModel = selected.model
          if (!structuredBackendSupported(selected.backend)) {
            return json(response, 409, { error: 'unsupported_execution_backend', backend_key: selected.backend })
          }
          // Optional: link this Run to a SpecOps change proposal. When non-null,
          // apply paths will flip the matching proposal.md from `proposed` to
          // `completed` once the Run lands. Omit for quick-runs.
          const changeId = typeof raw.change_id === 'string' && raw.change_id.trim() !== '' ? raw.change_id : null
          const run = await launchRun(workspace, tasks, selected.backend, typeof raw.base === 'string' ? raw.base : 'HEAD', options.runCacheRoot, runModel, changeId)
          const documentPath = typeof raw.document_path === 'string' ? raw.document_path : null
          // Authoritative dedup: reuse a live SpecOps session already bound to
          // this document (e.g. the clarify→intake session) instead of spawning
          // a second one. The frontend guard may miss on path-shape drift or the
          // intake→run timing race; this is the backstop.
          const existing = documentPath !== null
            ? await findActiveSpecOpsSessionByDocument(workspace, documentPath)
            : null
          let specopsSession
          if (existing !== null) {
            specopsSession = await updateSpecOpsSession(workspace, existing.id, (record) => {
              record.backend_key = selected.backend
              record.kode_session_id = null
              record.run_id = run.run_id
              record.phase = 'run_in_worktree'
              record.state = 'active'
              record.required_action = null
              if (record.document_path === null) record.document_path = canonicalDocumentKey(documentPath)
            })
            specOpsSessionEvents.publish('session.updated', existing.id, { run_id: run.run_id, kode_session_id: run.kode_session_id })
          } else {
            specopsSession = await createSpecOpsSession(workspace, {
              title: tasks[0]?.title ?? `Run ${run.run_id}`,
              backend_key: selected.backend,
              kode_session_id: run.kode_session_id,
              run_id: run.run_id,
              document_path: documentPath !== null ? canonicalDocumentKey(documentPath) : null,
              phase: 'run_in_worktree',
              state: 'active',
            })
            specOpsSessionEvents.publish('session.created', specopsSession.id, { run_id: run.run_id })
          }
          const started = await startRunExecution(run, runtime, specopsSession.id, options.runCacheRoot)
          watchRun(run.run_id, workspace, started)
          const attached = await readSpecOpsSession(workspace, specopsSession.id)
          return json(response, 201, { run: started.run, specops_session: attached })
        }
        if (request.method === 'POST' && url.pathname === '/api/quick-run') {
          const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
          if (typeof raw.kind !== 'string' || typeof raw.id !== 'string' || typeof raw.title !== 'string' || typeof raw.body !== 'string') {
            return json(response, 400, { error: 'kind, id, title, and body are required' })
          }
          if (!Array.isArray(raw.tasks)) {
            return json(response, 400, { error: 'tasks are required' })
          }
          if (raw.kind === 'spec') {
            return json(response, 422, { error: 'workflow_not_applicable', message: 'Normative specs can be reviewed and mapped, but cannot launch an implementation Run. Create a feature/bug/refactor work item targeting the spec.' })
          }
          const CHANGE_KINDS = new Set(['change', 'bug', 'refactor', 'feature', 'investigation'])
          const kindDir = raw.kind === 'spec' ? 'specs' : CHANGE_KINDS.has(raw.kind as string) ? 'changes' : undefined
          if (kindDir === undefined) return json(response, 400, { error: `kind must be one of: spec, ${[...CHANGE_KINDS].join(', ')}` })
          const selected = await agentSelection(workspace, 'implementation', raw)
          if (!structuredBackendSupported(selected.backend)) {
            return json(response, 409, { error: 'unsupported_execution_backend', backend_key: selected.backend })
          }

          // 1. Create document
          const docPath = `.specops/${kindDir}/${raw.id}.md`
          const defaultStatus = defaultStatusForKind(raw.kind as 'spec' | 'change' | 'bug' | 'refactor' | 'feature' | 'investigation')
          const workType = raw.kind === 'bug' ? 'bugfix' : raw.kind === 'change' ? 'feature' : raw.kind
          const docContent = `---\nschema_version: 2\nid: ${JSON.stringify(raw.id)}\nkind: ${raw.kind}\ndocument_class: work_item\nwork_type: ${workType}\ntitle: ${JSON.stringify(raw.title)}\nstatus: ${defaultStatus}\n---\n\n${raw.body}`
          const docFile = await resolveNewDocumentPath(workspace, docPath)
          if (await exists(docFile)) return json(response, 409, { error: 'document_already_exists', path: docPath })
          parseDocument(docContent, docPath)
          await atomicWrite(docFile, docContent)

          // 2. Create run
          const tasks = raw.tasks as Task[]
          if (tasks.some((task) => typeof task.id !== 'string' || typeof task.title !== 'string' || typeof task.prompt !== 'string' || !Array.isArray(task.verify))) {
            return json(response, 400, { error: 'invalid task' })
          }
          const quickRunModel = selected.model
          const run = await launchRun(workspace, tasks, selected.backend, typeof raw.base === 'string' ? raw.base : 'HEAD', options.runCacheRoot, quickRunModel)
          const specopsSession = await createSpecOpsSession(workspace, {
            title: raw.title,
            backend_key: selected.backend,
            kode_session_id: run.kode_session_id,
            run_id: run.run_id,
            document_path: docPath,
            phase: 'run_in_worktree',
            state: 'active',
          })
          specOpsSessionEvents.publish('session.created', specopsSession.id, { run_id: run.run_id })
          const started = await startRunExecution(run, runtime, specopsSession.id, options.runCacheRoot)
          watchRun(run.run_id, workspace, started)
          const attached = await readSpecOpsSession(workspace, specopsSession.id)
          return json(response, 201, { document: { path: docPath, version: version(docContent) }, run: started.run, specops_session: attached })
        }
        const gateApprovalMatch = /^\/api\/runs\/([0-9a-f-]{36})\/gates\/([a-z0-9._-]+)\/approve$/.exec(url.pathname)
        if (request.method === 'POST' && gateApprovalMatch !== null) {
          await readRun(workspace, gateApprovalMatch[1]!)
          const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
          const reason = typeof raw.reason === 'string' && raw.reason.trim() !== '' ? raw.reason.trim() : 'Approved by user'
          const actor = typeof raw.actor === 'string' && raw.actor.trim() !== '' ? raw.actor.trim() : 'user'
          await recordGateDecision(workspace, gateApprovalMatch[1]!, gateApprovalMatch[2]!, 'passed', reason, actor)
          return json(response, 200, { ok: true })
        }
        const runtimeEvidenceMatch = /^\/api\/runs\/([0-9a-f-]{36})\/evidence$/.exec(url.pathname)
        if (request.method === 'POST' && runtimeEvidenceMatch !== null) {
          const run = await readRun(workspace, runtimeEvidenceMatch[1]!)
          const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
          const kinds = new Set<RuntimeEvidenceKind>(['screenshot', 'action_trace', 'network_trace', 'api_contract', 'coverage', 'console_log'])
          if (typeof raw.subject !== 'string' || typeof raw.kind !== 'string' || !kinds.has(raw.kind as RuntimeEvidenceKind) || typeof raw.artifact !== 'string') return json(response, 400, { error: 'invalid runtime evidence' })
          const evidence = await recordRuntimeEvidence(workspace, {
            subject: raw.subject, commit: typeof raw.commit === 'string' ? raw.commit : run.base_commit,
            kind: raw.kind as RuntimeEvidenceKind, artifact: raw.artifact,
            producer: typeof raw.producer === 'string' ? raw.producer : 'runtime-adapter', passed: raw.passed !== false,
            depends_on: Array.isArray(raw.depends_on) ? raw.depends_on.filter((item): item is string => typeof item === 'string') : [],
          })
          await recordHarnessArtifact(workspace, run.run_id, {
            kind: 'evidence', subject: raw.subject, producer: evidence.producer, uri: raw.artifact,
            content_hash: null, source_commit: evidence.environment.commit, inputs: [], metadata: { evidence_id: evidence.id, claim: evidence.claim },
          })
          return json(response, 201, { evidence })
        }
        const runMatch = /^\/api\/runs\/([0-9a-f-]{36})(?:\/(verify|decision|apply|diff|harness|events))?$/.exec(url.pathname)
        if (runMatch !== null) {
          const run = await readRun(workspace, runMatch[1] as string)
          const action = runMatch[2]
          if (request.method === 'POST' && action !== undefined && ['verify', 'decision', 'apply'].includes(action)) {
            const key = `run:${run.run_id}:${action}`
            if (activeActions.has(key)) return json(response, 409, { error: 'action_in_progress', action })
            activeActions.add(key)
            const release = (): void => { activeActions.delete(key) }
            response.once('finish', release)
            response.once('close', release)
          }
          if (request.method === 'GET' && action === undefined) return json(response, 200, { run })
          if (request.method === 'GET' && action === 'harness') return json(response, 200, { state: await readHarnessState(workspace, run.run_id) })
          if (request.method === 'GET' && action === 'events') return json(response, 200, { events: await readHarnessEvents(workspace, run.run_id) })
          if (request.method === 'GET' && action === 'diff') return json(response, 200, await (async () => {
            const result = await import('../domain/run.js')
            return result.collectRunPatch(run)
          })())
          if (request.method === 'POST' && action === 'verify') {
            const specopsSession = await findSpecOpsSessionByRunId(workspace, run.run_id)
            if (run.state === 'awaiting_review') return json(response, 200, { run, already_verified: true })
            if (run.state !== 'awaiting_verify') {
              return json(response, 409, { error: 'run_not_verifiable', state: run.state })
            }
            const result = await verifyAndRouteReview(runtime, workspace, run, specopsSession?.id ?? null)
            return json(response, 200, result)
          }
          if (request.method === 'POST' && action === 'decision') {
            const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
            if (raw.verdict !== 'accept' && raw.verdict !== 'reject' && raw.verdict !== 'feedback') {
              return json(response, 400, { error: 'invalid verdict' })
            }
            const specopsSession = await findSpecOpsSessionByRunId(workspace, run.run_id)
            if (raw.verdict === 'accept' && run.state === 'completed') {
              return json(response, 200, { run, already_accepted: true })
            }
            if (specopsSession !== null) {
              await resolveRunInteraction(workspace, specopsSession.id, ['human_review'], {
                verdict: raw.verdict,
                note: typeof raw.note === 'string' ? raw.note : '',
              })
            }
            const decision = await decideRun(run, raw.verdict, typeof raw.note === 'string' ? raw.note : '', runtime)
            const decided = decision.run
            if (specopsSession !== null) {
              const updated = await updateSpecOpsSession(workspace, specopsSession.id, (record) => {
                if (decided.state === 'running') {
                  record.phase = 'run_in_worktree'
                  record.state = 'active'
                } else if (decided.state === 'completed') {
                  record.phase = 'apply_patch'
                  record.state = 'awaiting_user'
                } else if (decided.state === 'cancelled') {
                  record.phase = 'cancelled'
                  record.state = 'cancelled'
                }
              })
              specOpsSessionEvents.publish(updated.required_action === null ? 'session.updated' : 'session.action_required', specopsSession.id, updated.required_action)
            }
            if (decided.state === 'running' && decision.turn !== undefined) {
              watchRun(decided.run_id, workspace, decision.turn)
            }
            return json(response, 200, { run: decided })
          }
          if (request.method === 'POST' && action === 'apply') {
            const outcome = await applyCompletedRun(run)
            const specopsSession = await findSpecOpsSessionByRunId(workspace, run.run_id)
            if (specopsSession !== null) {
              const updated = await updateSpecOpsSession(workspace, specopsSession.id, (record) => {
                record.phase = 'completed'
                record.state = 'completed'
                record.required_action = null
              })
              specOpsSessionEvents.publish('session.updated', specopsSession.id, { phase: updated.phase, state: updated.state })
              await terminateSpecOpsExecution(runtime, kode, workspace, specopsSession.id, run.run_id)
            }
            return json(response, 200, { ok: true, applied: outcome.applied, reason: outcome.reason, commit: outcome.commit })
          }
        }
        const archiveMatch = /^\/api\/changes\/([A-Za-z0-9][A-Za-z0-9._/-]{0,127})\/archive$/.exec(url.pathname)
        if (request.method === 'POST' && archiveMatch !== null) {
          const changeId = archiveMatch[1] as string
          const result = await archiveChange(workspace, changeId)
          if (!result.ok) return json(response, 404, { error: result.diagnostics[0]?.message ?? 'archive failed' })
          return json(response, 200, result.data)
        }
        return json(response, 404, { error: 'not_found' })
      }

      const asset = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      if (!/^(index\.html|app\.js|styles\.css)$/.test(asset)) {
        response.writeHead(404).end()
        return
      }
      const source = assets[asset]
      if (source === undefined) {
        response.writeHead(404).end()
        return
      }
      const bytes = Buffer.from(source)
      response.writeHead(200, {
        'content-type': contentType(asset),
        'content-length': bytes.length,
        'cache-control': 'no-store',
        'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self' tauri: http://tauri.localhost`,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      })
      response.end(bytes)
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind a TCP address')
  expectedOrigin = `http://${host === '::1' ? `[${host}]` : host}:${address.port}`
  await runDriftLoop(workspace, 'startup').catch((error) => {
    console.warn(`[specops] startup drift loop failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise
    closing = true
    closePromise = (async () => {
      const results = await Promise.allSettled([
        new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
        runtime.shutdown(),
        shutdownMonitor(),
      ])
      while (backgroundTasks.size > 0) {
        await Promise.allSettled([...backgroundTasks])
      }
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure !== undefined) throw failure.reason
    })()
    return closePromise
  }
  return { origin: expectedOrigin, token, close }
}

export async function serve(options: ServeOptions): Promise<never> {
  const handle = await startServer(options)
  process.stdout.write(`${JSON.stringify({
    type: 'ready',
    protocol_version: SPECOPS_PROTOCOL_VERSION,
    origin: handle.origin,
    token: handle.token,
  })}\n`)
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
    // Parent-death watchdog: the GUI holds our stdin open for its lifetime.
    // When the GUI exits — normally, on crash, or via SIGKILL (dev hot-reload) —
    // the OS closes the pipe and stdin emits 'end'/'close'. Exit so we never
    // linger as an orphan sidecar that keeps its own run-monitor alive and would
    // launchRun duplicate worktrees on the next action.
    process.stdin.once('end', resolve)
    process.stdin.once('close', resolve)
    process.stdin.resume()
  })
  await handle.close()
  process.exit(0)
}

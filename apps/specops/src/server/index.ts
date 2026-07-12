import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { promisify } from 'node:util'

import { scanWorkspace, archiveChange } from '../domain/commands.js'
import { SpecOpsError } from '../core/errors.js'
import { driftWorkspace, analyzeWorkspace } from '../domain/gate.js'
import { parseDocument, defaultStatusForKind } from '../domain/spec.js'
import { applyCompletedRun, applyWithVerify, decideRun, launchRun, verifyRun } from '../domain/run-loop.js'
import { readRun, rollbackRunPatch, transitionRun, type RunRecord, type Task } from '../domain/run.js'
import { initRunMonitor, watchRun } from '../domain/run-monitor.js'
import { buildIntakePrompt, parseIntakeReceipt, checkProposal, buildIntakePlanPrompt, LANGUAGE_DIRECTIVE } from '../domain/intake.js'
import { buildClarifyPrompt, type ClarifyState } from '../domain/clarify.js'
import { loadConfig } from '../domain/config.js'
import { KNOWN_CAPABILITIES, loadPluginManifests } from '../domain/harness.js'
import {
  appendTranscript,
  attachSessionAgent,
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
  resumeUuidForPhase,
  updateSpecOpsSession,
  type SpecOpsSessionRecord,
} from '../domain/session.js'
import { specOpsSessionEvents } from '../domain/session-events.js'
import { watchSpecOpsSessionTranscript } from '../domain/session-monitor.js'
import { KodeClient, KodeRequestError } from '../adapters/kode.js'
import appScript from './public/app.js' with { type: 'text' }
import indexHtml from './public/index.html' with { type: 'text' }
import styles from './public/styles.css' with { type: 'text' }
import { atomicWrite, exists, pathInside, readText, resolveGitWorkspace } from '../store/workspace.js'

const execFile = promisify(execFileCallback)

const MAX_BODY_BYTES = 1_048_576
export const SPECOPS_PROTOCOL_VERSION = 1

export interface ServeOptions {
  workspace: string
  host?: string
  port?: number
  token?: string
  kodeClient?: KodeClient
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

async function recordAgent(
  workspace: string,
  specopsSessionId: string,
  session: { id: number; backend_key: string; status: string; session_uuid?: string },
  purpose: 'clarify' | 'plan' | 'intake' | 'implement' | 'repair' | 'review',
  model?: string,
): Promise<void> {
  await attachSessionAgent(workspace, specopsSessionId, {
    kode_session_id: session.id,
    session_uuid: session.session_uuid ?? null,
    backend_key: session.backend_key,
    model: model ?? null,
    purpose,
    status: session.status,
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

async function reconcileCompletedIntakeSessions(workspace: string): Promise<void> {
  const records = await listSpecOpsSessionRecords(workspace)
  for (const record of records) {
    if (record.document_path !== null) continue
    if (record.phase !== 'plan_approved' && record.phase !== 'analyze_request') continue

    const receiptId = findLatestReceiptId(record.transcript.map((entry) => [
      entry.text,
      entry.summary,
      entry.preview,
    ].filter(Boolean).join('\n')).join('\n'))
    if (receiptId === null) continue

    const receiptPath = pathInside(workspace, '.specops', 'state', 'intakes', `${receiptId}.json`)
    if (!await exists(receiptPath)) continue

    try {
      const receipt = parseIntakeReceipt(await readText(receiptPath), receiptId)
      const primaryFilePath = await resolveDocumentPath(workspace, receipt.primary)
      const primaryStat = await import('node:fs/promises').then((m) => m.stat(primaryFilePath))
      const primaryContent = primaryStat.isFile()
        ? await readText(primaryFilePath)
        : `Change folder: ${receipt.primary}`
      const completedTitle = await titleFromDocument(workspace, receipt.primary, record.title)
      const docKind = await readPrimaryKind(workspace, receipt.primary, primaryStat.isFile() ? primaryContent : null)
      const isDocOnly = docKind === 'spec' || docKind === 'investigation'

      await updateSpecOpsSession(workspace, record.id, (current) => {
        if (current.document_path !== null) return
        current.title = completedTitle
        current.document_path = canonicalDocumentKey(receipt.primary)
        if (isDocOnly) {
          current.phase = 'completed'
          current.state = 'completed'
          current.required_action = null
        } else {
          current.phase = 'run_in_worktree'
          current.state = 'awaiting_user'
          current.required_action = { kind: 'run_in_worktree' }
        }
      })
    } catch {
      // Best-effort recovery. If any candidate receipt is stale or malformed,
      // leave the session unchanged and let the normal live intake path handle it.
    }
  }
}

function isTerminalSessionState(state: string): boolean {
  return state === 'closed' || state === 'completed' || state === 'failed' || state === 'cancelled'
}

async function changedFilesForRun(run: RunRecord): Promise<string[]> {
  try {
    const { stdout } = await execFile('git', ['-C', run.worktree_path, 'diff', '--name-only', run.base_commit, '--'])
    const files = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (files.length > 0) return [...new Set(files)].sort()
  } catch {
    // Fall back to the collected patch below.
  }

  try {
    const patch = await readText(pathInside(run.workspace_root, '.specops', 'runs', run.run_id, 'output.patch'))
    const files = [...patch.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)]
      .map((match) => match[1]?.trim())
      .filter((file): file is string => Boolean(file))
    return [...new Set(files)].sort()
  } catch {
    return []
  }
}

function latestReviewSummary(run: RunRecord): string | undefined {
  for (let i = run.review_results.length - 1; i >= 0; i -= 1) {
    const item = run.review_results[i] as { summary?: unknown } | undefined
    if (typeof item?.summary === 'string' && item.summary.trim().length > 0) return item.summary
  }
  return undefined
}

async function reconcileRunBackedSessions(workspace: string): Promise<void> {
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

    if (run.state === 'awaiting_review') {
      const files = await changedFilesForRun(run)
      const reviewNote = latestReviewSummary(run)
      await updateSpecOpsSession(workspace, record.id, (current) => {
        if (isTerminalSessionState(current.state)) return
        current.phase = 'review'
        current.state = 'awaiting_user'
        current.required_action = {
          kind: 'review',
          patch_files: files,
          ...(reviewNote !== undefined ? { review_note: reviewNote } : {}),
        }
      })
      continue
    }

    if (run.state === 'awaiting_verify') {
      await updateSpecOpsSession(workspace, record.id, (current) => {
        if (isTerminalSessionState(current.state)) return
        current.phase = 'verify'
        current.state = 'awaiting_user'
        current.required_action = { kind: 'verify' }
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
    if (record.kode_session_id === null || isTerminalSessionState(record.state)) return
    const kodeSessionId = record.kode_session_id
    try {
      const session = await kode.getSession(kodeSessionId)
      if (session.status !== 'exited') return
    } catch (error) {
      // Network/auth failures are not proof that a session was destroyed.
      // Detach only when the bridge definitively says this numeric id is gone.
      if (!(error instanceof KodeRequestError) || error.status !== 404) return
    }
    await detachKodeSessionAttachment(workspace, record.id, kodeSessionId)
  }))
}

async function reconcileSessions(workspace: string, kode?: KodeClient): Promise<void> {
  await reconcileCompletedIntakeSessions(workspace)
  await reconcileRunBackedSessions(workspace)
  if (kode !== undefined) await reconcileKodeSessionAttachments(kode, workspace)
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
      if (record.run_id !== null) {
        try {
          const run = await readRun(workspace, record.run_id)
          if (run.state === 'running') watchRun(record.run_id, workspace, record.kode_session_id)
        } catch {
          // Missing or stale run metadata should not block transcript recovery.
        }
      }
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

async function rebuildSpecOpsExecution(
  kode: KodeClient,
  workspace: string,
  session: SpecOpsSessionRecord,
  continuationPrompt?: string,
): Promise<{ session: SpecOpsSessionRecord; promptDelivered: boolean }> {
  if (!RESUMABLE_SESSION_PHASES.has(session.phase)) {
    throw new SpecOpsError('session_not_recoverable', `Session phase ${session.phase} does not own a CLI execution session`)
  }
  const resumeUuid = resumeUuidForPhase(session)
  let cwd = workspace
  let runContext = ''
  if (session.run_id !== null) {
    const run = await readRun(workspace, session.run_id)
    cwd = run.worktree_path
    const task = run.tasks[run.current_task]
    runContext = [
      '',
      'Current run state:',
      `- State: ${run.state}`,
      `- Iteration: ${run.iteration}/${run.max_iterations}`,
      `- Current task: ${task?.title ?? 'None'}`,
      `- Task prompt: ${task?.prompt ?? 'None'}`,
      `- Required verification: ${task?.verify.join(', ') || 'None'}`,
      `- Latest verification evidence: ${JSON.stringify(run.verify_results).slice(-4000) || 'None'}`,
    ].join('\n')
  }
  const freshContext = resumeUuid === null
    ? `${buildSessionResumeContext(session)}${runContext}${continuationPrompt === undefined ? '' : `\n\nNew user message:\n${continuationPrompt}`}`
    : undefined
  const ks = await kode.createSession(session.backend_key, cwd, freshContext, resumeUuid ?? undefined)
  await updateSpecOpsSession(workspace, session.id, (record) => {
    record.kode_session_id = ks.id
    record.state = 'active'
  })
  await recordAgent(workspace, session.id, ks, 'repair')
  if (session.run_id !== null) watchRun(session.run_id, workspace, ks.id)
  watchSpecOpsSessionTranscript(kode, workspace, session.id, ks.id)
  const updated = await readSpecOpsSession(workspace, session.id)
  specOpsSessionEvents.publish('session.updated', session.id, { phase: updated.phase, state: updated.state, kode_session_id: ks.id })
  return { session: updated, promptDelivered: freshContext !== undefined && continuationPrompt !== undefined }
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
  if (kode !== undefined) {
    initRunMonitor(kode, workspace)
    await reattachLiveSessionMonitors(kode, workspace)
  }
  const intakes = new Map<number, {
    receiptId: string
    document: { path: string; version: string } | null
    documents: string[]
    error: string | null
    specopsSessionId: string
    planPhase?: boolean         // true when this intake is waiting for plan approval
    planApproved?: boolean      // true after user approved the plan
    backendKey?: string
    request?: string
  }>()
  const clarifies = new Map<number, ClarifyState & { specopsSessionId: string }>()
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
          const [scan, drift, analyze] = await Promise.all([scanWorkspace(workspace), driftWorkspace(workspace), analyzeWorkspace(workspace)])
          return json(response, 200, { workspace, scan, drift, analyze })
        }
        if (request.method === 'GET' && url.pathname === '/api/harness') {
          const [config, plugins] = await Promise.all([loadConfig(workspace), loadPluginManifests(workspace)])
          return json(response, 200, {
            project: config.project,
            workflows: config.workflows,
            agent_backends: config.agent_backends,
            plugins,
            known_capabilities: KNOWN_CAPABILITIES,
          })
        }
        if (request.method === 'POST' && url.pathname === '/api/analyze') {
          return json(response, 200, await analyzeWorkspace(workspace))
        }
        if (request.method === 'POST' && url.pathname === '/api/scan') {
          return json(response, 200, await scanWorkspace(workspace))
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
          await reconcileSessions(workspace, kode)
          const sessions = (await listSpecOpsSessions(workspace)).map((session) => withUnverifiedExecution(session, kode))
          return json(response, 200, { sessions })
        }
        const sessionMatch = /^\/api\/sessions\/([0-9a-f-]{36})(?:\/(input|action|interrupt|answer|plan_response))?$/.exec(url.pathname)
        if (sessionMatch !== null) {
          const sessionId = sessionMatch[1] as string
          const action = sessionMatch[2]
          if (request.method === 'GET' && action === undefined) {
            await reconcileSessions(workspace, kode)
            return json(response, 200, { session: withUnverifiedExecution(await readSpecOpsSession(workspace, sessionId), kode) })
          }
          if (request.method === 'POST' && action === 'interrupt') {
            if (kode === undefined) return json(response, 503, { error: 'kode_bridge_unavailable' })
            const session = await readSpecOpsSession(workspace, sessionId)
            if (session.kode_session_id === null) return json(response, 409, { error: 'kode_session_missing' })
            await kode.interrupt(session.kode_session_id)
            return json(response, 200, { ok: true })
          }
          if (request.method === 'POST' && action === 'input') {
            if (kode === undefined) return json(response, 503, { error: 'kode_bridge_unavailable' })
            const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
            if (typeof raw.text !== 'string' || raw.text.trim() === '') return json(response, 400, { error: 'text is required' })
            const prompt = raw.text.trim()
            let session = await readSpecOpsSession(workspace, sessionId)
            let promptDelivered = false
            if (session.kode_session_id === null) {
              const rebuilt = await rebuildSpecOpsExecution(kode, workspace, session, prompt)
              session = rebuilt.session
              promptDelivered = rebuilt.promptDelivered
            }
            if (session.kode_session_id === null) return json(response, 409, { error: 'kode_session_missing' })
            if (!promptDelivered) {
              try {
                await kode.sendPrompt(session.kode_session_id, prompt)
              } catch (error) {
                if (!(error instanceof KodeRequestError) || error.status !== 404) throw error
                await detachKodeSessionAttachment(workspace, sessionId, session.kode_session_id)
                const rebuilt = await rebuildSpecOpsExecution(kode, workspace, await readSpecOpsSession(workspace, sessionId), prompt)
                session = rebuilt.session
                if (!rebuilt.promptDelivered && session.kode_session_id !== null) await kode.sendPrompt(session.kode_session_id, prompt)
              }
            }
            const updated = await appendTranscript(workspace, sessionId, 'user', prompt, session.kode_session_id)
            const entry = updated.transcript[updated.transcript.length - 1]
            specOpsSessionEvents.publish('session.transcript_appended', sessionId, entry === undefined ? { role: 'user' } : { entries: [entry] })
            return json(response, 200, { session: updated })
          }
          if (request.method === 'POST' && action === 'answer') {
            if (kode === undefined) return json(response, 503, { error: 'kode_bridge_unavailable' })
            const session = await readSpecOpsSession(workspace, sessionId)
            if (session.kode_session_id === null) return json(response, 409, { error: 'kode_session_missing' })
            const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
            const questionId = typeof raw.question_id === 'string' ? raw.question_id : ''
            const choiceIndex = typeof raw.choice_index === 'number' ? raw.choice_index : -1
            if (questionId === '' || choiceIndex < 0) return json(response, 400, { error: 'question_id and choice_index are required' })
            const freeText = typeof raw.free_text === 'string' ? raw.free_text : undefined
            const pendingAction = session.required_action?.kind === 'answer'
              && session.required_action.question_id === questionId
              ? session.required_action
              : null
            await kode.answer(session.kode_session_id, questionId, choiceIndex, freeText)
            const label = typeof raw.label === 'string' ? raw.label : `option ${choiceIndex + 1}`
            await appendTranscript(workspace, sessionId, 'user', `(answered: ${label})`, session.kode_session_id)
            const updated = await updateSpecOpsSession(workspace, sessionId, (record) => {
              if (!record.answered_action_ids.includes(questionId)) record.answered_action_ids.push(questionId)
              record.decisions.push({
                id: questionId,
                kind: 'answer',
                outcome: 'answered',
                prompt: pendingAction?.prompt ?? null,
                selections: [label],
                note: freeText?.trim() || null,
                source: 'user',
                kode_session_id: session.kode_session_id,
                at: new Date().toISOString(),
              })
              record.required_action = null
            })
            specOpsSessionEvents.publish('session.updated', sessionId, { required_action: null })
            return json(response, 200, { session: updated })
          }
          if (request.method === 'POST' && action === 'plan_response') {
            if (kode === undefined) return json(response, 503, { error: 'kode_bridge_unavailable' })
            const session = await readSpecOpsSession(workspace, sessionId)
            if (session.kode_session_id === null) return json(response, 409, { error: 'kode_session_missing' })
            const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
            const planId = typeof raw.plan_id === 'string' ? raw.plan_id : ''
            const accept = typeof raw.accept === 'boolean' ? raw.accept : false
            if (planId === '') return json(response, 400, { error: 'plan_id is required' })
            const note = typeof raw.note === 'string' ? raw.note : undefined
            const pendingAction = session.required_action?.kind === 'plan_review'
              && session.required_action.plan_id === planId
              ? session.required_action
              : null
            await kode.planResponse(session.kode_session_id, planId, accept)
            await kode.waitForReady(session.kode_session_id)
            if (accept) {
              // Check whether this session belongs to an active intake —
              // intakes need acceptEdits mode + document-generation prompt.
              const intake = intakes.get(session.kode_session_id)
              if (intake !== undefined && intake.planPhase) {
                // Intake-level plan review: approve plan and trigger doc creation
                intake.planApproved = true
                await updateSpecOpsSession(workspace, sessionId, (record) => {
                  record.phase = 'plan_approved'
                  record.state = 'active'
                  record.required_action = null
                  if (!record.answered_action_ids.includes(planId)) record.answered_action_ids.push(planId)
                  record.decisions.push({
                    id: planId,
                    kind: 'plan_review',
                    outcome: 'approved',
                    prompt: pendingAction?.markdown ?? null,
                    selections: ['Approve plan'],
                    note: note?.trim() || null,
                    source: 'user',
                    kode_session_id: session.kode_session_id,
                    at: new Date().toISOString(),
                  })
                })
                specOpsSessionEvents.publish('session.updated', sessionId, { plan_approved: true })
                try { await kode.setMode(session.kode_session_id, 'acceptEdits') } catch { /* ignore */ }
                await kode.sendPrompt(session.kode_session_id, 'Plan approved. Now create the canonical SpecOps documents: write proposal.md (with YAML frontmatter), tasks.md, and optional design.md under `.specops/changes/`. Then write the receipt file as instructed.\n\n' + LANGUAGE_DIRECTIVE)
                return json(response, 200, { ok: true })
              }
              // Generic session plan_review: just approve and continue
              await appendTranscript(workspace, sessionId, 'system', 'Plan approved.', session.kode_session_id)
              const updated = await updateSpecOpsSession(workspace, sessionId, (record) => {
                record.required_action = null
                record.state = 'active'
                if (!record.answered_action_ids.includes(planId)) record.answered_action_ids.push(planId)
                record.decisions.push({
                  id: planId,
                  kind: 'plan_review',
                  outcome: 'approved',
                  prompt: pendingAction?.markdown ?? null,
                  selections: ['Approve plan'],
                  note: note?.trim() || null,
                  source: 'user',
                  kode_session_id: session.kode_session_id,
                  at: new Date().toISOString(),
                })
              })
              specOpsSessionEvents.publish('session.updated', sessionId, { required_action: null })
              return json(response, 200, { session: updated })
            }
            // Reject — send feedback to the session
            const feedback = note ?? 'Plan rejected. Please revise.'
            await appendTranscript(workspace, sessionId, 'user', feedback, session.kode_session_id)
            await updateSpecOpsSession(workspace, sessionId, (record) => {
              record.state = 'active'
              record.required_action = null
              if (!record.answered_action_ids.includes(planId)) record.answered_action_ids.push(planId)
              record.decisions.push({
                id: planId,
                kind: 'plan_review',
                outcome: 'revision_requested',
                prompt: pendingAction?.markdown ?? null,
                selections: ['Revise plan'],
                note: feedback,
                source: 'user',
                kode_session_id: session.kode_session_id,
                at: new Date().toISOString(),
              })
            })
            // If this is an intake session, switch back to plan_discussion
            const rejectIntake = intakes.get(session.kode_session_id)
            if (rejectIntake !== undefined && rejectIntake.planPhase) {
              await updateSpecOpsSession(workspace, sessionId, (record) => {
                record.phase = 'plan_discussion'
              })
            }
            specOpsSessionEvents.publish('session.updated', sessionId, { required_action: null })
            return json(response, 200, { ok: true })
          }
          if (request.method === 'POST' && action === 'action') {
            const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
            const kind = typeof raw.kind === 'string' ? raw.kind : ''
            const session = await readSpecOpsSession(workspace, sessionId)
            if (kind === 'close') {
              const closed = await closeSpecOpsSession(workspace, sessionId)
              specOpsSessionEvents.publish('session.closed', sessionId)
              return json(response, 200, { session: closed })
            }
            if (kind === 'focus') {
              if (kode === undefined) return json(response, 503, { error: 'kode_bridge_unavailable' })
              if (session.kode_session_id === null) return json(response, 409, { error: 'kode_session_missing' })
              await kode.focusSession(session.kode_session_id)
              return json(response, 200, { ok: true })
            }
            if (kind === 'resume') {
              if (kode === undefined) return json(response, 503, { error: 'kode_bridge_unavailable' })
              // Phases that own a kode session (either still running or exited).
              // Each of these may be resumed: alive → re-attach monitors;
              // dead → rebuild with the codebuddy UUID stored on the matching
              // agent (NOT the numeric kode_session_id, which is a bridge
              // internal primary key and drifts across restarts).
              if (RESUMABLE_SESSION_PHASES.has(session.phase)) {
                // 1. If the kode session is still alive, re-attach monitors.
                if (session.kode_session_id !== null) {
                  try {
                    const ks = await kode.getSession(session.kode_session_id)
                    if (ks.status !== 'exited') {
                      if (session.run_id !== null) watchRun(session.run_id, workspace, session.kode_session_id)
                      watchSpecOpsSessionTranscript(kode, workspace, sessionId, session.kode_session_id)
                      const updated = await updateSpecOpsSession(workspace, sessionId, (r) => { r.state = 'active' })
                      specOpsSessionEvents.publish('session.updated', sessionId, { phase: updated.phase, state: updated.state })
                      return json(response, 200, { session: updated })
                    }
                  } catch { /* session not found — fall through to rebuild */ }
                }
                const rebuilt = await rebuildSpecOpsExecution(kode, workspace, session)
                return json(response, 200, { session: rebuilt.session })
              }
              return json(response, 400, { error: 'unsupported_resume_phase', phase: session.phase })
            }
            if (kind === 'promote_intake') {
              const clarifyEntry = [...clarifies.entries()].find(([, item]) => item.specopsSessionId === sessionId)
              if (clarifyEntry === undefined) return json(response, 404, { error: 'clarify_not_found' })
              return json(response, 409, { error: 'use_clarify_promote_route', clarify_id: clarifyEntry[0] })
            }
            if (kind === 'run_in_worktree') {
              if (kode === undefined) return json(response, 503, { error: 'kode_bridge_unavailable' })
              if (!Array.isArray(raw.tasks)) return json(response, 400, { error: 'tasks are required' })
              const tasks = raw.tasks as Task[]
              if (tasks.some((task) => typeof task.id !== 'string' || typeof task.title !== 'string' || typeof task.prompt !== 'string' || !Array.isArray(task.verify))) {
                return json(response, 400, { error: 'invalid task' })
              }
              const backendKey = typeof raw.backend_key === 'string' ? raw.backend_key : session.backend_key
              const model = typeof raw.model === 'string' ? raw.model : undefined
              // Resolve the change proposal id this Run should be linked to.
              // Priority: explicit `change_id` in the request body > reverse-resolve
              // from the session's document_path (read the proposal.md frontmatter).
              // Null when neither is available (quick-runs, spec-only sessions).
              let changeId: string | null = typeof raw.change_id === 'string' && raw.change_id.trim() !== '' ? raw.change_id : null
              if (changeId === null && session.document_path !== null) {
                changeId = await readChangeIdFromDocumentPath(workspace, session.document_path)
              }
              const run = await launchRun(workspace, tasks, backendKey, typeof raw.base === 'string' ? raw.base : 'HEAD', kode, options.runCacheRoot, model, changeId)
              const updated = await updateSpecOpsSession(workspace, sessionId, (record) => {
                record.backend_key = backendKey
                record.kode_session_id = run.kode_session_id
                record.run_id = run.run_id
                record.phase = 'run_in_worktree'
                record.state = 'active'
                record.required_action = null
              })
              if (run.kode_session_id !== null) {
                await recordAgent(workspace, sessionId, {
                  id: run.kode_session_id,
                  backend_key: backendKey,
                  status: 'starting',
                }, 'implement', model)
              }
              if (run.kode_session_id !== null) {
                watchRun(run.run_id, workspace, run.kode_session_id)
                watchSpecOpsSessionTranscript(kode, workspace, sessionId, run.kode_session_id)
              }
              specOpsSessionEvents.publish('session.updated', sessionId, { run_id: run.run_id, kode_session_id: run.kode_session_id })
              return json(response, 201, { session: updated, run })
            }
            if (session.run_id !== null && (kind === 'verify' || kind === 'accept' || kind === 'reject' || kind === 'feedback' || kind === 'apply' || kind === 'apply_with_verify' || kind === 'rollback')) {
              const run = await readRun(workspace, session.run_id)
              if (kind === 'verify') {
                const result = await verifyRun(run)
                const updated = await updateSpecOpsSession(workspace, sessionId, (record) => {
                  record.phase = 'review'
                  record.state = 'awaiting_user'
                  record.required_action = { kind: 'review', patch_files: result.files }
                })
                specOpsSessionEvents.publish('session.action_required', sessionId, updated.required_action)
                return json(response, 200, { session: updated, ...result })
              }
              if (kind === 'apply') {
                const outcome = await applyCompletedRun(run)
                if (kode !== undefined && run.kode_session_id !== null) kode.killSession(run.kode_session_id).catch(() => undefined)
                const updated = await updateSpecOpsSession(workspace, sessionId, (record) => {
                  record.phase = 'completed'
                  record.state = 'completed'
                  record.required_action = null
                })
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
                if (kode !== undefined && run.kode_session_id !== null) kode.killSession(run.kode_session_id).catch(() => undefined)
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
              const verdict = kind === 'accept' ? 'accept' : kind === 'reject' ? 'reject' : 'feedback'
              const decided = await decideRun(run, verdict, typeof raw.note === 'string' ? raw.note : '', kode)
              const updated = await updateSpecOpsSession(workspace, sessionId, (record) => {
                if (decided.state === 'running') {
                  record.phase = 'run_in_worktree'
                  record.state = 'active'
                  record.required_action = null
                } else if (decided.state === 'completed') {
                  record.phase = 'apply_patch'
                  record.state = 'awaiting_user'
                  record.required_action = { kind: 'apply_patch' }
                } else if (decided.state === 'cancelled') {
                  record.phase = 'cancelled'
                  record.state = 'cancelled'
                  record.required_action = null
                }
              })
              if (decided.state === 'running' && decided.kode_session_id !== null) watchRun(decided.run_id, workspace, decided.kode_session_id)
              specOpsSessionEvents.publish(updated.required_action === null ? 'session.updated' : 'session.action_required', sessionId, updated.required_action)
              return json(response, 200, { session: updated, run: decided })
            }
            return json(response, 400, { error: 'unsupported_session_action' })
          }
        }
        if (request.method === 'POST' && url.pathname === '/api/intakes') {
          if (kode === undefined) return json(response, 503, { error: 'kode_bridge_unavailable' })
          const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
          if (typeof raw.request !== 'string' || raw.request.trim() === '') {
            return json(response, 400, { error: 'request is required' })
          }
          const backendKey = typeof raw.backend_key === 'string' ? raw.backend_key : 'codebuddy'
          const intakeModel = typeof raw.model === 'string' ? raw.model : undefined
          const prePlan = raw.pre_plan === true
          const receiptId = randomUUID()
          if (prePlan) {
            // Plan-first intake: create plan session, user approves plan before writing docs
            const requestText = raw.request.trim()
            const session = await kode.createPlanSession(
              backendKey,
              workspace,
              buildIntakePlanPrompt(requestText, receiptId),
              intakeModel,
            )
            const specopsSession = await createSpecOpsSession(workspace, {
              title: titleFromRequest(requestText),
              backend_key: backendKey,
              kode_session_id: session.id,
              phase: 'plan_discussion',
              state: 'active',
            })
            await recordAgent(workspace, specopsSession.id, session, 'plan', intakeModel)
            specOpsSessionEvents.publish('session.created', specopsSession.id, { kode_session_id: session.id })
            watchSpecOpsSessionTranscript(kode, workspace, specopsSession.id, session.id)
            intakes.set(session.id, {
              receiptId,
              document: null,
              documents: [],
              error: null,
              specopsSessionId: specopsSession.id,
              planPhase: true,
              planApproved: false,
              backendKey,
              request: requestText,
            })
            return json(response, 201, { intake_id: session.id, session, specops_session: specopsSession, plan_phase: true })
          }
          // Direct intake (existing flow)
          const requestText = raw.request.trim()
          const session = await kode.createAnalysisSession(
            backendKey,
            workspace,
            buildIntakePrompt(requestText, receiptId),
            intakeModel,
          )
          const specopsSession = await createSpecOpsSession(workspace, {
            title: titleFromRequest(requestText),
            backend_key: backendKey,
            kode_session_id: session.id,
            phase: 'analyze_request',
            state: 'active',
          })
          await recordAgent(workspace, specopsSession.id, session, 'intake', intakeModel)
          specOpsSessionEvents.publish('session.created', specopsSession.id, { kode_session_id: session.id })
          watchSpecOpsSessionTranscript(kode, workspace, specopsSession.id, session.id)
          intakes.set(session.id, {
            receiptId,
            document: null,
            documents: [],
            error: null,
            specopsSessionId: specopsSession.id,
          })
          return json(response, 201, { intake_id: session.id, session, specops_session: specopsSession })
        }
        // Plan response for plan-phase intakes
        const intakePlanMatch = /^\/api\/intakes\/(\d+)\/plan_response$/.exec(url.pathname)
        if (request.method === 'POST' && intakePlanMatch !== null) {
          if (kode === undefined) return json(response, 503, { error: 'kode_bridge_unavailable' })
          const id = Number(intakePlanMatch[1])
          const intake = intakes.get(id)
          if (intake === undefined || !intake.planPhase) return json(response, 404, { error: 'intake_not_found' })
          const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
          const planId = typeof raw.plan_id === 'string' ? raw.plan_id : ''
          const accept = raw.accept === true
          const note = typeof raw.note === 'string' ? raw.note.trim() : ''
          const currentSession = await readSpecOpsSession(workspace, intake.specopsSessionId)
          const planMarkdown = currentSession.required_action?.kind === 'plan_review'
            && currentSession.required_action.plan_id === planId
            ? currentSession.required_action.markdown ?? null
            : null
          if (accept) {
            intake.planApproved = true
            await updateSpecOpsSession(workspace, intake.specopsSessionId, (record) => {
              record.phase = 'plan_approved'
              record.state = 'active'
              record.required_action = null
              record.decisions.push({
                id: planId,
                kind: 'plan_review',
                outcome: 'approved',
                prompt: planMarkdown,
                selections: ['Approve plan'],
                note: note || null,
                source: 'user',
                kode_session_id: id,
                at: new Date().toISOString(),
              })
            })
            specOpsSessionEvents.publish('session.updated', intake.specopsSessionId, { plan_approved: true })
            // Accept the plan and send a prompt to create the docs
            try { await kode.planResponse(id, planId, true) } catch { /* ignore */ }
            await kode.waitForReady(id)
            // Switch to acceptEdits and ask to write documents
            try { await kode.setMode(id, 'acceptEdits') } catch { /* ignore */ }
            await kode.sendPrompt(id, 'Plan approved. Now create the canonical SpecOps documents: write proposal.md (with YAML frontmatter), tasks.md, and optional design.md under `.specops/changes/`. Then write the receipt file as instructed.\n\n' + LANGUAGE_DIRECTIVE)
          } else {
            // Reject — send feedback
            try { await kode.planResponse(id, planId, false) } catch { /* ignore */ }
            const feedback = note || 'Revise the plan and resubmit.'
            await appendTranscript(workspace, intake.specopsSessionId, 'user', feedback, id)
            await updateSpecOpsSession(workspace, intake.specopsSessionId, (record) => {
              record.phase = 'plan_discussion'
              record.state = 'active'
              record.required_action = null
              record.decisions.push({
                id: planId,
                kind: 'plan_review',
                outcome: 'revision_requested',
                prompt: planMarkdown,
                selections: ['Revise plan'],
                note: feedback,
                source: 'user',
                kode_session_id: id,
                at: new Date().toISOString(),
              })
            })
            specOpsSessionEvents.publish('session.updated', intake.specopsSessionId, { plan_approved: false })
            await kode.sendPrompt(id, `Plan rejected: ${feedback}\n\nRevise the plan in plan mode and call ExitPlanMode again.`)
          }
          return json(response, 200, { ok: true, plan_approved: intake.planApproved })
        }
        const intakeMatch = /^\/api\/intakes\/(\d+)$/.exec(url.pathname)
        if (request.method === 'GET' && intakeMatch !== null) {
          if (kode === undefined) return json(response, 503, { error: 'kode_bridge_unavailable' })
          const intakeId = Number(intakeMatch[1])
          const intake = intakes.get(intakeId)
          if (intake === undefined) return json(response, 404, { error: 'intake_not_found' })
          const session = await kode.getSession(intakeId)
          // Plan-phase intake: wait for plan approval, then poll for receipt
          if (intake.planPhase && !intake.planApproved) {
            // session-monitor publishes the exact plan_proposed payload. Do not
            // synthesize a plan from recent transcript messages: tool summaries
            // and partial assistant text are not an approval-grade artifact.
            return json(response, 200, {
              intake_id: intakeId,
              session,
              document: null,
              documents: [],
              error: intake.error,
              specops_session_id: intake.specopsSessionId,
              plan_phase: true,
              plan_approved: false,
            })
          }
          if (intake.document === null && intake.error === null) {
            try {
              const receiptPath = pathInside(
                workspace,
                '.specops',
                'state',
                'intakes',
                `${intake.receiptId}.json`,
              )
              if (await exists(receiptPath)) {
                const receipt = parseIntakeReceipt(await readText(receiptPath), intake.receiptId)
                // Validate all document paths are readable
                for (const documentPath of receipt.documents) {
                  const file = await resolveDocumentPath(workspace, documentPath)
                  // Change folder paths point to proposal.md; also accept the folder itself
                  const stat = await import('node:fs/promises').then((m) => m.stat(file))
                  if (stat.isFile() && isSpecDocumentPath(file)) {
                    parseDocument(await readText(file), documentPath)
                  }
                }
                // primary may be a file or a folder
                const primaryFilePath = await resolveDocumentPath(workspace, receipt.primary)
                const primaryStat = await import('node:fs/promises').then((m) => m.stat(primaryFilePath))
                const primaryContent = primaryStat.isFile()
                  ? await readText(primaryFilePath)
                  : `Change folder: ${receipt.primary}`
                intake.documents = receipt.documents
                intake.document = { path: receipt.primary, version: version(primaryContent) }
                const completedTitle = await titleFromDocument(workspace, receipt.primary, titleFromRequest(intake.request ?? receipt.primary))
                // Commit the freshly-written SpecOps docs so the Run worktree
                // (built from HEAD below) can see proposal.md / tasks.md.
                // Best-effort: failure logs a warning and we continue.
                await commitPlanDocs(workspace, completedTitle)
                // Determine the document kind to decide whether a worktree Run is
                // needed. `spec` and `investigation` are pure-documentation outputs
                // that intake already wrote to `.specops/` — running them through an
                // isolated worktree would just re-produce existing files (empty patch).
                // `bug`/`refactor`/`feature`/`change` touch source code, so they need
                // the Run worktree step.
                const docKind = await readPrimaryKind(workspace, receipt.primary, primaryStat.isFile() ? primaryContent : null)
                const isDocOnly = docKind === 'spec' || docKind === 'investigation'
                await updateSpecOpsSession(workspace, intake.specopsSessionId, (record) => {
                  record.title = completedTitle
                  record.document_path = canonicalDocumentKey(receipt.primary)
                  if (isDocOnly) {
                    record.phase = 'completed'
                    record.state = 'completed'
                    record.required_action = null
                  } else {
                    record.phase = 'run_in_worktree'
                    record.state = 'awaiting_user'
                    record.required_action = { kind: 'run_in_worktree' }
                  }
                })
                specOpsSessionEvents.publish(
                  isDocOnly ? 'session.updated' : 'session.action_required',
                  intake.specopsSessionId,
                  isDocOnly ? { phase: 'completed' } : { phase: 'run_in_worktree', document_path: receipt.primary },
                )
                // Checklist: validate proposal.md has required sections
                if (primaryStat.isFile() && isSpecDocumentPath(primaryFilePath)) {
                  const doc = parseDocument(primaryContent, receipt.primary)
                  const checklist = checkProposal(doc.body)
                  if (!checklist.ok) {
                    intake.error = `proposal.md missing required sections: ${checklist.missing.join(', ')}`
                  }
                }
              }
            } catch (error) {
              intake.error = error instanceof Error ? error.message : String(error)
              await updateSpecOpsSession(workspace, intake.specopsSessionId, (record) => {
                record.phase = 'failed'
                record.state = 'failed'
                record.required_action = null
              })
              specOpsSessionEvents.publish('session.updated', intake.specopsSessionId, { phase: 'failed' })
            }
          }
          return json(response, 200, {
            intake_id: intakeId,
            session,
            document: intake.document,
            documents: intake.documents,
            error: intake.error,
            specops_session_id: intake.specopsSessionId,
          })
        }
        // ── Clarify routes ──
        if (request.method === 'POST' && url.pathname === '/api/clarifies') {
          if (kode === undefined) return json(response, 503, { error: 'kode_bridge_unavailable' })
          const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
          if (typeof raw.request !== 'string' || raw.request.trim() === '') {
            return json(response, 400, { error: 'request is required' })
          }
          const backendKey = typeof raw.backend_key === 'string' ? raw.backend_key : 'codebuddy'
          const clarifyModel = typeof raw.model === 'string' ? raw.model : undefined
          const clarifyId = randomUUID()
          const requestText = raw.request.trim()
          const documentPath = typeof raw.document_path === 'string' && raw.document_path.trim() !== '' ? raw.document_path.trim() : null
          // Reuse an existing active clarify-backed session for the same document
          // so consecutive asks on the same doc don't spawn duplicates.
          if (documentPath !== null) {
            const existing = await findActiveSpecOpsSessionByDocument(workspace, documentPath)
            if (existing !== null) {
              const existingClarify = [...clarifies.values()].find((c) => c.specopsSessionId === existing.id)
              if (existingClarify !== undefined) {
                if (existing.required_action !== null || existing.state === 'awaiting_user') {
                  return json(response, 409, {
                    error: 'document_session_awaiting_action',
                    specops_session: existing,
                  })
                }
                await kode.sendPrompt(existingClarify.sessionId, requestText)
                existingClarify.status = 'asking'
                existingClarify.transcript.push({ role: 'user', text: requestText, at: new Date().toISOString() })
                const updated = await appendTranscript(workspace, existing.id, 'user', requestText, existingClarify.sessionId)
                const entry = updated.transcript[updated.transcript.length - 1]
                specOpsSessionEvents.publish('session.transcript_appended', existing.id, entry === undefined ? { role: 'user' } : { entries: [entry] })
                return json(response, 200, {
                  clarify_id: existingClarify.sessionId,
                  session: await kode.getSession(existingClarify.sessionId),
                  specops_session: updated,
                  reused: true,
                })
              }
            }
          }
          // Create session in bypass mode; user-facing plan/answer gates are managed by SpecOps.
          const session = await kode.createPlanSession(
            backendKey,
            workspace,
            buildClarifyPrompt(requestText, clarifyId),
            clarifyModel,
          )
          const specopsSession = await createSpecOpsSession(workspace, {
            title: titleFromRequest(requestText),
            backend_key: backendKey,
            kode_session_id: session.id,
            document_path: documentPath,
            phase: 'clarify',
            state: 'active',
          })
          await recordAgent(workspace, specopsSession.id, session, 'clarify', clarifyModel)
          specOpsSessionEvents.publish('session.created', specopsSession.id, { kode_session_id: session.id })
          watchSpecOpsSessionTranscript(kode, workspace, specopsSession.id, session.id)
          clarifies.set(session.id, {
            clarifyId,
            status: 'asking',
            sessionId: session.id,
            backendKey,
            ...(clarifyModel !== undefined ? { model: clarifyModel } : {}),
            request: requestText,
            planId: null,
            planMd: null,
            transcript: [],
            error: null,
            specopsSessionId: specopsSession.id,
          })
          return json(response, 201, { clarify_id: session.id, session, specops_session: specopsSession })
        }
        const clarifyPollMatch = /^\/api\/clarifies\/(\d+)$/.exec(url.pathname)
        if (request.method === 'GET' && clarifyPollMatch !== null) {
          if (kode === undefined) return json(response, 503, { error: 'kode_bridge_unavailable' })
          const id = Number(clarifyPollMatch[1])
          const clarify = clarifies.get(id)
          if (clarify === undefined) return json(response, 404, { error: 'clarify_not_found' })
          const session = await kode.getSession(id)
          const specopsSession = await readSpecOpsSession(workspace, clarify.specopsSessionId)
          const pendingAction = specopsSession.required_action
          // The clarify session's transcript is populated by session-monitor via
          // the bridge /transcript endpoint (the old `event.type === 'assistant'`
          // history scan here never matched — semantic.rs emits type "message",
          // not "assistant"). We only need to advance the clarify lifecycle: once
          // the kode session goes idle/exited the clarification round is done.
          if (pendingAction?.kind === 'plan_review') {
            clarify.status = 'plan_proposed'
            clarify.planId = pendingAction.plan_id
            clarify.planMd = pendingAction.markdown ?? null
          } else if (pendingAction?.kind === 'answer') {
            clarify.status = 'asking'
          } else if ((clarify.status === 'asking' || clarify.status === 'plan_proposed')
            && (session.status === 'idle' || session.status === 'exited')) {
            clarify.status = 'ready'
          }
          if (clarify.status === 'ready') {
            await updateSpecOpsSession(workspace, clarify.specopsSessionId, (record) => {
              record.state = 'awaiting_user'
              record.required_action = { kind: 'promote_intake', prompt: 'Clarification complete. Start intake when ready.' }
            })
            specOpsSessionEvents.publish('session.action_required', clarify.specopsSessionId, { kind: 'promote_intake' })
          }
          return json(response, 200, {
            clarify_id: id,
            session,
            status: clarify.status,
            transcript: clarify.transcript,
            error: clarify.error,
          })
        }
        const clarifyAnswerMatch = /^\/api\/clarifies\/(\d+)\/answer$/.exec(url.pathname)
        if (request.method === 'POST' && clarifyAnswerMatch !== null) {
          if (kode === undefined) return json(response, 503, { error: 'kode_bridge_unavailable' })
          const id = Number(clarifyAnswerMatch[1])
          const clarify = clarifies.get(id)
          if (clarify === undefined) return json(response, 404, { error: 'clarify_not_found' })
          const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
          if (typeof raw.answer !== 'string' || raw.answer.trim() === '') {
            return json(response, 400, { error: 'answer is required' })
          }
          // If there's an active plan proposed, accept it first, then send feedback
          if (clarify.status === 'plan_proposed' && clarify.planId !== null) {
            try { await kode.planResponse(id, clarify.planId, true) } catch { /* ignore */ }
            await kode.waitForReady(id)
          }
          const answer = raw.answer.trim()
          await kode.sendPrompt(id, answer)
          clarify.transcript.push({ role: 'user', text: answer, at: new Date().toISOString() })
          const updated = await appendTranscript(workspace, clarify.specopsSessionId, 'user', answer, id)
          await updateSpecOpsSession(workspace, clarify.specopsSessionId, (record) => {
            record.state = 'active'
            record.required_action = null
          })
          const entry = updated.transcript[updated.transcript.length - 1]
          specOpsSessionEvents.publish('session.transcript_appended', clarify.specopsSessionId, entry === undefined ? { role: 'user' } : { entries: [entry] })
          clarify.status = 'asking'
          return json(response, 200, { ok: true, status: clarify.status })
        }
        const clarifyPromoteMatch = /^\/api\/clarifies\/(\d+)\/promote$/.exec(url.pathname)
        if (request.method === 'POST' && clarifyPromoteMatch !== null) {
          if (kode === undefined) return json(response, 503, { error: 'kode_bridge_unavailable' })
          const id = Number(clarifyPromoteMatch[1])
          const clarify = clarifies.get(id)
          if (clarify === undefined) return json(response, 404, { error: 'clarify_not_found' })
          if (clarify.status !== 'ready') return json(response, 409, { error: 'clarify_not_ready' })
          // If plan was proposed, accept it before promoting
          if (clarify.planId !== null) {
            try { await kode.planResponse(id, clarify.planId, true) } catch { /* ignore */ }
          }
          const receiptId = randomUUID()
          // Build intake prompt with plan context
          const planContext = clarify.planMd
            ? `## Approved plan\n\n${clarify.planMd}`
            : clarify.transcript.map((t) => `### ${t.role}\n${t.text}`).join('\n\n')
          const clarifiedContext = `${clarify.request}\n\n${planContext}`
          const combinedPrompt = buildIntakePrompt(clarifiedContext, receiptId)
          const session = await kode.createAnalysisSession(clarify.backendKey, workspace, combinedPrompt, clarify.model)
          const specopsSession = await updateSpecOpsSession(workspace, clarify.specopsSessionId, (record) => {
            record.phase = 'analyze_request'
            record.state = 'active'
            record.required_action = null
            record.kode_session_id = session.id
          })
          await recordAgent(workspace, clarify.specopsSessionId, session, 'intake', clarify.model)
          specOpsSessionEvents.publish('session.updated', clarify.specopsSessionId, { phase: 'analyze_request', kode_session_id: session.id })
          watchSpecOpsSessionTranscript(kode, workspace, clarify.specopsSessionId, session.id)
          intakes.set(session.id, { receiptId, document: null, documents: [], error: null, specopsSessionId: clarify.specopsSessionId, request: clarifiedContext })
          clarifies.delete(id)
          kode.killSession(clarify.sessionId).catch(() => undefined)
          return json(response, 201, { intake_id: session.id, session, specops_session: specopsSession })
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
        if (request.method === 'POST' && url.pathname === '/api/runs') {
          const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
          if (!Array.isArray(raw.tasks) || typeof raw.backend_key !== 'string') {
            return json(response, 400, { error: 'tasks and backend_key are required' })
          }
          const tasks = raw.tasks as Task[]
          if (tasks.some((task) => typeof task.id !== 'string' || typeof task.title !== 'string' || typeof task.prompt !== 'string' || !Array.isArray(task.verify))) {
            return json(response, 400, { error: 'invalid task' })
          }
          const runModel = typeof raw.model === 'string' ? raw.model : undefined
          // Optional: link this Run to a SpecOps change proposal. When non-null,
          // apply paths will flip the matching proposal.md from `proposed` to
          // `completed` once the Run lands. Omit for quick-runs.
          const changeId = typeof raw.change_id === 'string' && raw.change_id.trim() !== '' ? raw.change_id : null
          const run = await launchRun(workspace, tasks, raw.backend_key, typeof raw.base === 'string' ? raw.base : 'HEAD', kode, options.runCacheRoot, runModel, changeId)
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
              record.backend_key = raw.backend_key as string
              record.kode_session_id = run.kode_session_id
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
              backend_key: raw.backend_key,
              kode_session_id: run.kode_session_id,
              run_id: run.run_id,
              document_path: documentPath !== null ? canonicalDocumentKey(documentPath) : null,
              phase: 'run_in_worktree',
              state: 'active',
            })
            specOpsSessionEvents.publish('session.created', specopsSession.id, { run_id: run.run_id, kode_session_id: run.kode_session_id })
          }
          if (run.kode_session_id !== null) {
            await recordAgent(workspace, specopsSession.id, {
              id: run.kode_session_id,
              backend_key: raw.backend_key,
              status: 'starting',
            }, 'implement', runModel)
            watchRun(run.run_id, workspace, run.kode_session_id)
            if (kode !== undefined) watchSpecOpsSessionTranscript(kode, workspace, specopsSession.id, run.kode_session_id)
          }
          return json(response, 201, { run, specops_session: specopsSession })
        }
        if (request.method === 'POST' && url.pathname === '/api/quick-run') {
          const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
          if (typeof raw.kind !== 'string' || typeof raw.id !== 'string' || typeof raw.title !== 'string' || typeof raw.body !== 'string') {
            return json(response, 400, { error: 'kind, id, title, and body are required' })
          }
          if (!Array.isArray(raw.tasks) || typeof raw.backend_key !== 'string') {
            return json(response, 400, { error: 'tasks and backend_key are required' })
          }
          const CHANGE_KINDS = new Set(['change', 'bug', 'refactor', 'feature', 'investigation'])
          const kindDir = raw.kind === 'spec' ? 'specs' : CHANGE_KINDS.has(raw.kind as string) ? 'changes' : undefined
          if (kindDir === undefined) return json(response, 400, { error: `kind must be one of: spec, ${[...CHANGE_KINDS].join(', ')}` })

          // 1. Create document
          const docPath = `.specops/${kindDir}/${raw.id}.md`
          const defaultStatus = defaultStatusForKind(raw.kind as 'spec' | 'change' | 'bug' | 'refactor' | 'feature' | 'investigation')
          const docContent = `---\nschema_version: 1\nid: ${JSON.stringify(raw.id)}\nkind: ${raw.kind}\ntitle: ${JSON.stringify(raw.title)}\nstatus: ${defaultStatus}\n---\n\n${raw.body}`
          const docFile = await resolveNewDocumentPath(workspace, docPath)
          if (await exists(docFile)) return json(response, 409, { error: 'document_already_exists', path: docPath })
          parseDocument(docContent, docPath)
          await atomicWrite(docFile, docContent)

          // 2. Create run
          const tasks = raw.tasks as Task[]
          if (tasks.some((task) => typeof task.id !== 'string' || typeof task.title !== 'string' || typeof task.prompt !== 'string' || !Array.isArray(task.verify))) {
            return json(response, 400, { error: 'invalid task' })
          }
          const quickRunModel = typeof raw.model === 'string' ? raw.model : undefined
          const run = await launchRun(workspace, tasks, raw.backend_key, typeof raw.base === 'string' ? raw.base : 'HEAD', kode, options.runCacheRoot, quickRunModel)
          const specopsSession = await createSpecOpsSession(workspace, {
            title: raw.title,
            backend_key: raw.backend_key,
            kode_session_id: run.kode_session_id,
            run_id: run.run_id,
            document_path: docPath,
            phase: 'run_in_worktree',
            state: 'active',
          })
          specOpsSessionEvents.publish('session.created', specopsSession.id, { run_id: run.run_id, kode_session_id: run.kode_session_id })
          if (run.kode_session_id !== null) {
            await recordAgent(workspace, specopsSession.id, {
              id: run.kode_session_id,
              backend_key: raw.backend_key,
              status: 'starting',
            }, 'implement', quickRunModel)
            watchRun(run.run_id, workspace, run.kode_session_id)
            if (kode !== undefined) watchSpecOpsSessionTranscript(kode, workspace, specopsSession.id, run.kode_session_id)
          }
          return json(response, 201, { document: { path: docPath, version: version(docContent) }, run, specops_session: specopsSession })
        }
        const runMatch = /^\/api\/runs\/([0-9a-f-]{36})(?:\/(verify|decision|apply|diff))?$/.exec(url.pathname)
        if (runMatch !== null) {
          const run = await readRun(workspace, runMatch[1] as string)
          const action = runMatch[2]
          if (request.method === 'GET' && action === undefined) return json(response, 200, { run })
          if (request.method === 'GET' && action === 'diff') return json(response, 200, await (async () => {
            const result = await import('../domain/run.js')
            return result.collectRunPatch(run)
          })())
          if (request.method === 'POST' && action === 'verify') {
            const result = await verifyRun(run)
            const specopsSession = await findSpecOpsSessionByRunId(workspace, run.run_id)
            if (specopsSession !== null) {
              const updated = await updateSpecOpsSession(workspace, specopsSession.id, (record) => {
                record.phase = 'review'
                record.state = 'awaiting_user'
                record.required_action = { kind: 'review', patch_files: result.files }
              })
              specOpsSessionEvents.publish('session.action_required', specopsSession.id, updated.required_action)
            }
            return json(response, 200, result)
          }
          if (request.method === 'POST' && action === 'decision') {
            const raw = JSON.parse((await requestBody(request)).toString('utf8')) as Record<string, unknown>
            if (raw.verdict !== 'accept' && raw.verdict !== 'reject' && raw.verdict !== 'feedback') {
              return json(response, 400, { error: 'invalid verdict' })
            }
            const decided = await decideRun(run, raw.verdict, typeof raw.note === 'string' ? raw.note : '', kode)
            const specopsSession = await findSpecOpsSessionByRunId(workspace, run.run_id)
            if (specopsSession !== null) {
              const updated = await updateSpecOpsSession(workspace, specopsSession.id, (record) => {
                if (decided.state === 'running') {
                  record.phase = 'run_in_worktree'
                  record.state = 'active'
                  record.required_action = null
                } else if (decided.state === 'completed') {
                  record.phase = 'apply_patch'
                  record.state = 'awaiting_user'
                  record.required_action = { kind: 'apply_patch' }
                } else if (decided.state === 'cancelled') {
                  record.phase = 'cancelled'
                  record.state = 'cancelled'
                  record.required_action = null
                }
              })
              specOpsSessionEvents.publish(updated.required_action === null ? 'session.updated' : 'session.action_required', specopsSession.id, updated.required_action)
            }
            // Re-watch if the run went back to running (feedback or next task)
            if (decided.state === 'running' && decided.kode_session_id !== null) {
              watchRun(decided.run_id, workspace, decided.kode_session_id)
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
            }
            // 关闭实现 session,对应的 tab 会被清理掉
            if (kode !== undefined && run.kode_session_id !== null) {
              kode.killSession(run.kode_session_id).catch(() => undefined)
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
  return {
    origin: expectedOrigin,
    token,
    close: async () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  }
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

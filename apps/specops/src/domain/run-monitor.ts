/**
 * RunMonitor — watches kode sessions for idle/exited state and auto-advances
 * the associated SpecOps run from 'running' → 'awaiting_verify' → 'awaiting_review'.
 *
 * Strategy:
 * - Subscribes to kode bridge WebSocket for instant `session.exited` events
 * - Polls `GET /api/v1/sessions/:id` every POLL_INTERVAL_MS to detect idle status
 *   (the bridge does not emit status_changed events over WS)
 * - When the session is idle for IDLE_SETTLE_MS, triggers auto-verify
 */
import type { KodeClient, KodeEvent } from '../adapters/kode.js'
import { SpecOpsError } from '../core/errors.js'
import { exists } from '../store/workspace.js'
import { loadConfig } from './config.js'
import { readRun, transitionRun } from './run.js'
import { decideRun, formatReviewNote, runReview, verifyRun } from './run-loop.js'
import { findSpecOpsSessionByRunId, updateSpecOpsSession } from './session.js'
import { specOpsSessionEvents } from './session-events.js'
import type WebSocket from 'ws'

interface MonitorEntry {
  runId: string
  workspace: string
  sessionId: number
  pollTimer: ReturnType<typeof setInterval> | null
  settleTimer: ReturnType<typeof setTimeout> | null
  advancing: boolean
}

const monitors = new Map<string, MonitorEntry>()
let ws: WebSocket | null = null
let kodeRef: KodeClient | null = null

/** How often to poll session status (ms). */
const POLL_INTERVAL_MS = 5_000

/** How long the session must stay idle before auto-advancing (ms). */
const IDLE_SETTLE_MS = 8_000

export function initRunMonitor(kode: KodeClient, _workspace: string): void {
  kodeRef = kode

  ws = kode.subscribe((event) => {
    handleEvent(event)
  })
  ws.on('error', () => { /* silently reconnect not needed — polling covers us */ })
  ws.on('close', () => { ws = null })
}

export function watchRun(runId: string, workspace: string, sessionId: number): void {
  if (monitors.has(runId)) return
  const entry: MonitorEntry = { runId, workspace, sessionId, pollTimer: null, settleTimer: null, advancing: false }
  monitors.set(runId, entry)
  startPolling(entry)
}

export function unwatchRun(runId: string): void {
  const entry = monitors.get(runId)
  if (entry === undefined) return
  if (entry.pollTimer !== null) clearInterval(entry.pollTimer)
  if (entry.settleTimer !== null) clearTimeout(entry.settleTimer)
  monitors.delete(runId)
}

export function shutdownMonitor(): void {
  for (const [id] of monitors) unwatchRun(id)
  if (ws !== null) { ws.close(); ws = null }
}

function handleEvent(event: KodeEvent): void {
  if (event.type !== 'session.exited') return
  for (const [, entry] of monitors) {
    if (entry.sessionId !== event.session_id) continue
    // Session exited — advance immediately
    if (entry.settleTimer !== null) clearTimeout(entry.settleTimer)
    entry.settleTimer = null
    advanceRun(entry)
  }
}

function startPolling(entry: MonitorEntry): void {
  if (entry.pollTimer !== null) return
  entry.pollTimer = setInterval(async () => {
    if (kodeRef === null || entry.advancing) return
    try {
      const session = await kodeRef.getSession(entry.sessionId)
      if (session.status === 'exited') {
        advanceRun(entry)
      } else if (session.status === 'idle') {
        // Start settle timer if not already running
        if (entry.settleTimer === null) {
          entry.settleTimer = setTimeout(() => {
            entry.settleTimer = null
            advanceRun(entry)
          }, IDLE_SETTLE_MS)
        }
      } else {
        // Session is busy/starting — cancel any pending settle
        if (entry.settleTimer !== null) {
          clearTimeout(entry.settleTimer)
          entry.settleTimer = null
        }
      }
    } catch { /* ignore transient errors */ }
  }, POLL_INTERVAL_MS)
}

async function advanceRun(entry: MonitorEntry): Promise<void> {
  if (entry.advancing) return
  entry.advancing = true
  unwatchRun(entry.runId)
  try {
    const run = await readRun(entry.workspace, entry.runId)
    if (run.state !== 'running') return // Already advanced or cancelled

    // If the worktree was cleaned up externally (e.g. system temp cleanup),
    // cancel the run so the session is properly removed.
    if (!await exists(run.worktree_path)) {
      await transitionRun(run, 'cancelled')
      return
    }

    // Only auto-advance if the worktree has actual changes
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    const { stdout } = await exec('git', ['-C', run.worktree_path, 'diff', '--stat', run.base_commit, '--'])
    if (stdout.trim().length === 0) {
      // No changes yet — re-watch so we check again later
      entry.advancing = false
      watchRun(entry.runId, entry.workspace, entry.sessionId)
      return
    }
    const result = await verifyRun(run)

    // Automated review (if enabled): run a fresh review agent against the diff
    // BEFORE surfacing the human review action. On a blocking review, feed the
    // findings back to the implementing session and re-run — never publish a
    // human action mid-review, so the frontend doesn't flash review buttons.
    const config = await loadConfig(entry.workspace)
    let reviewSummary: string | undefined
    if (config.review.enabled && kodeRef !== null) {
      const review = await runReview(run, kodeRef, config, result.patch)
      reviewSummary = review.summary
      if (review.blocker) {
        try {
          await decideRun(run, 'feedback', formatReviewNote(review), kodeRef)
          // decideRun moved the run back to 'running'; re-arm the monitor so the
          // next idle triggers verify + review again. unwatchRun (at entry) already
          // removed the old entry, so register a fresh watch.
          watchRun(entry.runId, entry.workspace, entry.sessionId)
          return
        } catch (error) {
          // max_iterations exhausted: decideRun set state='failed' and threw.
          // Don't swallow it — surface the accumulated findings to the human.
          if (!(error instanceof SpecOpsError && error.code === 'max_iterations')) throw error
          await publishReviewAction(entry, run.run_id, result.files, `Review still blocking after ${run.max_iterations} iterations. ${review.summary}`)
          return
        }
      }
    }

    await publishReviewAction(entry, run.run_id, result.files, reviewSummary)
  } catch {
    // verify may fail — that's acceptable,
    // the user can still manually trigger verify from the UI
  }
}

/** Surface the human review action for a run, attaching an optional review summary note. */
async function publishReviewAction(entry: MonitorEntry, runId: string, files: string[], reviewNote?: string): Promise<void> {
  const specopsSession = await findSpecOpsSessionByRunId(entry.workspace, runId)
  if (specopsSession === null) return
  const updated = await updateSpecOpsSession(entry.workspace, specopsSession.id, (record) => {
    record.phase = 'review'
    record.state = 'awaiting_user'
    record.required_action = { kind: 'review', patch_files: files, ...(reviewNote !== undefined ? { review_note: reviewNote } : {}) }
  })
  specOpsSessionEvents.publish('session.action_required', specopsSession.id, updated.required_action)
}

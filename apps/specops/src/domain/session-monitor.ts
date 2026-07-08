import type { KodeClient } from '../adapters/kode.js'
import { updateSessionAgentStatus, updateSpecOpsSession, type TranscriptEntry } from './session.js'
import { specOpsSessionEvents } from './session-events.js'

interface SessionMonitorEntry {
  kode: KodeClient
  workspace: string
  specopsSessionId: string
  kodeSessionId: number
  timer: ReturnType<typeof setInterval>
  polling: boolean
  consecutiveErrors: number
  /** id of the last pending prompt we published, to avoid re-firing every poll. */
  lastPendingId: string | null
}

const monitors = new Map<string, SessionMonitorEntry>()
const POLL_INTERVAL_MS = 2_500
const MAX_CONSECUTIVE_ERRORS = 4 // ~10s of failures before triggering resume

export function watchSpecOpsSessionTranscript(kode: KodeClient, workspace: string, specopsSessionId: string, kodeSessionId: number): void {
  unwatchSpecOpsSessionTranscript(specopsSessionId)
  const entry: SessionMonitorEntry = {
    kode,
    workspace,
    specopsSessionId,
    kodeSessionId,
    timer: setInterval(() => { poll(entry).catch(() => undefined) }, POLL_INTERVAL_MS),
    polling: false,
    consecutiveErrors: 0,
    lastPendingId: null,
  }
  monitors.set(specopsSessionId, entry)
  poll(entry).catch(() => undefined)
}

export function unwatchSpecOpsSessionTranscript(specopsSessionId: string): void {
  const entry = monitors.get(specopsSessionId)
  if (entry === undefined) return
  clearInterval(entry.timer)
  monitors.delete(specopsSessionId)
}

async function poll(entry: SessionMonitorEntry): Promise<void> {
  if (entry.polling) return
  entry.polling = true
  try {
    // The bus history only carries pty_bytes/meta/status — NOT the assistant/
    // user text. The real conversation lives in the backend's jsonl file, which
    // the bridge exposes as a full snapshot via /transcript. We pull the whole
    // thing each poll and merge by dedupe (jsonl is authoritative; cheap for
    // typical SpecOps sessions).
    const { messages } = await entry.kode.transcript(entry.kodeSessionId)
    // Reset error counter on successful poll
    entry.consecutiveErrors = 0
    // Poll kode session status for live status updates. This does its own
    // read-modify-write, so it must run BEFORE the transcript write below
    // (which re-reads the record) to avoid clobbering the status update.
    try {
      const ks = await entry.kode.getSession(entry.kodeSessionId)
      await updateSessionAgentStatus(entry.workspace, entry.specopsSessionId, entry.kodeSessionId, ks.status)
      specOpsSessionEvents.publish('session.status_changed', entry.specopsSessionId, {
        kode_status: ks.status,
        kode_session_id: entry.kodeSessionId,
      })
    } catch { /* ignore transient errors */ }
    if (messages.length === 0) {
      await syncPendingPrompt(entry)
      return
    }
    // Merge into the transcript, deduped by kind-aware key:
    // - text: (kode_session_id, role, text) — same prose from a different kode
    //   session is distinct; a user message we appended locally via /input
    //   dedupes against the jsonl echo.
    // - tool_use / tool_result: (kode_session_id, kind, tool_call_id) — the
    //   call/result pair is stable across polls; dedupe by call id, not text.
    const appended: TranscriptEntry[] = []
    await updateSpecOpsSession(entry.workspace, entry.specopsSessionId, (current) => {
      for (const message of messages) {
        const kind = message.kind ?? 'text'
        const dup = kind === 'text'
          ? current.transcript.some((item) =>
            item.kode_session_id === entry.kodeSessionId
            && item.role === message.role
            && (item.kind ?? 'text') === 'text'
            && item.text === message.text)
          : current.transcript.some((item) =>
            item.kode_session_id === entry.kodeSessionId
            && (item.kind ?? 'text') === kind
            && item.tool_call_id === message.tool_call_id)
        if (dup) continue
        const te: TranscriptEntry = {
          role: message.role,
          text: kind === 'text' ? (message.text ?? '') : '',
          at: new Date().toISOString(),
          kode_session_id: entry.kodeSessionId,
          kind,
          ...(message.tool !== undefined ? { tool: message.tool } : {}),
          ...(message.tool_call_id !== undefined ? { tool_call_id: message.tool_call_id } : {}),
          ...(message.summary !== undefined ? { summary: message.summary } : {}),
          ...(message.preview !== undefined ? { preview: message.preview } : {}),
          ...(message.status !== undefined ? { status: message.status } : {}),
        }
        current.transcript.push(te)
        appended.push(te)
      }
    })
    if (appended.length > 0) specOpsSessionEvents.publish('session.transcript_appended', entry.specopsSessionId, { entries: appended })

    // Surface the latest pending AskUserQuestion / ExitPlanMode as a required
    // action. The bridge already parses these from the jsonl onto the bus, so we
    // read them from history. We only set the action when none is pending or the
    // pending one is itself an answer/plan_review — never clobber a run-lifecycle
    // action (review/verify) set by run-monitor.ts (both write required_action).
    await syncPendingPrompt(entry)
  } catch {
    entry.consecutiveErrors += 1
    // After MAX_CONSECUTIVE_ERRORS consecutive failures, the kode session is
    // likely dead (GUI restart or tab closed). Stop polling to avoid noise.
    if (entry.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      // Check if session is truly dead by trying a getSession
      try {
        await entry.kode.getSession(entry.kodeSessionId)
        // Session is alive, reset counter
        entry.consecutiveErrors = 0
      } catch {
        // Session is dead — stop this monitor; user can manually resume
        unwatchSpecOpsSessionTranscript(entry.specopsSessionId)
      }
    }
  } finally {
    entry.polling = false
  }
}

/** required_action kinds owned by the run lifecycle (run-monitor.ts) — never overwrite these. */
const RUN_OWNED_ACTIONS = new Set(['review', 'verify', 'apply_patch', 'run_in_worktree'])

/**
 * Read the bridge event history for this kode session and, if the latest
 * pending AskUserQuestion / ExitPlanMode hasn't been answered yet, set it as the
 * SpecOps session's required_action so the console can render selectable options.
 */
async function syncPendingPrompt(entry: SessionMonitorEntry): Promise<void> {
  let events: { type: string; payload: unknown }[]
  try {
    const res = await entry.kode.history(entry.kodeSessionId)
    events = res.events
  } catch {
    return
  }
  // Walk newest-first; the latest question/plan wins.
  let pending: { kind: 'answer' | 'plan_review'; id: string; payload: Record<string, unknown> } | null = null
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev === undefined) continue
    const p = (ev.payload ?? {}) as Record<string, unknown>
    if (ev.type === 'ask_user_question' && typeof p.question_id === 'string') {
      pending = { kind: 'answer', id: p.question_id, payload: p }
      break
    }
    if (ev.type === 'plan_proposed' && typeof p.plan_id === 'string') {
      pending = { kind: 'plan_review', id: p.plan_id, payload: p }
      break
    }
  }
  if (pending === null) return
  // Already published this exact prompt — don't re-fire every 2.5s.
  if (entry.lastPendingId === pending.id) return

  await updateSpecOpsSession(entry.workspace, entry.specopsSessionId, (record) => {
    if (record.answered_action_ids.includes(pending.id)) return
    const current = record.required_action
    // Don't clobber a run-lifecycle action; only set when free or replacing a
    // stale answer/plan_review with a newer one.
    if (current !== null && RUN_OWNED_ACTIONS.has(current.kind)) return
    if (pending.kind === 'answer') {
      const options = Array.isArray(pending.payload.options)
        ? (pending.payload.options as Array<Record<string, unknown>>).map((o) => ({
          label: typeof o.label === 'string' ? o.label : String(o.label ?? ''),
          ...(typeof o.description === 'string' ? { description: o.description } : {}),
        }))
        : []
      record.required_action = {
        kind: 'answer',
        prompt: typeof pending.payload.question === 'string' ? pending.payload.question : '',
        question_id: pending.id,
        ...(typeof pending.payload.header === 'string' ? { header: pending.payload.header } : {}),
        options,
        multi_select: pending.payload.multi_select === true,
      }
    } else {
      record.required_action = {
        kind: 'plan_review',
        plan_id: pending.id,
        ...(typeof pending.payload.plan_md === 'string' ? { markdown: pending.payload.plan_md } : {}),
      }
    }
    record.state = 'awaiting_user'
  }).then((updated) => {
    const ra = updated.required_action
    if (ra !== null && (ra.kind === 'answer' || ra.kind === 'plan_review')) {
      const raId = ra.kind === 'answer' ? ra.question_id : ra.plan_id
      if (raId === pending.id) {
        entry.lastPendingId = pending.id
        specOpsSessionEvents.publish('session.action_required', entry.specopsSessionId, ra)
      }
    }
  }).catch(() => undefined)
}

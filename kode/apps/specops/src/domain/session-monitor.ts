import type { KodeClient } from '../adapters/kode.js'
import { readSpecOpsSession, updateSessionAgentStatus, updateSpecOpsSession, type TranscriptEntry } from './session.js'
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

type PendingPrompt = { kind: 'answer' | 'plan_review'; id: string; payload: Record<string, unknown> }

function answerQuestion(candidate: PendingPrompt): {
  question_id: string
  prompt: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multi_select: boolean
} {
  const options = Array.isArray(candidate.payload.options)
    ? (candidate.payload.options as Array<Record<string, unknown>>).map((option) => ({
      label: typeof option.label === 'string' ? option.label : String(option.label ?? ''),
      ...(typeof option.description === 'string' ? { description: option.description } : {}),
    }))
    : []
  return {
    question_id: candidate.id,
    prompt: typeof candidate.payload.question === 'string' ? candidate.payload.question : '',
    ...(typeof candidate.payload.header === 'string' ? { header: candidate.payload.header } : {}),
    options,
    multi_select: candidate.payload.multi_select === true,
  }
}

export function formatQuestionsForTranscript(questions: ReturnType<typeof answerQuestion>[]): string {
  return questions.map((question, index) => {
    const options = question.options.map((option, optionIndex) =>
      `  ${optionIndex + 1}. ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}`,
    )
    return [`Question ${index + 1}: ${question.prompt}`, ...options].join('\n')
  }).join('\n\n')
}

/** Convert retained bridge events into the next CLI prompt SpecOps must show. */
export function nextPendingPrompt(
  events: Array<{ type: string; payload: unknown }>,
  answeredActionIds: Iterable<string>,
): PendingPrompt | null {
  const answered = new Set(answeredActionIds)
  for (const ev of events) {
    const payload = (ev.payload ?? {}) as Record<string, unknown>
    if (ev.type === 'ask_user_question' && typeof payload.question_id === 'string'
      && !answered.has(payload.question_id)) {
      return { kind: 'answer', id: payload.question_id, payload }
    }
    if (ev.type === 'plan_proposed' && typeof payload.plan_id === 'string'
      && !answered.has(payload.plan_id)) {
      return { kind: 'plan_review', id: payload.plan_id, payload }
    }
  }
  return null
}

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
  // AskUserQuestion may contain several questions. The semantic bridge expands
  // those into consecutive events, while the CLI presents them one at a time.
  // Keep event order and surface the first unanswered item; choosing the newest
  // event skips straight to the last question and strands the earlier ones.
  const snapshot = await readSpecOpsSession(entry.workspace, entry.specopsSessionId)
  const pending = nextPendingPrompt(events, snapshot.answered_action_ids)
  if (pending === null) return
  const unansweredQuestions: PendingPrompt[] = events
    .flatMap((event): PendingPrompt[] => {
      const payload = (event.payload ?? {}) as Record<string, unknown>
      return event.type === 'ask_user_question' && typeof payload.question_id === 'string'
        ? [{ kind: 'answer', id: payload.question_id, payload }]
        : []
    })
    .filter((candidate) => !snapshot.answered_action_ids.includes(candidate.id))
  // Already published this exact prompt — don't re-fire every 2.5s. Reading
  // the durable action as well as the in-memory id is important: after q1 is
  // answered, q2 must surface even though the history snapshot is unchanged.
  const currentId = snapshot.required_action?.kind === 'answer'
    ? snapshot.required_action.question_id
    : snapshot.required_action?.kind === 'plan_review'
      ? snapshot.required_action.plan_id
      : null
  if (entry.lastPendingId === pending.id && currentId === pending.id) return

  let appendedQuestion: TranscriptEntry | null = null
  await updateSpecOpsSession(entry.workspace, entry.specopsSessionId, (record) => {
    if (record.answered_action_ids.includes(pending.id)) return
    const current = record.required_action
    // Don't clobber a run-lifecycle action; only set when free or replacing a
    // stale answer/plan_review with a newer one.
    if (current !== null && RUN_OWNED_ACTIONS.has(current.kind)) return
    if (pending.kind === 'answer') {
      const questions = unansweredQuestions.map(answerQuestion)
      const first = questions[0] ?? answerQuestion(pending)
      const questionText = formatQuestionsForTranscript(questions.length === 0 ? [first] : questions)
      const alreadyRecorded = record.transcript.some((item) =>
        item.kode_session_id === entry.kodeSessionId && item.role === 'agent' && item.text === questionText)
      if (!alreadyRecorded) {
        appendedQuestion = {
          role: 'agent', text: questionText, at: new Date().toISOString(),
          kode_session_id: entry.kodeSessionId, kind: 'text',
        }
        record.transcript.push(appendedQuestion)
      }
      record.required_action = {
        kind: 'answer',
        prompt: first.prompt,
        question_id: first.question_id,
        ...(first.header !== undefined ? { header: first.header } : {}),
        options: first.options,
        multi_select: first.multi_select,
        questions,
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
    if (appendedQuestion !== null) {
      specOpsSessionEvents.publish('session.transcript_appended', entry.specopsSessionId, { entries: [appendedQuestion] })
    }
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

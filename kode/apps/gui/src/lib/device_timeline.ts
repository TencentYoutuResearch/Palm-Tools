/**
 * Timeline of a session on another device of the account, built from the
 * relay's `/history` window (remote-protocol.md § semantic events).
 *
 * The window is re-fetched whole on every poll, so this is a pure fold:
 * the same events always give the same items. Cross-session messages use the
 * bridge's additive `relay` / `relay_tool` fields, mirroring the mobile cards
 * (apps/mobile/lib/src/ui/sessions/session_relay_cards.dart).
 */

export type DeviceEvent = { type: string; ts: number; payload: Record<string, any> }

export type TimelineItem = {
  key: string
  type: 'message' | 'tool_use' | 'ask_user_question' | 'plan_proposed'
  ts: number
  payload: Record<string, any>
  /** Questions and plans still waiting for an answer. */
  pending: boolean
  /** AskUserQuestion payloads asked together (`<tool id>-<n>`), answered as one. */
  questions?: Record<string, any>[]
}

const SHOWN = new Set(['message', 'tool_use', 'ask_user_question', 'plan_proposed'])
const CLEARS = new Set(['session.attention_cleared', 'interaction.resolved'])

function itemKey(e: DeviceEvent): string {
  const p = e.payload
  if (e.type === 'ask_user_question' && p.question_id && !p.request_id) {
    return `${e.type}-${String(p.question_id).replace(/-\d+$/, '')}`
  }
  return `${e.type}-${p.id ?? p.tool_use_id ?? p.question_id ?? p.request_id ?? p.plan_id ?? e.ts}`
}

export function buildTimeline(events: DeviceEvent[]): TimelineItem[] {
  const sorted = [...events].sort((a, b) => a.ts - b.ts)
  const items = new Map<string, TimelineItem>()
  const resolved = new Set<string>()
  let lastClear = -Infinity
  let lastUserMessage = -Infinity
  for (const e of sorted) {
    if (CLEARS.has(e.type)) {
      lastClear = Math.max(lastClear, e.ts)
      if (e.payload.request_id) resolved.add(String(e.payload.request_id))
      continue
    }
    if (!SHOWN.has(e.type)) continue
    if (e.type === 'message' && e.payload.role === 'user') lastUserMessage = Math.max(lastUserMessage, e.ts)
    const key = itemKey(e)
    const previous = items.get(key)
    if (previous && e.type === 'tool_use') {
      // Status updates re-send the same tool id; later non-null fields win.
      const fresh = Object.fromEntries(Object.entries(e.payload).filter(([, v]) => v != null))
      previous.payload = { ...previous.payload, ...fresh }
      continue
    }
    if (previous?.questions) {
      const at = previous.questions.findIndex((q) => q.question_id === e.payload.question_id)
      if (at >= 0) previous.questions[at] = e.payload
      else previous.questions.push(e.payload)
      continue
    }
    if (previous) {
      previous.payload = e.payload
      continue
    }
    const item: TimelineItem = { key, type: e.type as TimelineItem['type'], ts: e.ts, payload: e.payload, pending: false }
    if (e.type === 'ask_user_question') item.questions = [e.payload]
    items.set(key, item)
  }
  for (const item of items.values()) {
    item.questions?.sort((a, b) => questionIndex(a) - questionIndex(b))
    if (item.type !== 'ask_user_question' && item.type !== 'plan_proposed') continue
    const id = item.payload.request_id ?? item.payload.plan_id
    item.pending = item.ts > lastClear && item.ts > lastUserMessage && !(id && resolved.has(String(id)))
  }
  return [...items.values()]
}

function questionIndex(payload: Record<string, any>): number {
  return Number(/-(\d+)$/.exec(String(payload.question_id ?? ''))?.[1] ?? 0)
}

/** Latest `session.status` in the window, else the list's status. */
export function liveStatus(events: DeviceEvent[], fallback: string): string {
  let status = fallback
  let at = -Infinity
  for (const e of events) {
    if (e.ts < at) continue
    if (e.type === 'session.status' && typeof e.payload.status === 'string') {
      status = e.payload.status
      at = e.ts
    } else if (e.type === 'session.exited') {
      status = 'exited'
      at = e.ts
    }
  }
  return status
}

/** A failed delivery of one of this viewer's own commands, if any. */
export function commandFailure(events: DeviceEvent[], commandIds: Iterable<string>): string | null {
  const ids = new Set(commandIds)
  for (const e of [...events].reverse()) {
    if (e.type !== 'command.status' || !ids.has(e.payload.command_id)) continue
    if (e.payload.status === 'failed' || e.payload.status === 'expired') return String(e.payload.error ?? e.payload.status)
  }
  return null
}

type NamedSession = { backend_key: string; title: string | null; session_uuid?: string | null }

/** Kode-native messaging addresses are `kode:<backend>:<uuid>`. */
export function sessionNameFor(address: string | null | undefined, sessions: NamedSession[]): string | null {
  const parts = (address ?? '').split(':')
  if (parts.length < 3 || parts[0] !== 'kode') return null
  const backend = parts[1]
  const uuid = parts.slice(2).join(':')
  const match = sessions.find((s) => s.session_uuid === uuid && s.backend_key === backend)
  return match?.title?.trim() || null
}

/** i18n key for a `kode_sessions_*` tool call. */
export function relayToolTitleKey(relay: Record<string, any>): string {
  if (relay.op === 'send' && relay.in_reply_to != null) return 'devices.tool.reply'
  return ['list', 'create', 'send', 'read', 'wait'].includes(relay.op) ? `devices.tool.${relay.op}` : 'devices.tool.other'
}

/** Send-time delivery state from the tool result, not task completion. */
export function relayDelivery(payload: Record<string, any>): string | null {
  for (const raw of [payload.output_preview, payload.output]) {
    let value = raw
    if (typeof raw === 'string') {
      try { value = JSON.parse(raw) } catch { continue }
    }
    const status = value?.message?.status
    if (typeof status === 'string') return status
  }
  return null
}

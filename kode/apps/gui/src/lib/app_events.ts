import { derived, writable } from 'svelte/store'
import type { SessionId } from './ipc'

export type AppEventKind = 'attention' | 'turn_finished' | 'memory' | 'system'
export type AppEventSeverity = 'info' | 'warning' | 'success' | 'error'
export type AppEventStatus = 'active' | 'resolved'

export interface AppEvent {
  id: string
  kind: AppEventKind
  severity: AppEventSeverity
  status: AppEventStatus
  title: string
  detail?: string
  source?: string
  sessionId?: SessionId
  dedupeKey?: string
  createdAt: number
  updatedAt: number
}

export type AppEventInput = Omit<AppEvent, 'id' | 'createdAt' | 'updatedAt' | 'status'> & {
  id?: string
  status?: AppEventStatus
}

const MAX_EVENTS = 80

function makeId(input: AppEventInput, now: number): string {
  return input.id ?? `${input.kind}-${input.sessionId ?? 'global'}-${now}`
}

export const appEvents = writable<AppEvent[]>([])

export const activeAppEventCount = derived(appEvents, ($events) =>
  $events.filter((event) => event.status === 'active').length,
)

export function addOrUpdateAppEvent(input: AppEventInput): string {
  const now = Date.now()
  const dedupeKey = input.dedupeKey ?? input.id
  let id = input.id ?? ''
  appEvents.update((events) => {
    const idx = dedupeKey
      ? events.findIndex((event) => event.dedupeKey === dedupeKey || event.id === dedupeKey)
      : -1
    if (idx >= 0) {
      const existing = events[idx]
      id = existing.id
      const next: AppEvent = {
        ...existing,
        ...input,
        id: existing.id,
        dedupeKey: input.dedupeKey ?? existing.dedupeKey,
        status: input.status ?? 'active',
        createdAt: existing.createdAt,
        updatedAt: now,
      }
      return [next, ...events.slice(0, idx), ...events.slice(idx + 1)]
    }

    id = makeId(input, now)
    const next: AppEvent = {
      ...input,
      id,
      status: input.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    }
    return [next, ...events].slice(0, MAX_EVENTS)
  })
  return id
}

export function resolveAppEvents(match: (event: AppEvent) => boolean) {
  const now = Date.now()
  appEvents.update((events) =>
    events.map((event) =>
      match(event) && event.status !== 'resolved'
        ? { ...event, status: 'resolved', updatedAt: now }
        : event,
    ),
  )
}

export function clearAppEvents(match: (event: AppEvent) => boolean) {
  appEvents.update((events) => events.filter((event) => !match(event)))
}

export function clearAppEvent(id: string) {
  appEvents.update((events) => events.filter((event) => event.id !== id))
}

export function clearResolvedAppEvents() {
  appEvents.update((events) => events.filter((event) => event.status !== 'resolved'))
}

export function clearAllAppEvents() {
  appEvents.set([])
}

export function clearAppEventsForSession(sessionId: SessionId) {
  appEvents.update((events) => events.filter((event) => event.sessionId !== sessionId))
}

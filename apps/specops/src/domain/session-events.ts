export type SpecOpsSessionEventType =
  | 'session.created'
  | 'session.updated'
  | 'session.transcript_appended'
  | 'session.action_required'
  | 'session.status_changed'
  | 'session.closed'

export interface SpecOpsSessionEvent {
  type: SpecOpsSessionEventType
  session_id: string
  at: string
  payload?: unknown
}

type Listener = (event: SpecOpsSessionEvent) => void

class SpecOpsSessionEventBus {
  private listeners = new Set<Listener>()

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  publish(type: SpecOpsSessionEventType, sessionId: string, payload?: unknown): SpecOpsSessionEvent {
    const event: SpecOpsSessionEvent = { type, session_id: sessionId, at: new Date().toISOString(), payload }
    for (const listener of this.listeners) listener(event)
    return event
  }
}

export const specOpsSessionEvents = new SpecOpsSessionEventBus()

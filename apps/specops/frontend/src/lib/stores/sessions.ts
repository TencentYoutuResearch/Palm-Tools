import { writable, get } from 'svelte/store';
import { api, openEventStream } from '../api';
import type { SpecOpsSession, TranscriptEntry } from '../types';

interface LoadSessionsOptions {
  showLoading?: boolean;
}

interface SpecOpsSessionEvent {
  session_id?: string;
  at?: string;
  payload?: {
    entries?: TranscriptEntry[];
  };
}

export const sessions = writable<SpecOpsSession[]>([]);
export const sessionsLoading = writable<boolean>(false);
export const sessionsError = writable<string | null>(null);

export const activeSessionId = writable<string | null>(null);
export const activeSession = writable<SpecOpsSession | null>(null);
export const activeTranscript = writable<SpecOpsSession['transcript'] | undefined>(undefined);

let es: EventSource | null = null;
let selectRequest = 0;

function sessionSummary(session: SpecOpsSession): SpecOpsSession {
  return {
    id: session.id,
    title: session.title,
    backend_key: session.backend_key,
    phase: session.phase,
    state: session.state,
    document_path: session.document_path,
    required_action: session.required_action,
    workflow: session.workflow,
    agents: session.agents,
    updated_at: session.updated_at,
  };
}

function updateSessionSummary(session: SpecOpsSession): void {
  const summary = sessionSummary(session);
  sessions.update((items) => items.map((item) => (item.id === session.id ? { ...item, ...summary } : item)));
}

function transcriptEntryKey(entry: TranscriptEntry): string {
  const kind = entry.kind ?? 'text';
  if (kind !== 'text' && entry.tool_call_id) {
    return [entry.kode_session_id ?? '', kind, entry.tool_call_id].join('\u0000');
  }
  return [entry.kode_session_id ?? '', entry.role, kind, entry.text].join('\u0000');
}

function appendTranscriptEntries(sessionId: string, entries: TranscriptEntry[], updatedAt?: string): void {
  if (entries.length === 0) return;
  let changed = false;
  let transcript: TranscriptEntry[] = [];
  activeSession.update((session) => {
    if (session?.id !== sessionId) return session;
    transcript = [...(session.transcript ?? [])];
    const seen = new Set(transcript.map(transcriptEntryKey));
    for (const entry of entries) {
      const key = transcriptEntryKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      transcript.push(entry);
      changed = true;
    }
    if (!changed) return session;
    activeTranscript.set(transcript);
    return session;
  });
  // When activeSession is already set (same session), activeTranscript is updated above.
  // When it's not set (no session selected yet), just skip — no active view cares.
  if (changed && updatedAt) {
    sessions.update((items) => items.map((item) => (item.id === sessionId ? { ...item, updated_at: updatedAt } : item)));
  }
}

export async function loadSessions(options: LoadSessionsOptions = {}): Promise<void> {
  const showLoading = options.showLoading ?? true;
  if (showLoading) {
    sessionsLoading.set(true);
    sessionsError.set(null);
  }
  try {
    const res = await api.get<{ sessions: SpecOpsSession[] }>('/api/sessions');
    sessions.set(res.sessions ?? []);
    sessionsError.set(null);
  } catch (err) {
    sessionsError.set(err instanceof Error ? err.message : String(err));
  } finally {
    if (showLoading) sessionsLoading.set(false);
  }
}

export async function selectSession(id: string): Promise<void> {
  const previousId = get(activeSessionId);
  const previousSession = get(activeSession);
  const shouldClear = previousId !== id;
  const request = ++selectRequest;

  activeSessionId.set(id);
  if (shouldClear) {
    activeSession.set(null);
    activeTranscript.set(undefined);
  }

  try {
    const res = await api.get<{ session: SpecOpsSession }>(`/api/sessions/${id}`);
    if (request !== selectRequest || get(activeSessionId) !== id) return;
    activeSession.set(res.session);
    activeTranscript.set(res.session?.transcript);
    updateSessionSummary(res.session);
  } catch {
    if (request !== selectRequest || get(activeSessionId) !== id) return;
    if (shouldClear || previousSession?.id !== id) {
      activeSession.set(null);
      activeTranscript.set(undefined);
    }
  }
}

async function refreshSession(id: string): Promise<void> {
  try {
    const res = await api.get<{ session: SpecOpsSession }>(`/api/sessions/${id}`);
    activeSession.update((session) => {
      if (session?.id !== id) return session;
      // Only update metadata — keep existing transcript so ChatThread isn't disturbed.
      return { ...session, ...res.session, transcript: session.transcript ?? res.session?.transcript };
    });
    updateSessionSummary(res.session);
  } catch {
    // ignore
  }
}

export function subscribeEvents(): void {
  if (es !== null) return;
  es = openEventStream((type, data) => {
    const activeId = get(activeSessionId);
    // Server-side events carry session_id at the top level of the event object
    // (see domain/session-events.ts SpecOpsSessionEvent).
    const evt = data as SpecOpsSessionEvent | undefined;
    const sid = evt?.session_id;
    if (type === 'session.created') {
      loadSessions({ showLoading: false });
      if (sid && sid === activeId) selectSession(sid);
    } else if (type === 'session.transcript_appended') {
      const entries = evt?.payload?.entries ?? [];
      if (sid && sid === activeId) appendTranscriptEntries(sid, entries, evt?.at);
    } else if (type === 'session.updated' || type === 'session.action_required' || type === 'session.closed') {
      if (sid && sid === activeId) refreshSession(sid);
    }
  });
}

export function unsubscribeEvents(): void {
  if (es !== null) {
    es.close();
    es = null;
  }
}

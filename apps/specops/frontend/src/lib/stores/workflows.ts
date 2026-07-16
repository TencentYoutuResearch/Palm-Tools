import { api } from '../api';
import { loadState, pendingDocSelection } from './documents';
import { loadSessions, refreshSession, selectSession } from './sessions';

const intakeTimers = new Map<number, ReturnType<typeof setInterval>>();

interface IntakePollResponse {
  document?: string | null;
  documents?: string[];
  error?: string | null;
  specops_session_id?: string;
  plan_phase?: boolean;
  plan_approved?: boolean;
}

export function trackIntake(intakeId: number): void {
  if (intakeTimers.has(intakeId)) return;
  let selectedSessionId: string | null = null;
  let polling = false;

  const stop = (): void => {
    const timer = intakeTimers.get(intakeId);
    if (timer !== undefined) clearInterval(timer);
    intakeTimers.delete(intakeId);
  };

  const poll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      const res = await api.get<IntakePollResponse>(`/api/intakes/${intakeId}`);
      // Session metadata is delivered through SSE. Re-fetching the whole list
      // every two seconds made the sidebar alternate between its content and
      // the global Loading state for the entire lifetime of an intake.
      if (res.specops_session_id && selectedSessionId !== res.specops_session_id) {
        await loadSessions({ showLoading: false });
        await selectSession(res.specops_session_id);
        selectedSessionId = res.specops_session_id;
      } else if (res.specops_session_id) {
        // Keep a silent full-history reconciliation while the intake is active.
        // SSE remains the low-latency path; this closes gaps after reconnects.
        await refreshSession(res.specops_session_id);
      }
      const primary = res.document ?? res.documents?.[0] ?? null;
      if (primary) {
        await loadState();
        await loadSessions({ showLoading: false });
        pendingDocSelection.set(primary);
        stop();
        return;
      }
      if (res.error) stop();
    } catch {
      stop();
    } finally {
      polling = false;
    }
  };

  const timer = setInterval(() => {
    poll().catch(() => undefined);
  }, 2_000);
  intakeTimers.set(intakeId, timer);
  poll().catch(() => undefined);
}

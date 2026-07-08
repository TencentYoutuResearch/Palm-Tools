import { api } from '../api';
import { loadState, pendingDocSelection } from './documents';
import { loadSessions, selectSession } from './sessions';

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

  const stop = (): void => {
    const timer = intakeTimers.get(intakeId);
    if (timer !== undefined) clearInterval(timer);
    intakeTimers.delete(intakeId);
  };

  const poll = async (): Promise<void> => {
    try {
      const res = await api.get<IntakePollResponse>(`/api/intakes/${intakeId}`);
      await loadSessions();
      if (res.specops_session_id) {
        await selectSession(res.specops_session_id);
      }
      const primary = res.document ?? res.documents?.[0] ?? null;
      if (primary) {
        await loadState();
        pendingDocSelection.set(primary);
        stop();
        return;
      }
      if (res.error) stop();
    } catch {
      stop();
    }
  };

  const timer = setInterval(() => {
    poll().catch(() => undefined);
  }, 2_000);
  intakeTimers.set(intakeId, timer);
  poll().catch(() => undefined);
}

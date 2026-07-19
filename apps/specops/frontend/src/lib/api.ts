import { token } from './token';

export interface ApiError extends Error {
  status: number;
  body: unknown;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (token) headers['authorization'] = `Bearer ${token}`;
  return headers;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  const init: RequestInit = { method, headers: authHeaders(), signal: controller.signal };
  if (body !== undefined) {
    init.headers = authHeaders({ 'content-type': 'application/json' });
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${method} ${path} timed out`);
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const serverMessage = parsed !== null && typeof parsed === 'object' && 'error' in parsed
      ? String((parsed as { error: unknown }).error)
      : '';
    const err = new Error(serverMessage ? `${method} ${path} -> ${res.status}: ${serverMessage}` : `${method} ${path} -> ${res.status}`) as ApiError;
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
};

/**
 * Open the SpecOps SSE event stream. Token travels as a query param because
 * EventSource cannot set Authorization headers.
 */
export function openEventStream(
  onEvent: (type: string, data: unknown) => void,
  onOpen?: () => void,
): EventSource {
  const url = token ? `/api/events?token=${encodeURIComponent(token)}` : '/api/events';
  const es = new EventSource(url);
  if (onOpen !== undefined) es.onopen = onOpen;
  const parse = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };
  // Named SpecOps events.
  for (const name of [
    'session.created',
    'session.updated',
    'session.closed',
    'session.action_required',
    'session.status_changed',
    'session.transcript_appended',
    'session.transcript_delta',
    'session.transcript_upsert',
  ]) {
    es.addEventListener(name, (ev) => onEvent(name, parse((ev as MessageEvent).data)));
  }
  // Fallback for unnamed messages.
  es.onmessage = (ev) => onEvent('message', parse(ev.data));
  return es;
}

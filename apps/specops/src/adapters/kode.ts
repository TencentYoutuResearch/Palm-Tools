import WebSocket from 'ws'

import { SpecOpsError } from '../core/errors.js'

/**
 * Normalize the *body* of a chat message for a bracketed-paste submission to a
 * codebuddy/claude PTY: convert all CR (and CRLF) to LF and strip trailing
 * newlines. The submit keypress is sent separately as a bare `\r` (see
 * {@link buildSubmitBytes}), so the body itself must NOT carry a trailing
 * newline — inside a bracketed paste a trailing `\n` inserts a blank line into
 * the Ink input box instead of triggering submit, and a bare `\r` would be
 * treated as a premature line-end and swallow the text.
 */
export function normalizeSubmitText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '')
}

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const SUBMIT = '\r'

/**
 * Build the two raw byte payloads for submitting `text` to a codebuddy/claude
 * Ink input box over the bridge's raw `post_input` (which writes bytes verbatim,
 * no paste wrapping of its own):
 *
 *   1. `body`   — the message wrapped in bracketed-paste markers. Ink accepts
 *                 multi-line content inside the paste; no trailing newline.
 *   2. `submit` — a bare `\r`, sent as a *separate* write, which Ink reads as
 *                 the Enter keypress and submits the buffered paste.
 *
 * Sending body+`\n` in a single raw write is exactly the bug that leaves the
 * text sitting in the box (or drops it): the newline lands inside the input
 * instead of confirming it. Splitting the two writes matches how an interactive
 * paste-then-Enter behaves.
 */
export function buildSubmitBytes(text: string): { body: string; submit: string } {
  return { body: `${PASTE_START}${normalizeSubmitText(text)}${PASTE_END}`, submit: SUBMIT }
}

export interface KodeSession {
  id: number
  backend_key: string
  status: string
  session_uuid?: string
}

export interface KodeEvent {
  type: string
  session_id: number
  payload: unknown
}

/**
 * One entry returned by GET /sessions/:id/transcript. `kind` discriminates:
 * - `text`: ordinary user/agent message (carries `text`)
 * - `tool_use`: agent invoked a tool like Read/Grep/Bash (carries `tool`,
 *   `tool_call_id`, `summary`, `status:"running"`)
 * - `tool_result`: result of a tool call (carries `tool`, `tool_call_id`,
 *   `preview`, `status:"ok"|"error"`); UI pairs it with `tool_use` by
 *   `tool_call_id`.
 *
 * Fields not applicable to a given kind are absent. Protocol-level tools
 * (AskUserQuestion / ExitPlanMode / TaskCreate / TaskUpdate) are excluded —
 * they have their own dedicated cards.
 */
export interface TranscriptMessage {
  role: 'agent' | 'user'
  kind: 'text' | 'tool_use' | 'tool_result'
  /** text: only for kind="text" */
  text?: string
  /** tool name: only for kind="tool_use"|"tool_result" */
  tool?: string
  /** tool call id: only for kind="tool_use"|"tool_result" */
  tool_call_id?: string
  /** input summary: only for kind="tool_use" */
  summary?: string
  /** output preview: only for kind="tool_result" */
  preview?: string
  /** "running" for tool_use; "ok"|"error" for tool_result */
  status?: 'running' | 'ok' | 'error'
}

export class KodeClient {
  readonly name = 'kode'
  readonly baseUrl: string
  readonly token: string

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.token = token
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
    if (!response.ok) {
      const detail = await response.text()
      throw new SpecOpsError('kode_request_failed', `${init.method ?? 'GET'} ${path}: ${response.status} ${detail}`)
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  createSession(backendKey: string, cwd: string, initialPrompt?: string, resumeSessionUuid?: string, model?: string): Promise<KodeSession> {
    return this.request('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        backend_key: backendKey,
        cwd,
        permission_mode: 'bypass',
        extra_args: ['--add-dir', cwd],
        // The bridge inserts the positional prompt before variadic flags such as
        // --add-dir. Codebuddy submits it while starting the interactive session.
        ...(initialPrompt !== undefined ? { prompt: initialPrompt } : {}),
        ...(resumeSessionUuid !== undefined ? { resume_session_uuid: resumeSessionUuid } : {}),
        ...(model !== undefined && model !== '' ? { model } : {}),
      }),
    })
  }

  createPlanSession(backendKey: string, cwd: string, initialPrompt: string, model?: string): Promise<KodeSession> {
    return this.request('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        backend_key: backendKey,
        cwd,
        permission_mode: 'bypass',
        prompt: initialPrompt,
        ...(model !== undefined && model !== '' ? { model } : {}),
      }),
    })
  }

  /**
   * Create an analysis session. Pass `headless=true` for background agents the
   * user never interacts with directly (e.g. the auto-review agent): the bridge
   * skips the `session.created` event so the kode GUI does not open a tab for it.
   */
  createAnalysisSession(backendKey: string, cwd: string, initialPrompt: string, model?: string, headless = false): Promise<KodeSession> {
    return this.request('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        backend_key: backendKey,
        cwd,
        permission_mode: 'bypass',
        prompt: initialPrompt,
        ...(model !== undefined && model !== '' ? { model } : {}),
        ...(headless ? { headless: true } : {}),
      }),
    })
  }

  getSession(id: number): Promise<KodeSession> {
    return this.request(`/api/v1/sessions/${id}`)
  }

  /** Poll until session leaves 'starting' state (becomes idle/busy/exited). */
  async waitForReady(id: number, timeoutMs = 30_000): Promise<KodeSession> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const session = await this.getSession(id)
      if (session.status !== 'starting') return session
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new SpecOpsError('session_timeout', `Session ${id} did not become ready within ${timeoutMs}ms`)
  }

  async sendPrompt(id: number, prompt: string): Promise<void> {
    // The bridge's post_input writes bytes to the PTY verbatim, so SpecOps must
    // do the bracketed-paste wrapping and the submit itself. Sending body+`\n`
    // in one write only inserts a newline into the Ink input box without
    // submitting (the "text arrives + newline but never sends" symptom). Send
    // the paste-wrapped body first, then a separate bare `\r` as the Enter
    // keypress. A short gap lets the input box settle before the submit.
    const { body, submit } = buildSubmitBytes(prompt)
    await this.writeBytes(id, body)
    await new Promise((r) => setTimeout(r, 30))
    await this.writeBytes(id, submit)
  }

  /** Write raw bytes to the session PTY via the bridge (base64-encoded). */
  private async writeBytes(id: number, raw: string): Promise<void> {
    const bytes = Buffer.from(raw, 'utf8').toString('base64')
    await this.request(`/api/v1/sessions/${id}/input`, { method: 'POST', body: JSON.stringify({ bytes_b64: bytes }) })
  }

  /** Answer an AskUserQuestion: writes the 0-based choice digit to the session PTY. */
  async answer(id: number, questionId: string, choiceIndex: number, freeText?: string): Promise<void> {
    await this.request(`/api/v1/sessions/${id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ question_id: questionId, choice_index: choiceIndex, ...(freeText !== undefined ? { free_text: freeText } : {}) }),
    })
  }

  async killSession(id: number): Promise<void> {
    await this.request(`/api/v1/sessions/${id}`, { method: 'DELETE' })
  }

  async focusSession(id: number): Promise<void> {
    await this.request(`/api/v1/sessions/${id}/focus`, { method: 'POST' })
  }

  history(id: number, from = 0): Promise<{ events: KodeEvent[]; next_from: number }> {
    return this.request(`/api/v1/sessions/${id}/history?from=${from}`)
  }

  /**
   * Structured conversation transcript, read from the backend's jsonl session
   * file by the bridge. The bus history only carries pty_bytes/meta/status, not
   * assistant/user text, so this is the real source for chat content. Roles are
   * normalized to 'agent' (assistant) / 'user'.
   *
   * `kind` discriminates plain chat text from tool invocations:
   * - `text`: ordinary user/agent message (carries `text`)
   * - `tool_use`: agent invoked a tool like Read/Grep/Bash (carries `tool`,
   *   `tool_call_id`, `summary`, `status:"running"`)
   * - `tool_result`: the result of a tool call (carries `tool`, `tool_call_id`,
   *   `preview`, `status:"ok"|"error"`). The UI pairs this with the matching
   *   `tool_use` by `tool_call_id`.
   *
   * Protocol-level tools (AskUserQuestion / ExitPlanMode / TaskCreate / TaskUpdate)
   * are excluded — they have their own dedicated cards.
   */
  transcript(id: number): Promise<{ messages: TranscriptMessage[] }> {
    return this.request(`/api/v1/sessions/${id}/transcript`)
  }

  /** Interrupt a busy session by sending an ESC byte to the PTY. */
  async interrupt(id: number): Promise<void> {
    const bytes = Buffer.from('\x1b', 'utf8').toString('base64')
    await this.request(`/api/v1/sessions/${id}/input`, { method: 'POST', body: JSON.stringify({ bytes_b64: bytes }) })
  }

  subscribe(onEvent: (event: KodeEvent) => void): WebSocket {
    const url = new URL(this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = '/ws'
    url.searchParams.set('token', this.token)
    const socket = new WebSocket(url)
    socket.on('message', (raw) => {
      try { onEvent(JSON.parse(raw.toString()) as KodeEvent) } catch { /* ignore malformed remote events */ }
    })
    return socket
  }

  /** Switch the session to a target permission mode (e.g. "plan", "acceptEdits"). */
  async setMode(id: number, mode: string): Promise<void> {
    await this.request(`/api/v1/sessions/${id}/mode`, { method: 'POST', body: JSON.stringify({ mode }) })
  }

  /** Respond to a plan_proposed event: accept (true) or reject (false). */
  async planResponse(id: number, planId: string, accept: boolean): Promise<void> {
    await this.request(`/api/v1/sessions/${id}/plan_response`, {
      method: 'POST',
      body: JSON.stringify({ plan_id: planId, accept }),
    })
  }
}

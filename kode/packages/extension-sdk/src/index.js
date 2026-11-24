/**
 * Client for the Kode extension API (`kode.api/v1`).
 *
 * Kode starts an extension backend with `KODE_EXT_API` and `KODE_EXT_TOKEN`
 * when its manifest asks for any API capability. The token only carries those
 * capabilities and only sees sessions this extension created, unless it also
 * holds `sessions.read`.
 *
 * Events are pushed (Server-Sent Events). `events()` resumes from the last
 * delivered cursor after any disconnect, so a consumer never polls and never
 * misses a turn.
 */
import { randomUUID } from 'node:crypto'

export class KodeApiError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'KodeApiError'
    this.status = status
  }
}

const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 30000

export class KodeExtension {
  constructor({ api = process.env.KODE_EXT_API, token = process.env.KODE_EXT_TOKEN, fetch = globalThis.fetch } = {}) {
    if (!api || !token) throw new Error('KODE_EXT_API and KODE_EXT_TOKEN are required; declare an API capability in kode-extension.json')
    this.api = api.replace(/\/+$/, '')
    this.token = token
    this.fetch = fetch
  }

  async request(method, path, body) {
    const response = await this.fetch(`${this.api}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let value
    try { value = text ? JSON.parse(text) : {} } catch { value = { error: text } }
    if (!response.ok) throw new KodeApiError(response.status, value.error ?? `Kode API ${response.status}`)
    return value
  }

  /** API version, granted capabilities and optional features. */
  hello() { return this.request('GET', '/hello') }

  listSessions({ owner = 'self', label } = {}) {
    const query = new URLSearchParams({ owner, ...(label ? { label } : {}) })
    return this.request('GET', `/sessions?${query}`).then(r => r.sessions)
  }

  getSession(id) { return this.request('GET', `/sessions/${id}`) }

  /** Badge on one of this extension's panels (0 clears it). Needs `ui.notify`. */
  badge(panel, count) { return this.request('POST', '/ui/badge', { panel, count }) }

  /** A Kode notification; `panel` names the panel it is about. Needs `ui.notify`. */
  notify({ title, body = '', severity = 'info', panel } = {}) { return this.request('POST', '/ui/notify', { title, body, severity, panel }) }

  /**
   * Answer this extension's agent tools (`contributes.agentTools`, needs
   * `tools.provide`). `handlers[name](arguments, session)` returns the text
   * for the model or throws; runs until `signal` aborts.
   */
  async serveTools(handlers, { signal } = {}) {
    while (!signal?.aborted) {
      let calls
      try {
        calls = (await this.request('GET', '/tools/next?wait=25')).calls ?? []
      } catch (error) {
        if (error instanceof KodeApiError && (error.status === 401 || error.status === 403)) throw error
        await sleep(2000, signal)
        continue
      }
      await Promise.all(calls.map(async call => {
        let content, isError = false
        try {
          const handler = handlers[call.name]
          if (!handler) throw new Error(`No handler for ${call.name}`)
          content = await handler(call.arguments ?? {}, call.session)
        } catch (error) { content = error.message; isError = true }
        await this.request('POST', `/tools/${encodeURIComponent(call.id)}/result`, { content: typeof content === 'string' ? content : JSON.stringify(content ?? ''), is_error: isError }).catch(() => {})
      }))
    }
  }

  /** The user's bots: identity and limits, never their personas. */
  listBots() { return this.request('GET', '/bots') }

  /**
   * Start a session in Kode. Retrying with the same `idempotencyKey` returns
   * the first outcome instead of starting a second CLI. `initialInput` is
   * sent once the CLI reaches its prompt; watch for `session.input_result`.
   * With `bot` the bot decides the Agent, persona and permission ceiling.
   */
  createSession({ bot, backendKey, cwd, model, permissionMode, initialInput, labels = [], meta = {}, parent, idempotencyKey = randomUUID() }) {
    return this.request('POST', '/sessions', {
      bot, backend_key: backendKey, cwd, model, permission_mode: permissionMode, initial_input: initialInput,
      labels, meta, parent, idempotency_key: idempotencyKey,
    })
  }

  sendInput(id, text, { idempotencyKey = randomUUID() } = {}) {
    return this.request('POST', `/sessions/${id}/input`, { text, idempotency_key: idempotencyKey })
  }

  interrupt(id, { idempotencyKey = randomUUID() } = {}) {
    return this.request('POST', `/sessions/${id}/interrupt`, { idempotency_key: idempotencyKey })
  }

  updateMeta(id, { labels, meta } = {}) {
    return this.request('POST', `/sessions/${id}/meta`, { labels, meta })
  }

  /**
   * Async iterator of `{seq, session_id, kind, payload, ts}`. Starts at
   * `after` (default: now) and reconnects from the last seen `seq`.
   * Authorization errors end the iteration with a `KodeApiError`.
   */
  async *events({ kinds = [], owner = 'self', session, after, signal } = {}) {
    let cursor = after
    let delay = RETRY_MIN_MS
    while (!signal?.aborted) {
      const query = new URLSearchParams({ owner, ...(kinds.length ? { kinds: kinds.join(',') } : {}), ...(session ? { session: String(session) } : {}) })
      if (cursor !== undefined) query.set('after', String(cursor))
      try {
        const response = await this.fetch(`${this.api}/events/stream?${query}`, {
          headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' },
          signal,
        })
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          throw new KodeApiError(response.status, (await response.text()) || 'event stream rejected')
        }
        if (!response.ok || !response.body) throw new Error(`event stream ${response.status}`)
        delay = RETRY_MIN_MS
        for await (const event of parseSse(response.body)) {
          if (event.id !== undefined) cursor = Number(event.id)
          if (event.data) yield JSON.parse(event.data)
        }
      } catch (error) {
        if (error instanceof KodeApiError || signal?.aborted) throw error
      }
      await sleep(delay, signal)
      delay = Math.min(delay * 2, RETRY_MAX_MS)
    }
  }
}

/** Minimal SSE parser over a byte stream; yields `{id, event, data}`. */
export async function* parseSse(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n')
    let end
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const event = {}
      const data = []
      for (const line of frame.split('\n')) {
        if (!line || line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'data') data.push(value)
        else if (field === 'id' || field === 'event') event[field] = value
      }
      if (data.length || event.id !== undefined) yield { ...event, data: data.join('\n') }
    }
  }
}

function sleep(ms, signal) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

/** Node-side client. Backend admin credentials never enter a browser bundle. */
export class BackendClient {
  constructor(url, token, { fetch: fetcher = globalThis.fetch } = {}) {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('backend URL must be an HTTP(S) origin')
    this.url = parsed.origin
    this.token = token
    this.fetch = fetcher
  }
  async call(path, body, signal) {
    if (!path.startsWith('/api/v1/messaging/')) throw new Error('unsupported backend path')
    const timeoutMs = path === '/api/v1/messaging/workbench/agent-hub' ? 600000 : path === '/api/v1/messaging/workbench/handoff' ? 75000 : 15000
    const response = await this.fetch(`${this.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    })
    const text = await response.text()
    if (response.status === 404) throw Object.assign(new Error(`Kode backend is missing ${path} (HTTP 404); update the shared Kode backend and reconnect`), { status: 404 })
    let result
    try { result = text ? JSON.parse(text) : undefined } catch {
      throw new Error(`Kode backend returned invalid JSON (HTTP ${response.status}, ${path})`)
    }
    if (result === undefined) throw new Error(`Kode backend returned an empty response (HTTP ${response.status}, ${path})`)
    if (!response.ok) throw Object.assign(new Error(`kode backend (${response.status}): ${result.error ?? 'request failed'}`), { status: response.status, path, code: typeof result.code === 'string' && result.code.length <= 128 ? result.code : undefined })
    return result
  }
  async asset(path, signal) {
    if (!path.startsWith('/api/v1/messaging/')) throw new Error('unsupported backend path')
    const response = await this.fetch(`${this.url}${path}`, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      redirect: 'error',
    })
    if (!response.ok) throw Object.assign(new Error(`Kode backend asset unavailable (HTTP ${response.status})`), { status: response.status })
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].toLowerCase()
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) throw new Error('Kode backend returned a non-image asset')
    if (Number(response.headers.get('content-length')) > 4 * 1024 * 1024) throw new Error('Kode backend asset is too large')
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length > 4 * 1024 * 1024) throw new Error('Kode backend asset is too large')
    return { contentType, body }
  }
  forSession(token) { return new BackendClient(this.url, token, { fetch: this.fetch }) }
}

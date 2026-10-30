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
    const response = await this.fetch(`${this.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      redirect: 'error',
    })
    const result = await response.json()
    if (!response.ok) throw new Error(`kode backend (${response.status}): ${result.error ?? 'request failed'}`)
    return result
  }
  forSession(token) { return new BackendClient(this.url, token, { fetch: this.fetch }) }
}

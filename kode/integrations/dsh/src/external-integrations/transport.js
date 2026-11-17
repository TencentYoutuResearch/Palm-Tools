/** Only construct after the connection's exact destination and access have been authorized. */
function abortable(signal, operation) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', aborted)
    signal.addEventListener('abort', aborted, {once: true})
    // Check again before starting work. An already cancelled header lookup must
    // never continue into a fetch, even when its underlying promise settles late.
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation() }).then(
      result => { cleanup(); resolve(result) }, error => { cleanup(); reject(error) },
    )
  })
}
function cancelBody(body) {
  // Cancellation is best effort: an uncooperative source's cancel promise must
  // not hold Host disposal or a rejected response open indefinitely.
  try { Promise.resolve(body?.cancel()).catch(() => {}) } catch {}
}
export function readonlyTransport({origin, headers = () => ({}), fetch: fetcher = globalThis.fetch, timeoutMs = 15000}) {
  const base = new URL(origin)
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw Error('Clean authorized HTTPS origin required')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw Error('Invalid provider timeout')
  return async request => {
    if (request.method !== 'GET' || request.origin !== base.origin || typeof request.path !== 'string' || !request.path.startsWith('/') || request.path.startsWith('//')) throw Error('Read destination mismatch')
    const url = new URL(request.path, base)
    if (url.origin !== base.origin) throw Error('Origin escape rejected')
    // One deadline includes credential lookup, fetch and bounded body reading.
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new Error('Provider read timed out')), timeoutMs)
    const signal = request.signal ? AbortSignal.any([request.signal, deadline.signal]) : deadline.signal
    let response, reader, consumed = false, cancelled = false
    const releaseResponse = () => {
      const body = reader ?? response?.body
      if (!consumed && !cancelled && body) { cancelled = true; cancelBody(body) }
    }
    try {
      const approvedHeaders = await abortable(signal, () => headers({signal}))
      const fetching = abortable(signal, () => {
        return Promise.resolve(fetcher(url.href, {method: 'GET', headers: approvedHeaders, redirect: 'error', signal})).then(value => {
          // Take ownership before the abortable promise can settle. Cancellation
          // can win between fetch resolution and the caller's await continuation.
          response = value
          if (signal.aborted) releaseResponse()
          return value
        })
      })
      await fetching
      signal.throwIfAborted()
      if (!response.ok) throw Error('Provider read rejected')
      const max = Math.min(request.maxBytes ?? 4194304, 4194304)
      if (Number(response.headers.get('content-length')) > max) throw Error('Provider response too large')
      const parts = []
      let bytes = 0
      reader = response.body?.getReader()
      while (reader) {
        const {done, value} = await abortable(signal, () => reader.read())
        if (done) { consumed = true; break }
        bytes += value.length
        if (bytes > max) throw Error('Provider response too large')
        parts.push(value)
      }
      signal.throwIfAborted()
      return JSON.parse(Buffer.concat(parts).toString('utf8'))
    } catch {
      throw Error('Provider read not confirmed; verify connection and access')
    } finally {
      clearTimeout(timer)
      releaseResponse()
      reader?.releaseLock()
    }
  }
}

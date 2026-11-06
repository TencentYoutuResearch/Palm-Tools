/** Cookie-authenticated, bounded SSE reader. A reconnect always resumes the accepted cursor. */
export async function readMessageStream({ conversationId, after, signal, onPage, fetcher = globalThis.fetch, idleTimeout = 45000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(conversationId) || !Number.isSafeInteger(after) || after < 0) throw Error('Invalid stream scope')
  const idle = new AbortController(), activeSignal = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal
  let timer, reader
  const resetIdle = () => { clearTimer(timer); timer = setTimer(() => idle.abort(), idleTimeout) }
  const abortReader = () => { void reader?.cancel().catch(() => {}) }
  activeSignal.addEventListener('abort', abortReader)
  resetIdle()
  try {
    const response = await fetcher(`/api/kode/conversation/events?conversation_id=${encodeURIComponent(conversationId)}&after=${after}`, {
      method: 'GET', credentials: 'same-origin', redirect: 'error', headers: { accept: 'text/event-stream' }, signal: activeSignal,
    })
    if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw Error('Message stream unavailable')
    reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let buffer = '', event = '', id = '', data = [], bytes = 0
    const dispatch = () => {
      if (data.length) {
        if (event !== 'messages' || !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) throw Error('Invalid message event')
        const page = JSON.parse(data.join('\n'))
        if (!Array.isArray(page.items) || !page.items.length || page.items.at(-1)?.sequence !== Number(id)) throw Error('Invalid stream cursor')
        onPage(page)
      }
      event = ''; id = ''; data = []; bytes = 0
    }
    while (!activeSignal.aborted) {
      const { done, value } = await reader.read()
      if (done) throw Error('Message stream ended')
      resetIdle()
      buffer += decoder.decode(value, { stream: true })
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        bytes += line.length
        if (bytes > 4 * 1024 * 1024) throw Error('Message event too large')
        if (!line) { dispatch(); continue }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':'), field = colon < 0 ? line : line.slice(0, colon)
        let value = colon < 0 ? '' : line.slice(colon + 1); if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') event = value
        else if (field === 'id') id = value
        else if (field === 'data') data.push(value)
      }
      if (buffer.length > 4 * 1024 * 1024) throw Error('Message event too large')
    }
  } finally {
    clearTimer(timer); activeSignal.removeEventListener('abort', abortReader)
    await reader?.cancel().catch(() => {}); reader?.releaseLock()
  }
}

/** One stream per visible contact. Abort hidden requests; retry without losing committed messages. */
export function visibleMessageStream({ store, conversationId, document: doc = globalThis.document,
  stream = readMessageStream, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let stopped = false, controller, timer, generation = 0
  const clear = () => { clearTimer(timer); timer = undefined; controller?.abort(); controller = undefined; generation++ }
  const start = () => {
    if (stopped || doc.visibilityState === 'hidden') return
    const epoch = ++generation
    controller = new AbortController()
    const signal = controller.signal
    void stream({ conversationId, after: store.getSnapshot().conversations[conversationId]?.cursor ?? 0, signal,
      onPage: page => { if (!stopped && !signal.aborted && epoch === generation) store.acceptMessagePage(conversationId, page) },
    }).catch(() => {}).finally(() => {
      if (!stopped && epoch === generation && doc.visibilityState !== 'hidden') timer = setTimer(start, 3000)
    })
  }
  const changed = () => { clear(); start() }
  doc.addEventListener('visibilitychange', changed); start()
  return () => { stopped = true; clear(); doc.removeEventListener('visibilitychange', changed) }
}

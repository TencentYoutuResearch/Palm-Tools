/** Owner-only SSE adapter for the Home conversation cursor API.
 * This polls the durable Home messages endpoint; it is not a native Home push feed.
 */
export function registerConversationStream(ctx, config, timers = {}) {
  const setTimer = timers.setTimeout ?? setTimeout
  const clearTimer = timers.clearTimeout ?? clearTimeout
  const setHeartbeat = timers.setInterval ?? setInterval
  const clearHeartbeat = timers.clearInterval ?? clearInterval

  const streams = new Set()
  const unregister = ctx.webServer.register({ kind: 'exact', path: '/api/kode/conversation/events', handler: async (req, res) => {
    const send = (status, body) => {
      if (res.headersSent || res.writableEnded) return
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'GET') return send(405, { error: 'GET required' })
    if (!config?.backendClient) return send(503, { error: 'Conversation backend unavailable' })

    const validIdentity = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
    const sequence = value => typeof value === 'string' && /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value))
      ? Number(value) : null
    const query = new URL(req.url, 'http://localhost').searchParams
    if ([...query.keys()].some(key => !['conversation_id', 'after'].includes(key))
      || ['conversation_id', 'after'].some(key => query.getAll(key).length > 1)) {
      return send(400, { error: 'Invalid conversation stream query' })
    }
    const conversationId = query.get('conversation_id')
    if (!validIdentity(conversationId)) return send(400, { error: 'Invalid conversation identity' })
    const requested = query.has('after') ? sequence(query.get('after')) : 0
    if (requested === null) return send(400, { error: 'Invalid conversation cursor' })
    const lastEventHeader = req.headers?.['last-event-id']
    if (lastEventHeader !== undefined && (typeof lastEventHeader !== 'string' || sequence(lastEventHeader) === null)) {
      return send(400, { error: 'Invalid Last-Event-ID' })
    }
    const lastEventId = lastEventHeader === undefined ? null : Number(lastEventHeader)
    // EventSource reconnects keep the original `after` query while advancing Last-Event-ID.
    // A backwards header conflicts with the requested lower bound; a newer header is a valid resume.
    if (lastEventId !== null && lastEventId < requested) return send(400, { error: 'Conflicting conversation cursor' })
    let cursor = lastEventId ?? requested
    const home = ctx.get?.('kodeAgents')?.officialExecution?.host ?? config.quotaHost
    if (!validIdentity(home)) return send(503, { error: 'Conversation Home unavailable' })

    let pinnedTeam
    const validatePage = (page, after) => {
      if (!page || page.home_hub !== home || page.conversation_id !== conversationId || !validIdentity(page.team_id)
        || (pinnedTeam && page.team_id !== pinnedTeam)
        || !Array.isArray(page.items) || page.items.length > 50 || typeof page.has_more !== 'boolean') return false
      let prior = after
      const ids = new Set()
      for (const item of page.items) {
        if (!item || !validIdentity(item.id) || ids.has(item.id) || item.home_hub !== home || item.conversation_id !== conversationId
          || item.team_id !== page.team_id || !Number.isSafeInteger(item.sequence) || item.sequence <= prior
          || typeof item.content !== 'string' || Buffer.byteLength(item.content, 'utf8') > 65536) return false
        ids.add(item.id); prior = item.sequence
      }
      if (page.has_more) return page.items.length > 0 && page.next_cursor === prior
      return page.next_cursor === null
    }
    const readPage = (after, signal) => config.backendClient.call(
      `/api/v1/messaging/conversations/${encodeURIComponent(conversationId)}/messages?after=${after}&limit=50`, undefined, signal)

    let closed = false, timer = null, heartbeat = null, inFlight = null, blocked = false, hasMore = false
    const clearScheduled = () => { if (timer !== null) clearTimer(timer); timer = null }
    const stop = () => {
      if (closed) return
      closed = true
      streams.delete(shutdown)
      clearScheduled()
      if (heartbeat !== null) clearHeartbeat(heartbeat)
      heartbeat = null
      inFlight?.abort()
    }
    const shutdown = () => { stop(); if (!res.writableEnded) res.end() }
    streams.add(shutdown)
    req.once?.('aborted', stop)
    res.once?.('close', stop)

    let first
    try {
      inFlight = new AbortController()
      first = await readPage(cursor, inFlight.signal)
      if (closed) return
      if (!validatePage(first, cursor)) {
        stop()
        return send(409, { error: 'Conversation scope or cursor changed' })
      }
    } catch {
      if (!closed) send(409, { error: 'Conversation stream unavailable; retry from the last received cursor' })
      stop()
      return
    } finally {
      inFlight = null
    }

    if (closed) return
    pinnedTeam = first.team_id
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.flushHeaders?.()
    // Hold one Home page; split it into bounded events for maximum-size messages.
    let pendingPage = null, pendingIndex = 0
    const resume = () => {
      if (closed) return
      blocked = false
      if (writePending()) scheduleNext()
    }
    const writePending = () => {
      while (!closed && pendingPage && pendingIndex < pendingPage.items.length) {
        const item = pendingPage.items[pendingIndex++]
        cursor = item.sequence
        const more = pendingIndex < pendingPage.items.length || pendingPage.has_more
        const page = { ...pendingPage, items: [item], has_more: more, next_cursor: more ? cursor : null }
        const frame = `id: ${cursor}\nevent: messages\ndata: ${JSON.stringify(page)}\n\n`
        if (Buffer.byteLength(frame, 'utf8') > 1024 * 1024) { res.end(); stop(); return false }
        if (!res.write(frame)) {
          blocked = true; clearScheduled(); res.once('drain', resume); return false
        }
      }
      pendingPage = null; pendingIndex = 0
      return !closed
    }
    const writePage = page => {
      hasMore = page.has_more
      pendingPage = page; pendingIndex = 0
      return blocked ? false : writePending()
    }
    const scheduleNext = (delay = hasMore ? 0 : 1000) => {
      clearScheduled()
      if (!closed && !blocked) timer = setTimer(() => { timer = null; void poll() }, delay)
    }
    const failStream = () => {
      if (closed) return
      if (!blocked && !res.writableEnded) {
        res.write('event: error\ndata: {"error":"Conversation stream stopped; reconnect from Last-Event-ID"}\n\n')
      }
      if (!res.writableEnded) res.end()
      stop()
    }
    const poll = async () => {
      if (closed || blocked || inFlight) return
      const current = ctx.connection.admit(req)
      if ('rejection' in current || current.peer.principal.kind !== 'owner') { shutdown(); return }
      inFlight = new AbortController()
      let page
      try {
        page = await readPage(cursor, inFlight.signal)
        if (closed) return
        if (!validatePage(page, cursor)) return failStream()
      } catch {
        if (!closed) scheduleNext(1000)
        return
      } finally {
        inFlight = null
      }
      if (closed) return
      if (!writePage(page)) return
      scheduleNext()
    }

    writePage(first)
    if (closed) return
    heartbeat = setHeartbeat(() => {
      if (closed || blocked || res.writableEnded) return
      if (!res.write(': keep-alive\n\n')) {
        blocked = true
        clearScheduled()
        res.once('drain', resume)
      }
    }, 15000)
    scheduleNext()
  } })
  return () => { for (const shutdown of streams) shutdown(); if (typeof unregister === 'function') unregister() }
}

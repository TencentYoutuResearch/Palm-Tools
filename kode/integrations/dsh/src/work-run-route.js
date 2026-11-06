/** Owner control surface. Hub remains authority for revisions, stop evidence and receipts. */
export function registerWorkRun(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/work-run', handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (!['GET', 'POST'].includes(req.method)) return send(405, { error: 'GET or POST required' })
    if (!config?.backendClient) return send(503, { error: 'WorkRun backend unavailable' })
    const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
    try {
      if (req.method === 'GET') {
        const query = new URL(req.url, 'http://localhost').searchParams
        const id = query.get('run_id'), view = query.get('view') ?? 'status', after = query.get('after') ?? '0'
        if (view === 'diagnostics') {
          const revision = query.get('run_revision'), cursor = query.get('after') ?? ''
          if (!valid(id) || !/^[1-9]\d*$/.test(revision ?? '') || !Number.isSafeInteger(Number(revision)) || (cursor && !valid(cursor))
            || [...query.keys()].some(key => !['run_id', 'view', 'run_revision', 'after'].includes(key) || query.getAll(key).length !== 1)) {
            return send(400, { error: 'Invalid session diagnostic query' })
          }
          const page = new URLSearchParams({ run_revision: revision, ...(cursor ? { after: cursor } : {}) })
          return send(200, await config.backendClient.call(`/api/v1/messaging/work-runs/${encodeURIComponent(id)}/diagnostics?${page}`))
        }
        if (!valid(id) || !['status', 'events'].includes(view)
          || [...query.keys()].some(key => !['run_id', 'view', 'after'].includes(key) || query.getAll(key).length !== 1)
          || (view === 'status' && query.has('after')) || !/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) {
          return send(400, { error: 'Invalid WorkRun query' })
        }
        return send(200, await config.backendClient.call(`/api/v1/messaging/work-runs/${encodeURIComponent(id)}${view === 'events' ? `/events?after=${after}` : ''}`))
      }
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON required' })
      let bytes = 0; const chunks = []
      for await (const part of req) {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part); bytes += chunk.length
        if (bytes > 16384) return send(413, { error: 'WorkRun command too large' })
        chunks.push(chunk)
      }
      let input
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(400, { error: 'Invalid JSON' }) }
      if (!input || Array.isArray(input) || Object.keys(input).some(key => !['run_id', 'action', 'request_id', 'expected_revision', 'reason'].includes(key))
        || !valid(input.run_id) || !valid(input.request_id) || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1
        || !['cancel', 'request_cancel', 'cancel_settled', 'recheck_execution', 'takeover', 'resume'].includes(input.action)
        || (input.action === 'cancel' ? 'reason' in input : typeof input.reason !== 'string' || !input.reason.trim() || input.reason.includes('\0') || Buffer.byteLength(input.reason) > 2048)) {
        return send(400, { error: 'Invalid WorkRun command' })
      }
      const { run_id, ...command } = input
      return send(200, await config.backendClient.call(`/api/v1/messaging/work-runs/${encodeURIComponent(run_id)}`, command))
    } catch {
      // A reply can be lost after commit. Never retry with a fresh identity or claim stop.
      return send(409, { error: 'WorkRun operation was not confirmed; retry the exact command to recover its receipt', retry: 'same_request' })
    }
  } })
}

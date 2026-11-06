/** Owner runtime intent; this endpoint cannot create sessions, grants or budgets. */
export function registerBuilderSelection(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/builder/selection', handler: async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (!['GET', 'POST'].includes(req.method)) return send(405, { error: 'GET or POST required' })
    if (!config?.backendClient) return send(503, { error: 'Builder unavailable' })
    const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
    let id, command
    if (req.method === 'GET') {
      const query = new URL(req.url, 'http://localhost').searchParams
      id = query.get('draft_id')
      if (!valid(id) || [...query.keys()].some(key => key !== 'draft_id' || query.getAll(key).length !== 1)) return send(400, { error: 'Invalid selection query' })
    } else {
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON required' })
      try {
        let bytes = 0; const chunks = []
        for await (const part of req) { const chunk = Buffer.from(part); bytes += chunk.length; if (bytes > 32768) return send(413, { error: 'Selection too large' }); chunks.push(chunk) }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!input || Array.isArray(input) || Object.keys(input).some(key => !['draft_id', 'request_id', 'expected_revision', 'draft_revision', 'selection'].includes(key))
          || !valid(input.draft_id) || !valid(input.request_id) || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0
          || !Number.isSafeInteger(input.draft_revision) || input.draft_revision < 1) throw Error('Invalid selection')
        const { draft_id, ...value } = input; id = draft_id; command = value
      } catch { return send(400, { error: 'Invalid selection' }) }
    }
    try { return send(200, await config.backendClient.call(`/api/v1/messaging/superagents/drafts/${encodeURIComponent(id)}/selection`, command)) }
    catch { return send(req.method === 'POST' ? 409 : 503, { error: 'Selection not confirmed', ...(req.method === 'POST' ? { retry: 'same_request' } : {}) }) }
  } })
}

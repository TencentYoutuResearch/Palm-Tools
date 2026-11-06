/** Owner account grouping only; never provider credentials or observed balance. */
export function registerBuilderAccount(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/builder/account', handler: async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (!['GET', 'POST'].includes(req.method)) return send(405, { error: 'GET or POST required' })
    if (!config?.backendClient) return send(503, { error: 'Builder unavailable' })
    const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
    let path, command
    try {
      if (req.method === 'GET') {
        const query = new URL(req.url, 'http://localhost').searchParams, id = query.get('draft_id'), request = query.get('request_id')
        if (!valid(id) || !valid(request) || [...query.keys()].length !== 2) return send(400, { error: 'Exact receipt identity required' })
        path = `/api/v1/messaging/superagents/drafts/${encodeURIComponent(id)}/account-requests/${encodeURIComponent(request)}`
      } else {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON required' })
        let bytes = 0; const chunks = []
        for await (const part of req) { const chunk = Buffer.from(part); bytes += chunk.length; if (bytes > 8192) return send(413, { error: 'Command too large' }); chunks.push(chunk) }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!input || Array.isArray(input) || Object.keys(input).some(key => !['draft_id', 'request_id', 'draft_revision', 'selection_revision', 'account_id', 'account_epoch', 'create_account', 'expected_binding_revision'].includes(key))
          || !['draft_id', 'request_id', 'account_id'].every(key => valid(input[key])) || typeof input.create_account !== 'boolean'
          || !['draft_revision', 'selection_revision', 'account_epoch'].every(key => Number.isSafeInteger(input[key]) && input[key] > 0)
          || !Number.isSafeInteger(input.expected_binding_revision) || input.expected_binding_revision < 0) return send(400, { error: 'Invalid account confirmation' })
        const { draft_id, ...value } = input; command = value
        path = `/api/v1/messaging/superagents/drafts/${encodeURIComponent(draft_id)}/account`
      }
    } catch { return send(400, { error: 'Invalid account command' }) }
    try { return send(200, await config.backendClient.call(path, command)) }
    catch { return send(req.method === 'POST' ? 409 : 503, { error: 'Account grouping not confirmed', ...(req.method === 'POST' ? { retry: 'same_request' } : {}) }) }
  } })
}

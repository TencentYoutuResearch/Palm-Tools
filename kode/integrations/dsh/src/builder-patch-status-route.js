/** Read authoritative patch outcome before allowing local conflict resolution. */
export function registerBuilderPatchStatus(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/builder/patch-status', handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'GET') return send(405, { error: 'GET required' })
    if (!config?.backendClient) return send(503, { error: 'Builder unavailable' })
    const query = new URL(req.url, 'http://localhost').searchParams, keys = [...query.keys()]
    const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
    if (keys.length !== 4 || new Set(keys).size !== 4 || keys.some(key => !['draft_id', 'kind', 'request_id', 'expected_revision'].includes(key))
      || !valid(query.get('draft_id')) || !valid(query.get('request_id')) || !['answers', 'workspaces'].includes(query.get('kind'))
      || !/^[1-9]\d*$/.test(query.get('expected_revision')) || !Number.isSafeInteger(Number(query.get('expected_revision')))) return send(400, { error: 'Invalid patch query' })
    const draft = query.get('draft_id'); query.delete('draft_id')
    try { return send(200, await config.backendClient.call(`/api/v1/messaging/superagents/drafts/${encodeURIComponent(draft)}/patch-status?${query}`)) }
    catch { return send(503, { error: 'Patch outcome unavailable' }) }
  } })
}

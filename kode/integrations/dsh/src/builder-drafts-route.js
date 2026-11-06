/** Owner draft recovery; reading never creates a Builder runtime or activates a team. */
export function registerBuilderDrafts(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/builder/drafts', handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'GET') return send(405, { error: 'GET required' })
    if (!config?.backendClient) return send(503, { error: 'Builder drafts unavailable' })
    const query = new URL(req.url, 'http://localhost').searchParams, keys = [...query.keys()]
    const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
    if (keys.length !== new Set(keys).size || keys.some(key => !['draft_id', 'after', 'limit'].includes(key))) return send(400, { error: 'Invalid draft query' })
    let path = '/api/v1/messaging/superagents/drafts'
    if (query.has('draft_id')) {
      if (!valid(query.get('draft_id')) || keys.length !== 1) return send(400, { error: 'Invalid draft identity' })
      path += `/${encodeURIComponent(query.get('draft_id'))}`
    } else {
      const after = query.get('after') ?? '', limit = query.get('limit') ?? '25'
      if ((after && !valid(after)) || !/^[1-9]\d?$/.test(limit) || Number(limit) > 50) return send(400, { error: 'Invalid draft cursor' })
      path += `?after=${encodeURIComponent(after)}&limit=${limit}`
    }
    try { return send(200, await config.backendClient.call(path)) }
    catch (error) { return send(error?.status === 404 ? 404 : 503, { error: 'Builder drafts unavailable' }) }
  } })
}

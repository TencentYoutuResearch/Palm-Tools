/** Owner-only navigation endpoint. Chat, attachments and approvals use native UI. */
export function registerBuilderPlanning(ctx, sessions) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/builder/planning', handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'Authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (!['GET', 'POST'].includes(req.method)) return send(405, { error: 'GET or POST required' })
    try {
      if (req.method === 'GET') {
        const query = new URL(req.url, 'http://localhost').searchParams
        if ([...query.keys()].length !== 1 || !query.has('draft_id')) return send(400, { error: 'Draft identity required' })
        return send(200, await sessions.inspect(query.get('draft_id')))
      }
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON required' })
      let bytes = 0; const chunks = []
      for await (const part of req) {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part); bytes += chunk.length
        if (bytes > 16384) return send(413, { error: 'Planning request too large' })
        chunks.push(chunk)
      }
      let input
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(400, { error: 'Invalid JSON' }) }
      return send(200, await sessions.open(input))
    } catch (error) {
      const safe = /^(PLANNING_|DRAFT_|NATIVE_AGENT_|CONTROLLED_BUILDER_|INVALID_REQUEST)/.test(error.code ?? '')
      return send(error.code === 'INVALID_REQUEST' ? 400 : 409, { code: safe ? error.code : 'PLANNING_NOT_CONFIRMED',
        error: safe ? error.message : 'Planning was not confirmed; inspect the draft binding before retrying', execution_authorized: false })
    }
  } })
}

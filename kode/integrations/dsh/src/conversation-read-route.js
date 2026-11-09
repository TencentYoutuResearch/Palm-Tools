/** Owner read position is independent of Worker delivery consumption. */
export function registerConversationRead(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/conversation/read-state', handler: async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (!['GET', 'POST'].includes(req.method)) return send(405, { error: 'GET or POST required' })
    if (!config?.backendClient) return send(503, { error: 'Conversation backend unavailable' })
    const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
    try {
      const query = new URL(req.url, 'http://localhost').searchParams
      if (req.method === 'GET') {
        const id = query.get('conversation_id')
        if (!valid(id) || [...query.keys()].length !== 1) return send(400, { error: 'Invalid read-state query' })
        return send(200, await config.backendClient.call(`/api/v1/messaging/conversations/${encodeURIComponent(id)}/read-state`))
      }
      if ([...query.keys()].length) return send(400, { error: 'Unexpected read-state query' })
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON required' })
      let bytes = 0
      const chunks = []
      for await (const part of req) {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
        bytes += chunk.length
        if (bytes > 4096) return send(413, { error: 'Read-state request too large' })
        chunks.push(chunk)
      }
      let input
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(400, { error: 'Invalid JSON' }) }
      if (!input || Array.isArray(input) || Object.keys(input).some(key => !['conversation_id', 'through_sequence'].includes(key))
        || !valid(input.conversation_id) || !Number.isSafeInteger(input.through_sequence) || input.through_sequence < 0) {
        return send(400, { error: 'Invalid read position' })
      }
      return send(200, await config.backendClient.call(`/api/v1/messaging/conversations/${encodeURIComponent(input.conversation_id)}/read-state`, { through_sequence: input.through_sequence }))
    } catch {
      return send(409, { error: 'Read position was not confirmed; read current state or retry the same position', retry: 'same_position' })
    }
  } })
}

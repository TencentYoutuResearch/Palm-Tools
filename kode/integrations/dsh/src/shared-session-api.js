/** Owner-only access to conversations owned by another runtime on this Host. */
import { randomUUID } from 'node:crypto'
export function registerSharedSessionApi(ctx, backend) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/shared-session', handler: async (req, res) => {
    const send = (status, value) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(value)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    try {
      if (req.method === 'GET') {
        const query = new URL(req.url, 'http://localhost').searchParams
        const id = Number(query.get('id'))
        if (!Number.isSafeInteger(id) || id < 1) return send(400, { error: 'Session identity required' })
        const value = await backend.call(`/api/v1/messaging/runtime/history?id=${id}`)
        return send(200, value)
      }
      if (req.method !== 'POST') return send(405, { error: 'GET or POST required' })
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 128 * 1024) return send(413, { error: 'Message too large' }) }
      const input = JSON.parse(body)
      if (!['input', 'interrupt', 'answer', 'plan_response', 'model', 'mode'].includes(input.kind)) return send(400, { error: 'Unsupported session operation' })
      return send(200, await backend.call('/api/v1/messaging/runtime/command', { session_id: input.session_id, kind: input.kind, payload: input.payload, request_id: input.request_id ?? randomUUID() }))
    } catch (error) { return send(400, { error: error.message }) }
  } })
}

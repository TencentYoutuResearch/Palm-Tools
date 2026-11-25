import { admitHostRequest } from './host-admission.js'

const VALID_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_BODY_BYTES = 32 * 1024

/** Host-owner proxy for reviewing pending Kode memory proposals and browsing approved facts. */
export function registerMemoryApi(ctx, backend) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/memory', handler: async (req, res, peer) => {
    const send = (status, value) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(value))
    }
    const admitted = admitHostRequest(ctx, req, peer)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') {
      return send(403, { error: 'Host owner required' })
    }
    try {
      if (req.method === 'GET') {
        const url = new URL(req.url || '/api/kode/memory', 'http://localhost')
        const view = url.searchParams.get('view') || 'pending'
        if (view === 'facts') {
          const qs = new URLSearchParams()
          const q = url.searchParams.get('q')
          const scope = url.searchParams.get('scope')
          const limit = url.searchParams.get('limit')
          if (q && q.trim()) qs.set('q', q.trim())
          if (scope && scope.trim()) qs.set('scope', scope.trim())
          if (limit && /^\d+$/.test(limit)) qs.set('limit', limit)
          const suffix = qs.toString() ? `?${qs.toString()}` : ''
          return send(200, await backend.call(`/api/v1/messaging/memory/facts${suffix}`))
        }
        if (view !== 'pending') return send(400, { error: 'Unknown memory view' })
        return send(200, await backend.call('/api/v1/messaging/memory/pending'))
      }
      if (req.method !== 'POST') return send(405, { error: 'GET or POST required' })
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > MAX_BODY_BYTES) return send(413, { error: 'Request too large' })
      }
      const input = JSON.parse(body || '{}')
      if (!input || typeof input !== 'object') return send(400, { error: 'Invalid JSON payload' })
      if (input.action === 'review') {
        if (typeof input.id !== 'string' || !VALID_ID.test(input.id)) {
          return send(400, { error: 'Invalid memory ID' })
        }
        if (!input.verdict || typeof input.verdict !== 'object') {
          return send(400, { error: 'Missing review verdict' })
        }
        return send(
          200,
          await backend.call(
            `/api/v1/messaging/memory/pending/${encodeURIComponent(input.id)}/review`,
            { verdict: input.verdict },
          ),
        )
      }
      if (input.action === 'deprecate') {
        if (typeof input.id !== 'string' || !VALID_ID.test(input.id)) {
          return send(400, { error: 'Invalid memory ID' })
        }
        const reason = typeof input.reason === 'string' ? input.reason : ''
        return send(
          200,
          await backend.call(
            `/api/v1/messaging/memory/facts/${encodeURIComponent(input.id)}/deprecate`,
            { reason },
          ),
        )
      }
      return send(400, { error: 'Unknown memory action' })
    } catch (error) {
      if (error.status === 404) {
        return send(503, {
          code: 'KODE_SERVICE_UPDATE_REQUIRED',
          error: '所选主机的 Kode 服务版本较旧，需要更新并重启以支持共享记忆审批。',
        })
      }
      return send(400, { error: error.message })
    }
  } })
}

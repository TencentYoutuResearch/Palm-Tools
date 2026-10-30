import QRCode from 'qrcode'

/** Host-owner UI proxy. Browser clients never receive backend credentials. */
export function registerIntegrationApi(ctx, backend) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/integrations', handler: async (req, res) => {
    const send = (status, value) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(value)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    try {
      if (req.method === 'GET') return send(200, { settings: await backend.call('/api/v1/messaging/integrations'), cloud: await backend.call('/api/v1/messaging/cloud/status') })
      if (req.method !== 'POST') return send(405, { error: 'GET or POST required' })
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 8192) return send(413, { error: 'Request too large' }) }
      const input = JSON.parse(body)
      if (input.action === 'pair') {
        const pairing = await backend.call('/api/v1/messaging/cloud/pair', { server_url: input.server_url })
        // Encode the existing one-time invite locally; never send its secret to a QR service.
        try {
          pairing.qr_data_url = await QRCode.toDataURL(pairing.uri, { errorCorrectionLevel: 'M', margin: 4, scale: 6 })
        } catch {
          // The invite is already valid. Keep manual pairing available if rendering fails.
          pairing.qr_error = '二维码生成失败，请使用下方配对链接，或重新生成。'
        }
        return send(200, { pairing })
      }
      if (input.action !== 'configure') return send(400, { error: 'Unknown integration action' })
      return send(200, { settings: await backend.call('/api/v1/messaging/integrations', input.settings) })
    } catch (error) {
      if (error.status === 404) return send(503, { code: 'KODE_SERVICE_UPDATE_REQUIRED', error: '所选主机的 Kode 服务版本较旧，需要更新并重启。' })
      return send(400, { error: error.message })
    }
  } })
}

export const memoryTools = [
  { name: 'memory_search', description: 'Search reviewed shared Kode memory on this execution Host.', parameters: { query: { type: 'string', required: true }, scope: { type: 'string' }, top_k: { type: 'integer' } } },
  { name: 'memory_read', description: 'Read a reviewed Kode memory fact and its backlinks.', parameters: { id: { type: 'string', required: true } } },
  { name: 'memory_list_recent', description: 'Read recently reviewed Kode memories on this Host.', parameters: { scope: { type: 'string' }, since_hours: { type: 'integer' }, limit: { type: 'integer' } } },
  { name: 'memory_propose', description: 'Propose a reusable fact to Kode memory. It remains pending until the owner reviews it; never include credentials.', parameters: { scope: { type: 'string', required: true }, body: { type: 'string', required: true }, title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, kind: { type: 'string', enum: ['gotcha', 'invariant', 'recipe', 'dead_end', 'preference'] }, supersedes: { type: 'string' }, rationale: { type: 'string' }, confidence: { type: 'number' }, force: { type: 'boolean' } } },
  { name: 'memory_budget_status', description: 'Read this conversation’s remaining memory proposal budget.', parameters: {} },
]

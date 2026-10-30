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
      if (input.action === 'pair') return send(200, { pairing: await backend.call('/api/v1/messaging/cloud/pair', { server_url: input.server_url }) })
      if (input.action !== 'configure') return send(400, { error: 'Unknown integration action' })
      return send(200, { settings: await backend.call('/api/v1/messaging/integrations', input.settings) })
    } catch (error) { return send(400, { error: error.message }) }
  } })
}

export const memoryTools = [
  { name: 'memory_search', description: 'Search reviewed shared Kode memory on this execution Host.', parameters: { query: { type: 'string', required: true }, scope: { type: 'string' }, top_k: { type: 'integer' } } },
  { name: 'memory_read', description: 'Read a reviewed Kode memory fact and its backlinks.', parameters: { id: { type: 'string', required: true } } },
  { name: 'memory_list_recent', description: 'Read recently reviewed Kode memories on this Host.', parameters: { scope: { type: 'string' }, since_hours: { type: 'integer' }, limit: { type: 'integer' } } },
  { name: 'memory_propose', description: 'Propose a reusable fact to Kode memory. It remains pending until the owner reviews it; never include credentials.', parameters: { scope: { type: 'string', required: true }, body: { type: 'string', required: true }, title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, kind: { type: 'string', enum: ['gotcha', 'invariant', 'recipe', 'dead_end', 'preference'] }, supersedes: { type: 'string' }, rationale: { type: 'string' }, confidence: { type: 'number' }, force: { type: 'boolean' } } },
  { name: 'memory_budget_status', description: 'Read this conversation’s remaining memory proposal budget.', parameters: {} },
]

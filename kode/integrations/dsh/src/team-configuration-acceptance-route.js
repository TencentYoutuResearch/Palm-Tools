/** Explicit owner review only; saving a draft never calls this endpoint. */
export function registerTeamConfigurationAcceptance(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/teams/configuration-acceptance', handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return send(403, { code: 'OWNER_REQUIRED', error: 'Host owner required' })
    if (!['GET', 'POST'].includes(req.method)) return send(405, { code: 'METHOD_NOT_ALLOWED', error: 'GET or POST required' })
    if (!config?.backendClient) return send(503, { code: 'BACKEND_UNAVAILABLE', error: 'Team backend unavailable' })
    const valid = x => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(x)
    let command, path
    if (req.method === 'GET') {
      const query = new URL(req.url, 'http://host.invalid').searchParams
      const id = query.get('id'); const request = query.get('request_id')
      if (!valid(id) || (request !== null && !valid(request))) return send(400, { code: 'ACCEPTANCE_INVALID', error: 'Team and request identity required' })
      path = `/api/v1/messaging/teams/${encodeURIComponent(id)}/` + (request === null ? 'configuration-acceptance' : `configuration-acceptance-requests/${encodeURIComponent(request)}`)
    } else {
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { code: 'JSON_REQUIRED', error: 'JSON required' })
      try {
        let bytes = 0; const chunks = []
        for await (const part of req) { const chunk = Buffer.from(part); bytes += chunk.length; if (bytes > 131072) return send(413, { code: 'ACCEPTANCE_INVALID', error: 'Acceptance too large' }); chunks.push(chunk) }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!input || Object.keys(input).some(k => !['id', 'request_id', 'expected_revision', 'parent_accepted_revision', 'spec'].includes(k)) || !valid(input.id) || !valid(input.request_id)
          || !Number.isSafeInteger(input.expected_revision) || !Number.isSafeInteger(input.parent_accepted_revision) || input.parent_accepted_revision < 1 || input.parent_accepted_revision >= input.expected_revision || !input.spec || typeof input.spec !== 'object' || Array.isArray(input.spec)) return send(400, { code: 'ACCEPTANCE_INVALID', error: 'Exact configuration review required' })
        const { id, ...body } = input; command = body
        path = `/api/v1/messaging/teams/${encodeURIComponent(id)}/configuration-acceptance`
      } catch { return send(400, { code: 'ACCEPTANCE_INVALID', error: 'Invalid acceptance' }) }
    }
    try { return send(200, await config.backendClient.call(path, command)) }
    catch { return send(409, { code: 'CONFIGURATION_ACCEPTANCE_UNCONFIRMED', error: 'Configuration acceptance unconfirmed; retry the same command or reload after resolving the conflict', retry: 'same_request' }) }
  } })
}

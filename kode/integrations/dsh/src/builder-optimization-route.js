/** Explicit owner confirmation creates a design draft, never starts or activates anything. */
export function registerBuilderOptimization(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/builder/optimization-draft', handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admission = ctx.connection.admit(req)
    if ('rejection' in admission) return send(admission.rejection, { error: 'authentication required' })
    if (admission.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'POST') return send(405, { error: 'POST required' })
    if (!config?.backendClient) return send(503, { error: 'Builder backend unavailable' })
    if (!(req.headers?.['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON required' })
    if ([...new URL(req.url, 'http://localhost').searchParams].length) return send(400, { error: 'Query parameters are not accepted' })
    let input
    try {
      let bytes = 0; const chunks = []
      for await (const part of req) { const chunk = Buffer.from(part); bytes += chunk.length; if (bytes > 16384) return send(413, { error: 'Request too large' }); chunks.push(chunk) }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch { return send(400, { error: 'Invalid JSON' }) }
    const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
    if (!input || Array.isArray(input) || Object.keys(input).some(key => !['team_id', 'team_revision', 'draft_id', 'request_id', 'purpose'].includes(key))
      || !['team_id', 'draft_id', 'request_id'].every(key => valid(input[key])) || !Number.isSafeInteger(input.team_revision) || input.team_revision < 1
      || typeof input.purpose !== 'string' || !input.purpose.trim() || Buffer.byteLength(input.purpose) > 8192 || input.purpose.includes('\0')) return send(400, { error: 'Invalid optimization draft confirmation' })
    const { team_id, ...command } = input
    try { return send(200, await config.backendClient.call(`/api/v1/messaging/teams/${encodeURIComponent(team_id)}/builder-drafts`, command)) }
    catch { return send(409, { error: 'Creation was not confirmed. Retry only the exact request; if the Team changed, review its current revision and confirm a new draft.', retry: 'same_request' }) }
  } })
}

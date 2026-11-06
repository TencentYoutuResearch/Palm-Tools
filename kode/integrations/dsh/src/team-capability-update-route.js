/** Owner-only atomic capability draft updates and durable receipt lookup. */
export function registerTeamCapabilityUpdate(ctx, config) {
  const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
  const revision = value => Number.isSafeInteger(value) && value > 0
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/teams/capability-update', handler: async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (!config?.backendClient) return send(503, { error: 'Team backend unavailable' })
    let path, command
    try {
      const query = new URL(req.url, 'http://localhost').searchParams
      if (req.method === 'GET') {
        const team = query.get('team_id'), request = query.get('request_id')
        if ([...query.keys()].length !== 2 || !valid(team) || !valid(request)) return send(400, { error: 'Exact capability receipt identity required' })
        path = `/api/v1/messaging/teams/${encodeURIComponent(team)}/capability-update-requests/${encodeURIComponent(request)}`
      } else if (req.method === 'POST') {
        if ([...query.keys()].length) return send(400, { error: 'Query not permitted' })
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON required' })
        let bytes = 0; const chunks = []
        for await (const part of req) { const chunk = Buffer.from(part); bytes += chunk.length; if (bytes > 131072) return send(413, { error: 'Capability update too large' }); chunks.push(chunk) }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8')); command = input?.command
        if (!input || Object.keys(input).some(key => !['team_id', 'command'].includes(key)) || !valid(input.team_id)
          || !command || Array.isArray(command) || Object.keys(command).sort().join(',') !== 'assessments,capability_revision,replace_pins,request_id,scheduling_revision,target_id,team_revision'
          || !valid(command.request_id) || !valid(command.target_id) || !['team_revision', 'scheduling_revision', 'capability_revision'].every(key => revision(command[key]))
          || typeof command.replace_pins !== 'boolean' || !command.assessments || typeof command.assessments !== 'object' || Array.isArray(command.assessments)) return send(400, { error: 'Explicit capability update required' })
        path = `/api/v1/messaging/teams/${encodeURIComponent(input.team_id)}/capability-update`
      } else return send(405, { error: 'GET or POST required' })
    } catch { return send(400, { error: 'Invalid capability update' }) }
    try { return send(200, await config.backendClient.call(path, command)) }
    catch { return send(req.method === 'POST' ? 409 : 503, { error: 'Capability update not confirmed', retry: 'same_request' }) }
  } })
}

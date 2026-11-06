/** Fixed owner scheduling review/confirmation bridge. Never scans provider settings. */
export function registerTeamScheduling(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/teams/scheduling', handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (!['GET', 'POST'].includes(req.method)) return send(405, { error: 'GET or POST required' })
    if (!config?.backendClient) return send(503, { error: 'Team backend unavailable' })
    const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
    let path, command
    try {
      if (req.method === 'GET') {
        const query = new URL(req.url, 'http://localhost').searchParams, id = query.get('team_id'), request = query.get('request_id'), revision = query.get('team_revision')
        if (!valid(id) || [...query.keys()].length !== 2 || (request === null ? !/^[1-9]\d*$/.test(revision ?? '') || !Number.isSafeInteger(Number(revision)) : !valid(request))) return send(400, { error: 'Exact scheduling query required' })
        path = `/api/v1/messaging/teams/${encodeURIComponent(id)}/${request === null ? 'scheduling-options/' + revision : 'scheduling-requests/' + encodeURIComponent(request)}`
      } else {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON required' })
        let bytes = 0; const chunks = []
        for await (const part of req) { const chunk = Buffer.from(part); bytes += chunk.length; if (bytes > 131072) return send(413, { error: 'Scheduling command too large' }); chunks.push(chunk) }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        command = input?.command
        if (!valid(input?.team_id) || Object.keys(input).some(key => !['team_id', 'command'].includes(key)) || !command || Object.keys(command).some(key => !['request_id', 'team_revision', 'policy', 'internal_prices', 'account_capacities'].includes(key))
          || !valid(command.request_id) || !Number.isSafeInteger(command.team_revision) || command.team_revision < 1 || command.policy?.team_id !== input.team_id || command.policy?.policy?.kind !== 'scheduling') return send(400, { error: 'Explicit scheduling confirmation required' })
        path = `/api/v1/messaging/teams/${encodeURIComponent(input.team_id)}/scheduling`
      }
    } catch { return send(400, { error: 'Invalid scheduling command' }) }
    try { return send(200, await config.backendClient.call(path, command)) }
    catch { return send(req.method === 'GET' ? 503 : 409, { error: 'Scheduling result unavailable', ...(req.method === 'POST' ? { retry: 'same_request' } : {}) }) }
  } })
}

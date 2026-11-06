/** Owner-only Home trace bridge; no archive paths or execution actions are accepted. */
export function registerWorkRunTrace(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/work-run/trace', handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'GET') return send(405, { error: 'GET required' })
    const input = new URL(req.url, 'http://localhost').searchParams
    const keys = ['run_id', 'team_id', 'view', 'after', 'through', 'run_revision', 'q', 'limit']
    const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
    const views = ['manifest', 'work_events', 'assignments', 'operations', 'operation_events', 'model_calls', 'model_events', 'messages', 'communication_events', 'conversation', 'archives', 'verification_archives', 'team_history']
    if ([...input.keys()].some(key => !keys.includes(key) || input.getAll(key).length !== 1) || !valid(input.get('run_id')) || !valid(input.get('team_id')) || !views.includes(input.get('view'))
        || ['after', 'through', 'run_revision', 'limit'].some(key => input.has(key) && (!/^\d+$/.test(input.get(key)) || !Number.isSafeInteger(Number(input.get(key)))))
        || input.has('run_revision') && Number(input.get('run_revision')) < 1 || input.has('limit') && (Number(input.get('limit')) < 1 || Number(input.get('limit')) > 50)
        || Buffer.byteLength(input.get('q') ?? '', 'utf8') > 160 || input.get('q')?.includes('\0')) return send(400, { error: 'Invalid trace scope or cursor' })
    if (!config?.backendClient) return send(503, { error: 'Home trace unavailable' })
    try {
      const home = ctx.get?.('kodeAgents')?.officialExecution?.host ?? config.quotaHost
      if (!valid(home)) return send(503, { error: 'Trace Home unavailable' })
      const query = new URLSearchParams([...input].filter(([key]) => !['run_id', 'team_id'].includes(key)))
      const result = await config.backendClient.call(`/api/v1/messaging/work-runs/${encodeURIComponent(input.get('run_id'))}/trace?${query}`)
      if (result.schema_version !== 1 || result.read_only !== true || result.home_hub !== home || result.run_id !== input.get('run_id') || result.team_id !== input.get('team_id') || result.view !== input.get('view')
          || input.has('run_revision') && result.run_revision !== Number(input.get('run_revision'))) return send(409, { error: 'Trace identity changed' })
      return send(200, result)
    } catch { return send(409, { error: 'Trace unavailable or task changed; refresh the task before reading again' }) }
  } })
}

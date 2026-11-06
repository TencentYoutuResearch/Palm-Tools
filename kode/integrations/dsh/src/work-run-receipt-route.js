/** Read one atomic Home snapshot of command receipt + current run revision. */
export function registerWorkRunReceipt(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/work-run/receipt', handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'GET') return send(405, { error: 'GET required' })
    const query = new URL(req.url, 'http://localhost').searchParams, keys = ['run_id', 'team_id', 'request_id']
    const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
    if ([...query.keys()].length !== keys.length || keys.some(key => query.getAll(key).length !== 1 || !valid(query.get(key)))) return send(400, { error: 'Exact run/team/request required' })
    if (!config?.backendClient) return send(503, { error: 'WorkRun backend unavailable' })
    try {
      const home = ctx.get?.('kodeAgents')?.officialExecution?.host ?? config.quotaHost
      if (!valid(home)) return send(503, { error: 'Execution Home unavailable' })
      const [run, team, request] = keys.map(key => query.get(key))
      const result = await config.backendClient.call(`/api/v1/messaging/work-runs/${encodeURIComponent(run)}/commands/${encodeURIComponent(request)}`)
      if (result.snapshot !== 'work_run_command_receipt.v1' || result.home_hub !== home || result.run_id !== run || result.team_id !== team || result.request_id !== request
          || !Number.isSafeInteger(result.run_revision) || result.run_revision < 1 || typeof result.run_state !== 'string'
          || !Object.hasOwn(result, 'receipt') || result.receipt !== null && (!result.receipt?.request || !result.receipt?.result)) return send(409, { error: 'WorkRun receipt scope changed' })
      return send(200, result)
    } catch { return send(503, { error: 'WorkRun receipt unavailable; request remains unconfirmed' }) }
  } })
}

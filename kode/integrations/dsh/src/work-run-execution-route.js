import { workRunExecutionStatus } from './work-run-execution-status.js'
import { readWorkRunAccounting } from './work-run-accounting-status.js'
/** Owner-only bounded observation; never relabels the Home's authoritative run. */
export function registerWorkRunExecution(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/work-run/execution', handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'GET') return send(405, { error: 'GET required' })
    const query = new URL(req.url, 'http://localhost').searchParams
    const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
    const id = query.get('run_id'), team = query.get('team_id')
    if ([...query.keys()].length !== 2 || query.getAll('run_id').length !== 1 || query.getAll('team_id').length !== 1 || !valid(id) || !valid(team)) return send(400, { error: 'Exact run and team required' })
    if (!config?.backendClient) return send(503, { error: 'WorkRun backend unavailable' })
    try {
      const agents = ctx.get('kodeAgents'), home = agents?.officialExecution?.host ?? config.quotaHost
      if (!valid(home)) return send(503, { error: 'Execution Home unavailable' })
      const run = await config.backendClient.call(`/api/v1/messaging/work-runs/${encodeURIComponent(id)}`)
      if (run.id !== id || run.team_id !== team || run.home_hub !== home) return send(409, { error: 'WorkRun execution scope changed' })
      const accounting = await readWorkRunAccounting({host:home,client:config.backendClient},run)
      const observation = workRunExecutionStatus(agents?.workRuns, run, home)
      return send(200, { ...observation, ...(accounting.blocked && !['completed','failed','cancelled'].includes(run.state)
        ? {state:'waiting_accounting',blocked:true,reason:accounting.reason,retry_allowed:false} : {}), accounting })
    } catch { return send(503, { error: 'Execution observation unavailable; Home run status is unchanged' }) }
  } })
}

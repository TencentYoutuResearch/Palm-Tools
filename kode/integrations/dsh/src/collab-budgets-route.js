/** Current policy-linked budget facts; no provider-balance inference or automatic mutation. */
export function registerCollabBudgets(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/collab/budgets', handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'GET') return send(405, { error: 'GET required' })
    const query = new URL(req.url, 'http://localhost').searchParams, id = query.get('team_id')
    if ([...query.keys()].length !== 1 || !/^[A-Za-z0-9_.:-]{1,160}$/.test(id ?? '')) return send(400, { error: 'Invalid team budget query' })
    if (!config?.backendClient) return send(503, { error: 'Budget unavailable' })
    try {
      const call = path => config.backendClient.call('/api/v1/messaging/' + path)
      const team = await call(`teams/${encodeURIComponent(id)}`)
      const result = { team_id: id, team_revision: team.revision, home_hub: team.home_hub, label: '团队预算', budgets: [] }
      if (!team.spec.budget_policy_id) return send(200, { ...result, status: 'policy_missing' })
      let policy
      try { policy = await call(`team-policies/${encodeURIComponent(team.spec.budget_policy_id)}`) }
      catch (error) { if (error?.status === 404) return send(200, { ...result, status: 'policy_missing' }); throw error }
      if (policy.team_id !== id || policy.policy?.kind !== 'budget' || !Array.isArray(policy.policy.budget_ids) || policy.policy.budget_ids.length > 64) throw Error('Invalid budget policy')
      const budgets = await Promise.all(policy.policy.budget_ids.map(budget => call(`budgets/${encodeURIComponent(budget)}`)))
      if (budgets.some(row => !row.budget || (row.budget.scope !== 'shared' && (row.budget.scope !== 'team' || row.budget.scope_id !== id)))) throw Error('Budget scope mismatch')
      return send(200, { ...result, status: 'configured', policy_id: policy.id, policy_revision: policy.revision, budgets })
    } catch { return send(503, { error: 'Budget unavailable' }) }
  } })
}

/** Registered workspace discovery. Remote failure stays explicit; no directory is invented. */
export function registerBuilderWorkspaceDirectory(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/builder/workspace-directory', handler: async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'GET') return send(405, { error: 'GET required' })
    if (!config?.backendClient) return send(503, { error: 'Workspace directory unavailable' })
    const query = new URL(req.url, 'http://localhost').searchParams
    if ([...query.keys()].some(key => key !== 'node_id') || query.getAll('node_id').length > 1 || (query.has('node_id') && !/^[A-Za-z0-9_.:-]{1,160}$/.test(query.get('node_id')))) return send(400, { error: 'Invalid workspace query' })
    try {
      const catalog = await config.backendClient.call('/api/v1/messaging/workbench/workspaces/hosts')
      const hosts = [{ node_id: catalog.local_node_id, name: '此计算机' }, ...catalog.hosts.filter(row => row.node_id !== catalog.local_node_id).map(row => ({ node_id: row.node_id, name: row.node_id }))]
      if (!query.has('node_id')) return send(200, { home_hub: catalog.local_node_id, hosts })
      const node = query.get('node_id')
      if (!hosts.some(row => row.node_id === node)) return send(404, { error: 'Workspace host unavailable' })
      const page = await config.backendClient.call(`/api/v1/messaging/workbench/workspaces?node_id=${encodeURIComponent(node)}`)
      return send(200, { home_hub: catalog.local_node_id, node_id: node, workspaces: page.workspaces.map(row => ({ host_id: node, workspace_id: row.id, root_ref: row.path, name: row.title })) })
    } catch { return send(503, { error: 'Workspace directory unavailable' }) }
  } })
}

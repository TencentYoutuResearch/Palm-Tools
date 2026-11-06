/** Owner workspace intent only; grants and actual execution remain separate. */
export function registerBuilderWorkspaces(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/builder/workspaces', handler: async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'POST') return send(405, { error: 'POST required' })
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON required' })
    if (!config?.backendClient) return send(503, { error: 'Builder unavailable' })
    let input
    try {
      let bytes = 0; const chunks = []
      for await (const part of req) { const chunk = Buffer.from(part); bytes += chunk.length; if (bytes > 131072) return send(413, { error: 'Workspace selection too large' }); chunks.push(chunk) }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch { return send(400, { error: 'Invalid JSON' }) }
    const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
    if (!input || Object.keys(input).some(key => !['draft_id', 'request_id', 'expected_revision', 'workspace_refs'].includes(key))
      || !valid(input.draft_id) || !valid(input.request_id) || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1
      || !Array.isArray(input.workspace_refs) || input.workspace_refs.length > 64
      || input.workspace_refs.some(row => !row || Object.keys(row).some(key => !['host_id', 'workspace_id', 'root_ref'].includes(key)) || !valid(row.host_id) || !valid(row.workspace_id)
        || typeof row.root_ref !== 'string' || !row.root_ref.trim() || row.root_ref.includes('\0') || Buffer.byteLength(row.root_ref) > 1024)) return send(400, { error: 'Invalid workspaces' })
    try { const { draft_id, ...command } = input; return send(200, await config.backendClient.call(`/api/v1/messaging/superagents/drafts/${encodeURIComponent(draft_id)}/workspaces`, command)) }
    catch { return send(409, { error: 'Workspace selection not confirmed; retry the exact request', retry: 'same_request' }) }
  } })
}

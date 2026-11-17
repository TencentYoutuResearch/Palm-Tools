/** Called only after the owner bridge authenticates the request. */
export async function handleContactDirectory(req, res, client) {
  const query = new URL(req.url, 'http://localhost').searchParams
  const view = query.get('view')
  if (view === null) return false
  const send = (status, value) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
    return true
  }
  const keys = [...query.keys()]
  if (new Set(keys).size !== keys.length) return send(400, { error: 'Duplicate contact query' })
  const identity = value => typeof value === 'string' && value.length >= 1 && value.length <= 160 && !/[^A-Za-z0-9_.:-]/.test(value)
  try {
    if (view === 'contacts') {
      if (req.method !== 'GET') return send(405, { error: 'GET required' })
      if (keys.some(key => !['view', 'after', 'limit', 'q', 'archived', 'workspace_host', 'workspace_id', 'workspace_root'].includes(key))) return send(400, { error: 'Invalid contact directory query' })
      const scopeKeys = ['workspace_host', 'workspace_id', 'workspace_root']
      const scoped = scopeKeys.some(key => query.has(key))
      if (scoped && (!scopeKeys.every(key => query.has(key)) || !identity(query.get('workspace_host'))
        || !identity(query.get('workspace_id')) || !query.get('workspace_root').trim()
        || Buffer.byteLength(query.get('workspace_root')) > 1024 || query.get('workspace_root').includes('\0'))) {
        return send(400, { error: 'Invalid contact workspace scope' })
      }
      const after = query.get('after') ?? ''
      const limit = query.get('limit') ?? '25'
      const search = query.get('q') ?? ''
      const archived = query.get('archived') ?? 'false'
      if (!new RegExp(`^[A-Za-z0-9_-]{0,${scoped ? 16384 : 2048}}$`).test(after) || !/^[1-9]\d?$/.test(limit) || Number(limit) > 50
        || Buffer.byteLength(search) > 160 || search.includes('\0') || !['false', 'true'].includes(archived)) {
        return send(400, { error: 'Invalid contact directory page' })
      }
      const params = new URLSearchParams({ after, limit, q: search, archived })
      if (scoped) for (const key of scopeKeys) params.set(key, query.get(key))
      return send(200, await client.call(`/api/v1/messaging/contact-directory?${params}`))
    }
    if (view !== 'contact-preference' || keys.some(key => !['view', 'team_id', 'request_id'].includes(key)) || !identity(query.get('team_id'))) {
      return send(400, { error: 'Invalid contact preference query' })
    }
    const path = `/api/v1/messaging/teams/${encodeURIComponent(query.get('team_id'))}`
    const requestId = query.get('request_id')
    if (req.method === 'GET') {
      if (requestId !== null && !identity(requestId)) return send(400, { error: 'Invalid contact request identity' })
      return send(200, await client.call(requestId === null ? `${path}/contact-preference` : `${path}/contact-preference-requests/${encodeURIComponent(requestId)}`))
    }
    if (req.method !== 'POST') return send(405, { error: 'GET or POST required' })
    if (requestId !== null) return send(400, { error: 'Unexpected contact request query' })
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON required' })
    const chunks = []
    let bytes = 0
    for await (const part of req) {
      const chunk = Buffer.from(part)
      bytes += chunk.length
      if (bytes > 4096) return send(413, { error: 'Contact preference request too large' })
      chunks.push(chunk)
    }
    let command
    try { command = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(400, { error: 'Invalid JSON' }) }
    if (!command || Array.isArray(command) || Object.keys(command).sort().join(',') !== 'action,expected_revision,request_id'
      || !identity(command.request_id) || !Number.isSafeInteger(command.expected_revision) || command.expected_revision < 0
      || !['pin', 'unpin', 'archive', 'unarchive'].includes(command.action)) return send(400, { error: 'Invalid contact preference command' })
    return send(200, await client.call(`${path}/contact-preference`, command))
  } catch {
    return send(409, { error: 'Contact result unavailable. Recover the original request or refresh the directory.' })
  }
}

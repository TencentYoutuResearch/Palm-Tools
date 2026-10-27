/** Read-only, owner-authenticated name directory; backend credentials stay on the Host. */
export function registerMessagingApi(ctx, client, nodeId) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/sessions', handler: async (req, res) => {
    const json = (status, value) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(value)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return json(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return json(403, { error: 'Host owner required' })
    if (req.method !== 'GET') return json(405, { error: 'GET required' })
    try {
      const directory = await client.call('/api/v1/messaging/sessions')
      json(200, { nodeId, sessions: directory.sessions.map(({ address, title, online }) => ({ address, title, online })) })
    } catch { json(502, { error: '暂时无法读取会话名称' }) }
  } })
}

/** Backfill display names for previously registered, inactive sessions without resuming them. */
export async function syncSessionTitles(controller, client, ownedIds, signal) {
  if (!controller.list) return
  const { items } = await controller.list({}, signal)
  for (const session of items) {
    signal?.throwIfAborted()
    const title = session.projections?.values?.title
    if (!ownedIds.has(session.sessionId) || typeof title !== 'string' || !title.trim()) continue
    await client.call(`/api/v1/messaging/sessions/${encodeURIComponent(session.sessionId)}/title`, { title }, signal)
  }
}

/** Explicit human answers only; no model continuation, acceptance or activation. */
export function registerBuilderAnswers(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/builder/answers', handler: async (req, res) => {
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
      for await (const part of req) { const chunk = Buffer.from(part); bytes += chunk.length; if (bytes > 32768) return send(413, { error: 'Answers too large' }); chunks.push(chunk) }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch { return send(400, { error: 'Invalid JSON' }) }
    const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
    if (!input || Object.keys(input).some(key => !['draft_id', 'request_id', 'expected_revision', 'answers'].includes(key))
      || !valid(input.draft_id) || !valid(input.request_id) || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1
      || !input.answers || Array.isArray(input.answers) || typeof input.answers !== 'object'
      || Object.keys(input.answers).length < 1 || Object.keys(input.answers).length > 3
      || Object.entries(input.answers).some(([key, value]) => !valid(key) || typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > 8192)) return send(400, { error: 'Invalid answers' })
    try { const { draft_id, ...command } = input; return send(200, await config.backendClient.call(`/api/v1/messaging/superagents/drafts/${encodeURIComponent(draft_id)}/answers`, command)) }
    catch { return send(409, { error: 'Answers not confirmed; retry the exact request', retry: 'same_request' }) }
  } })
}

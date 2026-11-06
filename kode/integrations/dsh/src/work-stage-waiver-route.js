/** Exact owner decision only; the Hub revalidates policy, revision and evidence. */
export function registerWorkStageWaiver(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/work-run/waiver', handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (!['GET', 'POST'].includes(req.method)) return send(405, { error: 'GET or POST required' })
    if (!config?.backendClient) return send(503, { error: 'WorkRun backend unavailable' })
    const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
    try {
      if (req.method === 'GET') {
        const query = new URL(req.url, 'http://localhost').searchParams
        const run = query.get('run_id'), stage = query.get('stage_id'), receipt = query.get('request_id')
        if (!valid(run) || !valid(stage) || receipt !== null && !valid(receipt)
          || [...query.keys()].some(key => !['run_id', 'stage_id', 'request_id'].includes(key) || query.getAll(key).length !== 1)) return send(400, { error: 'Invalid waiver query' })
        const path = `/api/v1/messaging/work-runs/${encodeURIComponent(run)}/stages/${encodeURIComponent(stage)}`
        return send(200, await config.backendClient.call(path + (receipt === null ? '/waiver-plan' : `/waiver-requests/${encodeURIComponent(receipt)}`)))
      }
      if (new URL(req.url, 'http://localhost').search) return send(400, { error: 'Unexpected decision query' })
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON required' })
      let bytes = 0; const chunks = []
      for await (const part of req) { const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part); bytes += chunk.length; if (bytes > 16384) return send(413, { error: 'Decision too large' }); chunks.push(chunk) }
      let input
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(400, { error: 'Invalid JSON' }) }
      if (!input || Array.isArray(input) || Object.keys(input).some(key => !['run_id', 'stage_id', 'request_id', 'expected_revision', 'scope_hash', 'reason'].includes(key))
        || !valid(input.run_id) || !valid(input.stage_id) || !valid(input.request_id) || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1
        || typeof input.scope_hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.scope_hash)
        || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.includes('\0') || Buffer.byteLength(input.reason) > 2048) return send(400, { error: 'Invalid stage waiver decision' })
      const { run_id, stage_id, ...decision } = input
      return send(200, await config.backendClient.call(`/api/v1/messaging/work-runs/${encodeURIComponent(run_id)}/stages/${encodeURIComponent(stage_id)}/waiver`, decision))
    } catch {
      return send(409, { error: 'Decision was not confirmed; retry the exact decision to recover its receipt', retry: 'same_request' })
    }
  } })
}

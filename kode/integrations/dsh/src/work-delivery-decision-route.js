/** Exact owner decision only; the Hub revalidates policy, revision and evidence. */
export function registerWorkDeliveryDecision(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/work-run/decision', handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'POST') return send(405, { error: 'POST required' })
    if (!config?.backendClient) return send(503, { error: 'WorkRun backend unavailable' })
    try {
      if (new URL(req.url, 'http://localhost').search) return send(400, { error: 'Unexpected decision query' })
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON required' })
      let bytes = 0; const chunks = []
      for await (const part of req) { const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part); bytes += chunk.length; if (bytes > 16384) return send(413, { error: 'Decision too large' }); chunks.push(chunk) }
      let input
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(400, { error: 'Invalid JSON' }) }
      const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
      if (!input || Array.isArray(input) || Object.keys(input).some(key => !['run_id', 'request_id', 'expected_revision', 'evidence_hash', 'choice', 'reason'].includes(key))
        || !valid(input.run_id) || !valid(input.request_id) || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1
        || typeof input.evidence_hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.evidence_hash) || !['accept', 'reject'].includes(input.choice)
        || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.includes('\0') || Buffer.byteLength(input.reason) > 2048) return send(400, { error: 'Invalid delivery decision' })
      const { run_id, ...decision } = input
      return send(200, await config.backendClient.call(`/api/v1/messaging/work-runs/${encodeURIComponent(run_id)}/delivery-decision`, decision))
    } catch {
      return send(409, { error: 'Decision was not confirmed; retry the exact decision to recover its receipt', retry: 'same_request' })
    }
  } })
}

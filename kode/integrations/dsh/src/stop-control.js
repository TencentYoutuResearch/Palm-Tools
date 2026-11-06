/** Owner-only reconciliation. Attestation releases a fence; it never proves task success. */
import { createHash } from 'node:crypto'
export function stopFenceId(binding) {
  if (!binding?.stopBlocked) return null
  return binding.stopFenceId ?? `legacy-${createHash('sha256').update(JSON.stringify(binding.stopEvidence ?? null)).digest('hex')}`
}
export function registerStopControl(ctx) {
  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/session-stop-control', handler: async (req, res) => {
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return json(res, 403, { error: 'Host owner required' })
    if (req.method !== 'POST' || !(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 405, { error: 'JSON POST required' })
    try {
      let text = ''
      for await (const part of req) { text += part; if (Buffer.byteLength(text) > 8192) throw new Error('Request too large') }
      const input = JSON.parse(text)
      if (!input || typeof input.session_id !== 'string' || !input.session_id || input.session_id.length > 160) throw new Error('Session ID required')
      const adapter = ctx.get('kodeAgents')?.adapter
      if (!adapter) throw new Error('Native runtime unavailable')
      if (input.action === 'status') return json(res, 200, adapter.stopStatus(input.session_id))
      if (input.action !== 'reconcile') throw new Error('Unknown stop control action')
      json(res, 200, await adapter.reconcileStop(input))
    } catch (error) { json(res, 400, { error: error.message }) }
  } })
}

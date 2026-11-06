/** Host-level creation contract. Capability probes never create or start sessions. */
export const CREATION_CAPABILITIES_PATH = '/api/kode/session-creation-capabilities'
export const MODEL_SELECTION_FEATURE = 'creation_model_selection_v1'
export function registerCreationCapabilities(ctx) {
  return ctx.webServer.register({ kind: 'exact', path: CREATION_CAPABILITIES_PATH, handler: async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return reply(403, { error: 'Host owner required' })
    if (req.method !== 'GET') return reply(405, { error: 'GET required' })
    if (!ctx.get('kodeSessionCreator')) return reply(503, { error: 'Session creator unavailable' })
    return reply(200, { version: 1, features: [MODEL_SELECTION_FEATURE], selection_verification: 'requested' })
  } })
}
export async function createRemoteSession(url, cookie, input, signal) {
  const bounded = ms => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
  if (input.model !== undefined || input.reasoningEffort !== undefined) {
    const response = await fetch(`${url}${CREATION_CAPABILITIES_PATH}`, { headers: { cookie }, signal: bounded(15000) })
    if (!response.ok) throw new Error('Remote Host cannot verify model selection support; update its Kode plugin before creating this session')
    const capabilities = await response.json()
    if (capabilities.version !== 1 || !Array.isArray(capabilities.features) || !capabilities.features.includes(MODEL_SELECTION_FEATURE)) throw new Error('Remote Host does not support explicit creation model/effort selection')
  }
  const response = await fetch(`${url}/api/kode/session-create`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(input), signal: bounded(60000) })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error ?? 'Remote session creation failed')
  return value
}

/** Shared owner HTTP contract used by the desktop Host and remote portals. */
export function registerSessionCreationRoutes(ctx) {
  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
  const owner = req => { const admitted = ctx.connection.admit(req); return !('rejection' in admitted) && admitted.peer.principal.kind === 'owner' }
  ctx.effect(() => registerCreationCapabilities(ctx), 'kode.creation-capabilities-api')
  for (const [path, method] of [['/api/kode/session-create', 'create'], ['/api/kode/session-creation-status', 'lookup']]) ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler: async (req, res) => {
    if (!owner(req)) return json(res, 403, { error: 'Host owner required' })
    if (req.method !== 'POST' || !(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 405, { error: 'JSON POST required' })
    try {
      let body = ''; for await (const part of req) { body += part; if (Buffer.byteLength(body) > 65536) throw new Error('Request too large') }
      const creator = ctx.get('kodeSessionCreator'); if (!creator) throw new Error('Session creator unavailable')
      json(res, 200, await creator[method](JSON.parse(body)))
    } catch (error) { json(res, 400, { error: error.message }) }
  } }), `kode.session-${method}-api`)
 }
export async function lookupRemoteSessionCreation(url, cookie, input, signal) {
  const response = await fetch(`${url}/api/kode/session-creation-status`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(input), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })
  const value = await response.json(); if (!response.ok) throw new Error(value.error ?? 'Remote creation lookup failed'); return value
}

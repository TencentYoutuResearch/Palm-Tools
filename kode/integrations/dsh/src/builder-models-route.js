/** Public adapter metadata only. Discovery neither generates text nor authorizes execution. */
import { managedBuilderSnapshot } from './builder-profile-metadata.js'
import { officialResourceDirectory } from './official-resource-directory.js'
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
function modelInfo(value, provider) {
  if (!value || value.provider !== provider || !text(value.id) || !text(value.name)) throw Error('Invalid model metadata')
  return { provider, id: value.id, name: value.name }
}
export function registerBuilderModels(ctx, llm, home, service) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/builder/models', handler: async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'GET') return send(405, { error: 'GET required' })
    const query = new URL(req.url, 'http://localhost').searchParams
    const provider = query.get('provider'), model = query.get('model')
    if (!text(provider) || (query.has('model') && !text(model)) || [...query.keys()].some(key => !['provider', 'model', 'profile_id', 'profile_revision'].includes(key) || query.getAll(key).length !== 1)) return send(400, { error: 'Invalid model query' })
    const native = provider.startsWith('kode-workflow-')
    const identity = () => native ? managedBuilderSnapshot(service, llm, provider, query.get('profile_id'), query.get('profile_revision'))
      : !query.has('profile_id') && !query.has('profile_revision') && officialResourceDirectory(llm).items.some(row => row.provider_id === provider && row.registered) ? {} : null
    const before = identity()
    if (!before) return send(404, { error: 'Provider unavailable' })
    const controller = new AbortController()
    let timer
    try {
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('Discovery timed out')) }, 10000) })
      const lookup = async () => {
        if (model === null) {
          const rows = await llm.listModels(provider)
          if (!Array.isArray(rows) || rows.length > 2000) throw Error('Invalid model catalog')
          const items = rows.map(row => modelInfo(row, provider))
          if (new Set(items.map(row => row.id)).size !== items.length) throw Error('Duplicate model identity')
          return { items }
        }
        const value = await llm.resolveModelInfo(provider, model, controller.signal)
        const item = modelInfo(value, provider)
        if (item.id !== model) throw Error('Wrong model')
        let reasoning = null
        if (value.reasoning) {
          const { efforts, defaultEffort } = value.reasoning
          if (!Array.isArray(efforts) || efforts.length > 64 || efforts.some(row => !text(row.id) || !text(row.name)) || new Set(efforts.map(row => row.id)).size !== efforts.length
            || (defaultEffort !== undefined && !efforts.some(row => row.id === defaultEffort))) throw Error('Invalid reasoning metadata')
          reasoning = { efforts: efforts.map(({ id, name }) => ({ id, name })), default_effort: defaultEffort ?? null }
        }
        return { item: { ...item, reasoning } }
      }
      const value = await Promise.race([lookup(), deadline])
      const after = identity()
      if (!after || JSON.stringify(after) !== JSON.stringify(before)) return send(404, { error: 'Provider unavailable' })
      return send(200, { home_hub: home, provider, ...before, ...value, evidence: { source: 'adapter_catalog', live_model_availability: 'not_verified', authentication: 'not_verified', inference: 'not_tested' }, eligible_for_dispatch: false })
    } catch { return send(503, { error: 'Model metadata unavailable' }) }
    finally { clearTimeout(timer); controller.abort() }
  } })
}

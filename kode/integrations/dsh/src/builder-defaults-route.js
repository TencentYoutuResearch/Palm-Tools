import { proposeBuilderDefaults } from './builder-defaults.js'
import { controlledBinding, managedCodexEnabled } from './managed-codex-profile.js'
const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
export function registerBuilderDefaults(ctx, { backendClient, service, llm, home, defaults = {}, timeoutMs = 10000 }) {
 const preferences = () => typeof defaults === 'function' ? defaults() : defaults
 const snapshot = () => ({ defaultProfileId: service.profiles.defaultProfileId, profiles: service.profiles.list()
  .filter(profile => controlledBinding({ profile, managedBuilder: {} }))
  .map(profile => ({ id: profile.id, type: profile.type, protocol: profile.protocol,
   defaultModel: profile.defaultModel, defaultReasoningEffort: profile.defaultReasoningEffort, allowedModels: profile.allowedModels,
   ...(managedCodexEnabled(profile) ? { managedInference: { roles: profile.managedInference.roles } } : {}),
   runtime_available: service.hasRuntime(profile.type) })),
  providers: service.officialResourceDirectory().items.map(({ provider_id, registered }) => ({ provider_id, registered })) })
 return ctx.webServer.register({ kind: 'exact', path: '/api/kode/builder/default-selection', handler: async (req, res) => {
  const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
  const admitted = ctx.connection.admit(req)
  if ('rejection' in admitted) return send(admitted.rejection, { error: 'Authentication required' })
  if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
  if (req.method !== 'GET') return send(405, { error: 'GET required' })
  const query = new URL(req.url, 'http://localhost').searchParams, id = query.get('draft_id'), revision = Number(query.get('revision'))
  if (!valid(id) || !Number.isSafeInteger(revision) || revision < 1 || [...query.keys()].length !== 2 || [...query.keys()].some(key => !['draft_id', 'revision'].includes(key))) return send(400, { error: 'Invalid draft identity' })
  if (!backendClient || !service || !llm || !home) return send(503, { error: 'Builder defaults unavailable' })
  let timer
  const controller = new AbortController()
  try {
   const work = async () => {
    const path = '/api/v1/messaging/superagents/drafts/' + encodeURIComponent(id)
    const draft = await backendClient.call(path)
    if (draft.id !== id || draft.home_hub !== home || draft.status !== 'draft' || draft.revision !== revision) throw Error('Draft changed')
    const before = structuredClone(snapshot()), preference = structuredClone(preferences())
    if (before.profiles.length > 2000 || before.providers.length > 2000) throw Error('Catalog too large')
    const value = await proposeBuilderDefaults({ draft, ...before, configured: preference, listModels: provider => llm.listModels(provider), resolveModelInfo: (provider, model) => llm.resolveModelInfo(provider, model, controller.signal) })
    const current = await backendClient.call(path)
    if (current.id !== id || current.home_hub !== home || current.status !== 'draft' || current.revision !== revision || JSON.stringify(before) !== JSON.stringify(snapshot()) || JSON.stringify(preference) !== JSON.stringify(preferences())) throw Error('Configuration changed')
    return { ...value, home_hub: home, draft_id: id, draft_revision: revision }
   }
   const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('Timeout')) }, timeoutMs) })
   return send(200, await Promise.race([work(), deadline]))
  } catch { return send(409, { error: 'Default selection unavailable or changed', eligible_for_execution: false }) }
  finally { clearTimeout(timer); controller.abort() }
 } })
}

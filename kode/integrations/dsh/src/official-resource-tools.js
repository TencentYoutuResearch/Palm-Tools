/** Scoped read-only resource tools. Owner configuration fixes authority; model input cannot widen it. */
import { resourceCoverage } from './resource-coverage.js'
export const OFFICIAL_RESOURCE_TOOLS = Object.freeze(['kode_resources_coverage', 'kode_resources_rank'])
export function mountOfficialResourceTools(agentCtx, agent, service, client, host, policy) {
  const fixed = structuredClone(policy)
  if (typeof host !== 'string' || !host || !client || !Array.isArray(fixed.profiles) || fixed.profiles.length > 100 || fixed.profiles.some(id => typeof id !== 'string' || !id)
      || !Array.isArray(fixed.ranking?.candidates) || fixed.ranking.candidates.length > 25) throw new Error('Explicit resource tool scope required')
  const permitted = new Set(fixed.profiles)
  if (fixed.ranking.candidates.some(candidate => candidate.resource?.host !== host || !permitted.has(candidate.resource?.profile))) throw new Error('Ranking candidate exceeds resource tool scope')
  const toolView = agentCtx.get('tools')
  const tools = toolView?.forScope ? toolView.forScope(agentCtx) : toolView, policies = agentCtx.get('kodeOfficialToolPolicies')
  if (!tools || !policies) throw new Error('Controlled resource tool services unavailable')
  const filtered = {
    profiles: { list: () => service.profiles.list().filter(profile => permitted.has(profile.id)),
      get bindings() { return Object.fromEntries(Object.entries(service.profiles.bindings).filter(([, binding]) => permitted.has(binding.profile.id)).map(([id, binding]) => [id, { profile: binding.profile }])) } },
    hasRuntime: type => service.hasRuntime(type),
  }
  const definitions = [
    { name: OFFICIAL_RESOURCE_TOOLS[0], description: 'Read authorized local resource coverage. Unknown quota stays unknown; inventory does not authorize dispatch.',
      parameters: { type: 'object', properties: { after: { type: 'string', maxLength: 1024 }, limit: { type: 'integer', minimum: 1, maximum: 25 } }, additionalProperties: false },
      execute: async args => {
        const result = await resourceCoverage(filtered, client, host, { after: args.after ?? '', limit: args.limit ?? 10 })
        return { scope: 'authorized_local_profiles', host, total: result.total, next_cursor: result.next_cursor,
          limitations: result.limitations, eligible_for_dispatch: false,
          items: result.items.map(row => ({ profile_id: row.profile_id, profile_revision: row.profile_revision, name: row.name,
            executor_type: row.executor_type, configured: row.configured, runtime_available: row.runtime_available,
            quota_status: row.quota_status, limits: row.limits, provider_monetary: row.provider_monetary,
            grant_capability: row.grant_capability, budget_status: row.budget_status, eligible_for_dispatch: false })) }
      },
    },
    { name: OFFICIAL_RESOURCE_TOOLS[1], description: 'Recommend among owner-configured resource candidates using fixed quality floors and weights. Does not reserve budget or authorize dispatch.',
      parameters: { type: 'object', properties: { task_tag: { type: 'string', minLength: 1, maxLength: 160 } }, required: ['task_tag'], additionalProperties: false },
      execute: args => client.call('/api/v1/messaging/resources/rank', { ...structuredClone(fixed.ranking), task_tag: args.task_tag }),
    },
  ]
  const disposers = []
  try {
    for (const definition of definitions) {
      disposers.push(tools.register({ ...definition, output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] } }))
      disposers.push(policies.register(definition.name, { capabilities: ['read'], network: false,
        implementation: tools.get(definition.name, agent), authorize: async request => request.agent === agent && request.arguments !== null
          && typeof request.arguments === 'object' && !Array.isArray(request.arguments)
          && Object.keys(request.arguments).every(key => Object.hasOwn(definition.parameters.properties, key)) }, agent))
    }
  } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }
  return () => { for (const dispose of disposers.splice(0).reverse()) dispose() }
}

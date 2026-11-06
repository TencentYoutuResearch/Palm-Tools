import { proposedTargetPrices } from './team-pricing.js'
import { canonical } from './builder-accept-command.js'
export const schedulingKey = team => JSON.stringify(['team-scheduling', team.home_hub, team.id])
export function schedulingCommand(team, options, choices, preferences, requestId, pricing = {}, uuid, capacities = {}) {
  if (options?.team?.id !== team.id || options.team.home_hub !== team.home_hub || options.team.revision !== team.revision || !team.spec.scheduling_policy_id || options.eligible_for_execution !== false || options.options.length !== team.spec.execution_targets.length) throw Error('Wrong options')
  if (['quality', 'cost', 'latency', 'minimum_quality', 'minimum_confidence'].some(key => typeof preferences[key] !== 'string' || !preferences[key].trim()) || typeof preferences.allowUnknown !== 'boolean') throw Error('Explicit preferences required')
  const weights = Object.fromEntries(['quality', 'cost', 'latency'].map(key => [key, Number(preferences[key])]))
  const minimum_quality = Number(preferences.minimum_quality), minimum_confidence = Number(preferences.minimum_confidence)
  if (Object.values(weights).some(n => !Number.isInteger(n) || n < 0 || n > 1000) || !Object.values(weights).some(n => n > 0) || !Number.isInteger(minimum_quality) || minimum_quality < 0 || minimum_quality > 100 || !Number.isFinite(minimum_confidence) || minimum_confidence < 0 || minimum_confidence > 1) throw Error('Invalid preferences')
  const targets = {}, internalPrices = proposedTargetPrices(team, pricing, uuid)
  for (const target of team.spec.execution_targets) {
    const rows = options.options.filter(row => row.target_id === target.id), row = rows[0], binding = row?.binding
    if (rows.length !== 1 || !binding?.binding_current || binding.host !== target.host_id || binding.profile !== target.executor_profile_id || binding.account_id !== target.account_binding_id) throw Error('Account binding mismatch')
    const capability = row.capabilities.find(value => value.id === choices[target.id])
    if (!capability || capability.host !== target.host_id || capability.profile !== target.executor_profile_id || capability.model !== target.model_id || String(capability.revision) !== target.capability_profile_revision) throw Error('Capability unavailable')
    const limit_ids = [...new Set((row.quota?.buckets ?? []).map(bucket => bucket.limit_id))].sort()
    if (!limit_ids.length && !preferences.allowUnknown) throw Error('Quota source missing')
    const previous = options.policy?.policy?.targets?.[target.id]
    targets[target.id] = { resource: { host: target.host_id, profile: target.executor_profile_id, account_id: binding.account_id, account_epoch: binding.account_epoch, binding_revision: binding.revision, limit_ids, unknown_quota: preferences.allowUnknown ? 'team_budget' : 'require_fresh' }, capability_id: capability.id, capability_revision: capability.revision, preferred: previous?.preferred ?? false,
      ...(internalPrices[target.id] ? { internal_price_id: internalPrices[target.id].id } : previous?.internal_price_id ? { internal_price_id: previous.internal_price_id } : {}) }
  }
  const accountCapacities = {}
  for (const [account, entry] of Object.entries(capacities)) {
    const rows = options.options.filter(row => row.binding?.account_id === account)
    if (!rows.length || typeof entry?.enabled !== 'boolean') throw Error('Invalid capacity account')
    if (!entry.enabled) continue
    const snapshot = rows[0].assignment_capacity ?? null
    if (rows.some(row => canonical(row.assignment_capacity ?? null) !== canonical(snapshot))) throw Error('Account capacity changed')
    if (typeof entry.value !== 'string' || !/^[1-9]\d*$/.test(entry.value) || Number(entry.value) > 1024) throw Error('Invalid account capacity')
    accountCapacities[account] = { account_id: account, expected_revision: snapshot?.revision ?? 0, max_active_assignments: Number(entry.value) }
  }
  if (options.policy && (options.policy.id !== team.spec.scheduling_policy_id || options.policy.team_id !== team.id)) throw Error('Foreign policy')
  return { ...(Object.keys(accountCapacities).length ? { account_capacities: accountCapacities } : {}), ...(Object.keys(internalPrices).length ? { internal_prices: internalPrices } : {}), request_id: requestId, team_revision: team.revision, policy: { id: team.spec.scheduling_policy_id, team_id: team.id, expected_revision: options.policy?.revision ?? 0, policy: { kind: 'scheduling', targets, weights, minimum_quality, minimum_confidence } } }
}
export async function confirmScheduling({ storage, team, command, request, signal }) {
  const key = schedulingKey(team)
  const pending = await storage.reserve(key, { state: 'prepared', home_hub: team.home_hub, request_id: command.request_id, command: { team_id: team.id, command } })
  if (signal?.aborted) throw Error('Disposed')
  if (pending.home_hub !== team.home_hub || pending.command?.team_id !== team.id) throw Error('Wrong scheduling scope')
  const result = await request(pending.command, { signal, method: 'POST' }), sent = pending.command.command
  if (result.home_hub !== team.home_hub || result.team_id !== team.id || result.team_revision !== sent.team_revision || result.request_id !== sent.request_id || result.activation_performed !== false || result.eligible_for_execution !== false
    || result.policy?.id !== sent.policy.id || result.policy.team_id !== team.id || result.policy.revision !== sent.policy.expected_revision + 1 || canonical(result.policy.policy) !== canonical(sent.policy.policy)) throw Error('Invalid scheduling receipt')
  if (sent.internal_prices && (result.internal_prices?.label !== '内部计价' || result.internal_prices.provider_invoice !== false || canonical(result.internal_prices.prices) !== canonical(sent.internal_prices))) throw Error('Invalid internal price receipt')
  if (sent.account_capacities) {
    const returned = result.account_capacities
    if (returned?.scope !== 'account_shared_across_teams' || canonical(Object.keys(returned.capacities ?? {}).sort()) !== canonical(Object.keys(sent.account_capacities).sort())) throw Error('Invalid capacity receipt')
    for (const [account, value] of Object.entries(sent.account_capacities)) {
      const actual = returned.capacities[account]
      if (actual?.account_id !== account || actual.revision !== value.expected_revision + 1 || actual.max_active_assignments !== value.max_active_assignments || !Number.isSafeInteger(actual.held) || actual.held < 0 || actual.held > actual.max_active_assignments) throw Error('Invalid capacity receipt')
    }
  }
  await storage.save(key, { ...pending, state: 'accepted', receipt: result })
  return result
}
export async function requestScheduling(input, { signal, method = 'GET' } = {}) {
  const response = await fetch('/api/kode/teams/scheduling' + (method === 'GET' ? '?' + new URLSearchParams(input) : ''), { method, credentials: 'same-origin', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : {}) })
  if (!response.ok) throw Error('Scheduling unavailable')
  return response.json()
}

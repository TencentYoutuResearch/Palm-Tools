/** Reviewed capability updates with durable exact-command recovery. */
import { canonical } from './builder-accept-command.js'
const equal = (a, b) => canonical(a) === canonical(b)
const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
const revision = value => Number.isSafeInteger(value) && value > 0
export const capabilityUpdateKey = record => JSON.stringify(['team-capability-update', record.home_hub, record.team_id, record.target_id])
export function prepareCapabilityUpdate({ team, policy, profile, targetId, assessments, replacePins, requestId }) {
  const target = team?.spec?.execution_targets?.find(row => row.id === targetId), selected = policy?.policy?.targets?.[targetId]
  if (![team?.id, team?.home_hub, targetId, requestId].every(valid) || !target || !selected || typeof replacePins !== 'boolean'
    || ![team.revision, policy.revision, profile?.revision].every(revision) || policy.team_id !== team.id || policy.home_hub !== team.home_hub
    || policy.id !== team.spec.scheduling_policy_id || policy.policy.kind !== 'scheduling' || selected.capability_id !== profile.id
    || selected.capability_revision !== profile.revision || target.capability_profile_revision !== String(profile.revision)
    || selected.resource?.host !== target.host_id || selected.resource?.profile !== target.executor_profile_id || selected.resource?.account_id !== target.account_binding_id
    || profile.host !== target.host_id || profile.profile !== target.executor_profile_id || profile.model !== target.model_id
    || !assessments || Array.isArray(assessments) || typeof assessments !== 'object') throw Error('Capability review context changed')
  for (const [id, prior] of Object.entries(profile.assessments)) if (prior.pinned && !equal(prior, assessments[id]) && !replacePins) throw Error('Explicit fixed-preference replacement required')
  for (const [id, fact] of Object.entries(assessments)) if (!equal(profile.assessments[id], fact) && fact?.source !== 'user') throw Error('User provenance required')
  return structuredClone({ home_hub: team.home_hub, team_id: team.id, target_id: targetId, request_id: requestId, state: 'prepared',
    command: { request_id: requestId, team_revision: team.revision, target_id: targetId, scheduling_revision: policy.revision, capability_revision: profile.revision, assessments, replace_pins: replacePins },
    before: { team, policy, profile } })
}
export function verifyCapabilityUpdate(record, result) {
  const { team, policy, profile } = record.before, sent = record.command
  const spec = structuredClone(team.spec), scheduling = structuredClone(policy.policy)
  spec.execution_targets.find(row => row.id === sent.target_id).capability_profile_revision = String(sent.capability_revision + 1)
  scheduling.targets[sent.target_id].capability_revision = sent.capability_revision + 1
  const next = result?.team, updated = result?.capability_profile, scheduled = result?.scheduling_policy
  if (!result || result.home_hub !== record.home_hub || result.team_id !== team.id || result.request_id !== sent.request_id || result.target_id !== sent.target_id
    || result.activation_performed !== false || result.eligible_for_execution !== false
    || next?.id !== team.id || next.home_hub !== team.home_hub || next.revision !== sent.team_revision + 1 || next.superagent_id !== team.superagent_id || next.conversation_id !== team.conversation_id
    || next.eligible_for_execution !== false || !equal(next.spec, spec)
    || updated?.id !== profile.id || updated.revision !== sent.capability_revision + 1 || ['host', 'profile', 'model'].some(key => updated[key] !== profile[key]) || !equal(updated.assessments, sent.assessments)
    || scheduled?.id !== policy.id || scheduled.team_id !== team.id || scheduled.home_hub !== team.home_hub || scheduled.revision !== sent.scheduling_revision + 1 || !equal(scheduled.policy, scheduling)) throw Error('Capability update receipt mismatch')
  return result
}
export async function confirmCapabilityUpdate({ storage, prepared, request, signal }) {
  const key = capabilityUpdateKey(prepared), record = await storage.reserve(key, prepared)
  if (signal?.aborted) throw Error('Disposed')
  if (record.home_hub !== prepared.home_hub || record.team_id !== prepared.team_id || record.target_id !== prepared.target_id || !equal(record.command, prepared.command) || !equal(record.before, prepared.before)) throw Error('Recover the original pending capability update')
  if (record.state === 'accepted') return verifyCapabilityUpdate(record, record.receipt)
  const result = verifyCapabilityUpdate(record, await request({ team_id: record.team_id, command: record.command }, { signal }))
  await storage.save(key, { ...record, state: 'accepted', receipt: result }); return result
}

export async function requestCapabilityUpdate(input, { signal } = {}) {
  const options = { credentials: 'same-origin', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }
  const query = new URLSearchParams({ team_id: input.team_id, request_id: input.command.request_id })
  const receipt = await fetch(`/api/kode/teams/capability-update?${query}`, options)
  if (!receipt.ok) throw Error('Capability receipt unavailable')
  const saved = await receipt.json()
  if (!saved || !Object.hasOwn(saved, 'result')) throw Error('Invalid capability receipt lookup')
  if (saved.result !== null) return saved.result
  const response = await fetch('/api/kode/teams/capability-update', { ...options, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  if (!response.ok) throw Error('Capability update not confirmed')
  return response.json()
}

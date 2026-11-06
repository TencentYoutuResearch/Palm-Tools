import { canonical } from './builder-accept-command.js'
export const capabilityKey = (team, target) => JSON.stringify(['team-capability', team.home_hub, team.id, target.id])
export function capabilityCommand(team, target, row, values, uuid = () => crypto.randomUUID()) {
  const b = row?.binding, at = Date.now(), expires = new Date(values.expires).getTime(), score = Number(values.score), confidence = Number(values.confidence)
  if (target.capability_profile_revision !== '1' || !b?.binding_current || b.host !== target.host_id || b.profile !== target.executor_profile_id || b.account_id !== target.account_binding_id) throw Error('Matching current account and initial capability version required')
  if (!values.tag.trim() || values.tag.length > 160 || !values.score.trim() || !Number.isInteger(score) || score < 0 || score > 100 || !values.confidence.trim() || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 || !Number.isSafeInteger(expires) || expires <= at || values.evidence.length > 2048) throw Error('Explicit assessment required')
  const fact = evaluation => ({ evaluation, source: 'user', confidence, evidence: values.evidence.trim() ? [values.evidence.trim()] : [], updated_at: at, valid_until: expires, pinned: values.pinned })
  const assessments = { fit: fact({ kind: 'task_fit', tag: values.tag.trim(), score }) }
  if (values.cost) { if (!['low', 'medium', 'high'].includes(values.cost)) throw Error('Invalid cost'); assessments.cost = fact({ kind: 'cost_tier', tier: values.cost }) }
  if (values.latency) { if (!['low', 'medium', 'high'].includes(values.latency)) throw Error('Invalid latency'); assessments.latency = fact({ kind: 'latency', preference: values.latency }) }
  return { request_id: uuid(), team_revision: team.revision, target_id: target.id, create_account: false, reuse_binding: true,
    binding: { host: b.host, profile: b.profile, account_id: b.account_id, account_epoch: b.account_epoch, expected_revision: b.revision },
    capability_profile: { id: uuid(), expected_revision: 0, host: target.host_id, profile: target.executor_profile_id, model: target.model_id, assessments, replace_pins: false } }
}
export async function confirmCapability({ team, target, storage, command, request, signal }) {
  const key = capabilityKey(team, target)
  const pending = await storage.reserve(key, { state: 'prepared', home_hub: team.home_hub, request_id: command.request_id, command: { team_id: team.id, command } })
  if (signal?.aborted) throw Error('Disposed')
  if (pending.home_hub !== team.home_hub || pending.command?.team_id !== team.id || pending.command.command.target_id !== target.id) throw Error('Wrong capability scope')
  const result = await request(pending.command, { signal }), sent = pending.command.command, profile = result.capability_profile
  if (result.team_id !== team.id || result.team_revision !== sent.team_revision || result.request_id !== sent.request_id || result.target_id !== target.id || result.account_created !== false || result.binding_reused !== true || result.activation_performed !== false || result.eligible_for_execution !== false || result.quota_status !== 'not_checked'
    || profile?.id !== sent.capability_profile.id || profile.revision !== 1 || ['host', 'profile', 'model'].some(key => profile[key] !== sent.capability_profile[key]) || canonical(profile.assessments) !== canonical(sent.capability_profile.assessments)
    || canonical(result.binding) !== canonical({ host: sent.binding.host, profile: sent.binding.profile, account_id: sent.binding.account_id, account_epoch: sent.binding.account_epoch, revision: sent.binding.expected_revision })) throw Error('Invalid capability receipt')
  await storage.save(key, { ...pending, state: 'accepted', receipt: result }); return result
}
export async function requestCapability(input, { signal } = {}) {
  const response = await fetch('/api/kode/teams/resource', { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  if (!response.ok) throw Error('Capability not confirmed')
  return response.json()
}

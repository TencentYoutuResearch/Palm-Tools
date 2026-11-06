import { canonical } from './builder-accept-command.js'
export const authorityKey = team => JSON.stringify(['team-authority', team.home_hub, team.id])
/** Proposed scope is derived from the reviewed workflow, but only explicit owner confirmation grants it. */
export function authorityCommand(team, review, expiresAt, requestId, { allowClarificationAnswers = false } = {}) {
  if (typeof allowClarificationAnswers !== 'boolean') throw Error('Invalid clarification permission')
  if (review?.team?.id !== team.id || review.team.home_hub !== team.home_hub || review.team.revision !== team.revision || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw Error('Current review required')
  const configuration = review.configuration, budget = configuration?.policies?.budget, scheduling = configuration?.policies?.scheduling
  if (!configuration.workflow_bindings_valid || !configuration.project_delivery_bindings_valid || !configuration.execution_policy_bindings_valid
    || !budget || !scheduling || budget.team_id !== team.id || scheduling.team_id !== team.id || !team.spec.grant_id) throw Error('Policies and workflow required')
  const capabilities = new Set(['read']), tools = new Set(), targets = team.spec.workspace_refs.map(w => ({ host: w.host_id, workspace: w.workspace_id, root: w.root_ref }))
  let network = false, stages = 0
  for (const binding of configuration.bindings) for (const stage of binding.workflow.pack.stages) {
    const scope = stage.execution
    if (!scope || !Array.isArray(scope.capabilities) || !Array.isArray(scope.tools)) throw Error('Stage scope missing')
    stages++; for (const capability of scope.capabilities) capabilities.add(capability)
    for (const tool of scope.tools) tools.add(tool)
    network ||= scope.network
  }
  if (!stages) throw Error('Workflow empty')
  if (team.spec.kind === 'coordinator' || team.spec.workers.length) capabilities.add('delegate')
  // The Coordinator's fixed control tools are distinct from assigned stage tools.
  if (team.spec.kind === 'coordinator') for (const name of ['kode_coordinator_publish_reply', 'kode_coordinator_workflow_start', 'kode_coordinator_configuration', 'kode_coordinator_workflow_status']) tools.add(name)
  if (team.spec.kind === 'coordinator' && allowClarificationAnswers) tools.add('kode_coordinator_answer_clarification')
  const writePolicy = value => ({ id: value.id, team_id: team.id, expected_revision: value.revision, policy: structuredClone(value.policy) })
  if (review.grant && review.grant.policy.team_id !== team.id) throw Error('Foreign grant')
  return { request_id: requestId, team_revision: team.revision, budget_policy: writePolicy(budget), scheduling_policy: writePolicy(scheduling), grant: { expected_revision: review.grant?.revision ?? 0,
    policy: { id: team.spec.grant_id, team_id: team.id, enabled: true, expires_at: expiresAt, targets, capabilities: [...capabilities].sort(), tools: [...tools].sort(), network, budget_ids: [...budget.policy.budget_ids] } } }
}
export async function confirmTeamAuthority({ storage, team, command, request, signal }) {
  const key = authorityKey(team)
  const pending = await storage.reserve(key, { state: 'prepared', home_hub: team.home_hub, request_id: command.request_id, command: { team_id: team.id, command } })
  if (signal?.aborted) throw Error('Disposed')
  if (pending.home_hub !== team.home_hub || pending.command?.team_id !== team.id) throw Error('Wrong authority scope')
  const result = await request(pending.command, { signal }), sent = pending.command.command
  if (result.team_id !== team.id || result.team_revision !== sent.team_revision || result.request_id !== sent.request_id || result.activation_performed !== false
    || result.grant?.revision !== sent.grant.expected_revision + 1 || canonical(result.grant.policy) !== canonical(sent.grant.policy)
    || ['budget_policy', 'scheduling_policy'].some(key => result[key]?.id !== sent[key].id || result[key]?.team_id !== team.id || result[key]?.revision !== sent[key].expected_revision + 1 || canonical(result[key]?.policy) !== canonical(sent[key].policy))) throw Error('Invalid authority receipt')
  await storage.save(key, { ...pending, state: 'accepted', receipt: result })
  return result
}
export async function requestTeamAuthority(input, { signal } = {}) {
  const response = await fetch('/api/kode/teams/authority', { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  if (!response.ok) throw Error('Authority not confirmed')
  return response.json()
}

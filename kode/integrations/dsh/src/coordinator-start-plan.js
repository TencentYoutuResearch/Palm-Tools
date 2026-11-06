/** Read-only plan from activated authority. Keep the returned command unchanged for retries.
 * Ranking is a recommendation; the atomic start rechecks grants, funds and resources.
 */
import { isDeepStrictEqual } from 'node:util'
import { OFFICIAL_COORDINATOR_TOOLS, coordinatorToolNames } from './official-coordinator-tools.js'
import { profileRevision } from './agent-profiles.js'
import { preflightOfficialSelection } from './official-selection-preflight.js'
export function normalizeCoordinatorPlanInput(input) {
  const fields = ['team_id','command_id','request_id','owner_session','session_id','workspace_id','task_tag','target_id','expected_control_revision']
  const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(v)
  if (!input || Array.isArray(input) || Object.keys(input).some(k => !fields.includes(k))
      || !fields.filter(k => !['task_tag','target_id','expected_control_revision'].includes(k)).every(k => id(input[k]))
      || (input.target_id !== undefined && !id(input.target_id))
      || (input.expected_control_revision !== undefined && (!Number.isSafeInteger(input.expected_control_revision) || input.expected_control_revision < 0))
      || typeof input.task_tag !== 'string' || !input.task_tag.trim() || Buffer.byteLength(input.task_tag) > 160) throw Error('Invalid Coordinator plan request')
  return structuredClone(input)
}
export async function planCoordinatorStart(runtime, input, { signal } = {}) {
  input = normalizeCoordinatorPlanInput(input)
  const call = (path, body) => runtime.client.call(`/api/v1/messaging/${path}`, body, signal)
  const teamPath = `teams/${encodeURIComponent(input.team_id)}`
  const active = await call(`${teamPath}/activation`)
  if (!active?.active || active.authority_valid !== true) throw Error('Coordinator activation unavailable')
  const { control } = await call(`${teamPath}/coordinator-control`)
  if(input.expected_control_revision!==undefined&&(control?.revision??0)!==input.expected_control_revision)throw Error('Coordinator expected control changed')
  const snapshot = active.snapshot, spec = snapshot.team.spec
  const grant = snapshot.grant, budget = snapshot.policies.budget.policy, scheduling = snapshot.policies.scheduling.policy
  if (snapshot.team.home_hub !== runtime.host || snapshot.team.id !== input.team_id
      || budget.kind !== 'budget' || scheduling.kind !== 'scheduling') throw Error('Coordinator home or policy mismatch')
  const workspace = spec.workspace_refs.find(w => w.host_id === runtime.host && w.workspace_id === input.workspace_id)
  const target = grant.policy.targets.find(t => t.host === runtime.host && t.workspace === input.workspace_id && t.root === workspace?.root_ref)
  if (!workspace || !target || !['read','delegate'].every(c => grant.policy.capabilities.includes(c))
      || !OFFICIAL_COORDINATOR_TOOLS.every(t => grant.policy.tools.includes(t))
      || !budget.budget_ids.length || !budget.budget_ids.every(b => grant.policy.budget_ids.includes(b))) throw Error('Coordinator activated grant incomplete')
  const configured = spec.execution_targets.filter(t => spec.coordinator_targets.includes(t.id) && t.host_id === runtime.host && (input.target_id===undefined||t.id===input.target_id))
    .map(t => ({ target:t, candidate:scheduling.targets[t.id] }))
    .filter(({target:t,candidate:c}) => c?.internal_price_id && t.executor_profile_revision
      && c.resource.host === t.host_id && c.resource.profile === t.executor_profile_id
      && c.resource.account_id === t.account_binding_id && String(c.capability_revision) === t.capability_profile_revision)
  if (!configured.length) throw Error('No configured priced local Coordinator target')
  const choices=[]
  for(const choice of configured){
    signal?.throwIfAborted()
    try{
      const target=choice.target,profile=runtime.profiles.get(target.executor_profile_id)
      await preflightOfficialSelection(runtime.ctx,runtime.profiles,{profile,revision:profileRevision(profile),managedCoordinator:{team_id:input.team_id}},
        {profile_revision:target.executor_profile_revision,model:target.model_id,effort:target.effort??null,scope:'executor_configuration'},
        {provider:target.provider_id,model:target.model_id,...(target.effort==null?{}:{reasoningEffort:target.effort})},signal,
        {session:{header:{cwd:workspace.root_ref}}},runtime.managedCodex)
      choices.push(choice)
    }catch{signal?.throwIfAborted()}
  }
  // A UI-only Host sharing the backend must not fund/control a team whose
  // actual local executor it cannot prepare. Metadata lookup does not infer.
  if(!choices.length)throw Error('No current local Coordinator executor matches activated configuration')
  const ranking = await call('resources/rank', {
    task_tag:input.task_tag, minimum_quality:scheduling.minimum_quality, minimum_confidence:scheduling.minimum_confidence, weights:scheduling.weights,
    candidates:choices.map(({target:t,candidate:c}) => ({ capability_id:c.capability_id, capability_revision:c.capability_revision,
      model:t.model_id, resource:c.resource, preferred:c.preferred })),
  })
  const best = ranking.candidates?.[0]
  const matches = choices.filter(({target:t,candidate:c}) => best && best.host === t.host_id
    && best.profile === t.executor_profile_id && best.model === t.model_id
    && best.capability_id === c.capability_id && best.capability_revision === c.capability_revision)
  if (matches.length !== 1) throw Error('No unambiguous eligible Coordinator recommendation')
  const { target:selected, candidate } = matches[0]
  // Do not reserve or create during planning; stale plans fail the existing atomic gate.
  if (!isDeepStrictEqual(await call(`${teamPath}/activation`), active)
      || !isDeepStrictEqual((await call(`${teamPath}/coordinator-control`)).control, control)) throw Error('Coordinator authority changed during planning')
  const command = {
    command_id:input.command_id, team_id:input.team_id, provider:selected.provider_id,
    start:{ request_id:input.request_id, expected_control_revision:control?.revision ?? 0,
      team_revision:active.team_revision, activation_revision:active.revision, target_id:selected.id, price_id:candidate.internal_price_id,
      operation:{ owner_session:input.owner_session, request_key:input.request_id,
        worker:{node_id:runtime.host,session_id:input.session_id},
        selection_policy:{profile_revision:selected.executor_profile_revision,model:selected.model_id,effort:selected.effort ?? null,scope:'executor_configuration'},
        funding:{budget_ids:budget.budget_ids,amount:budget.max_assignment_charge,unit:budget.unit},resource:candidate.resource,
        grant_id:grant.policy.id,grant_scope:{team_id:input.team_id,revision:grant.revision,target,
          capabilities:['read','delegate'],tools:coordinatorToolNames(grant.policy.tools),network:false,budget_ids:budget.budget_ids}},
    },
  }
  return structuredClone({ command, ranking, state:'planned', dispatch_authorized:false })
}

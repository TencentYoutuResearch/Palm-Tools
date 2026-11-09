/** Second real, activated but idle contact with separate workspace/account/profile. */
import { cp } from 'node:fs/promises'
import { profileRevision } from '../../src/agent-profiles.js'

export async function pairedContactTeam({call,root,otherRoot,hub,profiles,spec,projectInput,deliveryInput,version,flow,budgetCommand,budgetPolicyCommand,scheduleCommand,capabilityCommand,grantCommand,activationCommand,policy}) {
  await cp(root,otherRoot,{recursive:true})
  const workspace={host_id:hub.node,workspace_id:'other-workspace',root_ref:otherRoot}
  const project=await call('project-configs',{...projectInput,id:'other-project',spec:{...projectInput.spec,repositories:{code:{repository_id:'other-repo',workspace}}}})
  const delivery=await call('project-configs',{id:'other-delivery',version:'1',spec:{kind:'delivery_policy',project:version(project),workflow:version(flow),targets:deliveryInput.targets,required_outputs:deliveryInput.required_outputs}})
  const otherSpec={...spec,name:'Other team',coordinator_startup:{...spec.coordinator_startup,workspace_id:'other-workspace'},workspace_refs:[workspace],execution_targets:spec.execution_targets.map(t=>({...t,executor_profile_id:'other-profile',executor_profile_revision:profileRevision(profiles.get('other-profile')),account_binding_id:'other-account'})),delivery_bindings:[{id:'local',workflow:version(flow),project:version(project),delivery_policy:version(delivery)}],grant_id:'other-grant',budget_policy_id:'other-budget-policy',scheduling_policy_id:'other-schedule'}
  const team=await call('teams',{id:'other-team',request_id:'create-other',expected_revision:0,spec:otherSpec})
  await call('resource-accounts',{id:'other-account',expected_epoch:0,enabled:true})
  await call('assignment-capacities',{account_id:'other-account',expected_revision:0,max_active_assignments:1})
  await call('resource-bindings',{host:hub.node,profile:'other-profile',account_id:'other-account',account_epoch:1,expected_revision:0})
  await call('capability-profiles',{...capabilityCommand,id:'other-capability',profile:'other-profile'})
  await call('budgets',{...budgetCommand,id:'other-budget',scope_id:'other-team'})
  const budget=await call('team-policies',{...budgetPolicyCommand,id:'other-budget-policy',team_id:'other-team',policy:{...budgetPolicyCommand.policy,budget_ids:['other-budget']}})
  const candidate=scheduleCommand.policy.targets.control
  const schedule=await call('team-policies',{...scheduleCommand,id:'other-schedule',team_id:'other-team',policy:{...scheduleCommand.policy,targets:{control:{...candidate,resource:{...candidate.resource,profile:'other-profile',account_id:'other-account'},capability_id:'other-capability'}}}})
  const grant=(await call('team-grants',{...grantCommand,policy:{...grantCommand.policy,id:'other-grant',team_id:'other-team',targets:[{host:hub.node,workspace:'other-workspace',root:otherRoot}],budget_ids:['other-budget']}})).grant
  await call('teams/other-team/activation',{...activationCommand,grant_revision:grant.revision,budget_policy:policy(budget),scheduling_policy:policy(schedule)})
  return team
}

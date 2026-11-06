/** Real Hub owner configuration for intake tests; no model or runtime is started. */
export async function conversationTeam(hub) {
  const profileHash = 'f'.repeat(64)
  const root='/api/v1/messaging',call=(p,b)=>hub.client.call(`${root}/${p}`,b),at=Date.now()
  const workspace={host_id:hub.node,workspace_id:'workspace',root_ref:'/fixture'},target={host:hub.node,workspace:'workspace',root:'/fixture'}
  const version=r=>({id:r.id,version:r.version,hash:r.hash}),policy=r=>({id:r.id,revision:r.revision,hash:r.hash})
  const flow=await call('workflows',{id:'flow',version:'1',inputs:['request'],stages:[{id:'inspect',role:'coordinator',requires:['request'],produces:['artifact'],independent_from:[],execution:{task_tag:'inspection',repository_binding:'code',capabilities:['read'],tools:['kode_artifact_capture','kode_coordinator_publish_reply'],network:false}}],completion_stages:['inspect'],evidence_rules:{artifact:{kind:'artifact',repository_binding:'code'}}})
  const project=await call('project-configs',{id:'project',version:'1',spec:{kind:'project_bindings',repositories:{code:{repository_id:'repo',workspace}},environments:{},commands:{},connections:{}}})
  const delivery=await call('project-configs',{id:'delivery',version:'1',spec:{kind:'delivery_policy',project:version(project),workflow:version(flow),targets:[{kind:'local',repository_binding:'code'}],required_outputs:['artifact']}})
  await call('resource-accounts',{id:'account',expected_epoch:0,enabled:true})
  await call('assignment-capacities',{account_id:'account',expected_revision:0,max_active_assignments:2})
  await call('resource-bindings',{host:hub.node,profile:'profile',account_id:'account',account_epoch:1,expected_revision:0})
  await call('capability-profiles',{id:'capability',expected_revision:0,host:hub.node,profile:'profile',model:'model',assessments:{}})
  await call('budgets',{id:'budget',scope:'team',scope_id:'team',unit:'credits',limit:100,starts_at:at-1000,ends_at:at+180000,expected_revision:0})
  const budget=await call('team-policies',{id:'budget-policy',team_id:'team',expected_revision:0,policy:{kind:'budget',budget_ids:['budget'],unit:'credits',max_assignment_charge:10}})
  const resource={host:hub.node,profile:'profile',account_id:'account',account_epoch:1,binding_revision:1,limit_ids:['daily'],unknown_quota:'team_budget'}
  const schedule=await call('team-policies',{id:'schedule',team_id:'team',expected_revision:0,policy:{kind:'scheduling',targets:{control:{resource,capability_id:'capability',capability_revision:1,preferred:false}},weights:{quality:1,cost:0,latency:0},minimum_quality:0,minimum_confidence:0}})
  const spec={name:'Team',purpose:'Work',kind:'coordinator',workspace_refs:[workspace],execution_targets:[{id:'control',host_id:hub.node,executor_profile_id:'profile',executor_profile_revision:profileHash,provider_id:'fixture',model_id:'model',effort:null,account_binding_id:'account',capability_profile_revision:'1'}],workers:[],coordinator_targets:['control'],workflow_pack_refs:[version(flow)],delivery_bindings:[{id:'local',workflow:version(flow),project:version(project),delivery_policy:version(delivery)}],grant_id:'grant',budget_policy_id:'budget-policy',scheduling_policy_id:'schedule',limits:{max_active_assignments:2,max_active_runs:2},proactive_mode:'off'}
  const team=await call('teams',{id:'team',request_id:'create',expected_revision:0,spec})
  const grant=(await call('team-grants',{expected_revision:0,policy:{id:'grant',team_id:'team',enabled:true,expires_at:at+180000,targets:[target],capabilities:['read','delegate'],tools:['kode_artifact_capture','kode_coordinator_publish_reply','kode_coordinator_workflow_start','kode_coordinator_configuration','kode_coordinator_workflow_status'],network:false,budget_ids:['budget']}})).grant
  await call('teams/team/activation',{action:'activate',request_id:'activate',expected_revision:0,team_revision:1,grant_revision:grant.revision,budget_policy:policy(budget),scheduling_policy:policy(schedule)})
  return team
}

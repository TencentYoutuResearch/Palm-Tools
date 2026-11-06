import { WorkRunController } from '../src/work-run-controller.js'
import { WorkRunService } from '../src/work-run-service.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
test('two teams share budget and account capacity without partial reservation; controller resumes definite capacity waits',{skip:!process.env.KODE_TEST_BACKEND_URL,timeout:30000},async()=>{
 const hub=await isolatedHub('shared-team-pressure')
 try{
  const call=(p,b)=>hub.client.call(`/api/v1/messaging/${p}`,b),at=Date.now(),v=r=>({id:r.id,version:r.version,hash:r.hash}),policy=r=>({id:r.id,revision:r.revision,hash:r.hash})
  await call('resource-accounts',{id:'account',expected_epoch:0,enabled:true})
  await call('resource-bindings',{host:hub.node,profile:'expert',account_id:'account',account_epoch:1,expected_revision:0})
  await call('assignment-capacities',{account_id:'account',expected_revision:0,max_active_assignments:1})
  await call('budgets',{id:'shared',scope:'shared',scope_id:'account',unit:'credits',limit:15,starts_at:at-1000,ends_at:at+60000,expected_revision:0})
  await call('capability-profiles',{id:'capability',expected_revision:0,host:hub.node,profile:'expert',model:'configured-expert',assessments:{fit:{evaluation:{kind:'task_fit',tag:'inspection',score:90},source:'user',confidence:1,evidence:[],pinned:false,updated_at:at,valid_until:at+60000}}})
  const flow=await call('workflows',{id:'inspect',version:'1',inputs:['request'],stages:[{id:'inspect',role:'coordinator',requires:['request'],produces:['artifact'],independent_from:[],execution:{task_tag:'inspection',repository_binding:'code',capabilities:['read'],tools:['kode_artifact_capture'],network:false}}],completion_stages:['inspect'],evidence_rules:{artifact:{kind:'artifact',repository_binding:'code'}}})
  for(const id of ['a','b']){
   const workspace={host_id:hub.node,workspace_id:`workspace-${id}`,root_ref:`/srv/fixture/${id}`}
   const project=await call('project-configs',{id:`project-${id}`,version:'1',spec:{kind:'project_bindings',repositories:{code:{repository_id:`repo-${id}`,workspace}},environments:{},commands:{},connections:{}}})
   const delivery=await call('project-configs',{id:`delivery-${id}`,version:'1',spec:{kind:'delivery_policy',workflow:v(flow),project:v(project),targets:[{kind:'local',repository_binding:'code'}],required_outputs:['artifact']}})
   await call('budgets',{id:`budget-${id}`,scope:'team',scope_id:id,unit:'credits',limit:100,starts_at:at-1000,ends_at:at+60000,expected_revision:0})
   const budget=await call('team-policies',{id:`budget-policy-${id}`,team_id:id,expected_revision:0,policy:{kind:'budget',budget_ids:[`budget-${id}`,'shared'],unit:'credits',max_assignment_charge:10}})
   const scheduling=await call('team-policies',{id:`schedule-${id}`,team_id:id,expected_revision:0,policy:{kind:'scheduling',targets:{expert:{resource:{host:hub.node,profile:'expert',account_id:'account',account_epoch:1,binding_revision:1,limit_ids:['daily'],unknown_quota:'team_budget'},capability_id:'capability',capability_revision:1,preferred:true}},weights:{quality:1,cost:0,latency:0},minimum_quality:0,minimum_confidence:0}})
   const grant=(await call('team-grants',{expected_revision:0,policy:{id:`grant-${id}`,team_id:id,enabled:true,expires_at:at+60000,targets:[{host:hub.node,workspace:workspace.workspace_id,root:workspace.root_ref}],capabilities:['read'],tools:['kode_artifact_capture'],network:false,budget_ids:[`budget-${id}`,'shared']}})).grant
   const spec={name:`Team ${id}`,purpose:'Shared expert pressure',kind:'coordinator',workspace_refs:[workspace],execution_targets:[{id:'expert',host_id:hub.node,executor_profile_id:'expert',executor_profile_revision:'f'.repeat(64),provider_id:'fixture',model_id:'configured-expert',effort:null,account_binding_id:'account',capability_profile_revision:'1'}],workers:[],coordinator_targets:['expert'],workflow_pack_refs:[v(flow)],delivery_bindings:[{id:'local',workflow:v(flow),project:v(project),delivery_policy:v(delivery)}],grant_id:`grant-${id}`,budget_policy_id:`budget-policy-${id}`,scheduling_policy_id:`schedule-${id}`,limits:{max_active_assignments:1,max_active_runs:8},proactive_mode:'off'}
   await call('teams',{id,request_id:'create',expected_revision:0,spec})
   await call(`teams/${id}/activation`,{action:'activate',request_id:'activate',expected_revision:0,team_revision:1,grant_revision:grant.revision,budget_policy:policy(budget),scheduling_policy:policy(scheduling)})
  }
  const prepare=run=>call(`work-runs/${run}/stages/inspect/assignments`,{request_id:'prepare',expected_revision:1,target_id:'expert',worker_id:null})
  const release=async assignment=>{
   const current=await call(`work-assignments/${assignment.id}`)
   return call(`work-assignments/${assignment.id}/abandon`,{request_id:'release',expected_revision:current.revision})
  }
  for(let round=0;round<4;round++){
   for(const team of ['a','b'])await call('work-runs',{id:`${team}-${round}`,request_id:`${team}-${round}`,team_id:team,team_revision:1,binding_id:'local',inputs:{request:'Inspect'},prior_run_id:null})
   const results=await Promise.allSettled(['a','b'].map(team=>prepare(`${team}-${round}`)))
   assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
   const winner=results.findIndex(r=>r.status==='fulfilled'),other=1-winner,teams=['a','b']
   const first=results[winner].value.assignment
   assert.equal((await call('budgets/shared')).budget.reserved,10)
   assert.equal((await call(`budgets/budget-${teams[other]}`)).budget.reserved,0,'failed cross-budget reserve is atomic')
   assert.equal((await call(`work-runs/${teams[other]}-${round}`)).revision,1,'failed assignment leaves run untouched')
   const command={request_id:'hold',expected_revision:first.revision}
   const held=await call(`work-assignments/${first.id}/resources`,command)
   assert.equal((await call('assignment-capacities/account')).held,1)
   await release(first)
   const next=(await prepare(`${teams[other]}-${round}`)).assignment
   await call(`work-assignments/${next.id}/resources`,{request_id:'hold',expected_revision:next.revision})
   assert.deepEqual(await call(`work-assignments/${first.id}/resources`,command),held,'old receipt cannot steal successor capacity')
   assert.equal((await call('assignment-capacities/account')).held,1)
   await release(next)
   for(const id of ['shared','budget-a','budget-b']){const b=(await call(`budgets/${id}`)).budget;assert.equal(b.reserved,0);assert.equal(b.spent,0)}
   assert.equal((await call('assignment-capacities/account')).held,0)
   if(round===1){await hub.stop('SIGKILL');await hub.start()}
  }
  const shared=(await call('budgets/shared')).budget
  await call('budgets',{id:'shared',scope:'shared',scope_id:'account',unit:'credits',limit:30,starts_at:shared.starts_at,ends_at:shared.ends_at,expected_revision:shared.revision})
  for(const team of ['a','b'])await call('work-runs',{id:`account-${team}`,request_id:`account-${team}`,team_id:team,team_revision:1,binding_id:'local',inputs:{request:'Inspect'},prior_run_id:null})
  const assignments=await Promise.all(['a','b'].map(async team=>(await prepare(`account-${team}`)).assignment))
  const holds=await Promise.allSettled(assignments.map(a=>call(`work-assignments/${a.id}/resources`,{request_id:'hold',expected_revision:a.revision})))
  assert.equal(holds.filter(r=>r.status==='fulfilled').length,1)
  const rejected=holds.find(r=>r.status==='rejected').reason
  assert.match(rejected.message,/account capacity exhausted/)
  assert.equal(rejected.status,409);assert.equal(rejected.code,'assignment_account_capacity_exhausted')
  const winner=holds.findIndex(r=>r.status==='fulfilled'),loser=1-winner
  assert.equal((await call('budgets/shared')).budget.reserved,20,'both waiting assignments retain authorized holds')
  await hub.stop('SIGKILL');await hub.start()
  assert.equal((await call('assignment-capacities/account')).held,1)
  const waitingRun=`account-${['a','b'][loser]}`,waitingAssignment=assignments[loser]
  let resourceAttempts=0
  const runtime={host:hub.node,profiles:{path:`${hub.root}/profiles.json`},client:{async call(path,body,signal){
   if(path.includes('/work-runs/active'))return {items:[await call(`work-runs/${waitingRun}`)],next_cursor:null}
   return hub.client.call(path,body,signal)
  }}}
  const controller=new WorkRunController({host:{execution:runtime,stop:new AbortController(),handles:new Map()},async start(id){
   resourceAttempts++
   const a=await call(`work-assignments/${id}`)
   await call(`work-assignments/${id}/resources`,{request_id:'service-hold',expected_revision:a.revision})
   return {mandate:{receipt:{}}} // No Worker creation: isolate controller/resource admission progression.
  }},{prepare:async()=>({})})
  const service=await new WorkRunService(controller,{intervalMs:100,maxWatches:1}).open()
  try{
   await service.scan()
   const until=Date.now()+3000
   while(service.rows[waitingRun]?.state!=='waiting_resource'){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,10))}
   assert.equal(service.rows[waitingRun].blocked,false)
   assert.equal(resourceAttempts,1)
   const blockedRevision=(await call(`work-runs/${waitingRun}`)).revision
   await release(assignments[winner])
   assert.equal((await call('assignment-capacities/account')).held,0)
   while((await call('assignment-capacities/account')).held===0){
    assert.ok(Date.now()<until,'service must retry after another team releases capacity')
    await service.scan();await new Promise(r=>setTimeout(r,10))
   }
   while(service.rows[waitingRun]?.state!=='started'){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,10))}
   assert.ok(resourceAttempts>=2)
   assert.equal(service.rows[waitingRun].blocked,false)
   assert.equal((await call(`work-runs/${waitingRun}`)).revision,blockedRevision,'recovery does not require changing Run revision or manual retry')
  }finally{await service.close()}
  const other=assignments[loser]
  assert.equal((await call(`work-assignments/${other.id}`)).resources.state,'held')
  await release(other)
  assert.equal((await call('assignment-capacities/account')).held,0)
  assert.equal((await call('budgets/shared')).budget.reserved,0)
 }finally{await hub.close()}
})

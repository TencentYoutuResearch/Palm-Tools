import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
test('Builder checks every proposed target and distinguishes unknown provider quota from team budget', {skip:!process.env.KODE_TEST_BACKEND_URL,timeout:30000},async()=>{
  const hub=await isolatedHub('builder-resources-home')
  try {
    const call=(path,body)=>hub.client.call(`/api/v1/messaging/${path}`,body)
    await call('resource-accounts',{id:'account',expected_epoch:0,enabled:true})
    const targets={}, executions=[]
    for (const id of ['fast','expert']) {
      await call('resource-bindings',{host:hub.node,profile:id,account_id:'account',account_epoch:1,expected_revision:0})
      await call('capability-profiles',{id,expected_revision:0,host:hub.node,profile:id,model:'configured-model',assessments:{}})
      targets[id]={resource:{host:hub.node,profile:id,account_id:'account',account_epoch:1,binding_revision:1,limit_ids:['primary'],unknown_quota:id==='fast'?'team_budget':'require_fresh'},capability_id:id,capability_revision:1,preferred:false}
      executions.push({id,host_id:hub.node,executor_profile_id:id,provider_id:'fixture',model_id:'configured-model',effort:null,account_binding_id:'account',capability_profile_revision:'1'})
    }
    const budget={id:'budget',scope:'team',scope_id:'candidate',unit:'credits',limit:100,expected_revision:0,starts_at:Date.now()-1000,ends_at:Date.now()+60000}
    await call('budgets',budget)
    await call('team-policies',{id:'budget-policy',team_id:'candidate',expected_revision:0,policy:{kind:'budget',budget_ids:['budget'],unit:'credits',max_assignment_charge:20}})
    await call('team-policies',{id:'schedule',team_id:'candidate',expected_revision:0,policy:{kind:'scheduling',targets,weights:{quality:1,cost:0,latency:0},minimum_quality:0,minimum_confidence:0}})
    await call('superagents/drafts',{id:'draft',request_id:'create',expected_revision:0,revoked:false,interview:{purpose:'Configure resources',workspace_refs:[],answers:{},questions:[],proposed_team:{name:'Candidate',purpose:'Work',kind:'coordinator',workspace_refs:[],execution_targets:executions,workers:[],coordinator_targets:['fast'],workflow_pack_refs:[],grant_id:null,budget_policy_id:'budget-policy',scheduling_policy_id:'schedule',limits:{max_active_assignments:2,max_active_runs:1},proactive_mode:'off'}}})
    const check=async()=>(await call('superagents/drafts/draft/preflight',{expected_revision:1,team_id:'candidate'})).resources
    const before=await call('budgets/budget')
    const query={expected_revision:1,team_id:'candidate',after_id:'',after_version:'',limit:10}
    const policies=await call('superagents/drafts/draft/catalog',{...query,kind:'scheduling_policy'})
    assert.deepEqual(policies.items.map(p=>p.id),['schedule'])
    const budgetPolicies=await call('superagents/drafts/draft/catalog',{...query,kind:'budget_policy'})
    assert.deepEqual(budgetPolicies.items.map(p=>p.id),['budget-policy'])
    assert.deepEqual((await call('superagents/drafts/draft/catalog',{...query,team_id:'foreign',kind:'scheduling_policy'})).items,[])
    await assert.rejects(call('superagents/drafts/draft/catalog',{...query,team_id:null,kind:'scheduling_policy'}),/candidate team/)
    const detailsPath='superagents/drafts/draft/policy-details'
    const details=target=>call(detailsPath,{expected_revision:1,team_id:'candidate',policy_id:'schedule',policy_revision:1,target_id:target})
    const fast=await details('fast')
    assert.equal(fast.details.quota.reason,'unknown_requires_team_budget')
    assert.equal(fast.details.capability.model,'configured-model')
    assert.equal(fast.details.capability_resource_identity_matches,true)
    assert.equal(fast.details.runtime_capabilities,'not_verified')
    assert.equal(fast.details.internal_price,null)
    assert.equal(fast.eligible_for_execution,false)
    const budgetDetails={expected_revision:1,team_id:'candidate',policy_id:'budget-policy',policy_revision:1,target_id:''}
    assert.equal((await call(detailsPath,budgetDetails)).details.team_budgets[0].snapshot.label,'团队预算')
    for(const change of [{team_id:'foreign'},{policy_revision:2},{target_id:'unexpected'}])await assert.rejects(call(detailsPath,{...budgetDetails,...change}),/conflict|no target/)
    const worker=await call('sessions',{session_id:'reader',title:'Reader',runtime:'external'})
    await assert.rejects(hub.client.forSession(worker.owner_token).call(`/api/v1/messaging/${detailsPath}`,budgetDetails),/403/)

    let result=await check()
    const startup=result.coordinator_startup
    assert.equal(startup.configuration_checks_complete,false)
    assert.equal(startup.eligible_for_execution,false)
    assert.equal(startup.reserved_by_preflight,false)
    assert.deepEqual(startup.issues.map(issue=>issue.code),[
      'coordinator_startup_required','coordinator_startup_grant_incomplete',
      'coordinator_startup_budget_incomplete','coordinator_priced_local_target_required',
    ])
    assert.deepEqual(startup.target_issues,[{target_id:'fast',issues:[
      'executor_profile_revision_missing','requested_model_price_missing_or_mismatched',
    ]}],'only Coordinator candidates participate in startup diagnostics')
    assert.equal(result.configured_target_count,2);assert.equal(result.targets.length,2)
    assert.deepEqual(result.targets.map(t=>t.status),['unknown_requires_team_budget','fresh_quota_required'])
    assert.equal(result.targets[0].quota.requires_team_budget,true)
    assert.equal(result.quota_and_identity_checks_complete,false)
    assert.equal(result.team_budgets[0].snapshot.label,'团队预算')
    assert.equal(result.team_budgets[0].covers_max_assignment_charge,true)
    assert.deepEqual(await call('budgets/budget'),before,'read-only diagnostics must not reserve credits')
    for (const profile of ['fast','expert']) {
      const at=Date.now()
      await call('quota-snapshots',{host:hub.node,profile,account_id:'account',account_epoch:1,binding_revision:1,observed_at_ms:at,truncated:false,buckets:[{limit_id:'primary',observed_at_ms:at,valid_until_ms:at+60000,windows:[{window_id:'hour',used_percent:10,resets_at_ms:at+60000,window_minutes:60}]}]})
    }
    result=await check();assert.equal(result.quota_and_identity_checks_complete,true)
    assert.ok(result.targets.every(t=>t.capability_identity==='matched' && !t.eligible_for_execution))
    assert.equal(result.eligible_for_execution,false,'quota identity checks do not prove runtime capabilities or task fit')
    await call('budgets',{...budget,limit:5,expected_revision:1})
    result=await check();assert.equal(result.team_budgets[0].covers_max_assignment_charge,false)
    const at=Date.now()
    await call('quota-snapshots',{host:hub.node,profile:'fast',account_id:'account',account_epoch:1,binding_revision:1,observed_at_ms:at,truncated:false,buckets:[{limit_id:'primary',observed_at_ms:at,valid_until_ms:at+60000,windows:[{window_id:'hour',used_percent:100,resets_at_ms:at+60000,window_minutes:60}]}]})
    assert.equal((await check()).targets[0].status,'provider_exhausted')
    assert.equal((await details('fast')).details.quota.reason,'provider_exhausted')
    await call('resource-accounts',{id:'account',expected_epoch:1,enabled:false})
    result=await check();assert.ok(result.targets.every(t=>t.status==='binding_unavailable'))
    await hub.stop('SIGKILL');await hub.start()
    result=await check();assert.ok(result.targets.every(t=>t.status==='binding_unavailable'))
    assert.equal((await details('fast')).details.quota.reason,'binding_unavailable')
    await call('team-policies',{id:'budget-policy',team_id:'candidate',expected_revision:1,policy:{kind:'budget',budget_ids:['budget'],unit:'credits',max_assignment_charge:1}})
    const currentPolicies=await call('superagents/drafts/draft/catalog',{...query,kind:'budget_policy'})
    assert.equal(currentPolicies.items.length,1,'historical ledger revisions must not duplicate current catalog')
    assert.equal(currentPolicies.items[0].revision,2)
    await assert.rejects(call(detailsPath,budgetDetails),/revision conflict/)
    assert.equal((await call(detailsPath,{...budgetDetails,policy_revision:2})).details.team_budgets[0].covers_max_assignment_charge,true)
    assert.equal((await call('budgets/budget')).budget.reserved,0)
    assert.deepEqual((await call('teams')).items,[])
  }finally{await hub.close()}
})

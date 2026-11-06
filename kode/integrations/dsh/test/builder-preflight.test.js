import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
test('Builder preflight validates a proposed configuration without materializing a team or activation', {skip:!process.env.KODE_TEST_BACKEND_URL,timeout:30000},async()=>{
  const hub=await isolatedHub('builder-preflight-home')
  try {
    const root='/api/v1/messaging', path=`${root}/superagents/drafts`
    const workspace={host_id:hub.node,workspace_id:'project',root_ref:'/fixture/project'}
    const interview={purpose:'Research project',workspace_refs:[workspace],answers:{},questions:[],proposed_team:null,
      questionnaire:{id:'custom',version:'1',questions:[{id:'delivery',prompt:'Where should delivery end?'}]}}
    let revision=0
    const save=async()=>{const row=await hub.client.call(path,{id:'draft',request_id:`save-${revision}`,expected_revision:revision,revoked:false,interview});revision=row.revision;return row}
    const check=()=>hub.client.call(`${path}/draft/preflight`,{expected_revision:revision,team_id:'candidate'})
    await save()
    let result=await check()
    assert.deepEqual(result.issues.map(i=>i.code),['interview_questions_pending','project_observations_missing','proposed_team_required'])
    assert.equal(result.configuration,null); assert.equal(result.eligible_for_execution,false)
    const workflow=await hub.client.call(`${root}/workflows`,{id:'research',version:'1',inputs:['request'],stages:[{id:'investigate',role:'researcher',requires:['request'],produces:['report'],independent_from:[]}],completion_stages:['investigate']})
    interview.answers.delivery='local report'
    interview.proposed_team={name:'Research',purpose:'Investigate requests',kind:'coordinator',workspace_refs:[workspace],execution_targets:[],workers:[],coordinator_targets:[],workflow_pack_refs:[{id:workflow.id,version:workflow.version,hash:workflow.hash}],grant_id:null,budget_policy_id:null,scheduling_policy_id:null,limits:{max_active_assignments:1,max_active_runs:1},proactive_mode:'off'}
    const saved=await save()
    result=await check()
    assert.deepEqual(result.issues.map(i=>i.code),['project_observations_missing'])
    assert.equal(result.resources.coordinator_startup.configuration_checks_complete,false)
    assert.ok(result.resources.coordinator_startup.issues.some(i=>i.code==='coordinator_startup_required'))
    assert.equal(result.resources.coordinator_startup.reserved_by_preflight,false)
    assert.equal(result.configuration.team_revision,null,'candidate has no saved team revision')
    assert.equal(result.configuration.issues[0].code,'stage_role_unassigned')
    assert.equal(result.configuration.issues[0].stage_id,'investigate')
    assert.deepEqual(result.configuration.policy_issues.map(i=>i.kind),['budget','scheduling'])
    assert.ok(result.configuration.binding_issues.some(i=>i.code==='delivery_binding_required'))
    assert.deepEqual(await hub.client.call(`${path}/draft`),saved,'preflight does not edit the interview')
    assert.deepEqual((await hub.client.call(`${root}/teams`)).items,[])
    const worker=await hub.client.call(`${root}/sessions`,{session_id:'worker',title:'Worker',runtime:'external'})
    await assert.rejects(hub.client.forSession(worker.owner_token).call(`${path}/draft/preflight`,{expected_revision:revision,team_id:'candidate'}),/403/)
    await assert.rejects(hub.client.call(`${path}/draft/preflight`,{expected_revision:1,team_id:'candidate'}),/revision conflict/)
    // The same shared validator must return the same configuration diagnostics after explicit save.
    await hub.client.call(`${root}/teams`,{id:'candidate',request_id:'explicit-save',expected_revision:0,spec:interview.proposed_team})
    const teamCheck=await hub.client.call(`${root}/teams/candidate/revisions/1/workflow-preflight`)
    for(const key of ['issues','workflows','policy_issues','binding_issues','pending_checks'])assert.deepEqual(result.configuration[key],teamCheck[key])
    interview.proposed_team.workspace_refs=[{...workspace,root_ref:'/fixture/unselected'}];await save()
    assert.ok((await check()).issues.some(i=>i.code==='proposed_workspace_not_selected'))
    interview.proposed_team.limits.max_active_runs=0;await save()
    result=await check();assert.ok(result.issues.some(i=>i.code==='proposed_team_invalid'));assert.equal(result.configuration,null)
    await hub.client.call(path,{id:'draft',request_id:'revoke',expected_revision:revision,revoked:true,interview});revision++
    await assert.rejects(check(),/revoked/)
  } finally {await hub.close()}
})

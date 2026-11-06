import test from 'node:test'
import assert from 'node:assert/strict'
import { planCoordinatorStart } from '../src/coordinator-start-plan.js'
import { OFFICIAL_COORDINATOR_TOOLS } from '../src/official-coordinator-tools.js'
import { coordinatorBootstrapInput } from '../src/coordinator-bootstrap.js'
import { startPlannedCoordinator } from '../src/coordinator-planned-start.js'
import { profileRevision } from '../src/agent-profiles.js'
const input={team_id:'team',command_id:'create',request_id:'start',owner_session:'owner',session_id:'coordinator',workspace_id:'workspace',task_tag:'coordination'}
function fixture(change=()=>{},race=false){
 const profile={id:'profile',name:'Fixture',type:'dsh'}
 const resource={host:'home',profile:'profile',account_id:'account'}
 const target={id:'target',host_id:'home',executor_profile_id:'profile',executor_profile_revision:profileRevision(profile),provider_id:'provider',model_id:'model',effort:'high',account_binding_id:'account',capability_profile_revision:'2'}
 const active={active:true,authority_valid:true,revision:3,team_revision:2,snapshot:{team:{id:'team',home_hub:'home',spec:{workspace_refs:[{host_id:'home',workspace_id:'workspace',root_ref:'/fixture'}],execution_targets:[target],coordinator_targets:['target']}},grant:{revision:4,policy:{id:'grant',targets:[{host:'home',workspace:'workspace',root:'/fixture'}],capabilities:['read','delegate','workspace_write'],tools:[...OFFICIAL_COORDINATOR_TOOLS,'kode_write_source'],budget_ids:['budget']}},policies:{budget:{policy:{kind:'budget',budget_ids:['budget'],unit:'credits',max_assignment_charge:40}},scheduling:{policy:{kind:'scheduling',minimum_quality:20,minimum_confidence:0.8,weights:{quality:1,cost:1,latency:1},targets:{target:{resource,capability_id:'capability',capability_revision:2,internal_price_id:'price',preferred:false}}}}}}}
 change(active)
 const calls=[];let reads=0
 return {calls,runtime:{host:'home',profiles:{get:id=>{if(id!==profile.id)throw Error('Unknown profile');return profile}},ctx:{llm:{resolveCallConfig:async config=>structuredClone(config)}},client:{async call(path,body){calls.push({path,body});if(path.endsWith('/activation'))return structuredClone(race&&++reads>1?{...active,revision:4}:active)
 if(path.endsWith('/coordinator-control'))return {control:null}
 if(path.endsWith('/resources/rank'))return {candidates:[{host:'home',profile:'profile',model:'model',capability_id:'capability',capability_revision:2}]}
 throw Error('Unexpected mutation or lookup')
 }}}}
}
test('planner preserves configured choices and only recommends with minimal Coordinator grant',async()=>{
 const f=fixture(),result=await planCoordinatorStart(f.runtime,input),op=result.command.start.operation
 assert.equal(result.dispatch_authorized,false)
 assert.equal(result.command.start.activation_revision,3)
 assert.equal(op.selection_policy.effort,'high')
 assert.deepEqual(op.grant_scope.capabilities,['read','delegate'])
 assert.deepEqual(op.grant_scope.tools,OFFICIAL_COORDINATOR_TOOLS)
 assert.equal(op.grant_scope.network,false)
 const rank=f.calls.find(c=>c.body)
 assert.equal(rank.path,'/api/v1/messaging/resources/rank')
 assert.equal(rank.body.task_tag,'coordination')
 assert.equal(f.calls.filter(c=>c.body).length,1)
})

test('a backend-sharing UI Host cannot reserve a Coordinator on an unavailable local executor',async()=>{
 for(const change of [runtime=>runtime.profiles.get=()=>{throw Error('No local executor')},runtime=>runtime.ctx.llm.resolveCallConfig=async()=>{throw Error('No local provider')}]){
  const f=fixture();change(f.runtime)
  await assert.rejects(planCoordinatorStart(f.runtime,input),/No current local Coordinator executor/)
  assert.ok(f.calls.every(row=>!row.body),'local readiness failure precedes ranking/reservation/dispatch')
 }
})
test('planner rejects revoked, foreign, undergranted and changed authority without writes',async()=>{
 for(const change of [a=>a.authority_valid=false,a=>a.snapshot.team.home_hub='foreign',a=>a.snapshot.grant.policy.tools=[],a=>a.snapshot.grant.policy.budget_ids=[],a=>a.snapshot.policies.scheduling.policy.targets.target.internal_price_id=null]){
  const f=fixture(change);await assert.rejects(planCoordinatorStart(f.runtime,input));assert.ok(f.calls.every(c=>!c.body))
 }
 const f=fixture(()=>{},true);await assert.rejects(planCoordinatorStart(f.runtime,input),/changed during planning/)
 await assert.rejects(planCoordinatorStart(f.runtime,{...input,model:'injected'}),/Invalid/)
})

test('recovery planner pins expected control and target instead of selecting an alternate executor',async()=>{
 const f=fixture()
 await assert.rejects(planCoordinatorStart(f.runtime,{...input,expected_control_revision:1}),/expected control changed/)
 await assert.rejects(planCoordinatorStart(f.runtime,{...input,target_id:'foreign'}),/No configured/)
 const result=await planCoordinatorStart(f.runtime,{...input,target_id:'target',expected_control_revision:0})
 assert.equal(result.command.start.target_id,'target')
})

test('initial bootstrap cannot persist a different start under the same identity after another Host wins control',async()=>{
 const f=fixture(active=>{active.snapshot.team.spec.coordinator_startup={workspace_id:'workspace',task_tag:'coordination'}})
 const active=await f.runtime.client.call('/api/v1/messaging/teams/team/activation')
 // Discovery saw no control. A competing Host committed before this plan read.
 const input=coordinatorBootstrapInput('home',active)
 const call=f.runtime.client.call
 f.runtime.client.call=async(path,...args)=>path.endsWith('/coordinator-control')?{control:{revision:1}}:call(path,...args)
 const profiles={coordinatorStartPlans:{},update(){throw Error('Must not persist a reranked conflicting intent')}}
 f.runtime.profiles=profiles
 const host={execution:f.runtime,stop:new AbortController(),coordinatorPlanStarts:new Map(),
  planCoordinatorStart:value=>planCoordinatorStart(f.runtime,value),startCoordinator(){throw Error('Must not dispatch conflicting intent')}}
 assert.equal(input.expected_control_revision,0)
 await assert.rejects(startPlannedCoordinator(host,input),/expected control changed/)
 assert.deepEqual(profiles.coordinatorStartPlans,{})
 assert.ok(f.calls.every(row=>!row.body),'a stale bootstrap cannot reserve or dispatch')
})

test('planner carries only explicitly granted optional clarification control', async () => {
 const f=fixture(active=>active.snapshot.grant.policy.tools.push('kode_coordinator_answer_clarification','unrelated_tool'))
 const result=await planCoordinatorStart(f.runtime,input)
 assert.deepEqual(result.command.start.operation.grant_scope.tools,[...OFFICIAL_COORDINATOR_TOOLS,'kode_coordinator_answer_clarification'])
})

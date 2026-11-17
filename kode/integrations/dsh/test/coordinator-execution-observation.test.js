import test from 'node:test'
import assert from 'node:assert/strict'
import { readAssignedExecution } from '../src/coordinator-read-tools.js'
import { readCoordinatorResources } from '../src/coordinator-resources.js'
const stage={stage_id:'implement',assignment_id:'assignment',attempt:1,state:'ready'},run={id:'run',team_id:'team',state:'waiting_resource',waiting_reason:'assignment_executor_admission_required',stages:[stage]}
function fixture(){const op={id:'operation',attempt:1,epoch:2,state:'active',lease_until:200,worker:{node_id:'home',session_id:'worker'}};const a={id:'assignment',run_id:'run',team_id:'team',stage_id:'implement',stage_attempt:1,worker:op.worker,dispatch:{command:{operation:{id:op.id,attempt:1,epoch:2}}},creation:{state:'created',session_id:'worker'},resources:{state:'held'},mandate:{receipt:{message_id:'mandate'}},admission:{kind:'official_local_host'},private:{credential:'DO_NOT_EXPORT'}};return{a,op,call:async path=>path==='work-assignments/assignment'?a:path==='operations/operation'?op:assert.fail(path)}}
test('ready/waiting_resource run exposes actual created held mandated Worker lease without granting execution',async()=>{
 const f=fixture(),observed=await readAssignedExecution(f.call,run,100)
 assert.equal(observed.items[0].active_worker_lease,true);assert.equal(observed.grants_execution,false);assert.equal(observed.items[0].completion_authorized,false)
 assert.equal(observed.items[0].worker_created,true);assert.equal(JSON.stringify(observed).includes('DO_NOT_EXPORT'),false)
 assert.equal(run.state,'waiting_resource');assert.equal(run.stages[0].state,'ready')
})
test('expired lease, missing mandate or resource hold cannot be relabelled active',async()=>{
 for(const field of ['lease','mandate','resources','creation','admission']){const f=fixture();if(field==='lease')f.op.lease_until=100;else f.a[field]=null;assert.equal((await readAssignedExecution(f.call,run,100)).items[0].active_worker_lease,false)}
})
test('foreign or changed assignment identity cannot expose its operation',async()=>{
 const f=fixture();f.a.team_id='other';let reads=0
 const result=await readAssignedExecution(async path=>{reads++;return f.call(path)},run,100)
 assert.equal(reads,1);assert.equal(result.items[0].active_worker_lease,null);assert.equal(result.items[0].operation_state,undefined)
})
test('static configuration false is explicitly not a live admission refusal',async()=>{
 const result=await readCoordinatorResources(async()=>assert.fail('no configuration available'),{},'team')
 assert.equal(result.eligible_for_execution,false);assert.equal(result.live_admission_status,'not_checked_by_this_read');assert.equal(result.eligibility_basis,'configuration_read_never_grants_execution')
})

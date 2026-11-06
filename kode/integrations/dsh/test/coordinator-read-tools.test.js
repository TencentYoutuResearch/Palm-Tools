import test from 'node:test'
import assert from 'node:assert/strict'
import { readCoordinatorState, clarificationPage } from '../src/coordinator-read-tools.js'

test('Coordinator reads pin authority, isolate teams and explicitly reject oversized details',async()=>{
 const scope={team_id:'team',conversation_id:'conversation',control_revision:1},operation={id:'op',attempt:1,epoch:1},agent={id:'coordinator'}
 const binding={managedOperation:operation,managedCoordinator:scope}
 const control={revision:1,team_id:'team',conversation_id:'conversation',home_hub:'home',worker:{node_id:'home',session_id:agent.id},request:{operation_id:'op',attempt:1,epoch:1,activation_revision:2,team_revision:3}}
 const selected={id:'delivery',workflow:{id:'workflow',version:'1',hash:'hash',pack:{inputs:['request'],completion_stages:['verified']}}}
 const activation={active:true,authority_valid:true,revision:2,team_revision:3,snapshot:{bindings:[selected]}}
 const run={id:'run',team_id:'team',home_hub:'home',revision:4,state:'waiting_resource',team_revision:3,completion_authorized:false,stages:[]}
 const accounting={home_hub:'home',run_id:'run',team_id:'team',run_revision:4,authority:'home_accounting_observation',read_only:true,blocked:false,state:'no_usage_blocker',reason:null,recovery:null,retry_allowed:false,unresolved_calls:[],truncated:false}
 let controlReads=0,changeOnSecond=false
 const runtime={host:'home',profiles:{binding:()=>binding},client:{call:async path=>{
  if(path.endsWith('/coordinator-control')){controlReads++;return {control:{...control,revision:changeOnSecond&&controlReads===2?2:control.revision}}}
  if(path.endsWith('/activation'))return activation
  if(path.endsWith('/work-runs/run/accounting-status'))return accounting
  if(path.endsWith('/work-runs/run'))return run
  assert.fail(`unexpected read ${path}`)
 }}}
 const read=(kind,args)=>{controlReads=0;return readCoordinatorState(runtime,agent,scope,operation,kind,args)}
 assert.deepEqual((await read('configuration',{binding_id:''})).bindings[0].inputs,['request'])
 assert.deepEqual((await read('configuration',{binding_id:'delivery'})).binding,selected)
 const baseStatus=await read('status',{run_id:'run'})
 assert.equal(baseStatus.state,'waiting_resource')
 assert.deepEqual(baseStatus.execution_accounting,accounting)
 run.inputs={request:'Original requirement'};run.prior_run_id='previous'
 run.human_acceptance={state:'rejected',revision:4,evidence_hash:'a'.repeat(64),requested_at:123,
  evidence:{large_body:'x'.repeat(70000)},decision:{choice:'reject',reason:'The output misses the requested behavior',actor:{kind:'human',id:'local_owner'},request_id:'decision'}}
 const status=await read('status',{run_id:'run'})
 assert.deepEqual(status.inputs,run.inputs);assert.equal(status.prior_run_id,'previous')
 assert.deepEqual(status.human_acceptance.decision,run.human_acceptance.decision)
 assert.equal(status.human_acceptance.evidence_hash,'a'.repeat(64))
 assert.equal(status.human_acceptance.evidence_included,false)
 assert.equal(status.human_acceptance.evidence,undefined)
 assert.equal(status.completion_authorized,false)
 run.pending_clarification={assignment_id:'assignment',stage_id:'implement',stage_attempt:1,context_hash:'context',request:{request_id:'question',call_id:'call',questions:[{id:'scope',question:'Which scope?'}],command:{internal_authority:'owner-only'}}}
 const clarification=(await read('status',{run_id:'run'})).worker_clarification
 assert.deepEqual(clarification.questions,[{id:'scope',question:'Which scope?'}])
 assert.equal(clarification.command,undefined);assert.equal(clarification.request_id,'question')
 run.state='cancelled';assert.equal((await read('status',{run_id:'run'})).worker_clarification,null);run.state='waiting_resource'
 delete run.pending_clarification
 run.inputs.request='x'.repeat(65536);await assert.rejects(read('status',{run_id:'run'}),/exceeds bounded/)
 const page=await read('status',{run_id:'run',omit_inputs:true})
 assert.equal(page.inputs,null);assert.equal(page.inputs_included,false)
 run.inputs.request='Original requirement'
 await assert.rejects(read('configuration',{binding_id:'foreign'}),/Unknown activated/)
 run.team_id='foreign';await assert.rejects(read('status',{run_id:'run'}),/outside fixed team/);run.team_id='team'
 changeOnSecond=true;await assert.rejects(read('status',{run_id:'run'}),/control changed/);changeOnSecond=false
 activation.authority_valid=false;await assert.rejects(read('configuration',{binding_id:''}),/activation changed/);activation.authority_valid=true
 selected.extra='x'.repeat(65536);await assert.rejects(read('configuration',{binding_id:'delivery'}),/exceeds bounded/);delete selected.extra
 binding.managedBuilder={draft_id:'draft'};await assert.rejects(read('status',{run_id:'run'}),/binding changed/)
})

test('Concurrent Worker questions page without authority payloads and reject stale cursors',()=>{
 const questions=Array.from({length:3},(_,i)=>({assignment_id:`a${i}`,stage_id:`branch${i}`,stage_attempt:1,
  context_hash:'hash',request:{request_id:`q${i}`,call_id:`c${i}`,questions:[{id:'scope',question:`Scope ${i}?`}],command:{private:'frozen grant'}}}))
 const run={revision:12,state:'running',clarifications:questions,pending_clarification:questions[0]}
 let cursor='',seen=[]
 do{
  const page=clarificationPage(run,cursor)
  seen.push(page.worker_clarification.request_id)
  assert.equal(page.worker_clarifications.count,3)
  assert.equal(JSON.stringify(page).includes('frozen grant'),false)
  cursor=page.worker_clarifications.next_cursor
 }while(cursor!==null)
 assert.deepEqual(seen,['q0','q1','q2'])
 for(const cursor of ['11:1','12:3','12:0','12:-1','garbage'])assert.throws(()=>clarificationPage(run,cursor),/cursor/)
 run.revision=13
 assert.throws(()=>clarificationPage(run,'12:1'),/revision changed/)
 run.state='cancelled'
 assert.equal(clarificationPage(run).worker_clarification,null)
 assert.equal(clarificationPage(run).worker_clarifications.count,0)
})

/** No model calls: validate fixture seams and reject cross-request acceptance evidence. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {readFile} from 'node:fs/promises'
import {liveParallelFixtureSource} from './support/live-parallel-fixture-source.js'
import {scopedRun,terminalReply,detectMissingTerminalReply,settleParallelCoordinator,parallelFailure} from './support/live-parallel-team-pipeline.js'
test('live fixture keeps permissions and budget while using real inbox and preserving its Hub',async()=>{
 const source=await readFile(new URL('./fixture-coordinator-pipeline.js',import.meta.url),'utf8'),generated=liveParallelFixtureSource(source)
 assert.ok(generated.includes('max_active_assignments:2,max_active_runs:2'))
 assert.ok(generated.includes("limit:followupScenario?200:transferScenario?150:100"),'original budget remains unchanged')
 assert.ok(generated.includes('host.coordinatorInbox'))
 assert.ok(generated.includes('live-parallel-team-pipeline.js'))
 assert.ok(generated.includes('live_parallel_retained_hub'))
 assert.ok(generated.includes('timeout:Infinity'))
 assert.equal(spawnSync(process.execPath,['--check','--input-type=module'],{input:generated,encoding:'utf8'}).status,0,'generated native fixture must parse without execution')
 assert.throws(()=>liveParallelFixtureSource(source.replace('max_active_assignments:1,max_active_runs:2','changed seam')),/fixture seam/)
})
const team={id:'team',conversation_id:'conversation'},human={id:'human-A'},run={id:'run-A',revision:9,team_id:'team',state:'completed',delivery:{at:100},inputs:{request:'REQ-A'},coordinator:{source_message_id:'human-A',conversation_id:'conversation'}}
test('intake maps exact source messages, rejects duplicate Runs and cross-team bindings',()=>{
 assert.equal(scopedRun([run],team,human,'REQ-A'),run)
 assert.equal(scopedRun([run],team,{id:'human-B'},'REQ-B'),null)
 assert.throws(()=>scopedRun([run,{...run,id:'duplicate'}],team,human,'REQ-A'))
 assert.throws(()=>scopedRun([{...run,team_id:'other'}],team,human,'REQ-A'))
 assert.throws(()=>scopedRun([{...run,inputs:{request:'REQ-B'}}],team,human,'REQ-A'))
})
test('final reply requires exact source, terminal update revision, marker and post-delivery time',()=>{
 const reply={id:'reply-A',actor:{kind:'superagent'},team_id:'team',conversation_id:'conversation',in_reply_to:'human-A',content:'REQ-A completed',created_at:101,source_update:{run_id:'run-A',revision:9}}
 assert.equal(terminalReply([reply],team,human,run,'REQ-A'),reply)
 for(const patch of [{in_reply_to:'human-B'},{source_update:{run_id:'run-B',revision:9}},{source_update:{run_id:'run-A',revision:8}},{created_at:99}])assert.equal(terminalReply([{...reply,...patch}],team,human,run,'REQ-A'),null)
 assert.throws(()=>terminalReply([{...reply,content:'REQ-B completed'}],team,human,run,'REQ-A'),/omitted requirement marker/)
 assert.throws(()=>terminalReply([{...reply,team_id:'other'}],team,human,run,'REQ-A'))
})

import {deliveryInputId} from '../src/delivery-tracker.js'
function terminalObservation(){
 const update={receipt:{message_id:'notice',run_id:run.id,revision:run.revision,team_id:team.id,conversation_id:team.conversation_id},summary:{source_message_id:human.id}}
 const events=[{seq:1,type:'user/message',data:{id:deliveryInputId('notice'),source:{form:'kode-coordinator-run-update',runId:run.id,revision:run.revision,sourceMessageId:human.id}}}]
 let idleCalls=0
 const owned={agent:{session:{snapshotEvents:()=>events},whenIdle:async()=>{idleCalls++}}}
 return {update,events,owned,idleCalls:()=>idleCalls,options:{owned,team,humans:[human],runs:[run],call:async()=>({update}),readMessages:async()=>[],settle:async()=>{}}}
}
test('consumed terminal update followed by settled natural idle fails if exact reply is missing',async()=>{
 const f=terminalObservation()
 await assert.rejects(detectMissingTerminalReply(f.options),/omitted exact final reply/)
 assert.equal(f.idleCalls(),2)
})
test('unconsumed update or newly arriving activity does not manufacture a terminal omission',async()=>{
 const f=terminalObservation();f.events.length=0
 await detectMissingTerminalReply(f.options);assert.equal(f.idleCalls(),0)
 const moving=terminalObservation();moving.options.settle=async()=>moving.events.push({seq:2,type:'agent/progress',data:{}})
 await detectMissingTerminalReply(moving.options);assert.equal(moving.idleCalls(),2)
})
test('publication completed during natural idle is observed before declaring omission',async()=>{
 const f=terminalObservation();f.options.readMessages=async()=>[{actor:{kind:'superagent'},team_id:team.id,conversation_id:team.conversation_id,in_reply_to:human.id,source_update:{run_id:run.id,revision:run.revision},created_at:101,content:'REQ-A complete'}]
 await detectMissingTerminalReply(f.options)
})
test('official close reuses exact persisted intent, never substitutes finish/dispose for accounting',async()=>{
 for(const existing of [false,true]){
  const op={id:'op',attempt:2,epoch:3},command={request_id:'existing-close',attempt:2,epoch:3,price_id:'price',settlement:'internal_price',idle_only:true},calls=[]
  const owned={agent:{id:'coordinator',whenIdle:async()=>{}},run:{finish(){throw Error('direct finish forbidden')}},dispose(){throw Error('direct dispose forbidden')}}
  const host={coordinatorCloseRecovery:{close:async()=>{}},closeCoordinator:async input=>{calls.push(input);return{state:'closed'}}}
  const call=async path=>path==='budgets/budget'?{budget:{spent:22,reserved:0,limit:100}}:{operation:op,intent:existing?{request:command}:null}
  await settleParallelCoordinator({host,owned,profiles:{binding:()=>({managedOperation:op})},call})
  assert.equal(calls.length,1);assert.equal(calls[0].operation_id,'op')
  if(existing)assert.deepEqual(calls[0].command,command)
  else assert.deepEqual(calls[0].command,{request_id:'parallel-team-final-close',attempt:2,epoch:3,price_id:'price',settlement:'internal_price'})
 }
})
test('official close preserves unsettled accounting as a failure',async()=>{
 const op={id:'op',attempt:1,epoch:1},owned={agent:{id:'coordinator',whenIdle:async()=>{}}},profiles={binding:()=>({managedOperation:op})}
 const host={coordinatorCloseRecovery:{close:async()=>{}},closeCoordinator:async()=>({state:'closed'})}
 await assert.rejects(settleParallelCoordinator({host,owned,profiles,call:async path=>path==='budgets/budget'?{budget:{spent:22,reserved:39,limit:100}}:{operation:op,intent:null}}))
 host.closeCoordinator=async()=>({state:'closing'})
 await assert.rejects(settleParallelCoordinator({host,owned,profiles,call:async()=>({operation:op,intent:null})}),/must complete/)
})

test('failure metadata retains classification and site without prompts or secrets',()=>{
 const e=Object.assign(Error('Terminal reply omitted requirement marker: REQ-A SECRET_PROMPT'),{name:'AssertionError',code:'ERR_ASSERTION',actual:'SECRET_VALUE',expected:0,operator:'strictEqual'})
 e.stack='AssertionError SECRET_PROMPT at /private/SECRET_PATH/test/support/live-parallel-team-pipeline.js:140:8'
 const result=parallelFailure(e),text=JSON.stringify(result)
 assert.equal(result.reason,'terminal_marker_missing');assert.equal(result.actual,null);assert.equal(result.expected,0)
 assert.deepEqual(result.sites,['live-parallel-team-pipeline.js:140:8']);assert.ok(!text.includes('SECRET'))
})

import {assertExpectedTerminal,detectMissingIntake} from './support/live-parallel-team-pipeline.js'
test('unexpected terminal fails without treating resource waits as terminal',()=>{
 for(const state of ['failed','cancelled'])assert.throws(()=>assertExpectedTerminal({state},'completed'),/unexpected terminal/)
 for(const state of ['running','blocked','waiting_resource','completed'])assertExpectedTerminal({state},'completed')
 assertExpectedTerminal({state:'cancelled'},'cancelled')
})
test('consumed intake needs stable idle and a missing Run before failing',async()=>{
 const events=[{seq:1,type:'user/message',data:{id:deliveryInputId('input')}}]
 let idle=0
 const options={owned:{agent:{session:{snapshotEvents:()=>events},whenIdle:async()=>{idle++}}},team,human,call:async()=>({input:{receipt:{message_id:'input',source_message_id:human.id,team_id:team.id,conversation_id:team.conversation_id}}}),readRun:async()=>null,settle:async()=>{}}
 await assert.rejects(detectMissingIntake(options),/omitted Run/);assert.equal(idle,2)
 await detectMissingIntake({...options,readRun:async()=>run})
 await detectMissingIntake({...options,settle:async()=>events.push({seq:2})})
 events.length=0;idle=0;await detectMissingIntake(options);assert.equal(idle,0)
})

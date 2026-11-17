/** Controlled cancellation regressions against the production state machine; not live drain evidence. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { advanceWorkRunCancellation } from '../src/work-run-cancellation.js'
function fixture({handle=false,binding,assignment:patch={}}={}) {
 const calls=[], stops=[];
 const run={id:'run-1',home_hub:'home',revision:4,state:'cancelling',cancellation:{assignment_ids:['a-1']}};
 const assignment={id:'a-1',run_id:'run-1',revision:2,creation:{state:'created'},worker:{node_id:'home',session_id:'s-1'},...patch};
 const controller={runtime:{host:'home',profiles:{binding:()=>binding}},host:{handles:new Map(handle?[['s-1',{}]]:[])},cursor:new Map(),dispatcher:{stop:async id=>{stops.push(id)}}};
 const call=async (path,body)=>{calls.push({path,body});if(path.includes('/work-runs/'))throw new Error('kode backend (400): cancellation pending: execution');return assignment};
 return {run,assignment,controller,call,calls,stops};
}
test('lost handle cannot manufacture drain evidence',async()=>{const f=fixture();assert.equal((await advanceWorkRunCancellation(f.controller,f.run,f.call)).state,'cancel_unconfirmed');assert.deepEqual(f.stops,[])});
test('owned live handle is drained through dispatcher',async()=>{const f=fixture({handle:true});assert.equal((await advanceWorkRunCancellation(f.controller,f.run,f.call)).state,'cancellation_execution_drained');assert.deepEqual(f.stops,['a-1'])});
test('persisted drained binding supports recovery without live handle',async()=>{const f=fixture({binding:{assignmentStop:{state:'drained'}}});await advanceWorkRunCancellation(f.controller,f.run,f.call);assert.deepEqual(f.stops,['a-1'])});
test('non-drained persisted binding cannot assert stop',async()=>{const f=fixture({binding:{assignmentStop:{state:'stopping'}}});assert.equal((await advanceWorkRunCancellation(f.controller,f.run,f.call)).state,'cancel_unconfirmed')});
test('remote worker is never stopped by home host',async()=>{const f=fixture({handle:true,assignment:{worker:{node_id:'remote',session_id:'s-1'}}});assert.equal((await advanceWorkRunCancellation(f.controller,f.run,f.call)).state,'waiting_remote_cancellation');assert.deepEqual(f.stops,[])});
test('assignment identity mismatch fails closed',async()=>{const f=fixture({assignment:{run_id:'other'}});await assert.rejects(advanceWorkRunCancellation(f.controller,f.run,f.call),/another Run/);assert.deepEqual(f.stops,[])});
test('uncreated assignment waits for disposition',async()=>{const f=fixture({assignment:{creation:{state:'reserved'}}});assert.equal((await advanceWorkRunCancellation(f.controller,f.run,f.call)).state,'waiting_cancellation_disposition')});
test('empty cancellation waits for accounting',async()=>{const f=fixture();f.run.cancellation.assignment_ids=[];assert.equal((await advanceWorkRunCancellation(f.controller,f.run,f.call)).state,'waiting_cancellation_accounting')});
test('unresolved usage does not release cancellation',async()=>{const f=fixture({assignment:{stop:{receipt:'stopped'}}});const call=async(p,b)=>{if(p.endsWith('/accounting'))throw new Error('kode backend (400): official usage remains unresolved');return f.call(p,b)};const r=await advanceWorkRunCancellation(f.controller,f.run,call);assert.equal(r.state,'waiting_cancellation_accounting');assert.equal(r.reason,'usage_reconciliation_required')});
test('valid final cancellation requires confirmed stop and released resources',async()=>{const f=fixture();const r=await advanceWorkRunCancellation(f.controller,f.run,async()=>({state:'cancelled',cancellation:{stop_confirmed:true,resources_released:true,receipt:'receipt'}}));assert.equal(r.state,'cancelled');assert.equal(r.receipt,'receipt')});
test('incomplete final receipt is rejected',async()=>{for(const receipt of [{stop_confirmed:true,resources_released:false},{stop_confirmed:false,resources_released:true}]){const f=fixture();await assert.rejects(advanceWorkRunCancellation(f.controller,f.run,async()=>({state:'cancelled',cancellation:receipt})),/Invalid final stop receipt/)}});
test('home identity mismatch prevents all calls',async()=>{const f=fixture();f.run.home_hub='other';await assert.rejects(advanceWorkRunCancellation(f.controller,f.run,f.call),/Invalid home stop context/);assert.equal(f.calls.length,0)});
test('takeover uses separate finalize endpoint action',async()=>{const f=fixture();f.run.state='taking_over';f.run.intervention={assignment_ids:['a-1']};const r=await advanceWorkRunCancellation(f.controller,f.run,async(p,b)=>{assert.equal(b.action,'finalize_takeover');return {state:'paused',intervention:{stop_confirmed:true,resources_released:true,receipt:'paused'}}});assert.equal(r.state,'paused')});

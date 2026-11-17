import test from 'node:test'
import assert from 'node:assert/strict'
import {createScopedCoordinatorModel} from '../src/scoped-coordinator-model.js'
import {contextScopeKey,discussionScopeId} from '../src/context-scope.js'
function fixture(){
  const scope={version:2,home_hub:'home',team_id:'team',kind:'discussion_thread',scope_id:discussionScopeId('surface','thread'),context_epoch:1}
  const key=contextScopeKey(scope),a={context_key:key,context_scope:scope,session_id:`context-${key}`,journal_id:'journal',operation_id:'op'}
  const envelope={runtime_ready:true,dispatch_allowed:true,stage:'runtime',authority:a},events=[],stop=new AbortController()
  const state={acquires:0,dispatches:0},route={provider:'fixture',model:'model'}
  const permit={authority:a,route,lease:{signal:stop.signal,assertActive:async()=>stop.signal.throwIfAborted()},
    policy:{callId:'call',admit:async identity=>events.push({kind:'admitted',...identity}),record:async e=>events.push(e)}}
  const options={authority:a,resolveAuthority:async()=>structuredClone(envelope),acquirePermit:async()=>{state.acquires++;return permit},
    dispatch:async function*(){state.dispatches++;yield{type:'usage',usage:{inputTokens:2,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}};yield{type:'finish',reason:{kind:'stop'}}}}
  const request={sessionId:a.session_id,...route,messages:[],tools:[]}
  return {a,envelope,events,state,permit,options,request,stop,run:async()=>{for await(const _ of createScopedCoordinatorModel(options)(request)){}}}
}
test('unready model bridge acquires no lease or provider',async()=>{
  const f=fixture();f.envelope.runtime_ready=false
  await assert.rejects(f.run(),/authority unavailable/);assert.equal(f.state.acquires,0);assert.equal(f.state.dispatches,0)
})
test('scope bridge retains original begin usage finish accounting lifecycle',async()=>{
  const f=fixture();await f.run()
  assert.deepEqual(f.events.map(e=>e.kind),['admitted','started','usage','finished'])
  assert.equal(f.events[2].usage.counters.input_tokens,2);assert.equal(f.events[3].session_id,f.a.session_id)
})
test('wrong permit journal or route cannot dispatch',async()=>{
  for(const mutate of [f=>f.permit.authority={...f.a,journal_id:'foreign'},f=>f.permit.route={provider:'other',model:'model'}]){
    const f=fixture();mutate(f);await assert.rejects(f.run(),/Exact operation/);assert.equal(f.state.dispatches,0)
  }
})
test('authority lost after begin ack records interrupted and no provider',async()=>{
  const f=fixture();f.permit.policy.admit=async()=>{f.envelope.runtime_ready=false}
  await assert.rejects(f.run(),/authority unavailable/);assert.equal(f.state.dispatches,0)
  assert.equal(f.events.at(-1).kind,'interrupted');assert.equal(f.events.at(-1).usage.reason,'lease_lost_before_dispatch')
})
test('midstream revocation reports uncertain and never completed',async()=>{
  const f=fixture();f.options.dispatch=async function*(){yield{type:'text',text:'first'};f.envelope.runtime_ready=false;yield{type:'finish',reason:{kind:'stop'}}}
  await assert.rejects(f.run(),/authority unavailable/)
  assert.equal(f.events.at(-1).kind,'interrupted');assert.equal(f.events.at(-1).outcome,'uncertain')
  assert.equal(f.events.some(e=>e.kind==='finished'),false)
})
test('consumer cancellation retains interruption evidence',async()=>{
  const f=fixture(),stream=createScopedCoordinatorModel(f.options)(f.request)
  await stream.next();await stream.return()
  assert.equal(f.events.at(-1).kind,'interrupted')
})
test('expired lease without signal abort cannot dispatch or record finish',async()=>{
  const f=fixture();let checks=0
  f.permit.lease.assertActive=async()=>{if(++checks>=3)throw Error('lease expired without signal')}
  await assert.rejects(f.run(),/lease expired/)
  assert.equal(f.stop.signal.aborted,false);assert.equal(f.state.dispatches,0)
  assert.equal(f.events.at(-1).kind,'interrupted')
  assert.equal(f.events.some(e=>e.kind==='finished'),false)
})
test('lease expiration during chunks cannot record a completed call',async()=>{
  const f=fixture();let active=true
  f.permit.lease.assertActive=async()=>{if(!active)throw Error('lease expired')}
  f.options.dispatch=async function*(){yield{type:'text',text:'partial'};active=false;yield{type:'finish',reason:{kind:'stop'}}}
  await assert.rejects(f.run(),/lease expired/)
  assert.equal(f.stop.signal.aborted,false);assert.equal(f.events.at(-1).kind,'interrupted')
})

/** Offline integration: real DSH roots/transport, real lease/outboxes, strict
 * in-process ledger. Fixture readiness is NOT production authorization. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Context} from '@deepseek-ai/cordis'
import LlmRuntime,{LlmAdapter} from '@deepseek-ai/dsh-llm'
import {acquireOperationLease} from '../src/operation-lease.js'
import {OfficialCallOutbox} from '../src/official-call-outbox.js'
import {SelectionOutbox} from '../src/selection-outbox.js'
import {createScopedCoordinatorModel} from '../src/scoped-coordinator-model.js'
import {createScopedCoordinatorCallOwner} from '../src/scoped-coordinator-call-owner.js'
import {createScopedCoordinatorRoot} from '../src/scoped-coordinator-root.js'
import {publicTextHash} from '../src/scoped-coordinator-prompt.js'
import {openScopedCoordinatorProfiles} from '../src/scoped-coordinator-profiles.js'
import {contextScopeKey,discussionScopeId} from '../src/context-scope.js'

async function fixture(t,mode='normal',owned=false,label='thread'){
  const dir=await mkdtemp(join(tmpdir(),'kode-scoped-accounting-')),file=join(dir,'only-session.json')
  const scope={version:2,home_hub:'fixture',team_id:'team',kind:label==='dm'?'team_private':'discussion_thread',scope_id:discussionScopeId('surface',label),context_epoch:1}
  const key=contextScopeKey(scope),session=`context-${key}`,operation={id:'operation',attempt:1,epoch:1}
  const authority={context_key:key,context_scope:scope,session_id:session,journal_id:'journal',operation_id:operation.id}
  const route={provider:'local-fixture',model:'fixture'},policy={scope:'executor_configuration',profile_revision:1,model:'fixture',effort:null}
  const worker={node_id:'fixture',session_id:session,grant_enforcement:true}
  const state={row:{...operation,worker,revision:1,state:'prepared',selection_policy:policy,grant_required:true,grant_available:true,
    budget_required:true,budget_available:mode!=='budget',lease_duration_ms:30000},provider:0,parentHooks:0,commands:[],calls:new Map(),selections:[],requests:[]}
  const profileOptions={path:file,authority,binding:{managedOperation:operation,revision:1}}
  let profiles=await openScopedCoordinatorProfiles({...profileOptions,mode:'fresh'})
  const client={async call(path,body){
    if(path===`/api/v1/messaging/operations/${operation.id}`){
      if(!body)return structuredClone(state.row)
      assert.equal(body.attempt,1);assert.equal(body.epoch,1);assert.equal(body.expected_revision,state.row.revision)
      assert.ok(['claim','renew','report'].includes(body.action.kind));state.commands.push(body.action.kind)
      if(body.action.kind!=='report'){assert.deepEqual(body.selection_ack,policy);if(!state.row.budget_available)throw Error('fixture budget denied')}
      state.row={...state.row,revision:state.row.revision+1,state:body.action.kind==='report'?'reported':'active'}
      if(mode==='lost_claim'&&body.action.kind==='claim')throw Error('fixture claim response lost')
      return {applied:true,operation:structuredClone(state.row)}
    }
    if(path==='/api/v1/messaging/selection-evidence'){
      assert.equal(body.worker_session,session);assert.equal(body.operation_id,operation.id)
      const rejected=mode==='selection'||body.model.observed!==policy.model;state.selections.push(structuredClone(body))
      return {sequence:state.selections.length,rejected,evidence:structuredClone(body)}
    }
    if(path==='/api/v1/messaging/official-calls'){
      assert.equal(body.worker_session,session);assert.equal(body.operation_id,operation.id);assert.equal(body.attempt,1);assert.equal(body.epoch,1)
      assert.equal(body.provider,route.provider);assert.equal(body.model,route.model)
      assert.equal(state.row.state,'active');assert.equal(state.row.budget_available,true)
      assert.equal(state.calls.has(body.call_id),false)
      const call={request:structuredClone(body),sequence:0,events:[]};state.calls.set(body.call_id,call)
      if(mode==='lost_begin')throw Error('fixture begin response lost')
      return {duplicate:false,call:structuredClone(call)}
    }
    const match=path.match(/^\/api\/v1\/messaging\/official-calls\/([^/]+)(\/events)?$/)
    if(match){
      const call=state.calls.get(match[1]);assert.ok(call)
      if(!match[2])return structuredClone(call)
      assert.equal(body.sequence,call.sequence+1);assert.ok(['usage','finished','interrupted'].includes(body.kind))
      assert.ok(!call.events.some(e=>e.kind!=='usage'));call.events.push(structuredClone(body));call.sequence++
      return {call:structuredClone(call)}
    }
    throw Error(`Unexpected fixture endpoint ${path}`)
  }}
  const transport=new Context(),parent=new Context();await transport.plugin(LlmRuntime);await parent.plugin(LlmRuntime)
  parent.on('llm/stream',()=>{state.parentHooks++;throw Error('PARENT_CANARY')},{global:true})
  class Deterministic extends LlmAdapter{async *stream(request){
    state.provider++;assert.equal(request.sessionId,session);assert.doesNotMatch(JSON.stringify(request.messages),/PARENT_CANARY/)
    state.requests.push(structuredClone({sessionId:request.sessionId,messages:request.messages,tools:request.tools??[],toolHistory:request.toolHistory}))
    yield {type:'usage',usage:{inputTokens:2,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}
    if(mode==='revoke')state.row.epoch++
    if(mode==='renew')state.row.revision++
    yield {type:'block-start',index:0,blockType:'text'}
    yield {type:'block-end',index:0,block:{type:'text',text:'LOCAL_ACCOUNTED'}}
    yield {type:'finish',reason:{kind:'stop'}}
  }}
  transport.llm.registerAdapter([route.provider],new Deterministic())
  const outbox=new OfficialCallOutbox(client,profiles),selection=new SelectionOutbox(client,profiles)
  let lease,prepared
  const manualModel=createScopedCoordinatorModel({authority,resolveAuthority:async()=>({runtime_ready:true,dispatch_allowed:true,stage:'runtime',authority}),
    acquirePermit:async()=>{
      lease??=await acquireOperationLease(client,operation,worker,{beforeClaim:async p=>{assert.deepEqual(p,policy);return true}})
      prepared=await transport.llm.prepareCall(route,lease.signal)
      assert.deepEqual(prepared.config,route)
      const callPolicy=outbox.policy(session,operation,()=>lease.assertActive())
      await selection.record(session,{operation,profile_revision:1,threadId:session,turnId:callPolicy.callId,inputIds:['input'],scope:policy.scope,observed_at:1,
        source:'official_prepared_call',model:{requested:'fixture',observed:mode==='selection'?'wrong':prepared.config.model,status:'reported'},effort:{requested:null,observed:null,status:'unverifiable'}})
      selection.assertSettled(session,operation,policy)
      return {authority:mode==='journal'?{...authority,journal_id:'foreign'}:mode==='operation'?{...authority,operation_id:'foreign'}:mode==='scope'?{...authority,context_key:'f'.repeat(64)}:authority,lease,route,policy:callPolicy}
    },dispatch:request=>prepared.stream(request)})
  const admittedAuthority=()=>mode==='journal'?{...authority,journal_id:'foreign'}:mode==='operation'?{...authority,operation_id:'foreign'}:mode==='scope'?{...authority,context_key:'f'.repeat(64)}:authority
  const owner=owned?await createScopedCoordinatorCallOwner({authority,operation,worker,route,profileRevision:1,profiles,client,
    inputIds:['input'],installAdapters:async registry=>registry.registerAdapter([route.provider],new Deterministic()),
    resolveLeaseAdmission:async()=>({claim_allowed:mode!=='not_ready'&&state.row.state==='prepared',authority:admittedAuthority()}),
    resolveAdmission:async()=>({runtime_ready:state.row.state==='active',dispatch_allowed:state.row.state==='active',stage:'runtime',authority:admittedAuthority()})}):null
  const model=owner?request=>owner.stream(request):manualModel
  const text=`EXPLICIT_PUBLIC_${label}`,root=await createScopedCoordinatorRoot({persistenceRoot:join(dir,'journals'),modelRoute:route,
    resolveAuthority:()=>({context_scope:scope,session_id:session,journal_id:'journal'}),
    resolvePublicManifest:()=>({version:1,context_key:key,procedure:{text,sha256:publicTextHash(text)},shared:[],tools:[]}),dispatch:model})
  t.after(async()=>{try{await root.close();await owner?.close();lease?.dispose();await selection.close();await transport.fiber.dispose();await parent.fiber.dispose();await profiles.close()}finally{await rm(dir,{recursive:true,force:true})}})
  await root.create(key)
  return {state,outbox,profiles,file,client,
    reopenProfiles:async()=>{await profiles.close();profiles=await openScopedCoordinatorProfiles({...profileOptions,mode:'restore'});return profiles},
    run:(inputId='input')=>root.followup(key,{inputId,text:`ONLY_THIS_SCOPE_${label}`})}
}
test('real independent root + lease + durable selection/call ledgers completes locally',async t=>{
  const f=await fixture(t);const result=await f.run();assert.equal(result.finalText,'LOCAL_ACCOUNTED')
  assert.equal(f.state.provider,1);assert.equal(f.state.parentHooks,0);assert.deepEqual(f.state.commands,['claim'])
  assert.deepEqual([...f.state.calls.values()][0].events.map(e=>e.kind),['usage','finished'])
  const saved=JSON.parse(await readFile(f.file,'utf8'));assert.equal(Object.values(Object.values(saved.bindings)[0].officialCalls)[0].done,true)
  assert.equal(f.state.selections.length,1)
})
for(const mode of ['budget','selection','scope','journal','operation'])test(`${mode} mismatch denies before provider`,async t=>{
  const f=await fixture(t,mode);await assert.rejects(f.run());assert.equal(f.state.provider,0);assert.equal(f.state.calls.size,0);assert.equal(f.state.parentHooks,0)
})
test('lease revocation interrupts actual call ledger, never records finished',async t=>{
  const f=await fixture(t,'revoke');await assert.rejects(f.run())
  assert.equal(f.state.provider,1);assert.deepEqual([...f.state.calls.values()][0].events.map(e=>e.kind),['usage','interrupted'])
})
test('lost begin response recovers durable evidence without another inference or begin',async t=>{
  const f=await fixture(t,'lost_begin');await assert.rejects(f.run());assert.equal(f.state.provider,0);assert.equal(f.state.calls.size,1)
  const restarted=new OfficialCallOutbox(f.client,await f.reopenProfiles());await restarted.recover()
  assert.equal(f.state.provider,0);assert.equal(f.state.calls.size,1)
  assert.deepEqual([...f.state.calls.values()][0].events.map(e=>e.kind),['interrupted'])
  await assert.rejects(f.run());assert.equal(f.state.provider,0)
})
test('Host call owner joins Prepared claim to Active admission and real isolated model request',async t=>{
  const f=await fixture(t,'normal',true);assert.equal((await f.run()).finalText,'LOCAL_ACCOUNTED')
  assert.equal(f.state.provider,1);assert.equal(f.state.parentHooks,0);assert.deepEqual(f.state.commands,['claim'])
  assert.deepEqual([...f.state.calls.values()][0].events.map(e=>e.kind),['usage','finished'])
})
for(const mode of ['budget','selection','scope','journal','operation'])test(`Host call owner rejects ${mode} before provider`,async t=>{
  const f=await fixture(t,mode,true);await assert.rejects(f.run())
  assert.equal(f.state.provider,0);assert.equal(f.state.calls.size,0);assert.equal(f.state.parentHooks,0)
})
test('Host call owner preserves interruption accounting after lease revocation',async t=>{
  const f=await fixture(t,'revoke',true);await assert.rejects(f.run())
  assert.equal(f.state.provider,1);assert.deepEqual([...f.state.calls.values()][0].events.map(e=>e.kind),['usage','interrupted'])
})
test('Host call owner lost begin recovers evidence without repeating inference',async t=>{
  const f=await fixture(t,'lost_begin',true);await assert.rejects(f.run())
  await assert.rejects(f.run('different-input'))
  assert.equal(f.state.provider,0);const recovered=new OfficialCallOutbox(f.client,await f.reopenProfiles());await recovered.recover()
  assert.equal(f.state.calls.size,1);assert.deepEqual([...f.state.calls.values()][0].events.map(e=>e.kind),['interrupted'])
})
test('Host call owner does not claim or infer when scope claim admission is unavailable',async t=>{
  const f=await fixture(t,'not_ready',true);await assert.rejects(f.run())
  assert.deepEqual(f.state.commands,[]);assert.equal(f.state.provider,0)
})
test('Host call owner loses claim response without retrying claim or inference',async t=>{
  const f=await fixture(t,'lost_claim',true);await assert.rejects(f.run());await assert.rejects(f.run())
  assert.deepEqual(f.state.commands,['claim']);assert.equal(f.state.provider,0);assert.equal(f.state.calls.size,0)
})
test('Host call owner accepts lease observation revision changes without changing scope identity',async t=>{
  const f=await fixture(t,'renew',true);assert.equal((await f.run()).finalText,'LOCAL_ACCOUNTED')
  assert.equal(f.state.row.revision,3);assert.equal(f.state.provider,1)
})
test('concurrent thread A, thread B and DM actual model requests never inherit each other',async t=>{
  const labels=['threadA','threadB','dm'],fixtures=await Promise.all(labels.map(label=>fixture(t,'normal',true,label)))
  await Promise.all(fixtures.map(f=>f.run()))
  const ids=new Set()
  for(let i=0;i<fixtures.length;i++){
    const f=fixtures[i],request=f.state.requests[0],actual=JSON.stringify(request.messages)
    ids.add(request.sessionId);assert.deepEqual(request.tools,[])
    assert.match(actual,new RegExp(`ONLY_THIS_SCOPE_${labels[i]}`));assert.match(actual,new RegExp(`EXPLICIT_PUBLIC_${labels[i]}`))
    for(const other of labels.filter(label=>label!==labels[i]))assert.doesNotMatch(actual,new RegExp(`(?:ONLY_THIS_SCOPE|EXPLICIT_PUBLIC)_${other}`))
    assert.equal(f.state.parentHooks,0);assert.equal(f.state.calls.size,1)
    assert.equal([...f.state.calls.values()][0].request.worker_session,request.sessionId)
  }
  assert.equal(ids.size,3)
})

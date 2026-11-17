/** Real AgentLoop, local deterministic transport, temporary JSONL only. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Context} from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {createScopedCoordinatorRoot,SCOPED_LOCAL_INPUT_RECORD} from '../src/scoped-coordinator-root.js'
import {publicTextHash,PUBLIC_MANIFEST_RECORD} from '../src/scoped-coordinator-prompt.js'
import {contextScopeKey,discussionScopeId} from '../src/context-scope.js'
import {scopedToolSchema,SCOPED_TOOL_IMPLEMENTATION,scopedToolRequestId} from '../src/scoped-tool-invocation.js'
const route={provider:'local-fixture',model:'fixture'}
const text=text=>({text,sha256:publicTextHash(text)})
function fixtures(name,kind='discussion_thread'){
  const context_scope={version:2,home_hub:'home',team_id:'team',kind,scope_id:discussionScopeId('surface',name),context_epoch:1}
  const key=contextScopeKey(context_scope)
  return{key,authority:{context_scope,session_id:`context-${key}`,journal_id:`journal-${name}`},
    manifest:{version:1,context_key:key,procedure:text('PUBLIC_PROCEDURE'),shared:[{id:'public-knowledge',revision:1,...text('EXPLICIT_SHARED_CANARY')}],tools:[]}}
}
async function files(root){const result=[];for(const d of await readdir(root,{withFileTypes:true})){const p=join(root,d.name);if(d.isDirectory())result.push(await files(p));else if(d.name.endsWith('.jsonl'))result.push(await readFile(p,'utf8'))}return result.join('\n')}
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'kode-isolated-root-')),records=new Map(),requests=[],captures=new Map()
  const make=(extra={})=>createScopedCoordinatorRoot({persistenceRoot:root,modelRoute:route,
    resolveAuthority:key=>records.get(key)?.authority,resolvePublicManifest:key=>records.get(key)?.manifest,
    testCapture:(key,snapshot)=>captures.set(key,snapshot),
    dispatch:async function*(r){requests.push({sessionId:r.sessionId,messages:structuredClone(r.messages),tools:structuredClone(r.tools)})
      yield{type:'block-start',index:0,blockType:'text'}
      yield{type:'block-end',index:0,block:{type:'text',text:'LOCAL_COMPLETED'}}
      yield{type:'finish',reason:{kind:'stop'}}},...extra})
  const api=await make();t.after(async()=>{await api.close();await rm(root,{recursive:true,force:true})})
  return{root,records,requests,captures,api,make,add(name,kind){const f=fixtures(name,kind);records.set(f.key,f);return f}}
}
test('actual independent roots exclude parent providers and ordinary/global/internal hooks before journal/model entry',async t=>{
  const f=await fixture(t),parent=new Context();t.after(()=>parent.fiber.dispose())
  await parent.plugin(SystemPrompt)
  parent.systemPrompt.section({name:'private',order:0,text:'PARENT_PRIVATE_SECTION'})
  parent.systemPrompt.variable('private',()=>{throw Error('PARENT_PRIVATE_VARIABLE')})
  parent.systemPrompt.context({name:'private-context',order:0,required:true,text:'PARENT_PRIVATE_CONTEXT'})
  parent.systemPrompt.tools(()=>({schemas:[{name:'private',description:'PARENT_PRIVATE_TOOL',parameters:{}}]}))
  let hooks=0
  for(const name of ['agent/pre-step','agent/created','session/event','system-prompt/assemble','internal/dispatch']){
    parent.on(name,()=>{hooks++;throw Error('PARENT_PRIVATE_HOOK')})
    parent.on(name,()=>{hooks++;throw Error('PARENT_PRIVATE_GLOBAL_HOOK')},{global:true})
  }
  for(const [name,kind] of [['A','discussion_thread'],['B','discussion_thread'],['DM','team_private']]){
    const row=f.add(name,kind)
    await f.api.create(row.key)
    const result=await f.api.followup(row.key,{inputId:`input-${name}`,text:`INPUT_ONLY_${name}`})
    assert.equal(result.state,'completed');assert.equal(result.published,false)
    assert.equal(result.finalText,'LOCAL_COMPLETED')
    assert.equal(result.events,undefined);assert.equal(result.messages,undefined)
    const dump=JSON.stringify(f.captures.get(row.key))
    assert.match(dump,/EXPLICIT_SHARED_CANARY/);assert.match(dump,/PUBLIC_PROCEDURE/)
    assert.match(dump,new RegExp(`INPUT_ONLY_${name}`));assert.doesNotMatch(dump,/PARENT_PRIVATE/)
    for(const other of ['A','B','DM'])if(other!==name)assert.ok(!dump.includes(`INPUT_ONLY_${other}"`))
    assert.equal(f.captures.get(row.key).events.filter(e=>e.type===PUBLIC_MANIFEST_RECORD).length,1)
  }
  assert.equal(hooks,0);assert.equal(f.requests.length,3)
  for(const r of f.requests){assert.deepEqual(r.tools,[]);assert.doesNotMatch(JSON.stringify(r),/PARENT_PRIVATE/)}
  assert.doesNotMatch(await files(f.root),/PARENT_PRIVATE/)
  assert.match(await files(f.root),/EXPLICIT_SHARED_CANARY/)
})
test('factory restore binds original public manifest and generation; one backend writer only',async t=>{
  const f=await fixture(t),a=f.add('A')
  await f.api.create(a.key);await f.api.followup(a.key,{inputId:'first',text:'FIRST_INPUT'})
  const other=await f.make();t.after(()=>other.close())
  await assert.rejects(other.restore(a.key))
  await f.api.close(a.key)
  await f.api.restore(a.key)
  await assert.rejects(f.api.followup(a.key,{inputId:'first',text:'FIRST_INPUT'}),/already recorded/)
  await assert.rejects(f.api.followup(a.key,{inputId:'first',text:'CHANGED'}),/hash conflict/)
  await f.api.followup(a.key,{inputId:'second',text:'SECOND_INPUT'})
  assert.match(JSON.stringify(f.captures.get(a.key)),/FIRST_INPUT/)
  assert.equal(f.captures.get(a.key).events.filter(e=>e.type===PUBLIC_MANIFEST_RECORD).length,1)
  await f.api.close(a.key)
  const original=structuredClone(a.manifest)
  a.manifest.shared[0]={id:'public-knowledge',revision:2,...text('CHANGED_SHARED')}
  await assert.rejects(f.api.restore(a.key),/manifest.*changed/)
  a.manifest=original;a.authority.journal_id='different-generation'
  await assert.rejects(f.api.restore(a.key),/origin or generation/)
})
test('unapproved manifest shape/hash/target and mutable authority reject without provider dispatch',async t=>{
  const f=await fixture(t),a=f.add('A'),original=structuredClone(a.manifest)
  for(const mutate of [m=>m.procedure.sha256='0'.repeat(64),m=>m.context_key='0'.repeat(64),m=>m.tools=[{name:'memory_search'}]]){
    a.manifest=structuredClone(original);mutate(a.manifest);await assert.rejects(f.api.create(a.key),/manifest/)
  }
  a.manifest=original;await f.api.create(a.key)
  a.manifest.procedure=text('CHANGED_PUBLIC')
  await assert.rejects(f.api.followup(a.key,{inputId:'x',text:'NEVER_DISPATCH'}),/manifest changed/)
  assert.equal(f.requests.length,0)
})
test('actual scoped tools schemas, results and fixed-source publication never cross roots or replay on restore',async t=>{
  const f=await fixture(t),states=new Map(),claims=new Map(),calls=[],requests=[],steps=new Map()
  const api=await f.make({resolveToolManifest:key=>states.get(key),resolveClaimAuthority:key=>({runtime_ready:true,dispatch_allowed:true,stage:'runtime',...claims.get(key)}),
    invokeGranted:async request=>{calls.push(request);const{args,...provenance}=request;return{status:'completed',receipt_id:`receipt-${calls.length}`,provenance,data:{text:`RESULT_${request.authority.operation_id}`}}},
    dispatch:async function*(request){
      requests.push({sessionId:request.sessionId,tools:structuredClone(request.tools),messages:structuredClone(request.messages)})
      const step=(steps.get(request.sessionId)??0)+1;steps.set(request.sessionId,step)
      if(step<3){const tool=request.tools.find(t=>t.name.startsWith(step===1?'read_':'publish_'))
        yield{type:'block-start',index:0,blockType:'tool-call'}
        yield{type:'block-end',index:0,block:{type:'tool-call',id:`call-${step}`,name:tool.name,arguments:step===1?'{}':'{"text":"EXACT_REPLY"}'}}
      }else{yield{type:'block-start',index:0,blockType:'text'};yield{type:'block-end',index:0,block:{type:'text',text:'TOOL_TURN_COMPLETED'}}}
      yield{type:'finish',reason:{kind:step<3?'tool-calls':'stop'}}
    }})
  t.after(()=>api.close())
  for(const [name,kind]of[['A','discussion_thread'],['B','discussion_thread'],['DM','team_private']]){
    const a=f.add(name,kind),authority={...a.authority,operation_id:`op_${name}`},proof=claim(a,name)
    proof.authority.operation_id=authority.operation_id;proof.entry.operation_id=authority.operation_id
    proof.entry.id=`entry_${name}`;proof.entry.claim_id=`claim_${name}`;proof.entry.source_message_id=`source_${name}`
    proof.message.id=`source_${name}`;proof.message.content=`TOOL_INPUT_${name}`;proof.entry.source_content_sha256=publicTextHash(proof.message.content)
    claims.set(a.key,proof)
    const tools=['read_approved_summary','publish_reply'].map(action=>({name:action,action,description:`SCHEMA_ONLY_${name}`,implementation_id:SCOPED_TOOL_IMPLEMENTATION,
      parameters:scopedToolSchema(action),
      grant:{grant_id:`grant_${action}`,scope_key:a.key,journal_id:authority.journal_id,operation_id:authority.operation_id,target:`target_${name}`,
        source_receipt_id:proof.entry.id,entry_id:proof.entry.id,claim_id:proof.entry.claim_id,source_message_id:proof.message.id}}))
    const state={runtime_ready:true,authority,manifest:{authority,manifest_id:`tools_${name}`,tools}};states.set(a.key,state)
    await api.create(a.key)
    await assert.rejects(api.followup(a.key,{inputId:'wrong_source',text:'NO'}),/Claim-only/)
    const result=await api.followupClaim(a.key,proof)
    assert.equal(result.finalText,'TOOL_TURN_COMPLETED');assert.equal(result.published,false)
    assert.equal(calls.filter(c=>c.authority.session_id===a.authority.session_id).length,2)
    const own=requests.filter(r=>r.sessionId===a.authority.session_id)
    assert.equal(own.length,3)
    for(const request of own){
      assert.deepEqual(request.tools,tools.map(({name,description,parameters})=>({name,description,parameters})).sort((a,b)=>a.name<b.name?-1:1))
      for(const other of ['A','B','DM'])if(other!==name)assert.ok(!JSON.stringify(request).includes(`SCHEMA_ONLY_${other}"`))
    }
    assert.match(JSON.stringify(own.at(-1).messages),new RegExp(`RESULT_op_${name}`))
    const snapshot=f.captures.get(a.key),receipt=snapshot.events.find(e=>e.type===SCOPED_LOCAL_INPUT_RECORD)
    assert.equal(snapshot.events.find(e=>e.type==='user/message').data.id,receipt.data.message_id)
    for(const request of calls.filter(c=>c.authority.session_id===a.authority.session_id)){
      assert.equal(request.invocation.request_id,scopedToolRequestId(request.invocation))
      assert.equal(request.invocation.source_receipt_id,proof.entry.id)
      const call=snapshot.events.find(e=>e.seq===request.invocation.tool_call_seq)
      assert.equal(call.type,'tool/call');assert.equal(call.data.callId,request.invocation.tool_call_id)
    }
    const second=structuredClone(proof);second.entry.id=`second_${name}`;second.message.id=`second_source_${name}`;second.entry.source_message_id=second.message.id
    claims.set(a.key,second);await assert.rejects(api.followupClaim(a.key,second),/exact first claim/);claims.set(a.key,proof)
    await api.close(a.key);await api.restore(a.key)
    await assert.rejects(api.followupClaim(a.key,proof),/already recorded/)
    await api.close(a.key)
    state.manifest.tools[0].description='CHANGED_SCHEMA_DESCRIPTION'
    await assert.rejects(api.restore(a.key),/manifest.*changed/)
    state.manifest.tools[0].description=`SCHEMA_ONLY_${name}`
    state.manifest.tools[0].implementation_id='different_impl'
    await assert.rejects(api.restore(a.key),/implementation/)
  }
  assert.equal(calls.length,6)
})
function claim(a,name='A'){
  const origin={home_hub:'home',host_id:'host',workspace_id:'workspace',root_ref:'root'}
  const authority={...a.authority,context_key:a.key,operation_id:'operation',operation_revision:1,attempt:1,epoch:1,
    control_revision:1,team_revision:1,audience_revision:1,origin,worker:{node_id:'home',session_id:a.authority.session_id}}
  const message={id:'source-message',kind:'discussion',surface_id:'surface',thread_id:name,scope:origin,actor:{kind:'human',id:'local_owner'},content:'CLAIM_INPUT'}
  const entry={id:'entry',context_key:a.key,state:'claimed',claim_id:'claim',operation_id:authority.operation_id,journal_id:authority.journal_id,
    worker:authority.worker,operation_revision:1,operation_attempt:1,operation_epoch:1,control_revision:1,source_message_id:message.id,source_content_sha256:publicTextHash(message.content)}
  return{authority,entry,message}
}
test('claim boundary rejects wrong root, operation, control, source and absent resolver; persists exact proof before delivery',async t=>{
  const f=await fixture(t),a=f.add('A'),proof=claim(a),state={runtime_ready:true,dispatch_allowed:true,stage:'runtime',authority:proof.authority,entry:proof.entry,message:proof.message}
  await f.api.create(a.key);await assert.rejects(f.api.followupClaim(a.key,proof),/resolver unavailable/);await f.api.close(a.key)
  const api=await f.make({resolveClaimAuthority:()=>state});t.after(()=>api.close());await api.restore(a.key)
  for(const mutate of [p=>p.authority.journal_id='foreign',p=>p.authority.session_id='foreign',p=>p.authority.operation_id='foreign',
    p=>p.authority.control_revision=2,p=>p.entry.source_content_sha256='0'.repeat(64),p=>p.message.thread_id='B',p=>p.message.actor.id='foreign',
    p=>{p.entry.id='forged_entry';p.entry.claim_id='forged_claim'},p=>{p.message.content='FORGED';p.entry.source_content_sha256=publicTextHash('FORGED')}]){
    const changed=structuredClone(proof);mutate(changed);await assert.rejects(api.followupClaim(a.key,changed))
  }
  state.runtime_ready=false;await assert.rejects(api.followupClaim(a.key,proof),/runtime not ready/);state.runtime_ready=true
  assert.equal(f.requests.length,0)
  const result=await api.followupClaim(a.key,proof);assert.equal(result.finalText,'LOCAL_COMPLETED')
  const snapshot=f.captures.get(a.key),marker=snapshot.events.find(e=>e.type===SCOPED_LOCAL_INPUT_RECORD)
  assert.deepEqual(marker.data.claim, {authority:proof.authority,entry:proof.entry})
  assert.ok(marker.seq<snapshot.events.find(e=>e.type==='user/message').seq)
  await api.close(a.key);await api.restore(a.key)
  await assert.rejects(api.followupClaim(a.key,proof),/already recorded/)
  assert.equal(f.requests.length,1)
})
test('pending exact claim cannot lose ownership through close/restore or ordinary followup',async t=>{
  const f=await fixture(t),a=f.add('A'),proof=claim(a),gate=Promise.withResolvers(),entered=Promise.withResolvers()
  let first=true
  const api=await f.make({resolveClaimAuthority:async()=>{
    if(first){first=false;entered.resolve();await gate.promise}
    return{runtime_ready:true,dispatch_allowed:true,stage:'runtime',...proof}
  }});t.after(()=>api.close())
  await api.create(a.key)
  await assert.rejects(api.followup(a.key,{inputId:'bypass',text:'NO'}),/Claim-only/)
  const result=api.followupClaim(a.key,proof);await entered.promise
  await assert.rejects(api.close(a.key),/Active claim/);await assert.rejects(api.close(),/Active claim/)
  await assert.rejects(api.restore(a.key),/already owned/)
  await assert.rejects(api.followup(a.key,{inputId:'bypass',text:'NO'}),/busy/)
  gate.resolve();assert.equal((await result).state,'completed');assert.equal(f.requests.length,1)
})

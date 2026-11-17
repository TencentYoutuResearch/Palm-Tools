/** Original NativeAgentFactory/Driver, isolated real SessionStore/JSONL.
 * Stub runtime only; this proves lifecycle isolation, not CLI grant enforcement.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Context} from '@deepseek-ai/cordis'
import Sessions from '@deepseek-ai/dsh-session'
import Agents from '@deepseek-ai/dsh-agent'
import Projections from '@deepseek-ai/dsh-session-projection'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import {NativeAgentFactory} from '../src/native-agent-factory.js'
import {boundaryProjection,inboxProjection} from '../src/native-agent-driver.js'
import {builderContextKey} from '../src/builder-context-scope.js'
import {builderPublicManifest} from '../src/scoped-builder-manifest.js'
import {BUILDER_INPUT_RECORD} from '../src/scoped-builder-input.js'
import {BUILDER_JOURNAL_RECORD} from '../src/scoped-builder-session-adapter.js'
import {deliveryInputId} from '../src/delivery-tracker.js'
async function fixture(t,{service=true,flushFailure=false}={}){
  const root=await mkdtemp(join(tmpdir(),'kode-native-builder-')),ctx=new Context(),parent=new Context()
  const builder_context={version:1,kind:'builder_draft',home_hub:'fixture',draft_id:'draft',context_epoch:1},key=builderContextKey(builder_context)
  const authority={builder_context,context_key:key,session_id:`builder-context-${key}`,journal_id:'journal',operation:{id:'operation',attempt:1,epoch:1}}
  const selection={provider:'kode-agent-original-cli',model:'original-model'},admission={authority,cwd:root,selection,public_manifest:builderPublicManifest(key),tool_manifest:[]}
  const state={calls:[],sources:new Map(),revalidated:0,asserted:0,failFlush:false,parentEvents:0}
  await ctx.plugin(Sessions);await ctx.plugin(Agents);await ctx.plugin(Projections);await ctx.plugin(Jsonl,{root:join(root,'journals'),compression:'none'})
  ctx.sessionProjections.register(boundaryProjection);ctx.sessionProjections.register(inboxProjection)
  ctx.provide('tools',{schemas:()=>[]})
  ctx.provide('kodeAgents',{adapter:{
    async *stream(options){state.calls.push(options);yield {type:'block-start',index:0,blockType:'text'}
      yield {type:'block-end',index:0,block:{type:'text',text:'ORIGINAL_NATIVE_DRIVER'}};yield {type:'finish',reason:{kind:'stop'}}},
    async closeSession(){},hasContinuation:()=>false,
  }})
  for(const event of ['session/event','agent/created','agent/assistant-stream'])parent.on(event,()=>{state.parentEvents++;throw Error('PARENT_EVENT_CANARY')},{global:true})
  if(flushFailure)ctx.on('session/flush',()=>{if(state.failFlush)throw Error('fixture flush failed')})
  if(service)ctx.provide('kodeBuilderRuntime',{
    sessionAdmission:()=>structuredClone(admission),async setupAgent(){},async assertSession(){state.asserted++},
    inputReceipt:(_agent,message)=>state.sources.get(message.id),
    async revalidateInput(_agent,source){state.revalidated++;assert.deepEqual(state.sources.get(deliveryInputId(source.receipt.message_id)),source)},
  })
  const factory=new NativeAgentFactory(ctx)
  t.after(async()=>{await factory.close();await ctx.fiber.dispose();await parent.fiber.dispose();await rm(root,{recursive:true,force:true})})
  const options={sessionId:authority.session_id,agentOptions:selection,meta:{cwd:root}}
  const input=(id='input',text='OWNER_REQUEST')=>{
    const source={request:{request_id:id,draft_id:'draft',attempt:1,epoch:1,content:text},receipt:{operation_id:'operation',message_id:`source-${id}`,
      worker:{node_id:'fixture',session_id:authority.session_id},home_hub:'fixture',actor:{kind:'human',id:'local_owner'},state:'queued',created_at:1}}
    const message={id:deliveryInputId(source.receipt.message_id),role:'user',source:{kind:'user'},content:[{type:'text',text}]}
    state.sources.set(message.id,source);return {source,message}
  }
  return {ctx,factory,state,options,authority,admission,input,root}
}
test('original native factory/driver retains CLI selection and isolates durable Builder sources',async t=>{
  const f=await fixture(t),handle=await f.factory.createAgent(f.ctx,f.options),agent=handle.agent
  assert.equal(agent.isKodeNativeAgent,true);assert.deepEqual(agent.options,f.options.agentOptions)
  const {message}=f.input();await agent.followup(message);await agent.whenIdle()
  assert.equal(f.state.calls.length,1);assert.equal(f.state.parentEvents,0)
  assert.equal(f.state.calls[0].provider,'kode-agent-original-cli')
  const events=agent.session.snapshotEvents();assert.equal(events[0].type,BUILDER_JOURNAL_RECORD)
  const receipt=events.find(e=>e.type===BUILDER_INPUT_RECORD),inbox=events.find(e=>e.type==='agent/inbox/spliced'&&e.data.inserted.length)
  assert.ok(receipt.seq<inbox.seq);assert.ok(inbox.seq<events.find(e=>e.type==='user/message').seq)
  assert.equal(events.at(-1).data.reason.kind,'completed')
  await assert.rejects(agent.followup(message),/already recorded/)
  await handle.dispose()
  const restored=await f.factory.resume(f.ctx,{resumeSessionId:agent.id,agentOptions:f.options.agentOptions})
  assert.equal(restored.agent.isKodeNativeAgent,true);assert.equal(f.state.calls.length,1)
  const second=f.input('second');await restored.agent.followup(second.message);await restored.agent.whenIdle()
  assert.equal(f.state.calls.length,2);await restored.dispose()
})
test('reserved Builder IDs require Host authority and reject seed, parent, selection and root sharing',async t=>{
  const missing=await fixture(t,{service:false});await assert.rejects(missing.factory.createAgent(missing.ctx,missing.options),/Host authority/)
  const f=await fixture(t)
  for(const mutation of [{seed:[]},{parentAgent:{}},{inheritedEventCount:0},{agentOptions:{provider:'kode-agent-other',model:'original-model'}}]){
    await assert.rejects(f.factory.createAgent(f.ctx,{...f.options,...mutation}))
  }
  await assert.rejects(f.factory.importHistory(f.authority.session_id,[],f.root,f.options.agentOptions),/cannot import/)
  const owned=await f.factory.createAgent(f.ctx,f.options)
  f.admission.authority.builder_context.draft_id='other-draft'
  f.admission.authority.context_key=builderContextKey(f.admission.authority.builder_context)
  f.admission.authority.session_id=`builder-context-${f.admission.authority.context_key}`
  f.admission.public_manifest=builderPublicManifest(f.admission.authority.context_key)
  await assert.rejects(f.factory.createAgent(f.ctx,{...f.options,sessionId:f.admission.authority.session_id}),/independent root/)
  await owned.dispose()
})
test('native Builder blocks source forgery and all alternate input/model bypasses',async t=>{
  const f=await fixture(t),handle=await f.factory.createAgent(f.ctx,f.options),agent=handle.agent
  const {message}=f.input(),forged=structuredClone(message);forged.content[0].text='FORGED'
  assert.throws(()=>agent.followup(forged),/staged owner receipt/)
  assert.throws(()=>agent.inject(message),/without an owner receipt/)
  assert.throws(()=>agent.steer(message),/steering/)
  assert.throws(()=>agent.interruptAndInsert(message),/direct insertion/)
  assert.throws(()=>agent.selectModel({provider:'kode-agent-other',model:'other'}),/model selection/)
  assert.equal(f.state.calls.length,0);await handle.dispose()
})
test('source durability failure never queues or invokes the native runtime',async t=>{
  const f=await fixture(t,{flushFailure:true}),handle=await f.factory.createAgent(f.ctx,f.options)
  f.state.failFlush=true;await assert.rejects(handle.agent.followup(f.input().message),/flush failed/)
  assert.equal(handle.agent.inbox.nextTurn.length,0);assert.equal(f.state.calls.length,0)
  f.state.failFlush=false;await handle.dispose()
  await assert.rejects(f.factory.resume(f.ctx,{resumeSessionId:f.authority.session_id,agentOptions:f.options.agentOptions}),/reconciliation/)
})
test('Builder shell/slash text never reaches native runtime, and uncertain turn cannot resume',async t=>{
  const f=await fixture(t),handle=await f.factory.createAgent(f.ctx,f.options)
  await handle.agent.followup(f.input('shell','!echo forbidden').message);await handle.agent.whenIdle()
  assert.equal(f.state.calls.length,0);assert.equal(handle.agent.session.snapshotEvents().at(-1).data.reason.kind,'error')
  await handle.dispose();await assert.rejects(f.factory.resume(f.ctx,{resumeSessionId:f.authority.session_id,agentOptions:f.options.agentOptions}),/reconciliation/)
})

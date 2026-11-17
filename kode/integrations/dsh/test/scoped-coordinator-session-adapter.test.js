/** Real AgentLoop factory + real JSONL writer, no Hub, network or inference. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {Context,symbols} from '@deepseek-ai/cordis'
import SessionStore,{Session,SessionPreparation,appendPluginRecord} from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime,{LlmAdapter,createUserMessage} from '@deepseek-ai/dsh-llm'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import {createScopedCoordinatorSessionAdapter} from '../src/scoped-coordinator-session-adapter.js'
import {SCOPED_COORDINATOR_JOURNAL_RECORD as MARKER} from '../src/scoped-coordinator-journal.js'
import {contextScopeKey,discussionScopeId} from '../src/context-scope.js'
import {mountCoordinatorRoleContext} from '../src/coordinator-role-context.js'
import {OfficialLoopHost} from '../src/official-loop-host.js'
import {officialLoopServices} from '../src/official-loop-services.js'
import {createScope} from '@deepseek-ai/dsh-scope'
const requireLoop=createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const {default:Tools}=await import(requireLoop.resolve('@deepseek-ai/dsh-tools'))
const route={provider:'fixture',model:'model'}
function authority(name='a',kind='discussion_thread'){
  const context_scope={version:2,home_hub:'home',team_id:'team',kind,scope_id:kind==='discussion_thread'?discussionScopeId('surface',name):'private',context_epoch:1}
  return {context_scope,session_id:`context-${contextScopeKey(context_scope)}`,journal_id:`generation-${name}`}
}
function append(session,text){
  session.append('turn/start',{turn:1});session.append('step/start',{turn:1,step:1})
  session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}),{surfaceOp:'append'})
  session.append('request/header',{reason:'initial',header:{config:route,tools:[{name:`tool_${text}`,description:`SCHEMA_${text}`,parameters:{type:'object',properties:{}}}]}})
  session.append('step/end',{turn:1,step:1});session.append('turn/end',{turn:1,reason:'completed'})
}
const request=session=>({...route,sessionId:session.id,messages:session.deriveMessages(),toolHistory:session.toolHistory(),tools:session.requestHeader().tools})
async function fixture(t,{persistence=true,hostMode=false,resolver=true}={}){
  const root=await mkdtemp(join(tmpdir(),'kode-owned-scope-')),ctx=new Context(),handles=[],admissions=new Map(),counts={create:0,open:0}
  t.after(async()=>{try{for(const h of handles)await h.dispose().catch(()=>{});await ctx.fiber.dispose()}finally{await rm(root,{recursive:true,force:true})}})
  await ctx.plugin(SessionStore);await ctx.plugin(AgentRegistry);await ctx.plugin(Projections)
  if(persistence)await ctx.plugin(Jsonl,{root,compression:'none'})
  await ctx.plugin(SystemPrompt,{includeHarnessIdentity:false,includeRuntimeContext:false});await ctx.plugin(Tools);await ctx.plugin(LlmRuntime)
  const original=ctx.sessions,adapter=createScopedCoordinatorSessionAdapter(original,id=>admissions.get(id))
  if(hostMode){
    const bindings={},executions=[]
    const execution={host:'home',profiles:{binding:id=>bindings[id],bindings,coordinatorCloseIntents:{}},
      client:{call:async()=>{throw Error('No Hub exists in this fixture')}},
      loopServices:()=>officialLoopServices(ctx,()=>{throw Error('No model/tool execution allowed in fixture')}),
      open:async agent=>{executions.push(agent.id);const stop=new AbortController();return{signal:stop.signal,dispose:()=>stop.abort(),whenStopped:async()=>{}}},
      ...(resolver?{scopedCoordinatorAdmission:id=>admissions.get(id)}:{})}
    const host=new OfficialLoopHost(ctx,execution)
    const watcherStarts={inbox:0,transfers:0,recovery:0}
    for(const [key,watcher] of [['inbox',host.coordinatorInbox],['transfers',host.coordinatorTransfers],['recovery',host.coordinatorCloseRecovery]]){
      const start=watcher.start.bind(watcher);watcher.start=()=>{watcherStarts[key]++;return start()}
    }
    t.after(()=>host.close())
    const bind=(id,scope)=>{bindings[id]={profile:{type:'dsh'},managedOperation:{id:'operation',attempt:1,epoch:1},
      managedCoordinator:{team_id:'team',conversation_id:'conversation',control_revision:1,...(scope?{context_scope:scope}:{})}}}
    return {ctx,original,host,execution,executions,admissions,bind,watcherStarts}
  }
  const scope=ctx.isolate('sessions').isolate('sessionPersistence')
  const fiber=await scope.plugin(function fixtureServices(c){
    c.provide('sessions',adapter.sessions)
    if(persistence){
      const backend=ctx.sessionPersistence
      c.provide('sessionPersistence',new Proxy({}, {get(_target,key){
        if(typeof key==='symbol')return undefined
        const value=Reflect.get(backend,key,backend)
        if(key==='create'||key==='open')return (...args)=>{counts[key]++;return value.apply(backend,args)}
        return typeof value==='function'?value.bind(backend):value
      }}))
    }
  })
  const loopFiber=await fiber.ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:1})
  const factory=loopFiber.ctx.get('agentLoop')
  const create=async(a,extra={})=>{
    admissions.set(a.session_id,{mode:'fresh',authority:a})
    const h=await factory.createAgent(fiber.ctx,{sessionId:a.session_id,agentOptions:route,...extra,setup:async(c,agent)=>{
      const scoped=createScope(c,agent[symbols.original]??agent).ctx
      agent.ctx=scoped.extend({sessions:scoped.reflect.trace(adapter.sessions)})
      return extra.setup?.(agent.ctx,agent)
    }});handles.push(h);return h
  }
  const restore=async a=>{
    admissions.set(a.session_id,{mode:'restore',authority:a})
    const h=await factory.resume(fiber.ctx,{resumeSessionId:a.session_id,agentOptions:route,setup:async(c,agent)=>{
      const scoped=createScope(c,agent[symbols.original]??agent).ctx
      agent.ctx=scoped.extend({sessions:scoped.reflect.trace(adapter.sessions)})
    }});handles.push(h);return h
  }
  return {ctx,original,adapter,admissions,counts,factory,scope:fiber.ctx,create,restore,handles}
}

test('real factory pre-init marks before setup; unique writer durably restores same scope without second marker',async t=>{
  const f=await fixture(t),a=authority();let setup=false
  const h=await f.create(a,{setup:async(_ctx,agent)=>{
    setup=true;assert.equal(agent.session.snapshotEvents()[0].type,MARKER)
    assert.equal(agent.session.firstLiveSeq,0);assert.equal(f.counts.create,1)
  }})
  assert.equal(setup,true);assert.equal(f.counts.create,1)
  append(h.agent.session,'A')
  await f.adapter.dispatch(h.agent.session,request(h.agent.session),r=>{
    assert.match(JSON.stringify(r),/SCHEMA_A/);assert.equal(Object.isFrozen(r),true)
    assert.throws(()=>r.messages.push({role:'user'}),TypeError)
  })
  await h.dispose()
  const restored=await f.restore(a)
  assert.equal(f.counts.create,1);assert.equal(f.counts.open,1)
  assert.equal(restored.agent.session.snapshotEvents().filter(e=>e.type===MARKER).length,1)
  await f.adapter.dispatch(restored.agent.session,request(restored.agent.session),r=>assert.match(JSON.stringify(r),/SCHEMA_A/))
})

test('real concurrent A/B/private factories have isolated provider histories and reject mixed requests',async t=>{
  const f=await fixture(t),rows=[],observed=new Map()
  for(const [name,kind] of [['A','discussion_thread'],['B','discussion_thread'],['PRIVATE','team_private']]){
    const seen=[];observed.set(name,seen)
    const h=await f.create(authority(name,kind),{setup:async c=>{c.on('session/event',session=>seen.push(session.id))}})
    append(h.agent.session,name);rows.push([name,h.agent.session])
  }
  let calls=0
  for(const [name,session] of rows){
    await f.adapter.dispatch(session,request(session),r=>{
      calls++;assert.match(JSON.stringify(r.toolHistory),new RegExp(`SCHEMA_${name}`))
      for(const [other] of rows)if(other!==name)assert.ok(!JSON.stringify(r).includes(`SCHEMA_${other}`))
    })
  }
  const a=rows[0][1],b=rows[1][1]
  for(const candidate of [{...request(a),messages:b.deriveMessages()},
    {...request(a),toolHistory:b.toolHistory()},{...request(a),sessionId:b.id},
    {...request(a),systemPrompt:'private injection'}]){
    await assert.rejects(f.adapter.dispatch(a,candidate,()=>calls++),/differs|Unexpected/)
  }
  assert.equal(calls,3)
  for(const [name,session] of rows){
    assert.ok(observed.get(name).length>0,'original agent-scoped event carrier is preserved')
    assert.ok(observed.get(name).every(id=>id===session.id),'other agents do not gain event visibility')
  }
})

test('ordinary SessionStore behavior is unchanged and fresh scoped seed/parent routes fail before factory writer',async t=>{
  const f=await fixture(t),a=authority()
  const ordinary=f.original.prepare('ordinary',{seed:[]})
  assert.ok(ordinary instanceof Session);assert.equal(ordinary.snapshotEvents().filter(e=>e.type===MARKER).length,0)
  const wrapped=f.adapter.sessions.prepare('other-ordinary',{seed:[]})
  assert.ok(wrapped instanceof Session);assert.equal(wrapped.snapshotEvents().filter(e=>e.type===MARKER).length,0)
  const preparation=SessionPreparation.create(wrapped);preparation[Symbol.dispose]()
  assert.equal(preparation.session,wrapped,'factory disposal contract remains the exact Session')
  for(const extra of [{seed:[]},{meta:{parentSession:'parent'}},{inheritedEventCount:0}]){
    await assert.rejects(f.create(a,extra),/Fresh scope forbids/)
  }
  assert.equal(f.counts.create,0)
  f.admissions.clear()
  assert.throws(()=>f.adapter.sessions.prepare(a.session_id),/no Host admission/)
  assert.ok(f.original.prepare(a.session_id) instanceof Session,'ordinary service is not globally patched')
  assert.ok(f.adapter.sessions.prepare('context-old-legacy') instanceof Session,'a prefix is not a scope identity')
  f.admissions.set(a.session_id,{mode:'legacy'})
  assert.equal(f.adapter.sessions.prepare(a.session_id).snapshotEvents().length,0,'trusted known legacy collision remains unchanged')
})

test('actual no-persistence factory cannot pass the durability guard',async t=>{
  const f=await fixture(t,{persistence:false}),h=await f.create(authority())
  append(h.agent.session,'A');let calls=0
  await assert.rejects(f.adapter.dispatch(h.agent.session,request(h.agent.session),()=>calls++),/No session durability listener/)
  assert.equal(calls,0)
})

test('changed trusted generation, stale object and duplicate marker are rejected',async t=>{
  const f=await fixture(t),a=authority(),h=await f.create(a),s=h.agent.session;append(s,'A')
  f.admissions.set(a.session_id,{mode:'fresh',authority:{...a,journal_id:'other'}})
  await assert.rejects(f.adapter.dispatch(s,request(s),()=>assert.fail('provider')),/authority changed/)
  f.admissions.set(a.session_id,{mode:'fresh',authority:a})
  appendPluginRecord(s,MARKER,{version:1,authority:a,header:s.header})
  await assert.rejects(f.adapter.dispatch(s,request(s),()=>assert.fail('provider')),/origin or generation/)
  await h.dispose()
  await assert.rejects(f.adapter.dispatch(s,request(s),()=>assert.fail('provider')),/live owned object/)
})

test('actual AgentLoop followup raw request passes scoped guard to local deterministic stream',async t=>{
  const f=await fixture(t),errors=[],seen=[]
  f.ctx.on('agent/error',event=>errors.push(event.error.message))
  class LocalFixture extends LlmAdapter{
    async *stream(options){
      const session=f.original.get(options.sessionId)
      assert.ok(session,'actual adapter request identifies its live Session')
      seen.push({keys:Object.keys(options).sort(),signal:options.signal instanceof AbortSignal,
        messages:structuredClone(options.messages),toolHistory:structuredClone(options.toolHistory)})
      assert.deepEqual(options.messages,Session.prototype.deriveMessages.call(session))
      assert.deepEqual(options.toolHistory,Session.prototype.toolHistory.call(session))
      const guarded=await f.adapter.dispatch(session,options,async function*(request){
        assert.equal(request.signal,options.signal)
        assert.ok(Object.isFrozen(request.messages))
        assert.deepEqual(request.tools,[])
        yield {type:'block-start',index:0,blockType:'text'}
        yield {type:'block-end',index:0,block:{type:'text',text:'LOCAL_FIXTURE_REPLY'}}
        yield {type:'finish',reason:{kind:'stop'}}
      })
      await assert.rejects(f.adapter.dispatch(session,options,()=>{}),/already in progress/)
      yield* guarded
    }
  }
  f.ctx.llm.registerAdapter(['fixture'],new LocalFixture())
  const h=await f.create(authority())
  h.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'ACTUAL_LOOP_CANARY'}]}))
  await h.agent.whenIdle()
  assert.deepEqual(errors,[])
  assert.equal(seen.length,1)
  assert.equal(seen[0].signal,true)
  assert.match(JSON.stringify(seen[0].messages),/ACTUAL_LOOP_CANARY/)
  assert.ok(seen[0].keys.includes('signal'))
  t.diagnostic(`Actual locally guarded adapter request keys: ${seen[0].keys.join(', ')}`)
})

const raw=service=>service[symbols.original]??service
test('owned factory stream locks until cancellation; generation changes fail before next delivery',async t=>{
  const f=await fixture(t),a=authority(),h=await f.create(a),s=h.agent.session;append(s,'STREAM_A')
  const controller=new AbortController();let closed=0
  const stream=await f.adapter.dispatch(s,{...request(s),signal:controller.signal},async function*(){try{yield 'A';yield 'B'}finally{closed++}})
  assert.deepEqual(await stream.next(),{done:false,value:'A'})
  await assert.rejects(f.adapter.dispatch(s,request(s),()=>{}),/already in progress/)
  controller.abort(Error('cancelled'));await stream.return()
  assert.equal(closed,1)
  await f.adapter.dispatch(s,request(s),()=>{})
  const next=await f.adapter.dispatch(s,request(s),async function*(){yield 'A'})
  f.admissions.set(a.session_id,{mode:'fresh',authority:{...a,journal_id:'changed'}})
  await assert.rejects(next.next(),/authority changed/)
})
test('uncertain stream cancellation permanently fences owned Session',async t=>{
  const f=await fixture(t),h=await f.create(authority()),s=h.agent.session;append(s,'A')
  const stream=await f.adapter.dispatch(s,request(s),()=>({[Symbol.asyncIterator](){return this},async next(){return {done:false}},async return(){throw Error('cleanup failed')}}))
  await assert.rejects(stream.return(),/cleanup failed/)
  await assert.rejects(f.adapter.dispatch(s,request(s),()=>assert.fail('provider')),/not the live owned/)
})
test('real OfficialLoopHost registers ready adapter only in its controlled scope, then guards actual Session projections',async t=>{
  const f=await fixture(t,{hostMode:true}),a=authority()
  f.bind(a.session_id,a.context_scope);f.admissions.set(a.session_id,{runtime_ready:true,mode:'fresh',authority:a})
  const owned=await f.host.create({sessionId:a.session_id,agentOptions:route})
  assert.ok(f.host.scopedCoordinatorSessions)
  assert.deepEqual(f.watcherStarts,{inbox:0,transfers:0,recovery:0})
  assert.equal(raw(f.ctx.sessions),raw(f.original),'root service is unchanged')
  assert.equal(owned.agent.session.snapshotEvents()[0].type,MARKER)
  append(owned.agent.session,'HOST_A')
  await f.host.scopedCoordinatorSessions.dispatch(owned.agent.session,request(owned.agent.session),r=>assert.match(JSON.stringify(r),/SCHEMA_HOST_A/))
  assert.deepEqual(f.executions,[a.session_id])
  f.bind('legacy')
  await assert.rejects(f.host.create({sessionId:'legacy',agentOptions:route}),/cannot acquire legacy/)
  assert.equal(f.host.handles.get(a.session_id),owned)
  assert.equal(owned.run.signal.aborted,false)
  assert.equal(raw(f.ctx.sessions),raw(f.original))
  await owned.dispose()
})

test('ready Host cannot downgrade a missing or mismatched Coordinator context binding',async t=>{
  const f=await fixture(t,{hostMode:true}),a=authority()
  f.admissions.set(a.session_id,{runtime_ready:true,mode:'fresh',authority:a})
  for(const scope of [undefined,authority('b').context_scope]){
    f.bind(a.session_id,scope)
    await assert.rejects(f.host.create({sessionId:a.session_id,agentOptions:route}),/binding differs/)
  }
  assert.deepEqual(f.executions,[])
  assert.equal(await f.ctx.sessionPersistence.stat(a.session_id),undefined)
})

for(const resolver of [false,true])test(`unready/no-resolver Host keeps original legacy SessionStore (resolver=${resolver})`,async t=>{
  const f=await fixture(t,{hostMode:true,resolver}),id='legacy'
  f.bind(id);f.admissions.set(id,{runtime_ready:false,mode:'legacy'})
  let setupCtx
  const control={request:{team_revision:1}},activation={active:true,authority_valid:true,home_hub:'home',team_id:'team',team_revision:1,snapshot:{team:{id:'team',home_hub:'home',revision:1,spec:{}}}}
  f.execution.client.call=async path=>{
    if(path==='/api/v1/messaging/teams/team/activation')return structuredClone(activation)
    if(path==='/api/v1/messaging/teams/team/coordinator-control')return {control:structuredClone(control)}
    throw Error('Unexpected fixture Hub read: '+path)
  }
  f.execution.profiles.patchBinding=async(id,patch)=>Object.assign(f.execution.profiles.bindings[id],structuredClone(patch))
  const owned=await f.host.create({sessionId:id,agentOptions:route,setup:async(c,agent)=>{setupCtx=c;await mountCoordinatorRoleContext(c,agent,f.execution,f.execution.profiles.binding(id).managedCoordinator,control)}})
  assert.equal(f.host.scopedCoordinatorSessions,undefined)
  assert.deepEqual(f.watcherStarts,{inbox:1,transfers:1,recovery:1})
  assert.equal(raw(f.host.scope.get('sessions')),raw(f.original))
  assert.equal(raw(owned.agent.ctx.get('sessions')),raw(f.original))
  assert.equal(owned.agent.ctx,setupCtx)
  assert.equal(owned.agent.session.snapshotEvents().filter(e=>e.type===MARKER).length,0)
  const a=authority();f.bind(a.session_id,a.context_scope)
  await assert.rejects(f.host.create({sessionId:a.session_id,agentOptions:route}),/not runtime ready/)
  if(resolver){
    f.admissions.set(a.session_id,{runtime_ready:true,mode:'fresh',authority:a})
    await assert.rejects(f.host.create({sessionId:a.session_id,agentOptions:route}),/Existing legacy Host/)
  }
  assert.equal(f.host.handles.get(id),owned)
  assert.equal(owned.run.signal.aborted,false)
  assert.equal(raw(f.ctx.sessions),raw(f.original))
  await owned.dispose()
})

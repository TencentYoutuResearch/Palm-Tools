/** Actual DSH Session + JSONL backend; provider is an in-process observation only. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {Session,appendPluginRecord} from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import {createUserMessage,createSystemMessage,createAssistantMessage,createToolResultMessage} from '@deepseek-ai/dsh-llm'
import {ScopedCoordinatorJournal,SCOPED_COORDINATOR_JOURNAL_RECORD as MARKER} from '../src/scoped-coordinator-journal.js'
import {discussionScopeId,contextScopeKey} from '../src/context-scope.js'

const route={provider:'fixture',model:'model'}
const authority=(name='a',kind='discussion_thread')=>{
  const context_scope={version:2,home_hub:'home',team_id:'team',kind,
    scope_id:kind==='discussion_thread'?discussionScopeId('surface',name):'private',context_epoch:1}
  return {session_id:`context-${contextScopeKey(context_scope)}`,journal_id:`generation-${name}`,context_scope}
}
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'kode-scoped-journal-')),ctx=new Context(),journals=[]
  await ctx.plugin(Jsonl,{root,compression:'none'})
  t.after(async()=>{try{for(const j of journals)await j.close().catch(()=>{});await ctx.fiber.dispose()}finally{await rm(root,{recursive:true,force:true})}})
  const persistence=ctx.sessionPersistence
  const create=async(a=authority(),session=Session.create(a.session_id))=>{
    const journal=await ScopedCoordinatorJournal.create({session,persistence,authority:a});journals.push(journal);return journal
  }
  const restore=async(a=authority())=>{const j=await ScopedCoordinatorJournal.restore({persistence,authority:a});journals.push(j);return j}
  return {persistence,create,restore}
}
function appendHistory(session,canary) {
  session.append('turn/start',{turn:1})
  session.append('step/start',{turn:1,step:1})
  session.append('system/message',{turn:1,step:1,message:createSystemMessage('Shared public Coordinator procedure')},{surfaceOp:'append'})
  session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:canary}]}),{surfaceOp:'append'})
  const name=`tool_${canary}`,callId=`call_${canary}`
  session.append('request/header',{reason:'initial',header:{config:route,tools:[{name,description:`SCHEMA_${canary}`,parameters:{type:'object',properties:{}}}]}})
  session.append('assistant/message',{turn:1,step:1,stream:[],message:createAssistantMessage({source:{provider:'fixture',model:'model'},content:[{type:'tool-call',id:callId,name,arguments:'{}'}]})},{surfaceOp:'append'})
  const execution=session.append('tool/call',{turn:1,step:1,callId,name,arguments:'{}'})
  session.append('tool/result',{turn:1,step:1,message:createToolResultMessage({callId,isError:false,content:[{type:'text',text:`RESULT_${canary}`} ]})},{surfaceOp:'append',sourceEventSeqs:[execution.seq]})
  session.append('step/end',{turn:1,step:1})
  session.append('turn/end',{turn:1,reason:'completed'})
}

test('detached journal retains writer lease through stream abort and flushes afterward',async t=>{
  const f=await fixture(t),j=await f.create(),controller=new AbortController();appendHistory(j.session,'A')
  const stream=await j.dispatch(j.session,route,async function*(request){assert.equal(request.signal,controller.signal);yield 'A'}, {signal:controller.signal})
  await assert.rejects(j.close(),/already in progress/)
  await assert.rejects(j.flush(j.session),/already in progress/)
  assert.equal((await stream.next()).value,'A')
  controller.abort();await stream.return()
  await j.flush(j.session);await j.close()
})
test('real DSH messages and toolHistory isolate threads A/B and private canaries across durable restore',async t=>{
  const f=await fixture(t),cases=[['a','discussion_thread','THREAD_A'],['b','discussion_thread','THREAD_B'],['private','team_private','PRIVATE']]
  for(const [name,kind,canary] of cases){
    const a=authority(name,kind),j=await f.create(a);appendHistory(j.session,canary)
    let calls=0
    const inspect=request=>{
      calls++
      assert.deepEqual(request.messages,Session.prototype.deriveMessages.call(j.session))
      assert.deepEqual(request.toolHistory,Session.prototype.toolHistory.call(j.session))
      assert.notEqual(request.messages[0],Session.prototype.deriveMessages.call(j.session)[0],'provider gets detached copies')
      assert.throws(()=>request.messages.push({role:'user'}),TypeError)
      assert.throws(()=>request.messages[0].content[0].text='PROVIDER_MUTATION',TypeError)
      assert.throws(()=>request.toolHistory.tools[0].description='PROVIDER_MUTATION',TypeError)
      assert.match(JSON.stringify(request.messages),new RegExp(`RESULT_${canary}`))
      assert.match(JSON.stringify(request.toolHistory),new RegExp(`SCHEMA_${canary}`))
      for(const [, ,foreign] of cases)if(foreign!==canary)assert.ok(!JSON.stringify(request).includes(foreign))
    }
    await j.dispatch(j.session,route,inspect);assert.equal(calls,1)
    const before={messages:j.session.deriveMessages(),toolHistory:j.session.toolHistory()}
    await j.close()
    await assert.rejects(j.dispatch(j.session,route,inspect),/closed/)
    const check=await f.persistence.open(a.session_id,'read')
    try { assert.deepEqual((await check.read()).events[0].data.header,check.header) } finally { await check.close() }
    const restored=await f.restore(a)
    await restored.dispatch(restored.session,route,request=>{
      assert.deepEqual(request.messages,before.messages)
      assert.deepEqual(request.toolHistory,before.toolHistory)
      for(const [, ,foreign] of cases)if(foreign!==canary)assert.ok(!JSON.stringify(request).includes(foreign))
    })
    await restored.close()
  }
})

test('fresh admission rejects old, seeded, inherited, parent and fake sessions before persistence',async t=>{
  const f=await fixture(t),a=authority()
  const old=Session.create(a.session_id);appendHistory(old,'OLD')
  const restored=Session.create(a.session_id,old.snapshotEvents(),old.header)
  const seeded=Session.create(a.session_id,[],{...old.header,isSeeded:true,parentSession:'parent'},0)
  const parent=Session.create(a.session_id,[],{...old.header,parentSession:'parent'})
  for(const session of [old,restored,seeded,parent,{header:old.header,snapshotEvents:()=>[]}]){
    await assert.rejects(f.create(a,session),/fresh|empty|lineage/)
  }
  assert.equal(await f.persistence.stat(a.session_id),undefined)
  const j=await f.create(a)
  await assert.rejects(f.create(a,j.session),/unowned/)
})

test('dispatch rejects foreign session and external histories even with copied scope labels',async t=>{
  const f=await fixture(t),a=await f.create(),b=await f.create(authority('b'))
  appendHistory(a.session,'A');appendHistory(b.session,'B')
  let calls=0;const provider=()=>{calls++}
  await assert.rejects(a.dispatch(b.session,route,provider),/another Session/)
  for(const extra of [{messages:b.session.deriveMessages()},{toolHistory:b.session.toolHistory()},
    {tools:[]},{sessionId:a.session.id},{context_scope:authority().context_scope}]){
    await assert.rejects(a.dispatch(a.session,{...route,...extra},provider),/external request history/)
  }
  await assert.rejects(a.dispatch(a.session,{provider:'fixture',model:'other'},provider),/committed request header/)
  // Methods overridden by a caller cannot substitute another Session's projections.
  a.session.deriveMessages=()=>b.session.deriveMessages()
  a.session.toolHistory=()=>b.session.toolHistory()
  await a.dispatch(a.session,route,request=>{calls++;assert.ok(!JSON.stringify(request).includes('SCHEMA_B'));assert.match(JSON.stringify(request),/SCHEMA_A/)})
  assert.equal(calls,1)
})

test('restoration rejects wrong trusted scope, old journal generation and wrong session',async t=>{
  const f=await fixture(t),a=authority(),j=await f.create(a);appendHistory(j.session,'A');await j.flush(j.session);await j.close()
  for(const wrong of [{...a,journal_id:'older-generation'},
    {...a,context_scope:authority('b').context_scope},
    {...a,context_scope:{...a.context_scope,team_id:'other'}},
    {...a,context_scope:authority('private','team_private').context_scope}]){
    await assert.rejects(f.restore(wrong),/marker mismatch|trusted context key/)
  }
  await assert.rejects(f.restore({...a,session_id:'absent-session'}))
  const good=await f.restore(a)
  await good.dispatch(good.session,route,request=>assert.match(JSON.stringify(request),/SCHEMA_A/))
})

test('duplicate or foreign scope markers poison the complete request before a provider call',async t=>{
  const f=await fixture(t),a=authority(),j=await f.create(a);appendHistory(j.session,'A')
  await j.flush(j.session)
  appendPluginRecord(j.session,MARKER,{version:1,authority:authority('b'),header:j.session.header})
  let calls=0
  await assert.rejects(j.dispatch(j.session,route,()=>{calls++}),/unique origin marker/)
  assert.equal(calls,0)
  const read=await f.persistence.open(a.session_id,'read')
  try{assert.equal((await read.read()).events.filter(e=>e.type===MARKER).length,1,'invalid marker was not persisted')}finally{await read.close()}
})

for(const corruption of ['missing','late','duplicate','wrong-header','wrong-session'])test(`real persistence restore rejects ${corruption} marker`,async t=>{
  const f=await fixture(t),a=authority(),session=Session.create(a.session_id)
  const marker={version:1,authority:a,header:{...session.header,delegationDepth:0}}
  if(corruption==='late')appendHistory(session,'LEGACY')
  if(corruption==='wrong-header')marker.header={...session.header,cwd:'/wrong'}
  if(corruption==='wrong-session')marker.authority={...a,session_id:'other-session'}
  if(corruption!=='missing')appendPluginRecord(session,MARKER,marker)
  if(corruption==='duplicate')appendPluginRecord(session,MARKER,marker)
  const handle=await f.persistence.create(session.header)
  await handle.append(session.snapshotEvents());await handle.flush();await handle.close()
  await assert.rejects(f.restore(a),/marker mismatch/)
})

test('close flushes Host-appended tail and a fresh backend restores real on-disk messages/toolHistory',async()=>{
  const root=await mkdtemp(join(tmpdir(),'kode-scoped-journal-'))
  let ctx=new Context(),j
  try{
    await ctx.plugin(Jsonl,{root,compression:'none'})
    const a=authority(),session=Session.create(a.session_id)
    j=await ScopedCoordinatorJournal.create({session,persistence:ctx.sessionPersistence,authority:a})
    appendHistory(session,'DURABLE')
    await j.close();await ctx.fiber.dispose()
    ctx=new Context();await ctx.plugin(Jsonl,{root,compression:'none'})
    j=await ScopedCoordinatorJournal.restore({persistence:ctx.sessionPersistence,authority:a})
    await j.dispatch(j.session,route,request=>{
      assert.match(JSON.stringify(request.messages),/RESULT_DURABLE/)
      assert.match(JSON.stringify(request.toolHistory),/SCHEMA_DURABLE/)
    })
  }finally{await j?.close().catch(()=>{});try{await ctx.fiber.dispose()}finally{await rm(root,{recursive:true,force:true})}}
})

test('uncertain storage flush fences provider calls and cannot be retried on the same journal',async t=>{
  const f=await fixture(t),a=authority(),session=Session.create(a.session_id)
  let failFlush=false,calls=0
  const persistence={create:async(...args)=>{
    const handle=await f.persistence.create(...args)
    return new Proxy(handle,{get(target,key){
      if(key==='flush')return async()=>{if(failFlush)throw Error('synthetic uncertain flush');return target.flush()}
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
    }})
  }}
  const j=await ScopedCoordinatorJournal.create({session,persistence,authority:a})
  try{
    appendHistory(session,'A');failFlush=true
    await assert.rejects(j.dispatch(session,route,()=>calls++),/uncertain flush/)
    failFlush=false
    await assert.rejects(j.dispatch(session,route,()=>calls++),/failed/)
    assert.equal(calls,0)
  }finally{await j.close()}
})

test('a concurrent Host tail append during durability cannot reach provider unflushed',async t=>{
  const f=await fixture(t),a=authority(),session=Session.create(a.session_id)
  let mutate=false,calls=0
  const persistence={create:async(...args)=>{
    const handle=await f.persistence.create(...args)
    return new Proxy(handle,{get(target,key){
      if(key==='flush')return async()=>{
        await target.flush()
        if(mutate){mutate=false;appendPluginRecord(session,'plugin:kode/fixture-observation',{text:'concurrent'})}
      }
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
    }})
  }}
  const j=await ScopedCoordinatorJournal.create({session,persistence,authority:a})
  try{
    appendHistory(session,'A');mutate=true
    await assert.rejects(j.dispatch(session,route,()=>calls++),/changed during durability/)
    assert.equal(calls,0)
    await j.dispatch(session,route,()=>calls++)
    assert.equal(calls,1,'only the now-durable unchanged journal may dispatch')
  }finally{await j.close()}
})

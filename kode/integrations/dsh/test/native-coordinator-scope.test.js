/** Actual original native factory/driver/adapter with repository RPC fixture,
 * never installed CLI, credentials, network or server readiness changes. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import Sessions from '@deepseek-ai/dsh-session'
import Agents from '@deepseek-ai/dsh-agent'
import Projections from '@deepseek-ai/dsh-session-projection'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import {NativeAgentFactory} from '../src/native-agent-factory.js'
import {boundaryProjection,inboxProjection} from '../src/native-agent-driver.js'
import {AgentRuntimeAdapter} from '../src/agent-runtime.js'
import {AgentProfiles} from '../src/agent-profiles.js'
import {nativeUsageCapability} from '../src/native-session.js'
import {contextScopeKey,discussionScopeId} from '../src/context-scope.js'
import {deliveryInputId} from '../src/delivery-tracker.js'
import {ordinaryHostInstall} from '../src/host-install-admission.js'
import {nativeCoordinatorBinding} from '../src/native-coordinator-scope.js'
const server=fileURLToPath(new URL('./fixture-codex-server.js',import.meta.url))
test('scope production boundary rejects missing managed operation before inference',async t=>{
  const f=await fixture(t),h=await f.factory.createAgent(f.ctx,f.options),{message}=f.input()
  await h.agent.followup(message);await h.agent.whenIdle()
  assert.match(JSON.stringify(h.agent.session.snapshotEvents().findLast(e=>e.type==='turn/end')?.data),/exact managed operation/)
  const wire=await readFile(f.log,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error})
  assert.doesNotMatch(wire,/"method":"turn\/start"/)
})
async function fixture(t,name='A',kind='discussion_thread',type='codex'){
  const dir=await mkdtemp(join(tmpdir(),'kode-native-scope-')),ctx=new Context(),log=join(dir,'wire.jsonl')
  const context_scope={version:2,home_hub:'home',team_id:'team',kind,scope_id:discussionScopeId('surface',name),context_epoch:1},key=contextScopeKey(context_scope)
  const authority={context_scope,context_key:key,session_id:`context-${key}`,journal_id:`journal-${name}`,operation_id:`op-${name}`,origin:{home_hub:'home',host_id:'home',workspace_id:'workspace',root_ref:'root'}}
  const profiles=await new AgentProfiles(join(dir,'profiles.json')).open([{id:'original',name:'Original',type,executable:process.execPath,args:[type==='codex'?server:fileURLToPath(new URL(type==='claude'?'./fixture-claude-stream-json.js':'./fixture-acp-server.js',import.meta.url))],env:{KODE_FIXTURE_RPC_LOG:log,KODE_FIXTURE_AGENT_LABEL:name,KODE_ACP_FIXTURE_LOG:log,KODE_ACP_FIXTURE_LABEL:name,KODE_CLAUDE_FIXTURE_LOG:log,CLAUDE_CONFIG_DIR:dir}}])
  const selection={provider:'kode-agent-original',model:type==='codex'?'fixture-model':type==='claude'?'fixture-claude':'fixture-fast'},snapshot={authority,cwd:dir,selection},sources=new Map()
  await ctx.plugin(Sessions);await ctx.plugin(Agents);await ctx.plugin(Projections);await ctx.plugin(Jsonl,{root:join(dir,'journals'),compression:'none'})
  ctx.sessionProjections.register(boundaryProjection);ctx.sessionProjections.register(inboxProjection)
  ctx.provide('tools',{schemas:()=>[]})
  const adapter=new AgentRuntimeAdapter(ctx,profiles),runtime={adapter,profiles,recordBinding(){},hasRuntime:()=>true}
  const admissions=new Map([[authority.session_id,snapshot]])
  ctx.provide('kodeAgents',runtime)
  ctx.provide('kodeCoordinatorScopeRuntime',{sessionAdmission:id=>structuredClone(admissions.get(id)),async setupAgent(){},async assertSession(){return true},
    inputReceipt:(_a,m)=>sources.get(m.id),async revalidateInput(_a,p){assert.deepEqual(sources.get(deliveryInputId(p.entry.id)),p);return true}})
  const factory=new NativeAgentFactory(ctx),options={sessionId:authority.session_id,agentOptions:selection,meta:{cwd:dir}}
  t.after(async()=>{try{await factory.close();await adapter.close();await ctx.fiber.dispose()}finally{await rm(dir,{recursive:true,force:true})}})
  const input=(id='first')=>{
    const text=`SCOPE_${name}_${id}`,entry={id:`entry-${id}`,claim_id:`claim-${id}`,state:'claimed',context_key:key,journal_id:authority.journal_id,operation_id:authority.operation_id,source_message_id:`source-${id}`,source_content_sha256:createHash('sha256').update(text).digest('hex')}
    const proof={authority,entry,message:{id:entry.source_message_id,content:text,actor:{kind:'human',id:'local_owner'},scope:authority.origin,surface_id:'surface',thread_id:name}}
    const message={id:deliveryInputId(entry.id),role:'user',source:{kind:'user'},content:[{type:'text',text}]};sources.set(message.id,proof);return {message,proof}
  }
  return {ctx,adapter,factory,options,input,snapshot,sources,log,profiles,authority,admissions}
}
test('two scoped sessions share original framework while journals and tool facades remain private',async t=>{
  const f=await fixture(t),a=await f.factory.createAgent(f.ctx,f.options)
  const bSnapshot=structuredClone(f.snapshot)
  bSnapshot.authority.context_scope.scope_id=discussionScopeId('surface','B')
  const key=contextScopeKey(bSnapshot.authority.context_scope)
  Object.assign(bSnapshot.authority,{context_key:key,session_id:`context-${key}`,journal_id:'journal-B',operation_id:'op-B'})
  f.admissions.set(bSnapshot.authority.session_id,bSnapshot)
  const b=await f.factory.createAgent(f.ctx,{...f.options,sessionId:bSnapshot.authority.session_id})
  assert.equal(a.agent.ctx.root,b.agent.ctx.root)
  assert.notEqual(a.agent.session,b.agent.session)
  assert.notEqual(a.agent.ctx.tools,b.agent.ctx.tools)
  assert.notEqual(a.agent.ctx.tools,f.ctx.tools)
  for(const h of [a,b])await ordinaryHostInstall(h.agent,()=>{throw Error('must not install')})
  const {message}=f.input();await a.agent.followup(message);await a.agent.whenIdle()
  assert.equal(a.agent.lastError,undefined)
  assert.ok(!JSON.stringify(b.agent.session.snapshotEvents()).includes('SCOPE_A_first'))
  assert.equal(b.agent.session.snapshotEvents().filter(e=>e.type==='user/message').length,0)
})
test('unadmitted A/B/private sources stay in independent journals without any CLI request or replay',async t=>{
  for(const [name,kind] of [['A','discussion_thread'],['B','discussion_thread'],['DM','team_private']]){
    const f=await fixture(t,name,kind),h=await f.factory.createAgent(f.ctx,f.options),{message}=f.input()
    assert.ok(nativeCoordinatorBinding(h.agent), 'real factory owns a trusted WeakMap binding')
    let installs=0
    await ordinaryHostInstall(h.agent,()=>{installs++;throw Error('must not install')})
    assert.equal(installs,0,'trusted scope cannot enter ordinary token/tool/pump installer')
    await h.agent.followup(message);await h.agent.whenIdle()
    assert.equal(h.agent.session.snapshotEvents()[0].type,'plugin:kode/scoped-coordinator-journal')
    assert.equal(h.agent.lastError,undefined)
    const events=JSON.stringify(h.agent.session.snapshotEvents())
    assert.match(events,/exact managed operation/);assert.match(events,new RegExp(`SCOPE_${name}_first`))
    const wire=await readFile(f.log,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error})
    assert.equal(wire,'','missing operation authority must reject before any CLI request')
    for(const other of ['A','B','DM'])if(other!==name)assert.ok(!events.includes(`SCOPE_${other}_`))
    await assert.rejects(h.agent.followup(message),/already recorded/)
    assert.throws(()=>h.agent.send(message,'next-turn',true),/receipt/)
    await h.dispose()
  }
})
test('foreign receipt, inherited seed, parent, selection and DSH tool injection fail closed',async t=>{
  const f=await fixture(t)
  for(const extra of [{seed:[]},{parentAgent:{}},{agentOptions:{provider:'kode-agent-other',model:'x'}}])await assert.rejects(f.factory.createAgent(f.ctx,{...f.options,...extra}))
  const h=await f.factory.createAgent(f.ctx,f.options),{message,proof}=f.input()
  proof.message.thread_id='B';assert.throws(()=>h.agent.followup(message),/exact owner claim/)
  proof.message.thread_id='A';f.ctx.tools.schemas=()=>[{name:'foreign',parameters:{}}]
  assert.deepEqual(h.agent.ctx.tools.schemas(h.agent),[])
  assert.equal(f.ctx.tools.schemas()[0].name,'foreign')
  await h.agent.followup(message);await h.agent.whenIdle()
  assert.equal(h.agent.lastError,undefined)
})
test('native usage capability boundaries are not replaced by OfficialCall or fixture flags',()=>{
  assert.equal(nativeUsageCapability({type:'codex'}).supported,true)
  for(const profile of [{type:'cursor'},{type:'claude'},{type:'custom',executable:'hy4'}]){
    assert.equal(nativeUsageCapability(profile).supported,false)
    assert.equal(nativeUsageCapability(profile).reason,'usage_collector_unsupported')
  }
  assert.equal(nativeUsageCapability({type:'custom',protocol:'codex'}).supported,true)
})
for(const type of ['cursor','claude'])test(`unadmitted ${type} scope preserves journal source and sends zero CLI requests`,async t=>{
  const f=await fixture(t,type,'discussion_thread',type),h=await f.factory.createAgent(f.ctx,f.options),{message}=f.input()
  await h.agent.followup(message);await h.agent.whenIdle();assert.equal(h.agent.lastError,undefined)
  const events=JSON.stringify(h.agent.session.snapshotEvents())
  assert.match(events,/exact managed operation/);assert.match(events,new RegExp(`SCOPE_${type}_first`))
  const wire=await readFile(f.log,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error})
  assert.equal(wire,'','missing operation authority must reject before any CLI request')
  assert.equal(nativeUsageCapability({type}).supported,false)
})

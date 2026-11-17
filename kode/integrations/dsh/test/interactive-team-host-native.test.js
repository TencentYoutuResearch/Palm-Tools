/** Real Host + native factory/driver/ACP/JSONL. Only BackendClient is a strict in-process ledger. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {randomUUID,createHash} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import Sessions from '@deepseek-ai/dsh-session'
import Agents from '@deepseek-ai/dsh-agent'
import Projections from '@deepseek-ai/dsh-session-projection'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import {AgentProfiles,profileRevision} from '../src/agent-profiles.js'
import {AgentRuntimeAdapter} from '../src/agent-runtime.js'
import {NativeAgentFactory,installNativeFactoryRouting} from '../src/native-agent-factory.js'
import {boundaryProjection,inboxProjection} from '../src/native-agent-driver.js'
import {nativeInteractiveTeamBinding} from '../src/native-interactive-team.js'
import {createInteractiveTeamHostRuntime,isAbsentInteractiveSession} from '../src/interactive-team-host-runtime.js'
import {ordinaryHostInstall} from '../src/host-install-admission.js'
const sha=s=>createHash('sha256').update(s).digest('hex'),copy=v=>structuredClone(v)
async function fixture(t,{noEffort=false,invalidEffort=false,storageFault=false,omittedEffort=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'kode-host-interactive-')),log=join(dir,'wire.jsonl'),ctx=new Context()
 const profiles=await new AgentProfiles(join(dir,'profiles.json')).open([{id:'original',name:'Original',type:'codebuddy',executable:process.execPath,args:[fileURLToPath(new URL(noEffort?'./fixture-acp-no-effort.js':'./fixture-acp-server.js',import.meta.url))],env:{KODE_ACP_FIXTURE_LOG:log}}])
 await ctx.plugin(Sessions);await ctx.plugin(Agents);await ctx.plugin(Projections);await ctx.plugin(Jsonl,{root:join(dir,'journals'),compression:'none'})
 ctx.sessionProjections.register(boundaryProjection);ctx.sessionProjections.register(inboxProjection);ctx.provide('tools',{schemas:()=>[{name:'PARENT_HUB_CANARY',description:'No inheritance',parameters:{type:'object'}}]});ctx.provide('workspaceRegistry',{get:id=>id==='workspace'?{path:dir}:undefined})
 const adapter=new AgentRuntimeAdapter(ctx,profiles),service={profiles,adapter,recordBinding(){},hasRuntime:()=>true};ctx.provide('kodeAgents',service)
 let factory;await ctx.plugin({name:'interactive-host-fixture',inject:['agents','sessions','sessionProjections','sessionPersistence','kodeAgents','tools'],apply(c){factory=new NativeAgentFactory(c)}})
 const bindings=new Map(),sources=new Map(),claims=new Map(),outboxes=new Map(),handles=new Map(),calls=[];let fault=null,creates=0;const bindRequests=new Map()
 const team={id:'team',revision:1,home_hub:'home',spec:{execution_mode:'interactive_native',workers:[]}}
 const backend={async call(route,payload){calls.push({route,payload:copy(payload)});const bits=route.split('/');
  if(route.endsWith('/bindings')&&payload){if(bindRequests.has(payload.request_id))return {...copy(bindRequests.get(payload.request_id)),new_binding:false};const b={version:1,execution_mode:'interactive_native',binding_id:randomUUID(),revision:1,home_hub:'home',...Object.fromEntries(['team_id','team_revision','surface_id','thread_id','audience_revision','context_epoch','participant_id','target_id'].map(k=>[k,payload[k]])),surface_kind:payload.thread_id==='DM'?'dm':'channel',native_session_id:`session-${randomUUID()}`,workspace:{host_id:'home',workspace_id:payload.workspace_id,root_ref:dir},selection:{profile_id:'original',profile_revision:profileRevision(profiles.get('original')),model:'fixture-fast',reasoningEffort:invalidEffort?'INVALID':noEffort||omittedEffort?null:'medium'},state:'bound'};if(payload.first_source_message_id){b.first_source_message_id=payload.first_source_message_id;b.first_source_content_sha256=sha(sources.get(payload.first_source_message_id).content)};bindings.set(b.binding_id,b);bindRequests.set(payload.request_id,{binding:copy(b),team_snapshot:copy(team)});if(fault==='post-target')b.thread_id='FOREIGN';return {binding:copy(b),team_snapshot:copy(team),new_binding:true}}
  const id=bits[bits.indexOf('bindings')+1],b=bindings.get(id);assert.ok(b,'exact binding route')
  if(route.endsWith('/recovery')){if(fault==='recovery-after-create'&&handles.size)throw Error('fixture proof unavailable after create');const m=sources.get(b.first_source_message_id);return {binding:copy(b),team_snapshot:copy(team),message:copy(m),never_claimed:![...claims.values()].some(r=>r.binding.binding_id===id),recovery_state:'unclaimed'}}
  if(!payload){if(fault==='get-target')return {binding:{...copy(b),binding_id:'FOREIGN'},team_snapshot:copy(team)};return {binding:copy(b),team_snapshot:copy(team)}}
  if(route.endsWith('/sources/claim')){const m=sources.get(payload.source_message_id);assert.ok(m);const key=id+':'+payload.request_id,old=claims.get(key);if(old){assert.equal(old.message.id,m.id);return {...copy(old),new_claim:false}}
   const receipt={receipt_id:randomUUID(),binding_id:id,request_id:payload.request_id,native_session_id:b.native_session_id,source_message_id:m.id,source_content_sha256:sha(m.content),state:'claimed'};const value={binding:copy(b),receipt,message:copy(m)};claims.set(key,value);return {...copy(value),new_claim:true}}
  if(route.endsWith('/sources/finish')){assert.deepEqual(Object.keys(payload).sort(),['header_sha256','journal_id','native_session_id','receipt_id','request_id','source_marker_sha256','text','text_sha256','turn_id'].sort());const row=[...claims.values()].find(x=>x.receipt.receipt_id===payload.receipt_id);assert.ok(row);assert.equal(payload.native_session_id,b.native_session_id);assert.equal(payload.text_sha256,sha(payload.text));
   const out={outbox_id:randomUUID(),binding_id:id,receipt_id:payload.receipt_id,state:'pending',text:payload.text,text_sha256:payload.text_sha256,host_report:Object.fromEntries(['journal_id','turn_id','header_sha256','source_marker_sha256'].map(k=>[k,payload[k]])),proof_kind:'owner_host_report'};
   if(fault==='old-outbox'){const old=[...outboxes.values()][0];return {binding:copy(b),receipt:{...copy(row.receipt),state:'completed',outbox_id:old.outbox_id},outbox:{...copy(old),state:'pending'},new_completion:true}}
   row.receipt={...row.receipt,state:'completed',outbox_id:out.outbox_id};outboxes.set(out.outbox_id,out);return {binding:copy(b),receipt:copy(row.receipt),outbox:copy(out),new_completion:true}}
  if(route.endsWith('/publish')){const oid=bits.at(-2),out=outboxes.get(oid);assert.ok(out);const row=[...claims.values()].find(x=>x.receipt.receipt_id===out.receipt_id),m={id:randomUUID(),surface_id:b.surface_id,thread_id:b.thread_id,scope:copy(row.message.scope),actor:{kind:'interactive_participant',team_id:b.team_id,participant_id:b.participant_id,target_id:b.target_id,session_id:b.native_session_id},kind:'superagent_reply',content:out.text,source_message_id:row.receipt.source_message_id,delivery_state:'published',execution_authorized:false};
   if(fault==='publish-source')m.source_message_id='OTHER';if(fault==='publish-content')m.content='OTHER';if(fault==='publish-actor')m.actor.target_id='OTHER';out.state='published';out.message=m;return {receipt:copy(row.receipt),outbox:copy(out),message:copy(m),new_publication:true}}
  throw Error('Unexpected backend route '+route)
 }}
 const runtimeCtx=storageFault?{get:name=>name==='sessionPersistence'?{open:async()=>{throw Object.assign(Error('permission denied'),{code:'EPERM'})}}:ctx.get(name)}:ctx
 const host=createInteractiveTeamHostRuntime({ctx:runtimeCtx,backend,service,home:'home',nativeBinding:nativeInteractiveTeamBinding});ctx.provide('kodeInteractiveTeamRuntime',host)
 ctx.provide('sessionController',{list:async()=>({items:[...handles.keys()].map(sessionId=>({sessionId}))}),create:async({sessionId})=>{creates++;if(fault==='create-before-storage')throw Error('fixture before storage');const h=await factory.createAgent(ctx,{sessionId,agentOptions:{provider:'unrelated-global',model:'unrelated'},meta:{cwd:dir}});handles.set(sessionId,h);await ordinaryHostInstall(h.agent,()=>{throw Error('must not install parent Hub')});return {sessionId}},resolveAgent:async id=>({agent:handles.get(id)?.agent})})
 t.after(async()=>{try{await factory.close();await adapter.close();await ctx.fiber.dispose()}finally{await rm(dir,{recursive:true,force:true})}})
 const open=async thread=>host.open({request_id:randomUUID(),team_id:'team',team_revision:1,surface_id:'surface',thread_id:thread,audience_revision:1,participant_id:'coordinator',target_id:'target',workspace_id:'workspace',context_epoch:1})
 const deliver=async(b,n)=>{const m={id:randomUUID(),content:`CANARY_${b.thread_id}_${n}`,actor:{kind:'human',id:'local_owner'},surface_id:b.surface_id,thread_id:b.thread_id,scope:{home_hub:b.home_hub,...b.workspace}};sources.set(m.id,m);return host.deliver({binding_id:b.binding_id,request_id:randomUUID(),source_message_id:m.id}).catch(e=>{const a=handles.get(b.native_session_id).agent;throw new Error(e.message+'; '+(a.lastError?.stack??JSON.stringify(a.session.snapshotEvents().findLast(e=>e.type==='turn/end')?.data)))})}
 return {ctx,host,open,deliver,calls,log,handles,outboxes,sources,bindings,profiles,fault:v=>{fault=v},creates:()=>creates}
}
test('actual Host opens original native sessions and publishes six same-scope journal replies',async t=>{
 const f=await fixture(t)
 for(const name of ['A','B','DM']){const opened=await f.open(name);for(const n of [1,2]){const result=await f.deliver(opened.binding,n);assert.equal(result.state,'published');assert.deepEqual(result.usage,{state:'unknown'})}}
 assert.equal(f.creates(),3);assert.equal(f.calls.filter(c=>c.route.endsWith('/publish')).length,6);assert.ok(!(await readFile(f.log,'utf8')).includes('PARENT_HUB_CANARY'))
})
for(const fault of ['old-outbox','publish-source','publish-content','publish-actor'])test(`actual Host refuses ${fault} completion substitution`,async t=>{
 const f=await fixture(t),a=await f.open('A');await f.deliver(a.binding,1);f.fault(fault);const before=f.calls.filter(c=>c.route.endsWith('/publish')).length
 await assert.rejects(f.deliver(a.binding,2),/outcome requires inspection|receipt differs/)
 if(fault==='old-outbox')assert.equal(f.calls.filter(c=>c.route.endsWith('/publish')).length,before)
})
test('GET wrong binding and POST wrong target reject before create',async t=>{
 const f=await fixture(t);f.fault('post-target');await assert.rejects(f.open('A'),/target differs/);assert.equal(f.creates(),0)
 f.fault(null);const a=await f.open('A');f.fault('get-target');await assert.rejects(f.deliver(a.binding,1),/read identity differs/)
})

test('original no-reasoning model accepts null effort without inventing one',async t=>{const f=await fixture(t,{noEffort:true}),a=await f.open('NoEffort');assert.equal(a.binding.selection.reasoningEffort,null);assert.equal((await f.deliver(a.binding,1)).state,'published')})
test('invalid frozen effort rejects before any Session is created',async t=>{const f=await fixture(t,{invalidEffort:true});await assert.rejects(f.open('BadEffort'),/推理强度/);assert.equal(f.creates(),0)})
test('false terminal durability blocks finish and publication',async t=>{
 const f=await fixture(t),a=await f.open('Durable'),agent=f.handles.get(a.session_id).agent
 const remove=f.ctx.on('session/event',(session,event)=>{if(session===agent.session&&event.type==='turn/end'){agent.ctx=agent.ctx.extend({sessions:{flush:async()=>false}})}})
 await assert.rejects(f.deliver(a.binding,1),/outcome requires inspection|not durable/);remove()
 assert.equal(f.calls.filter(c=>c.route.endsWith('/sources/finish')||c.route.endsWith('/publish')).length,0)
})

test('owner explicitly recovers same unclaimed source after bind but before native storage, once',async t=>{
 const f=await fixture(t),source={id:'original-source',content:'CANARY_recovery',actor:{kind:'human',id:'local_owner'},surface_id:'surface',thread_id:'original-source',scope:{home_hub:'home'}}
 f.sources.set(source.id,source)
 const input={request_id:'composer:original-source',team_id:'team',team_revision:1,surface_id:'surface',thread_id:source.id,audience_revision:1,participant_id:'coordinator',target_id:'target',workspace_id:'workspace',context_epoch:1,first_source_message_id:source.id}
 f.fault('create-before-storage');await assert.rejects(f.host.open(input),/fixture before storage/)
 const b=[...f.bindings.values()][0],cmd={binding_id:b.binding_id,source_message_id:source.id,request_id:'composer-source:original-source'}
 assert.equal((await f.host.inspect(b.binding_id)).recovery.state,'recoverable')
 assert.equal((await f.host.inspect(b.binding_id)).diagnostic.phase,'native_create')
 f.fault(null);await assert.rejects(f.host.open(input),/explicit original-source recovery/)
 const results=await Promise.allSettled([f.host.recover(cmd),f.host.recover(cmd)])
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
 assert.equal(results.find(r=>r.status==='fulfilled').value.state,'published')
 assert.equal(f.bindings.size,1);assert.equal(f.handles.size,1)
 assert.equal([...f.handles.keys()][0],b.native_session_id)
 await assert.rejects(f.host.recover(cmd),/not safely recoverable/)
 assert.equal((await f.host.inspect(b.binding_id)).recovery.state,'requires_inspection')
 assert.equal(f.calls.filter(c=>c.route.endsWith('/publish')).length,1)
})

test('factory routing honors exact interactive admission ahead of unrelated global defaults',async()=>{
 const upstream={createAgent:async()=>{throw Error('unexpected official fallback')},resume:async()=>{throw Error('unexpected resume')}}
 const runtime={sessionAdmission:async id=>id==='owned'?{binding:{native_session_id:id,execution_mode:'interactive_native'}}:undefined}
 const ctx={agents:{requireFactory:()=>({target:upstream}),get:()=>undefined},kodeAgents:{profiles:{bindings:{}}},on(){},get:name=>name==='kodeInteractiveTeamRuntime'?runtime:undefined}
 let calls=0
 const native={createAgent:async(_ctx,options)=>{calls++;return {agent:{id:options.sessionId}}}}
 const remove=installNativeFactoryRouting(ctx,native)
 await upstream.createAgent(ctx,{sessionId:'owned',agentOptions:{provider:'official',model:'global'},meta:{agentPreset:'kode-native'}})
 assert.equal(calls,1)
 await assert.rejects(upstream.createAgent(ctx,{sessionId:'ordinary',agentOptions:{provider:'official',model:'global'},meta:{agentPreset:'kode-native'}}),/official fallback/)
 remove()
 await assert.rejects(upstream.createAgent(ctx,{sessionId:'owned',agentOptions:{provider:'official',model:'global'},meta:{agentPreset:'kode-native'}}),/保护历史/)
})

test('creation succeeded but subsequent proof failed: persisted native identity is inspection-only',async t=>{
 const f=await fixture(t),m={id:'proof-source',content:'CANARY_proof',actor:{kind:'human',id:'local_owner'},surface_id:'surface',thread_id:'proof-source',scope:{home_hub:'home'}};f.sources.set(m.id,m)
 const command={request_id:'composer:proof-source',team_id:'team',team_revision:1,surface_id:'surface',thread_id:m.id,audience_revision:1,participant_id:'coordinator',target_id:'target',workspace_id:'workspace',context_epoch:1,first_source_message_id:m.id}
 f.fault('create-before-storage');await assert.rejects(f.host.open(command));const b=[...f.bindings.values()][0],input={binding_id:b.binding_id,source_message_id:m.id,request_id:'composer-source:proof-source'}
 f.fault('recovery-after-create');await assert.rejects(f.host.recover(input),/proof unavailable/)
 f.fault(null);const status=await f.host.inspect(b.binding_id);assert.equal(status.recovery.recovery_allowed,false);assert.equal(status.recovery.native_absent,false);assert.equal(status.recovery.never_claimed,true)
 const count=f.creates();await assert.rejects(f.host.recover(input),/not safely recoverable/);assert.equal(f.creates(),count);assert.equal(f.calls.filter(c=>c.route.endsWith('/sources/claim')).length,0)
})

test('released runtime persistence error identity works across separate package constructors',async()=>{
 const {SessionPersistenceNotFoundError:Local}=await import('@deepseek-ai/dsh-session-persistence')
 const Other=class SessionPersistenceNotFoundError extends Error {constructor(id){super('session absent');this.name='SessionPersistenceNotFoundError';this.sessionId=id}}
 const error=new Other('same-id');assert.equal(error instanceof Local,false)
 assert.equal(isAbsentInteractiveSession(error,'same-id'),true)
 for(const e of [new Other('foreign-id'),Object.assign(new Error('not found'),{code:'ENOENT'}),{name:'SessionPersistenceNotFoundError',sessionId:'same-id'},new Error('permission denied')])assert.equal(isAbsentInteractiveSession(e,'same-id'),false)
})

test('unknown native storage permission failure never permits create or recovery',async t=>{
 const f=await fixture(t,{storageFault:true})
 await assert.rejects(f.open('NoAccess'),/permission denied/)
 assert.equal(f.creates(),0)
 assert.equal(f.calls.filter(c=>c.route.endsWith('/sources/claim')).length,0)
})

test('frozen unspecified effort preserves native default without silently rewriting binding',async t=>{
 const f=await fixture(t,{omittedEffort:true}),opened=await f.open('NativeDefault')
 assert.equal(opened.binding.selection.reasoningEffort,null)
 assert.equal(f.handles.get(opened.session_id).agent.model.current().reasoningEffort,undefined)
 assert.equal((await f.deliver(opened.binding,1)).state,'published')
 assert.equal([...f.bindings.values()][0].selection.reasoningEffort,null)
 const wire=(await readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse)
 assert.equal(wire.some(r=>r.method==='session/set_config_option'&&r.params?.configId==='effort'),false)
})

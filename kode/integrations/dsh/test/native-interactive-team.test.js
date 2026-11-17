import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {createHash,randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import Sessions from '@deepseek-ai/dsh-session'
import Agents from '@deepseek-ai/dsh-agent'
import Projections from '@deepseek-ai/dsh-session-projection'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import {NativeAgentFactory} from '../src/native-agent-factory.js'
import {boundaryProjection,inboxProjection} from '../src/native-agent-driver.js'
import {AgentRuntimeAdapter} from '../src/agent-runtime.js'
import {AgentProfiles} from '../src/agent-profiles.js'
import {deliveryInputId} from '../src/delivery-tracker.js'
import {nativeInteractiveTeamBinding,INTERACTIVE_TEAM_RECORD,INTERACTIVE_TEAM_INPUT_RECORD} from '../src/native-interactive-team.js'
async function fixture(t,type='codebuddy'){
 const dir=await mkdtemp(join(tmpdir(),'kode-interactive-test-')),ctx=new Context(),log=join(dir,'wire.jsonl')
 const profiles=await new AgentProfiles(join(dir,'profiles.json')).open([{id:'original',name:'Original',type,executable:process.execPath,args:[fileURLToPath(new URL(type==='codex'?'./fixture-codex-server.js':'./fixture-acp-server.js',import.meta.url))],env:{KODE_ACP_FIXTURE_LOG:log,KODE_FIXTURE_RPC_LOG:log}}])
 await ctx.plugin(Sessions);await ctx.plugin(Agents);await ctx.plugin(Projections);await ctx.plugin(Jsonl,{root:join(dir,'journals'),compression:'none'})
 ctx.sessionProjections.register(boundaryProjection);ctx.sessionProjections.register(inboxProjection);ctx.provide('tools',{schemas:()=>[{name:'PARENT_HUB_CANARY',description:'must not inherit',parameters:{type:'object'}}]})
 const adapter=new AgentRuntimeAdapter(ctx,profiles),runtime={adapter,profiles,recordBinding(){},hasRuntime:()=>true};ctx.provide('kodeAgents',runtime)
 const admissions=new Map(),sources=new Map(),completed=[],before=[],approvals=[];let revoked=false,deny=false
 ctx.provide('approval',{effectivePolicy:()=> 'never',request:async request=>{approvals.push(request.toolName);return 'denied'}})
 ctx.provide('sandboxPolicy',{resolve:()=>({mode:'danger-full-access'})})
 ctx.provide('kodeInteractiveTeamRuntime',{sessionAdmission:id=>structuredClone(admissions.get(id)),async setupAgent(){},async assertSession(){return !revoked},inputReceipt:(_a,m)=>sources.get(m.id),async revalidateInput(_a,{receipt}){return !revoked&&[...sources.values()].some(p=>p.receipt.receipt_id===receipt.receipt.receipt_id)},async beforeTurn(a,p){before.push(p);assert.equal(p.selection.model.status,type==='codex'?'requested':'reported');assert.equal(a.session.snapshotEvents().filter(e=>e.type===INTERACTIVE_TEAM_INPUT_RECORD).length,before.filter(x=>x.binding.binding_id===p.binding.binding_id).length);return {receipt_id:p.receipt.receipt.receipt_id,state:'claimed',dispatch_allowed:!revoked&&!deny}},async completedTurn(a,p){assert.equal(a.session.snapshotEvents().findLast(e=>e.type==='turn/end').data.reason.kind,'completed');assert.equal('text' in p,false);completed.push(p)}})
 let factory;await ctx.plugin({name:'fixture-native-owner',inject:['agents','sessions','sessionProjections','sessionPersistence','kodeAgents','tools'],apply(c){factory=new NativeAgentFactory(c)}})
 t.after(async()=>{try{await factory.close();await adapter.close();await ctx.fiber.dispose()}finally{await rm(dir,{recursive:true,force:true})}})
 const make=async(name,kind='channel')=>{
  const id=`session-${randomUUID()}`,bound=await profiles.bind(id,'original'),selection={provider:'kode-agent-original',model:type==='codex'?'fixture-model':'fixture-fast'}
  const binding={version:1,execution_mode:'interactive_native',binding_id:`binding-${name}`,revision:1,home_hub:'home',team_id:'team',team_revision:1,surface_kind:kind,surface_id:'surface',thread_id:name,audience_revision:1,context_epoch:1,participant_id:'coordinator',target_id:'target',native_session_id:id,workspace:{host_id:'host',workspace_id:'workspace',root_ref:dir},selection:{profile_id:'original',profile_revision:bound.revision,model:type==='codex'?'fixture-model':'fixture-fast'},state:'bound'}
  admissions.set(id,{binding,cwd:dir,selection});const options={sessionId:id,agentOptions:selection,meta:{cwd:dir}},h=await factory.createAgent(ctx,options)
  const input=(n)=>{const text=`CANARY_${name}_${n}`,receipt={receipt_id:`${name}-${n}`,binding_id:binding.binding_id,source_message_id:`source-${name}-${n}`,source_content_sha256:createHash('sha256').update(text).digest('hex'),native_session_id:id,state:'claimed'},message={id:deliveryInputId(receipt.receipt_id),role:'user',source:{kind:'user'},content:[{type:'text',text}]};sources.set(message.id,{binding,receipt,message:{id:receipt.source_message_id,content:text,actor:{kind:'human',id:'local_owner'},surface_id:'surface',thread_id:name},new_claim:true});return message}
  return {h,binding,options,input}
 }
 return {ctx,factory,profiles,make,admissions,sources,completed,before,log,approvals,deny:()=>{deny=true},revoke:()=>{revoked=true}}
}
test('real native factory, original CodeBuddy ACP fixture, A/B/DM multiple turns and JSONL stay distinct',async t=>{
 const f=await fixture(t),items=[]
 for(const [name,kind] of [['A','channel'],['B','channel'],['DM','dm']]){const item=await f.make(name,kind);items.push(item);assert.ok(nativeInteractiveTeamBinding(item.h.agent));for(const n of [1,2]){await item.h.agent.followup(item.input(n));await item.h.agent.whenIdle();assert.equal(item.h.agent.session.snapshotEvents().findLast(e=>e.type==='turn/end').data.reason.kind,'completed',JSON.stringify(item.h.agent.session.snapshotEvents().findLast(e=>e.type==='turn/end').data))}}
 assert.equal(f.completed.length,6);assert.equal(f.before.length,6)
 for(const item of items){const log=JSON.stringify(item.h.agent.session.snapshotEvents());assert.equal(item.h.agent.session.snapshotEvents()[0].type,INTERACTIVE_TEAM_RECORD);for(const other of items)if(item!==other)assert.ok(!log.includes(`CANARY_${other.binding.thread_id}_`));await assert.rejects(item.h.agent.followup(item.input(1)),/already recorded/);assert.equal(f.profiles.binding(item.h.agent.id).managedOperation,undefined)}
 const wire=JSON.parse('['+(await readFile(f.log,'utf8')).trim().split('\n').join(',')+']');assert.equal(wire.filter(r=>r.method==='session/prompt').length,6)
})
test('foreign body and revoked owner cannot enter native prompt; ordinary cache lookup is empty',async t=>{
 const f=await fixture(t),a=await f.make('A'),m=a.input(1);m.content[0].text='FOREIGN';assert.throws(()=>a.h.agent.followup(m),/trusted source/)
 f.revoke();await assert.rejects(a.h.agent.followup(a.input(2)),/authority changed/)
 assert.equal(await readFile(f.log,'utf8').catch(()=>''),'')
 assert.equal(await f.ctx.get('kodeInteractiveTeamRuntime').sessionAdmission('ordinary',{mode:'restore'}),undefined)
})

test('Codex original explicit model wire has independent source admission, no managed gate',async t=>{
 const f=await fixture(t,'codex'),a=await f.make('Codex');await a.h.agent.followup(a.input(1));await a.h.agent.whenIdle()
 assert.equal(a.h.agent.session.snapshotEvents().findLast(e=>e.type==='turn/end').data.reason.kind,'completed',JSON.stringify(a.h.agent.session.snapshotEvents().findLast(e=>e.type==='turn/end').data))
 const wire=(await readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);const turn=wire.find(r=>r.method==='turn/start');assert.equal(turn.params.model,'fixture-model');assert.equal(f.before.length,1);assert.equal(f.completed.length,1);assert.ok(!JSON.stringify(wire).includes('PARENT_HUB_CANARY'));assert.ok(!JSON.stringify(wire).includes('Find a named conversation'))
})
test('completed journal cold admission is exact; missing Host marker fallback rejected',async t=>{
 const f=await fixture(t),a=await f.make('Cold');await a.h.agent.followup(a.input(1));await a.h.agent.whenIdle();await a.h.dispose()
 const restored=await f.factory.resume(f.ctx,{resumeSessionId:a.binding.native_session_id,agentOptions:a.options.agentOptions});assert.ok(nativeInteractiveTeamBinding(restored.agent));await restored.dispose()
 f.admissions.delete(a.binding.native_session_id);await assert.rejects(f.factory.resume(f.ctx,{resumeSessionId:a.binding.native_session_id,agentOptions:a.options.agentOptions}),/fall back/)
})

test('explicit interactive denial emits zero prompt and failed source cannot cold replay',async t=>{
 const f=await fixture(t),a=await f.make('Denied');f.deny();await a.h.agent.followup(a.input(1));await a.h.agent.whenIdle()
 assert.equal(a.h.agent.session.snapshotEvents().findLast(e=>e.type==='turn/end').data.reason.kind,'error')
 const wire=await readFile(f.log,'utf8');assert.ok(!wire.includes('session/prompt'));assert.ok(!wire.includes('PARENT_HUB_CANARY'))
 await a.h.dispose();await assert.rejects(f.factory.resume(f.ctx,{resumeSessionId:a.binding.native_session_id,agentOptions:a.options.agentOptions}),/Uncertain interactive/)
})
test('CLI native permission invokes original ask and never inherits parent never shortcut',async t=>{
 const f=await fixture(t),a=await f.make('APPROVAL');await a.h.agent.followup(a.input(1));await a.h.agent.whenIdle()
 assert.equal(f.approvals.length,1)
 const rows=(await readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rows.find(r=>r.method==='permission-result').params.outcome.optionId,'deny');assert.ok(!JSON.stringify(rows).includes('PARENT_HUB_CANARY'));assert.equal(rows.find(r=>r.method==='session/new').params.mcpServers.length,0)
})

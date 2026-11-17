/** Installed SessionController + real official/native factories. No CLI or model. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { AgentProfiles } from '../src/agent-profiles.js'
import * as factoryPlugin from '../src/native-agent-factory.js'
import { createBuilderPlanningSessions } from '../src/builder-planning-session.js'
import { createNativePlanningBridge } from '../src/native-planning-bridge.js'
import { nativePlanningBinding, NATIVE_PLANNING_RECORD } from '../src/native-planning-session.js'
import { AgentRuntimeAdapter } from '../src/agent-runtime.js'
import { persistedPlanningContext, planningContextInput, PLANNING_TURN_CONTEXT_RECORD } from '../src/planning-draft-context.js'
import { readBuilderProposalCandidate } from '../src/builder-proposal-candidate.js'
import { BUILDER_PLANNING_PROMPT } from '../src/builder-planning-prompt.js'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
async function fixture(t, provider, legacyPartial = false, saved, wireType) {
  const root = saved?.root ?? await mkdtemp(join(tmpdir(),'kode-planning-controller-')), ctx = new Context(), rows = saved?.rows ?? new Map(), writers = new Set(), fibers = [], faults = {}
  const disk = saved?.disk ?? {state:null,revision:0,creates:0,nativeCalls:0,workspaceIds:[]}
  let planning, admit = true, closed = false, admissionOverride
  const shutdown=async()=>{if(closed)return;closed=true;for(const f of [...fibers].reverse())await f.dispose();await service.adapter.close?.();await profiles.close?.()}
  const wire=join(root,'wire.jsonl')
  const profiles=await new AgentProfiles(join(root,'profiles.json')).open([{id:'selected',name:'Selected',type:wireType??'custom',executable:process.execPath,...(wireType?{args:[fileURLToPath(new URL(wireType==='claude'?'./fixture-claude-stream-json.js':'./fixture-codex-server.js',import.meta.url))],env:{KODE_CLAUDE_FIXTURE_LOG:wire,KODE_FIXTURE_RPC_LOG:wire,CLAUDE_CONFIG_DIR:root}}:{})}])
  for(const plugin of [SessionStore,AgentRegistry,ProjectionRegistry]) fibers.push(await ctx.plugin(plugin))
  const handle=(row,write)=>({header:row.header,inheritedEventCount:0,read:async()=>({events:[...row.events]}),append:async events=>row.events.push(...events),flush:async()=>{if(faults.failMarkerFlush&&row.events.some(e=>e.type===NATIVE_PLANNING_RECORD))throw Error('fixture interrupted marker flush')},close:async()=>{if(write)writers.delete(row.header.id)}})
  ctx.provide('sessionPersistence',{create:async header=>{disk.creates++;assert.ok(!rows.has(header.id));const row={header,events:[]};rows.set(header.id,row);writers.add(header.id);return handle(row,true)},open:async(id,access)=>{if(!rows.has(id))throw Error('not found');if(access==='write'){await faults.beforeWriter?.(id);if(writers.has(id))throw Error('already owned');writers.add(id)}return handle(rows.get(id),access==='write')}})
  ctx.on('session/event',(session,event)=>{if(writers.has(session.id))rows.get(session.id).events.push(event)});ctx.on('session/flush',async()=>{})
  const workspace={id:'workspace',path:root,sessionIds:disk.workspaceIds,attachSession:async id=>{if(!workspace.sessionIds.includes(id))workspace.sessionIds.push(id)}}
  const service={profiles,hasRuntime:()=>true,recordBinding(agent,profile){agent.session.append('plugin:kode/agent-binding',{profileId:profile.id,name:profile.name,type:profile.type,uiChannel:'native'})},adapter:{listModels:async()=>[{id:'chosen-model'}],closeSession:async()=>{},hasContinuation:()=>false,async *stream(){disk.nativeCalls++;throw Error('No model must run')}}}
  if(wireType){const adapter=new AgentRuntimeAdapter(ctx,profiles,{recordNative(){},resolveProfile:async p=>p});const stream=adapter.stream.bind(adapter);adapter.stream=async function*(options){disk.nativeCalls++;yield* stream(options)};adapter.listModels=async()=>[{id:wireType==='claude'?'fixture-claude':'fixture'}];service.adapter=adapter}
  const services={tools:{schemas:()=>[],resolve:async()=>({tools:[],schemas:[],dispose(){}})},systemPrompt:{variable:()=>()=>{}},llm:{},sessionTitle:{rename:()=>({eventSeq:0})},kodeAgents:service,
    agentDefaultModel:{currentSelection:()=>({provider,model:'global-default'})},attachments:{imageLimits:{maxImageBytes:1024}},fileUploads:{registerAgentResolver:()=>()=>{}},fs:{},remoteAccess:{allows:()=>true},
    typert:{resources:{register(){}},lookups:{configure(){}},contexts:{configureHost(){}}},workspaceRegistry:{get:id=>id==='workspace'?workspace:undefined,list:()=>[workspace],archivedSessionIds:[]},
    sessionQuery:{listSessions:async()=>[...rows.values()].map(row=>({header:row.header})),observeSession:async id=>{const row=rows.get(id);if(!row)throw new SessionQueryError('not found','SESSION_QUERY_SESSION_NOT_FOUND');return{...row,inheritedEventCount:0,[Symbol.dispose](){}}}},
    agentPresets:{register:async()=>()=>{},resolve:async id=>({id}),mount:async(scope)=>{const session=scope.get('agent')?.session; if(session) for(const type of ['permission/preset','sandbox/mode','approval/policy'])session.append(type,{fixture:true})}},
    kodePlanningRuntime:{sessionAdmission:(...args)=>admissionOverride?admissionOverride(...args):admit?planning?.sessionAdmission(...args):undefined,completionAdmission:(...args)=>planning.completionAdmission(...args),readContext:(...args)=>planning.readContext(...args),inspect:(...args)=>planning.inspect(...args)},}
  for(const[name,value]of Object.entries(services))ctx.provide(name,value)
  fibers.push(await ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:10}));const factoryFiber=await ctx.plugin(factoryPlugin);fibers.push(factoryFiber);fibers.push(await ctx.plugin(SessionController,{nativeOpen:false}))
  for(const fiber of fibers)await fiber.await?.()
  const draft={id:'draft',home_hub:'home',status:'draft',revision:1,interview:{purpose:'Plan',workspace_refs:[{host_id:'home',workspace_id:'workspace',root_ref:root}]}}
  const backend={call:async(path,body)=>{if(path.endsWith('/selection'))return{draft_id:'draft',home_hub:'home',runtime_binding:null,record:null};if(path.endsWith('/drafts/draft'))return structuredClone(draft);assert.ok(path.endsWith('/documents/session-index'));if(body){assert.equal(body.expected_revision,disk.revision);disk.state=structuredClone(body.value);disk.revision++}return{value:structuredClone(disk.state),revision:disk.revision}}}
  const bridge=createNativePlanningBridge({ctx,service});
  if(legacyPartial){const legacy={...bridge,async create(input){
    const location=input.workspace_id?{workspaceId:input.workspace_id}:{cwd:(await planning.sessionAdmission(input.session_id,{mode:'fresh'})).binding.cwd}
    admit=false;let agent;try {await ctx.sessionController.create({sessionId:input.session_id,agentPreset:'kode-native',...location});agent=(await ctx.sessionController.resolveAgent(input.session_id)).agent}finally{admit=true}
    // Reproduce the old controller/routing sequence using a real official Agent.
    assert.notEqual(agent.isKodeNativeAgent,true)
    if(agent.session.snapshotEvents().length===0)for(const type of ['permission/preset','sandbox/mode','approval/policy'])agent.session.append(type,{fixture:true})
    await profiles.bind(agent.id,input.profile_id);service.recordBinding(agent,profiles.get(input.profile_id))
    await ctx.sessions.flush(agent.session)
    await ctx.kodeNativeFactory.promote(agent,input.selection)
    throw Error('old promotion unexpectedly succeeded')
  }};
    planning=createBuilderPlanningSessions({ctx,backendClient:backend,home:'home',service,bridge:legacy})
  }else planning=createBuilderPlanningSessions({ctx,backendClient:backend,home:'home',service,bridge})
  const request={draft_id:'draft',draft_revision:1,request_id:'original',profile_id:'selected',model:wireType?(wireType==='claude'?'fixture-claude':'fixture'):'chosen-model',workspace_id:'workspace'}
  t.after(async()=>{await shutdown();if(!saved)await rm(root,{recursive:true,force:true})})
  return{ctx,rows,planning,bridge,service,request,root,wire,backend,factoryFiber,fibers,shutdown,faults,draft,disk,checkpoint:()=>({root,rows,disk}),overrideAdmission:fn=>{admissionOverride=fn},counts:()=>({creates:disk.creates,nativeCalls:disk.nativeCalls}),state:()=>disk.state}
}
for(const provider of ['official-dsh','kode-agent-selected'])test(`actual controller global ${provider} still enters owner-selected native planning fresh path`,async t=>{
 const f=await fixture(t,provider),opened=await f.planning.open(f.request),found=await f.ctx.sessionController.resolveAgent(opened.session_id),agent=found.agent
 assert.equal(found.error,undefined);assert.equal(agent.isKodeNativeAgent,true);assert.equal(nativePlanningBinding(agent).draft_id,'draft')
 assert.equal(agent.options.provider,'kode-agent-selected');assert.equal(agent.options.model,'chosen-model')
 assert.equal(f.rows.get(agent.id).events.filter(e=>e.type===NATIVE_PLANNING_RECORD).length,1)
 assert.deepEqual(f.counts(),{creates:1,nativeCalls:0});assert.equal(opened.state,'ready')
 const recovered=await f.planning.open(f.request);assert.equal(recovered.session_id,agent.id);assert.deepEqual(f.counts(),{creates:1,nativeCalls:0})
})
test('missing owner admission does not turn an ordinary dsh create into planning',async t=>{
 const f=await fixture(t,'official-dsh'),id='session-22222222-2222-4222-8222-222222222222'
 await f.ctx.sessionController.create({sessionId:id,agentPreset:'kode-native',cwd:f.root})
 const {agent}=await f.ctx.sessionController.resolveAgent(id)
 assert.notEqual(agent.isKodeNativeAgent,true);assert.equal(nativePlanningBinding(agent),undefined)
 assert.equal(typeof agent.selectModel,'undefined','installed ReactLoopAgent is not the SessionController command API')
 assert.equal(f.rows.get(id).events.some(e=>e.type===NATIVE_PLANNING_RECORD),false);assert.equal(f.counts().nativeCalls,0)
})

test('explicit completion of original partial uses same ID through the real factory and sends no model input',async t=>{
 const f=await fixture(t,'official-dsh',true)
 await assert.rejects(f.planning.open(f.request),/requires inspection/)
 const before=await f.planning.inspect('draft'),id=before.session_id,row=f.rows.get(id),prefix=structuredClone(row.events)
 assert.equal(before.state,'uncertain');assert.deepEqual(prefix.map(e=>e.type),['permission/preset','sandbox/mode','approval/policy','plugin:kode/agent-binding'])
 await assert.rejects(f.planning.open(f.request),/blank journal|binding changed|recovery/)
 assert.deepEqual(row.events,prefix)
 const repaired=await f.planning.open({...f.request,complete_partial:true})
 assert.equal(repaired.session_id,id);assert.equal(repaired.state,'ready');assert.equal(repaired.execution_authorized,false)
 assert.deepEqual(row.events.slice(0,prefix.length),prefix)
 assert.equal(row.events.filter(e=>e.type===NATIVE_PLANNING_RECORD).length,1)
 assert.equal(row.events.filter(e=>e.type==='plugin:kode/planning-creation-completed').length,1)
 assert.deepEqual(row.events.find(e=>e.type==='model/selection').data,{provider:'kode-agent-selected',model:'chosen-model'})
 assert.equal(row.events.some(e=>/^(user|assistant|tool|turn|request)\//.test(e.type)),false)
 assert.equal((await f.ctx.sessionController.resolveAgent(id)).agent.isKodeNativeAgent,true)
 assert.deepEqual(f.counts(),{creates:1,nativeCalls:0})
 assert.equal((await f.planning.open({...f.request,complete_partial:true})).session_id,id)
 assert.deepEqual(f.counts(),{creates:1,nativeCalls:0})
})
for(const fault of ['input','foreign-profile','thread','continuation','wrong-request','officialToolArchive','officialCalls','officialTools','quotaFenceRevision','remoteQuotaFences','usageOutbox','runtime-removed','subagent-origin'])test(`partial completion rejects ${fault} without rewriting the original journal`,async t=>{
 const f=await fixture(t,'official-dsh',true);await assert.rejects(f.planning.open(f.request))
 const id=(await f.planning.inspect('draft')).session_id,row=f.rows.get(id),command={...f.request,complete_partial:true}
 if(fault==='input')row.events.push({seq:row.events.length,type:'user/message',data:{id:'historical'}})
 if(fault==='foreign-profile')row.events[row.events.length-1]={...row.events.at(-1),data:{...row.events.at(-1).data,profileId:'foreign'}}
 if(fault==='thread')await f.service.profiles.patchBinding(id,{threadId:'unrelated-thread'})
 if(fault==='continuation')f.service.adapter.hasContinuation=()=>true
 if(fault==='wrong-request')command.request_id='another-request'
 if(['officialToolArchive','officialCalls','officialTools','usageOutbox'].includes(fault))await f.service.profiles.patchBinding(id,{[fault]:{activity:{}}})
 if(fault==='quotaFenceRevision')await f.service.profiles.patchBinding(id,{quotaFenceRevision:1})
 if(fault==='remoteQuotaFences')await f.service.profiles.patchBinding(id,{remoteQuotaFences:[{}]})
 if(fault==='runtime-removed')f.service.hasRuntime=()=>false
 if(fault==='subagent-origin')row.header={...row.header,origin:'subagent'}
 const before=structuredClone(row.events)
 await assert.rejects(f.planning.open(command))
 assert.deepEqual(row.events,before);assert.equal((await f.planning.inspect('draft')).state,'uncertain');assert.deepEqual(f.counts(),{creates:1,nativeCalls:0})
})
test('complete_partial cannot create a fresh reservation',async t=>{
 const f=await fixture(t,'official-dsh')
 await assert.rejects(f.planning.open({...f.request,complete_partial:true}),{code:'PLANNING_PARTIAL_NOT_PROVEN'})
 assert.deepEqual(f.counts(),{creates:0,nativeCalls:0})
})

for(const privateCwd of [false,true])test(`cold Context completes the original partial using persisted registry, profiles and journal (private: ${privateCwd})`,async t=>{
 const first=await fixture(t,'official-dsh',true);if(privateCwd)delete first.request.workspace_id;await assert.rejects(first.planning.open(first.request))
 const id=(await first.planning.inspect('draft')).session_id,prefix=structuredClone(first.rows.get(id).events),saved=first.checkpoint()
 await first.shutdown()
 const cold=await fixture(t,'official-dsh',false,saved);if(privateCwd)delete cold.request.workspace_id
 assert.equal(cold.ctx.agents.get(id),undefined)
 const result=await cold.planning.open({...cold.request,complete_partial:true})
 assert.equal(result.session_id,id);assert.equal(result.state,'ready')
 assert.deepEqual(cold.rows.get(id).events.slice(0,4),prefix)
 assert.equal(cold.ctx.agents.get(id).isKodeNativeAgent,true)
 assert.deepEqual(cold.counts(),{creates:1,nativeCalls:0})
})
test('reload sentinel rejects exact reserved fresh planning instead of using official defaults',async t=>{
 const f=await fixture(t,'official-dsh')
 await f.factoryFiber.dispose()
 await assert.rejects(f.planning.open(f.request),/保护历史/)
 assert.deepEqual(f.counts(),{creates:0,nativeCalls:0})
 const ordinary=await f.ctx.agents.create({sessionId:'ordinary-after-unload',agentOptions:{provider:'official-dsh',model:'x'}})
 assert.notEqual(ordinary.agent.isKodeNativeAgent,true);await ordinary.dispose()
})
test('foreign admission never falls through to ordinary factory',async t=>{
 const f=await fixture(t,'official-dsh')
 f.overrideAdmission(()=>({binding:{session_id:'foreign',mode:'interactive_planning'}}))
 await assert.rejects(f.ctx.sessionController.create({sessionId:'session-22222222-2222-4222-8222-222222222222',agentPreset:'kode-native',cwd:f.root}),/Foreign planning admission/)
 assert.deepEqual(f.counts(),{creates:0,nativeCalls:0})
})
for(const fault of ['authority','journal'])test(`completion rechecks ${fault} after acquiring the writer`,async t=>{
 const f=await fixture(t,'official-dsh',true);await assert.rejects(f.planning.open(f.request))
 const id=(await f.planning.inspect('draft')).session_id
 f.faults.beforeWriter=()=>{if(fault==='authority')f.draft.revision++;else f.rows.get(id).events.push({seq:4,time:Date.now(),type:'user/message',data:{id:'race'}})}
 await assert.rejects(f.planning.open({...f.request,complete_partial:true}))
 assert.equal(f.rows.get(id).events.some(e=>e.type===NATIVE_PLANNING_RECORD),false)
 assert.deepEqual(f.counts(),{creates:1,nativeCalls:0})
})
test('interrupted completion cannot report ready or automatically reuse a partial repair marker',async t=>{
 const f=await fixture(t,'official-dsh',true);await assert.rejects(f.planning.open(f.request))
 const id=(await f.planning.inspect('draft')).session_id;f.faults.failMarkerFlush=true
 await assert.rejects(f.planning.open({...f.request,complete_partial:true}),/interrupted marker flush/)
 assert.equal((await f.planning.inspect('draft')).state,'uncertain');assert.equal(f.ctx.agents.get(id),undefined)
 assert.equal(f.rows.get(id).events.some(e=>e.type==='model/selection'),false)
 f.faults.failMarkerFlush=false
 await assert.rejects(f.planning.open(f.request),/selection is incomplete/)
 await assert.rejects(f.planning.open({...f.request,complete_partial:true}),/exact setup-only/)
 assert.deepEqual(f.counts(),{creates:1,nativeCalls:0})
})
for(const fast of [false,true])test(`partial Fast ${fast} is ${fast?'refused without proven transport':'persisted without changing selection'}`,async t=>{
 const f=await fixture(t,'official-dsh',true)
 f.service.profiles.defaultModelFor=()=>({fast})
 f.service.adapter.listModels=async()=>[{id:'chosen-model',fastCapability:{transport:'service-tier',tier:'fast'}}]
 await assert.rejects(f.planning.open(f.request))
 const id=(await f.planning.inspect('draft')).session_id
 if(fast)await assert.rejects(f.planning.open({...f.request,complete_partial:true}),/lineage/)
 else {const result=await f.planning.open({...f.request,complete_partial:true});assert.equal(result.state,'ready');assert.equal(f.rows.get(id).events.find(e=>e.type==='plugin:kode/model-fast').data.fast,false)}
 assert.deepEqual(f.counts(),{creates:1,nativeCalls:0})
})

test('work enqueued by an announce listener cannot start inference during completion',async t=>{
 const f=await fixture(t,'official-dsh',true);await assert.rejects(f.planning.open(f.request))
 const id=(await f.planning.inspect('draft')).session_id
 f.ctx.on('agent/created',({agent})=>{if(agent.id===id)agent.followup({id:'announce-race',role:'user',content:[{type:'text',text:'not authorized by completion'}]})})
 await assert.rejects(f.planning.open({...f.request,complete_partial:true}),/active or queued/)
 assert.equal((await f.planning.inspect('draft')).state,'uncertain')
 assert.deepEqual(f.counts(),{creates:1,nativeCalls:0})
})

for(const type of ['claude','codex'])test(`${type}: same-ID completion freezes context before the first real native SDK turn`,async t=>{
 const f=await fixture(t,'official-dsh',true,undefined,type)
 // A saved proposal is draft data, not elevated system instructions.
 f.draft.interview.proposed_team={name:'Saved configuration',purpose:'Keep existing settings',kind:'coordinator',workers:[],coordinator_prompt:'Owner-reviewed role',workspace_refs:[],execution_targets:[],coordinator_targets:[],workflow_pack_refs:[],grant_id:null,budget_policy_id:null,scheduling_policy_id:null,limits:{max_active_assignments:1,max_active_runs:1},proactive_mode:'off'}
 await assert.rejects(f.planning.open(f.request))
 const id=(await f.planning.inspect('draft')).session_id,prefix=structuredClone(f.rows.get(id).events)
 const result=await f.planning.open({...f.request,complete_partial:true})
 assert.equal(result.session_id,id);assert.deepEqual(f.counts(),{creates:1,nativeCalls:0})
 assert.deepEqual(f.rows.get(id).events.slice(0,4),prefix)
 const agent=f.ctx.agents.get(id),snapshot=persistedPlanningContext(agent.session.snapshotEvents(),nativePlanningBinding(agent)),errors=[]
 f.ctx.on('agent/error',({error})=>errors.push(error))
 const input={id:'first-owner-turn',role:'user',source:{kind:'user'},content:[{type:'text',text:'Improve this saved configuration.'}]}
 agent.followup(input);await agent.whenIdle()
 assert.equal(errors.length,0,errors.map(e=>e.stack).join('\n'))
 const rows=(await readFile(f.wire,'utf8')).trim().split('\n').map(JSON.parse)
 const user=type==='claude'?rows.find(r=>r.type==='user')?.message.content:rows.find(r=>r.method==='turn/start')?.params.input
 const system=type==='claude'?rows.find(r=>r.request?.subtype==='initialize')?.request.appendSystemPrompt:rows.find(r=>r.method==='thread/start')?.params.developerInstructions
 assert.deepEqual(user[0],planningContextInput(snapshot));assert.equal(user[1].text,input.content[0].text)
 assert.equal(system,BUILDER_PLANNING_PROMPT);assert.ok(!system.includes('Owner-reviewed role'))
 const proof=agent.session.snapshotEvents().find(e=>e.type===PLANNING_TURN_CONTEXT_RECORD)
 assert.equal(proof.data.sha256,snapshot.sha256);assert.equal(proof.data.draft_revision,1)
 const candidate=await readBuilderProposalCandidate(f.ctx,f.backend,'draft')
 assert.equal(candidate.source.context_sha256,snapshot.sha256);assert.equal(candidate.source.draft_revision,1)
 if(process.env.KODE_TEST_PLANNING_WIRE_DIR){await mkdir(process.env.KODE_TEST_PLANNING_WIRE_DIR,{recursive:true});await writeFile(join(process.env.KODE_TEST_PLANNING_WIRE_DIR,`${type}-completion-first-turn.json`),JSON.stringify({fixture:true,session_id:id,draft_revision:1,context_sha256:snapshot.sha256,system,user,turn_receipt:proof.data},null,2)+'\n')}
 f.draft.revision=2;agent.followup({...input,id:'pending-after-edit'});await agent.whenIdle()
 assert.equal(errors.at(-1).code,'PLANNING_CONTEXT_CHANGED');assert.equal(agent.inbox.nextTurn[0].id,'pending-after-edit')
 assert.deepEqual(f.counts(),{creates:1,nativeCalls:1})
 await assert.rejects(readBuilderProposalCandidate(f.ctx,f.backend,'draft'),{code:'PROPOSAL_DRAFT_CHANGED'})
})

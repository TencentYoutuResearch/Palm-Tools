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
import { AgentProfiles } from '../../src/agent-profiles.js'
import * as factoryPlugin from '../../src/native-agent-factory.js'
import { createBuilderPlanningSessions } from '../../src/builder-planning-session.js'
import { createNativePlanningBridge } from '../../src/native-planning-bridge.js'
import { nativePlanningBinding, NATIVE_PLANNING_RECORD } from '../../src/native-planning-session.js'
import { AgentRuntimeAdapter } from '../../src/agent-runtime.js'
import { persistedPlanningContext, planningContextInput, PLANNING_TURN_CONTEXT_RECORD } from '../../src/planning-draft-context.js'
import { readBuilderProposalCandidate } from '../../src/builder-proposal-candidate.js'
import { BUILDER_PLANNING_PROMPT } from '../../src/builder-planning-prompt.js'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
export async function planningHarness(t, provider, legacyPartial = false, saved, wireType, readResources) {
  const root = saved?.root ?? await mkdtemp(join(tmpdir(),'kode-planning-controller-')), ctx = new Context(), rows = saved?.rows ?? new Map(), writers = new Set(), fibers = [], faults = {}
  const disk = saved?.disk ?? {state:null,revision:0,creates:0,nativeCalls:0,workspaceIds:[]}
  let planning, admit = true, closed = false, admissionOverride
  const shutdown=async()=>{if(closed)return;closed=true;for(const f of [...fibers].reverse())await f.dispose();await service.adapter.close?.();await profiles.close?.()}
  const wire=join(root,'wire.jsonl')
  const profiles=await new AgentProfiles(join(root,'profiles.json')).open([{id:'selected',name:'Selected',type:wireType??'custom',executable:process.execPath,...(wireType?{args:[fileURLToPath(new URL(wireType==='claude'?'../fixture-claude-stream-json.js':'../fixture-codex-server.js',import.meta.url))],env:{KODE_CLAUDE_FIXTURE_LOG:wire,KODE_FIXTURE_RPC_LOG:wire,CLAUDE_CONFIG_DIR:root}}:{})}])
  for(const plugin of [SessionStore,AgentRegistry,ProjectionRegistry]) fibers.push(await ctx.plugin(plugin))
  const handle=(row,write)=>({header:row.header,inheritedEventCount:0,read:async()=>({events:[...row.events]}),append:async events=>row.events.push(...events),flush:async()=>{if(faults.failMarkerFlush&&row.events.some(e=>e.type===NATIVE_PLANNING_RECORD))throw Error('fixture interrupted marker flush')},close:async()=>{if(write)writers.delete(row.header.id)}})
  ctx.provide('sessionPersistence',{create:async header=>{disk.creates++;assert.ok(!rows.has(header.id));const row={header,events:[]};rows.set(header.id,row);writers.add(header.id);return handle(row,true)},open:async(id,access)=>{if(!rows.has(id))throw Error('not found');if(access==='write'){await faults.beforeWriter?.(id);if(writers.has(id))throw Error('already owned');writers.add(id)}return handle(rows.get(id),access==='write')}})
  ctx.on('session/event',(session,event)=>{if(writers.has(session.id))rows.get(session.id).events.push(event)});ctx.on('session/flush',async()=>{})
  const workspace={id:'workspace',path:root,sessionIds:disk.workspaceIds,attachSession:async id=>{if(!workspace.sessionIds.includes(id))workspace.sessionIds.push(id)}}
  const service={profiles,hasRuntime:()=>true,recordBinding(agent,profile){agent.session.append('plugin:kode/agent-binding',{profileId:profile.id,name:profile.name,type:profile.type,uiChannel:'native'})},adapter:{listModels:async()=>[{id:'chosen-model'}],closeSession:async()=>{},hasContinuation:()=>false,async *stream(){disk.nativeCalls++;throw Error('No model must run')}}}
  if(wireType){const adapter=new AgentRuntimeAdapter(ctx,profiles,{recordNative(){},resolveProfile:async p=>p});const stream=adapter.stream.bind(adapter);adapter.stream=async function*(options){disk.nativeCalls++;yield* stream(options)};adapter.listModels=async()=>[{id:wireType==='claude'?'fixture-claude':'fixture'}];service.adapter=adapter}
  const services={tools:{schemas:()=>[],resolve:async()=>({tools:[],schemas:[],dispose(){}})},systemPrompt:{variable:()=>()=>{}},llm:{},sessionTitle:{rename:()=>({eventSeq:0})},kodeAgents:service,
    agentDefaultModel:{currentSelection:()=>({provider,model:'global-default'})},attachments:{imageLimits:{maxImageBytes:1024,maxImagesPerMessage:1,maxMessageImageBytes:1024,maxImagePixels:1024,maxImageDimension:32,mediaTypes:[]}},fileUploads:{registerAgentResolver:()=>()=>{}},fs:{},remoteAccess:{allows:()=>true},
    typert:{resources:{register(){}},lookups:{configure(){}},contexts:{configureHost(){}}},workspaceRegistry:{get:id=>id==='workspace'?workspace:undefined,list:()=>[workspace],archivedSessionIds:[]},
    sessionQuery:{listSessions:async()=>[...rows.values()].map(row=>({header:row.header})),observeSession:async id=>{const row=rows.get(id);if(!row)throw new SessionQueryError('not found','SESSION_QUERY_SESSION_NOT_FOUND');return{...row,inheritedEventCount:0,projections:ctx.sessionProjections.restore({},row.events,0,row.header,0).snapshot,[Symbol.dispose](){}}}},
    agentPresets:{register:async()=>()=>{},resolve:async id=>({id}),mount:async(scope)=>{const session=scope.get('agent')?.session; if(session) for(const type of ['permission/preset','sandbox/mode','approval/policy'])session.append(type,{fixture:true})}},
    kodePlanningRuntime:{sessionAdmission:(...args)=>admissionOverride?admissionOverride(...args):admit?planning?.sessionAdmission(...args):undefined,completionAdmission:(...args)=>planning.completionAdmission(...args),readContext:(...args)=>planning.readContext(...args),inspect:(...args)=>planning.inspect(...args),handoffStatus:(...args)=>planning.handoffStatus(...args),prepareHandoff:(...args)=>planning.prepareHandoff(...args),handoff:(...args)=>planning.handoff(...args)},}
  for(const[name,value]of Object.entries(services))ctx.provide(name,value)
  fibers.push(await ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:10}));const factoryFiber=await ctx.plugin(factoryPlugin);fibers.push(factoryFiber);fibers.push(await ctx.plugin(SessionController,{nativeOpen:false}))
  for(const fiber of fibers)await fiber.await?.()
  const draft={id:'draft',home_hub:'home',status:'draft',revision:1,interview:{purpose:'Plan',workspace_refs:[{host_id:'home',workspace_id:'workspace',root_ref:root}]}}
  const backend={call:async(path,body)=>{if(path.endsWith('/selection'))return{draft_id:'draft',home_hub:'home',runtime_binding:null,record:null};if(path.endsWith('/drafts/draft'))return structuredClone(draft);assert.ok(path.endsWith('/documents/session-index'));if(body){if(body.expected_revision!==disk.revision)throw Error('configuration changed');disk.state=structuredClone(body.value);disk.revision++}return{value:structuredClone(disk.state),revision:disk.revision}}}
  const rawBridge=createNativePlanningBridge({ctx,service});
  const bridge={...rawBridge,async create(input){await faults.beforeCreate?.(input);const result=await rawBridge.create(input);await faults.afterCreate?.(input);if(faults.loseCreateResponse)throw Error('fixture lost successor response');return result}};
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
    planning=createBuilderPlanningSessions({ctx,backendClient:backend,home:'home',service,bridge:legacy,readResources})
  }else planning=createBuilderPlanningSessions({ctx,backendClient:backend,home:'home',service,bridge,readResources})
  const request={draft_id:'draft',draft_revision:1,request_id:'original',profile_id:'selected',model:wireType?(wireType==='claude'?'fixture-claude':'fixture'):'chosen-model',workspace_id:'workspace'}
  t.after(async()=>{await shutdown();if(!saved)await rm(root,{recursive:true,force:true})})
  return{newPlanning:(options={})=>createBuilderPlanningSessions({ctx,backendClient:backend,home:'home',service,bridge,readResources,...options}),ctx,rows,planning,bridge,service,request,root,wire,backend,factoryFiber,fibers,shutdown,faults,draft,disk,checkpoint:()=>({root,rows,disk}),overrideAdmission:fn=>{admissionOverride=fn},counts:()=>({creates:disk.creates,nativeCalls:disk.nativeCalls}),state:()=>disk.state}
}

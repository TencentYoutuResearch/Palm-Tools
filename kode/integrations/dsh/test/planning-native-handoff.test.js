import test from 'node:test'
import assert from 'node:assert/strict'
import { planningHarness } from './support/planning-native-harness.js'
import { profileRevision } from '../src/agent-profiles.js'
import { nativePlanningBinding } from '../src/native-planning-session.js'
import { persistedPlanningContext } from '../src/planning-draft-context.js'
import { readBuilderProposalCandidate } from '../src/builder-proposal-candidate.js'
import { registerAgentHubApi } from '../src/agent-hub-api.js'
import { assertOrdinaryHandoffSource,assertOrdinaryHandoffIdentity } from '../src/native-handoff-contract.js'
import { Readable } from 'node:stream'
async function setup(t,privateCwd=false,readResources){
 const f=await planningHarness(t,'official-dsh',false,undefined,undefined,readResources);if(privateCwd)delete f.request.workspace_id
 const opened=await f.planning.open(f.request);f.source=opened.session_id
 await f.service.profiles.save({id:'target',name:'Existing CLI',type:'claude',executable:f.root+'/tclaude-fixture',args:[],env:{FIXTURE_ONLY:'not-a-credential'},allowedModels:['target-model'],managedInference:{bootstrap:{executable:f.root+'/claude-fixture',pathVariable:'TCLAUDE_CLAUDE_PATH',provider:'fixture',home:f.root},reasoningEfforts:['medium'],roles:['worker','builder','coordinator']}})
 f.service.adapter.listModels=async()=>[{id:'target-model',reasoningEfforts:[{id:'medium'}],fastCapability:{transport:'service-tier',defaultEnabled:false,tier:'priority'}},{id:'forbidden'}]
 f.prepare=()=>f.planning.prepareHandoff({action:'prepare-handoff',sessionId:f.source,profileId:'target',selection:{model:'target-model',reasoningEffort:'medium',fast:false}})
 const prepared=await f.prepare();f.command={...prepared.prepared,requestId:'handoff-original'};return f
}
for(const privateCwd of [false,true])test(`native planning handoff preserves source and policies, activates one epoch, sends nothing (private ${privateCwd})`,async t=>{
 const f=await setup(t,privateCwd),old=f.ctx.agents.get(f.source),prefix=structuredClone(old.session.snapshotEvents()),oldBinding=nativePlanningBinding(old),oldContext=persistedPlanningContext(prefix,oldBinding)
 const [a,b]=await Promise.all([f.planning.handoff(f.command),f.planning.handoff(f.command)])
 assert.equal(a.session_id,b.session_id);assert.notEqual(a.session_id,f.source);assert.equal(a.context_epoch,2);assert.equal(a.automatic_input,false)
 assert.deepEqual(old.session.snapshotEvents(),prefix);assert.deepEqual(f.counts(),{creates:2,nativeCalls:0})
 const target=f.ctx.agents.get(a.session_id),bound=f.service.profiles.binding(a.session_id)
 assert.equal(bound.revision,f.command.planning.target_profile_revision);assert.deepEqual(bound.profile.allowedModels,['target-model']);assert.deepEqual(bound.profile.managedInference,f.service.profiles.get('target').managedInference)
 assert.equal(profileRevision(bound.profile),profileRevision(f.service.profiles.get('target')))
 assert.equal(target.options.model,'target-model');assert.equal(target.options.reasoningEffort,'medium')
 const context=persistedPlanningContext(target.session.snapshotEvents(),nativePlanningBinding(target))
 assert.equal(context.draft_revision,oldContext.draft_revision);assert.notEqual(context.sha256,oldContext.sha256)
 assert.deepEqual(context.data,oldContext.data)
 if(privateCwd)assert.notEqual(target.session.header.cwd,old.session.header.cwd)
 assert.equal((await f.planning.handoff(f.command)).session_id,a.session_id);assert.deepEqual(f.counts(),{creates:2,nativeCalls:0})
 assert.equal((await f.planning.handoffStatus(f.source)).state,'superseded');assert.equal((await f.planning.inspect('draft')).session_id,a.session_id)
 assert.equal((await f.planning.sessionAdmission(f.source,{mode:'restore'})).binding.session_id,f.source)
 await assert.rejects(f.planning.readContext(f.source),{code:'PLANNING_SESSION_SUPERSEDED'})
 const candidate=await readBuilderProposalCandidate(f.ctx,f.backend,'draft');assert.equal(candidate.state,'no_completed_reply')
 old.followup({id:'stale-input',role:'user',content:[{type:'text',text:'must stay queued'}]});await old.whenIdle()
 assert.equal(old.inbox.nextTurn[0].id,'stale-input');assert.deepEqual(f.counts(),{creates:2,nativeCalls:0})
})
test('lost successor response remains same pending reservation and readonly proof completes it',async t=>{
 const f=await setup(t);f.faults.loseCreateResponse=true
 await assert.rejects(f.planning.handoff(f.command),{code:'PLANNING_HANDOFF_UNCERTAIN',status:409})
 const status=await f.planning.handoffStatus(f.source),id=status.pending.reserved_session_id
 assert.equal(status.state,'handoff_pending');assert.deepEqual(status.pending.retry_command,f.command)
 assert.equal((await f.planning.inspect('draft')).session_id,f.source)
 await assert.rejects(f.planning.readContext(f.source),{code:'PLANNING_HANDOFF_PENDING'})
 f.faults.loseCreateResponse=false
 const result=await f.planning.handoff(f.command);assert.equal(result.session_id,id);assert.deepEqual(f.counts(),{creates:2,nativeCalls:0})
})
for(const fault of ['source_epoch','source_context_sha256','draft_revision','profile','selection','pending-input'])test(`handoff rejects ${fault} without replacing source`,async t=>{
 const f=await setup(t),command=structuredClone(f.command)
 if(fault==='source_epoch')command.planning.source_epoch++
 if(fault==='source_context_sha256')command.planning.source_context_sha256='0'.repeat(64)
 if(fault==='draft_revision')f.draft.revision++
 if(fault==='profile')await f.service.profiles.save({...f.service.profiles.get('target'),name:'Changed'})
 if(fault==='selection')command.selection.model='forbidden'
 if(fault==='pending-input')f.ctx.agents.get(f.source).inject({id:'waiting',role:'user',content:[{type:'text',text:'waiting'}]})
 await assert.rejects(f.planning.handoff(command));assert.equal((await f.planning.inspect('draft')).session_id,f.source);assert.deepEqual(f.counts(),{creates:1,nativeCalls:0})
})
test('draft changes after successor creation never silently activates or retries another Session',async t=>{
 const f=await setup(t);f.faults.afterCreate=()=>{f.draft.revision++}
 await assert.rejects(f.planning.handoff(f.command),/changed/)
 assert.equal((await f.planning.inspect('draft')).session_id,f.source)
 await assert.rejects(f.planning.handoff(f.command));assert.deepEqual(f.counts(),{creates:2,nativeCalls:0})
})
test('ordinary handoff rejects both live and cold planning identities',async t=>{
 const f=await setup(t),agent=f.ctx.agents.get(f.source)
 assert.throws(()=>assertOrdinaryHandoffSource(f.service.profiles,f.source,agent,{}),{code:'PLANNING_HANDOFF_REQUIRED'})
 await assert.rejects(assertOrdinaryHandoffIdentity({service:name=>name==='kodePlanningRuntime'?f.planning:f.ctx.get(name)},f.source),{code:'PLANNING_HANDOFF_REQUIRED'})
 // Even a missing registry must not adopt its durable planning marker.
 await assert.rejects(assertOrdinaryHandoffIdentity({service:name=>name==='kodePlanningRuntime'?undefined:f.ctx.get(name)},f.source),{code:'PLANNING_HANDOFF_REQUIRED'})
})
test('same native owner action exposes trusted metadata and planning receipt without ordinary mailbox input',async t=>{
 const f=await setup(t);let handler,calls=0
 const ctx={get:n=>f.ctx.get(n),connection:{admit:r=>({peer:{principal:{kind:r.owner?'owner':'guest'}}})},webServer:{register:r=>{handler=r.handler}}}
 registerAgentHubApi(ctx,{hub:{},service:f.service,backend:{call(){calls++;throw Error('ordinary automatic input must not be used')}}})
 const request=async(body,owner=true)=>{const req=Readable.from(body?[JSON.stringify(body)]:[]);req.owner=owner;req.method=body?'POST':'GET';req.url='/api/kode/agent-hub?session_id='+f.source;req.headers={'content-type':'application/json'};const res={setHeader(){},end(v){this.body=JSON.parse(v)}};await handler(req,res);return res}
 assert.equal((await request(f.command,false)).statusCode,403)
 const info=await request();assert.equal(info.body.planning_handoff.session_id,f.source)
 const p=await request({action:'prepare-handoff',sessionId:f.source,profileId:'target',selection:f.command.selection});assert.equal(p.body.kind,'planning')
 const legacy={...f.command};delete legacy.planning
 assert.equal((await request(legacy)).body.code,'PLANNING_HANDOFF_REQUIRED')
 const result=await request(f.command);assert.equal(result.statusCode,200);assert.equal(result.body.context_epoch,2);assert.equal(calls,0);assert.deepEqual(f.counts(),{creates:2,nativeCalls:0})
})

test('independent registry writers CAS one successor without relying on shared jobs',async t=>{
 const f=await setup(t),other=f.newPlanning(),second={...f.command,requestId:'competing-request'}
 const outcomes=await Promise.allSettled([f.planning.handoff(f.command),other.handoff(second)])
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1)
 assert.equal(Object.keys(f.state().builderPlanning.handoffs).length,1)
 assert.equal(Object.keys(f.state().builderPlanning.history).length,1)
 assert.deepEqual(f.counts(),{creates:2,nativeCalls:0})
})
for(const privateCwd of [false,true])test(`cold Context restores archived and active identities without replay (private ${privateCwd})`,async t=>{
 const f=await setup(t,privateCwd),result=await f.planning.handoff(f.command),saved=f.checkpoint()
 await f.shutdown()
 const cold=await planningHarness(t,'official-dsh',false,saved)
 assert.equal(cold.ctx.agents.get(f.source),undefined)
 const oldResult=await cold.ctx.sessionController.resolveAgent(f.source),targetResult=await cold.ctx.sessionController.resolveAgent(result.session_id)
 assert.equal(oldResult.error,undefined);assert.equal(targetResult.error,undefined)
 const old=oldResult.agent,target=targetResult.agent
 assert.equal(nativePlanningBinding(old).context_epoch,1);assert.equal(nativePlanningBinding(target).context_epoch,2)
 assert.equal((await cold.planning.handoff(f.command)).session_id,result.session_id)
 old.followup({id:'cold-old-input',role:'user',content:[{type:'text',text:'must not dispatch'}]});await old.whenIdle()
 assert.equal(old.inbox.nextTurn[0].id,'cold-old-input');assert.equal(target.inbox.nextTurn.length,0)
 await assert.rejects(cold.planning.readContext(f.source),{code:'PLANNING_SESSION_SUPERSEDED'})
 assert.equal((await cold.planning.readContext(result.session_id)).context_epoch,2)
 assert.deepEqual(cold.counts(),{creates:2,nativeCalls:0})
})
for(const pending of [false,true])test(`readContext rejects handoff during asynchronous draft read (pending ${pending})`,async t=>{
 const f=await setup(t),call=f.backend.call
 let intercepted=false
 f.backend.call=async(...args)=>{
  const value=await call(...args)
  if(!intercepted&&args[0].endsWith('/drafts/draft')){intercepted=true;f.faults.loseCreateResponse=pending;try{await f.planning.handoff(f.command)}catch(e){if(!pending)throw e}}
  return value
 }
 await assert.rejects(f.planning.readContext(f.source),{code:pending?'PLANNING_HANDOFF_PENDING':'PLANNING_SESSION_SUPERSEDED'})
 assert.deepEqual(f.counts(),{creates:2,nativeCalls:0})
})
for(const pending of [false,true])test(`candidate does not return the archived generation after concurrent handoff (pending ${pending})`,async t=>{
 const f=await setup(t),call=f.backend.call
 let reads=0,intercepted=false
 f.backend.call=async(...args)=>{
  const value=await call(...args)
  // Draft reads for initial candidate, inspect, and two restore admissions
  // precede the final draft verification. Race exactly after the journal read.
  if(args[0].endsWith('/drafts/draft')&&++reads===5&&!intercepted){intercepted=true;f.faults.loseCreateResponse=pending;try{await f.planning.handoff(f.command)}catch(e){if(!pending)throw e}}
  return value
 }
 await assert.rejects(readBuilderProposalCandidate(f.ctx,f.backend,'draft'),{code:pending?'PLANNING_HANDOFF_PENDING':'PLANNING_SESSION_SUPERSEDED'})
 assert.equal(intercepted,true);assert.deepEqual(f.counts(),{creates:2,nativeCalls:0})
})


test('ready receipt cannot claim current after a second writer advances its epoch during verification',async t=>{
 const f=await setup(t),first=await f.planning.handoff(f.command)
 const next=await f.planning.prepareHandoff({action:'prepare-handoff',sessionId:first.session_id,profileId:'target',selection:f.command.selection})
 const command={...next.prepared,requestId:'next-generation'},call=f.backend.call,other=f.newPlanning()
 let intercepted=false
 f.backend.call=async(...args)=>{const value=await call(...args);if(!intercepted&&args[0].endsWith('/drafts/draft')){intercepted=true;await other.handoff(command)}return value}
 await assert.rejects(f.planning.handoff(f.command),{code:'PLANNING_SESSION_SUPERSEDED'})
 assert.equal((await f.planning.inspect('draft')).context_epoch,3);assert.deepEqual(f.counts(),{creates:3,nativeCalls:0})
})
test('failure before physical creation retains one reservation and never creates on retry',async t=>{
 const f=await setup(t);f.faults.beforeCreate=()=>{throw Error('fixture unavailable before creation')}
 await assert.rejects(f.planning.handoff(f.command),{code:'PLANNING_HANDOFF_UNCERTAIN',status:409})
 const status=await f.planning.handoffStatus(f.source),reserved=status.pending.reserved_session_id
 assert.equal(f.rows.has(reserved),false);f.faults.beforeCreate=undefined
 await assert.rejects(f.planning.handoff(f.command),{code:'PLANNING_HANDOFF_UNCERTAIN',status:409})
 assert.equal((await f.planning.handoffStatus(f.source)).pending.reserved_session_id,reserved)
 assert.deepEqual(f.counts(),{creates:1,nativeCalls:0})
})

for (const privateCwd of [false,true]) test(`explicit latest-draft successor preserves old evidence and access (private ${privateCwd})`, async t => {
 const f=await planningHarness(t,'official-dsh');if(privateCwd)delete f.request.workspace_id
 const original=await f.planning.open(f.request),old=f.ctx.agents.get(original.session_id),prefix=structuredClone(old.session.snapshotEvents())
 const oldContext=persistedPlanningContext(prefix,nativePlanningBinding(old))
 f.draft.revision++;f.draft.interview.purpose='Owner revised goal'
 if(privateCwd)f.draft.interview.workspace_refs=[{host_id:'home',workspace_id:'workspace',root_ref:f.root}]
 const input={action:'prepare-handoff',sessionId:original.session_id,profileId:'selected',selection:{model:'chosen-model'}}
 await assert.rejects(f.planning.prepareHandoff(input),{code:'PLANNING_HANDOFF_SOURCE_CHANGED'})
 const prepared=await f.planning.prepareHandoff({...input,refreshContext:true}),command={...prepared.prepared,requestId:'refresh-context'}
 assert.equal(command.planning.refresh_context.source_draft_revision,1)
 assert.equal(command.planning.source_context_sha256,oldContext.sha256)
 const status=await f.planning.handoffStatus(original.session_id)
 assert.equal(command.planning.refresh_context.target_context_sha256,status.latest_context_sha256)
 const result=await f.planning.handoff(command),target=f.ctx.agents.get(result.session_id),context=persistedPlanningContext(target.session.snapshotEvents(),nativePlanningBinding(target))
 assert.equal(context.draft_revision,2);assert.equal(context.data.purpose,'Owner revised goal')
 assert.deepEqual(old.session.snapshotEvents(),prefix);assert.deepEqual(result.initial_selection,original.initial_selection)
 assert.deepEqual(f.counts(),{creates:2,nativeCalls:0})
 if(privateCwd){assert.equal(nativePlanningBinding(target).location.kind,'private_planning');assert.equal(nativePlanningBinding(target).workspace_id,null)}
 else assert.equal(target.session.header.cwd,old.session.header.cwd)
 assert.equal((await readBuilderProposalCandidate(f.ctx,f.backend,'draft')).state,'no_completed_reply')
 assert.equal((await f.planning.handoff(command)).session_id,result.session_id)
})
for (const fault of ['source-hash','source-version','target-hash','target-content','revision','pending-input']) test(`latest-draft confirmation rejects ${fault} without touching original`, async t => {
 const f=await setup(t,true),old=f.ctx.agents.get(f.source),prefix=structuredClone(old.session.snapshotEvents())
 f.draft.revision++
 const p=await f.planning.prepareHandoff({action:'prepare-handoff',sessionId:f.source,profileId:'target',selection:f.command.selection,refreshContext:true})
 const command={...p.prepared,requestId:'refresh-context'}
 if(fault==='source-hash')command.planning.source_context_sha256='0'.repeat(64)
 if(fault==='source-version')command.planning.refresh_context.source_draft_revision++
 if(fault==='target-hash')command.planning.refresh_context.target_context_sha256='0'.repeat(64)
 if(fault==='target-content')f.draft.interview.purpose='changed without revision'
 if(fault==='revision')f.draft.revision++
 if(fault==='pending-input')old.inject({id:'keep-pending',role:'user',content:[{type:'text',text:'pending'}]})
 await assert.rejects(f.planning.handoff(command));assert.deepEqual(f.counts(),{creates:1,nativeCalls:0})
 if(fault!=='pending-input')assert.deepEqual(old.session.snapshotEvents(),prefix)
})

import { createBuilderPlanningResources } from '../src/builder-planning-resources.js'
import { BUILDER_PLANNING_PROMPT_V2_VERSION } from '../src/builder-planning-prompt-v2.js'
import { nativePlanningPromptVersion } from '../src/native-planning-session.js'
test('v2 successor freezes once, preserves source bytes, recovers exact journal and cold-restores without reader', async t => {
  let reads=0
  const resources=await createBuilderPlanningResources({home:'home'})()
  const f=await setup(t,false,async()=>{reads++;return resources})
  const source=f.ctx.agents.get(f.source),prefix=structuredClone(source.session.snapshotEvents())
  assert.equal(nativePlanningPromptVersion(source),BUILDER_PLANNING_PROMPT_V2_VERSION)
  f.faults.loseCreateResponse=true
  await assert.rejects(f.planning.handoff(f.command),{code:'PLANNING_HANDOFF_UNCERTAIN'})
  assert.equal(reads,2)
  const pending=(await f.planning.handoffStatus(f.source)).pending.reserved_session_id
  f.faults.loseCreateResponse=false
  const result=await f.planning.handoff(f.command)
  assert.equal(result.session_id,pending);assert.equal(reads,2)
  assert.deepEqual(source.session.snapshotEvents(),prefix)
  const target=f.ctx.agents.get(result.session_id)
  assert.equal(nativePlanningPromptVersion(target),BUILDER_PLANNING_PROMPT_V2_VERSION)
  assert.deepEqual(persistedPlanningContext(target.session.snapshotEvents(),nativePlanningBinding(target)).data.resources_snapshot,resources)
  const saved=f.checkpoint();await f.shutdown()
  const cold=await planningHarness(t,'official-dsh',false,saved)
  const restored=await cold.ctx.sessionController.resolveAgent(result.session_id)
  assert.equal(restored.error,undefined);assert.equal(nativePlanningPromptVersion(restored.agent),BUILDER_PLANNING_PROMPT_V2_VERSION)
  assert.equal((await cold.planning.handoff(f.command)).session_id,result.session_id)
  cold.service.adapter.listModels=f.service.adapter.listModels
  const prepared=await cold.planning.prepareHandoff({action:'prepare-handoff',sessionId:result.session_id,profileId:'target',selection:f.command.selection})
  await assert.rejects(cold.planning.handoff({...prepared.prepared,requestId:'no-reader'}),{code:'PLANNING_CONTEXT_INVALID'})
  assert.equal(cold.counts().creates,2)
})
test('explicit v1 successor upgrades only new journal when resources become available',async t=>{
  const f=await setup(t),source=f.ctx.agents.get(f.source),prefix=structuredClone(source.session.snapshotEvents())
  const resources=await createBuilderPlanningResources({home:'home'})()
  const upgraded=f.newPlanning({readResources:async()=>resources})
  const result=await upgraded.handoff(f.command)
  assert.deepEqual(source.session.snapshotEvents(),prefix)
  assert.equal(nativePlanningPromptVersion(source),undefined)
  assert.equal(nativePlanningPromptVersion(f.ctx.agents.get(result.session_id)),BUILDER_PLANNING_PROMPT_V2_VERSION)
})

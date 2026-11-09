/** Actual official runtime and Host inbox with a controlled adapter; no paid inference. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import { createRequire } from 'node:module'
const loopRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { default: Tools } = await import(loopRequire.resolve('@deepseek-ai/dsh-tools'))
const { default: SystemPrompt } = await import(loopRequire.resolve('@deepseek-ai/dsh-system-prompt'))
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { isolatedHub } from './support/isolated-hub.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { OfficialExecution } from '../src/official-execution.js'
import { OfficialLoopHost } from '../src/official-loop-host.js'
import { OfficialToolPolicies } from '../src/official-grant-guard.js'
import { apply as applyHost } from '../src/host.js'
import * as persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { deliveryInputId } from '../src/delivery-tracker.js'

import { COORDINATOR_PROMPT_VERSION } from '../src/coordinator-context.js'

test('Coordinator official loop consumes home conversation inputs exactly once with durable evidence', {skip:!process.env.KODE_TEST_BACKEND_URL,timeout:30000},async()=>{
 const hub=await isolatedHub('official-coordinator'),ctx=new Context()
 let execution,host
 try{
  await ctx.plugin(SessionStore);await ctx.plugin(AgentRegistry);await ctx.plugin(Projections)
  await ctx.plugin(SystemPrompt,{includeHarnessIdentity:false,includeRuntimeContext:false})
  await ctx.plugin(Tools);await ctx.plugin(LlmRuntime)
  const root=await realpath(hub.root),call=(p,b)=>hub.client.call(`/api/v1/messaging/${p}`,b),at=Date.now()
  await ctx.plugin(persistence,{root:join(root,'sessions'),compression:'zstd'})
  const profiles=await new AgentProfiles(join(root,'profiles.json')).open([{id:'profile',name:'Coordinator',type:'dsh'}])
  await profiles.bind('probe','profile');const profileHash=profiles.binding('probe').revision
  ctx.provide('workspaceRegistry',{list:()=>[{id:'workspace',path:root}]})
  ctx.provide('kodeOfficialToolPolicies',new OfficialToolPolicies())
  let calls=0,currentReply,currentStart,currentRunId;const errors=[]
  ctx.on('agent/error',e=>errors.push(e.error.message))
  class Fixture extends LlmAdapter{
   async *stream(options){
    assert.match(JSON.stringify(options.messages.filter(m=>m.role==='system')),new RegExp(COORDINATOR_PROMPT_VERSION))
    assert.match(JSON.stringify(options.messages),/Implement the requirement/)
    assert.deepEqual(options.tools.map(t=>t.name).sort(),['kode_coordinator_publish_reply','kode_coordinator_workflow_start','kode_coordinator_configuration','kode_coordinator_workflow_status'].sort())
    assert.match(JSON.stringify(options.messages),new RegExp(currentReply.source_message_id))
    calls++
    if(calls>=7)assert.match(JSON.stringify(options.messages),/Also preserve existing behavior/)
    if(calls%6===1||calls%6===2){
     yield {type:'block-start',index:0,blockType:'tool-call'}
     yield {type:'block-end',index:0,block:{type:'tool-call',id:`config-${calls}`,name:'kode_coordinator_configuration',arguments:JSON.stringify({binding_id:calls%6===1?'':'local'})}}
    }else if(calls%6===3){
     assert.match(JSON.stringify(options.messages),/completion_stages/)
     assert.match(JSON.stringify(options.messages),/团队预算/)
     assert.match(JSON.stringify(options.messages),/provider_monetary/)
     assert.match(JSON.stringify(options.messages),/not_connected/)

     yield {type:'block-start',index:0,blockType:'tool-call'}
     yield {type:'block-end',index:0,block:{type:'tool-call',id:`start-${calls}`,name:'kode_coordinator_workflow_start',arguments:JSON.stringify(currentStart)}}
    }else if(calls%6===4){
     yield {type:'block-start',index:0,blockType:'tool-call'}
     yield {type:'block-end',index:0,block:{type:'tool-call',id:`status-${calls}`,name:'kode_coordinator_workflow_status',arguments:JSON.stringify({run_id:currentRunId})}}
    }else if(calls%6===5){
     assert.match(JSON.stringify(options.messages),/waiting_resource/)
     const statusMessage=options.messages.find(m=>m.role==='tool'&&m.source?.callId===`status-${calls-1}`)
     const status=JSON.parse(statusMessage.content.filter(b=>b.type==='text').map(b=>b.text).join(''))
     assert.deepEqual(status.inputs,currentStart.inputs)
     assert.equal(status.prior_run_id,currentStart.prior_run_id??null)
     assert.equal(status.human_acceptance,null)
     assert.equal(status.completion_authorized,false)

     yield {type:'block-start',index:0,blockType:'tool-call'}
     yield {type:'block-end',index:0,block:{type:'tool-call',id:`publish-${calls}`,name:'kode_coordinator_publish_reply',arguments:JSON.stringify(currentReply)}}
    }else{
     assert.match(JSON.stringify(options.messages),/published/)
     yield {type:'block-start',index:0,blockType:'text'}
     yield {type:'block-end',index:0,block:{type:'text',text:'Reply published; execution is pending.'}}
    }
    yield {type:'usage',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}
    yield {type:'finish',reason:{kind:calls%6!==0?'tool-calls':'stop'}}
   }
  }
  ctx.llm.registerAdapter(['fixture'],new Fixture())
  let lostPublication=false,publicationWrites=0,lostWorkflow=false,workflowWrites=0
  const transport={call:async(path,body,...rest)=>{
   const result=await hub.client.call(path,body,...rest)
   if(body&&path.endsWith('/coordinator-replies')){publicationWrites++;if(!lostPublication){lostPublication=true;throw Error('fixture publication reply lost')}}
   if(body&&path.endsWith('/work-runs')){currentRunId=result.id;workflowWrites++;if(!lostWorkflow||(process.env.KODE_TEST_COORDINATOR_FOLLOWUP==='1'&&workflowWrites===2)){lostWorkflow=true;throw Error('fixture workflow reply lost')}}
   return result
  }}
  execution=new OfficialExecution(ctx,profiles,transport,{host:hub.node});host=new OfficialLoopHost(ctx,execution)
  ctx.provide('kodeAgents',{profiles,officialExecution:execution,officialLoops:host})
  await applyHost(ctx,{url:hub.url,tokenFile:join(hub.root,'admin.token'),stateFile:join(hub.root,'host-state.json'),agentRuntime:false,runtimeBridge:false,pollMs:10})
  const workspace={host_id:hub.node,workspace_id:'workspace',root_ref:root},target={host:hub.node,workspace:'workspace',root}
  const version=r=>({id:r.id,version:r.version,hash:r.hash}),policy=r=>({id:r.id,revision:r.revision,hash:r.hash})
  const flow=await call('workflows',{id:'flow',version:'1',inputs:['request'],stages:[{id:'inspect',role:'coordinator',requires:['request'],produces:['artifact'],independent_from:[],execution:{task_tag:'inspection',repository_binding:'code',capabilities:['read'],tools:['kode_artifact_capture','kode_coordinator_publish_reply'],network:false}}],completion_stages:['inspect'],evidence_rules:{artifact:{kind:'artifact',repository_binding:'code'}}})
  const project=await call('project-configs',{id:'project',version:'1',spec:{kind:'project_bindings',repositories:{code:{repository_id:'repo',workspace}},environments:{},commands:{},connections:{}}})
  const delivery=await call('project-configs',{id:'delivery',version:'1',spec:{kind:'delivery_policy',project:version(project),workflow:version(flow),targets:[{kind:'local',repository_binding:'code'}],required_outputs:['artifact']}})
  await call('resource-accounts',{id:'account',expected_epoch:0,enabled:true})
  await call('assignment-capacities',{account_id:'account',expected_revision:0,max_active_assignments:2})
  await call('resource-bindings',{host:hub.node,profile:'profile',account_id:'account',account_epoch:1,expected_revision:0})
  await call('capability-profiles',{id:'capability',expected_revision:0,host:hub.node,profile:'profile',model:'model',assessments:{}})
  await call('budgets',{id:'budget',scope:'team',scope_id:'team',unit:'credits',limit:100,starts_at:at-1000,ends_at:at+60000,expected_revision:0})
  const budget=await call('team-policies',{id:'budget-policy',team_id:'team',expected_revision:0,policy:{kind:'budget',budget_ids:['budget'],unit:'credits',max_assignment_charge:40}})
  const resource={host:hub.node,profile:'profile',account_id:'account',account_epoch:1,binding_revision:1,limit_ids:['daily'],unknown_quota:'team_budget'}
  const schedule=await call('team-policies',{id:'schedule',team_id:'team',expected_revision:0,policy:{kind:'scheduling',targets:{control:{resource,capability_id:'capability',capability_revision:1,preferred:false}},weights:{quality:1,cost:0,latency:0},minimum_quality:0,minimum_confidence:0}})
  const spec={name:'Team',purpose:'Work',kind:'coordinator',workspace_refs:[workspace],execution_targets:[{id:'control',host_id:hub.node,executor_profile_id:'profile',executor_profile_revision:profileHash,provider_id:'fixture',model_id:'model',effort:null,account_binding_id:'account',capability_profile_revision:'1'}],workers:[],coordinator_targets:['control'],workflow_pack_refs:[version(flow)],delivery_bindings:[{id:'local',workflow:version(flow),project:version(project),delivery_policy:version(delivery)}],grant_id:'grant',budget_policy_id:'budget-policy',scheduling_policy_id:'schedule',limits:{max_active_assignments:2,max_active_runs:2},proactive_mode:'off'}
  const team=await call('teams',{id:'team',request_id:'create',expected_revision:0,spec})
  const grant=(await call('team-grants',{expected_revision:0,policy:{id:'grant',team_id:'team',enabled:true,expires_at:at+60000,targets:[target],capabilities:['read','delegate'],tools:['kode_artifact_capture','kode_coordinator_publish_reply','kode_coordinator_workflow_start','kode_coordinator_configuration','kode_coordinator_workflow_status'],network:false,budget_ids:['budget']}})).grant
  await call('teams/team/activation',{action:'activate',request_id:'activate',expected_revision:0,team_revision:1,grant_revision:grant.revision,budget_policy:policy(budget),scheduling_policy:policy(schedule)})
  await call('price-versions',{id:'price',model:'model',model_policy:'requested_model',unit:'credits',input_per_million:1000000,cached_per_million:1000000,output_per_million:1000000})
  const selection={profile_revision:profileHash,model:'model',effort:null,scope:'executor_configuration'}

  const operationRequest={owner_session:'owner',request_key:'coordinator',worker:{node_id:hub.node,session_id:'coordinator'},selection_policy:selection,funding:{budget_ids:['budget'],amount:40,unit:'credits'},resource,grant_id:'grant',grant_scope:{team_id:'team',revision:1,target,capabilities:['read','delegate'],tools:['kode_artifact_capture','kode_coordinator_publish_reply','kode_coordinator_workflow_start','kode_coordinator_configuration','kode_coordinator_workflow_status'],network:false,budget_ids:['budget']}}
  const bundle=await call('operation-bundles',operationRequest)
  await call(`budget-reservations/${bundle.reservation.request.id}/pricing`,{price_id:'price'})
  let op=bundle.operation,controlRevision=1,resumeReceipt,resumeInput
  await call('teams/team/coordinator-control',{request_id:'bind',expected_revision:0,team_revision:1,activation_revision:1,operation_id:op.id,operation_revision:op.revision,attempt:1,epoch:1,target_id:'control'})
  const command=await host.prepareCoordinator({command_id:'create',team_id:'team',control_revision:1,operation_revision:op.revision,profile_id:'profile',provider:'fixture'})
  assert.equal(calls,0)
  assert.equal((await call('sessions')).sessions.some(s=>s.address.session_id==='coordinator'),false)
  const creation=await host.dispatches.dispatch(command)
  assert.equal(creation.state,'created')
  assert.deepEqual(await host.dispatches.dispatch(command),creation)
  assert.equal(calls,0)
  assert.equal((await call(`operations/${op.id}`)).state,'active')
  assert.equal((await call('sessions')).sessions.find(s=>s.address.session_id==='coordinator').runtime,'dsh')
  assert.ok(!JSON.stringify(await ctx.systemPrompt.assemble({})).includes(COORDINATOR_PROMPT_VERSION))
  let owned=host.handles.get('coordinator')
  const waitFor=async predicate=>{const until=Date.now()+6000;while(!await predicate()){assert.ok(Date.now()<until,'expected runtime evidence before timeout');await new Promise(r=>setTimeout(r,10))}}
  const spoof=await call('messages',{source:'coordinator',target:{node_id:hub.node,session_id:'coordinator'},idempotency_key:'spoof',content:JSON.stringify({format:'kode.coordinator.input.v1',operation_id:op.id,conversation_id:team.conversation_id,source_message_id:'fake'})})
  await waitFor(async()=>(await call(`messages/${spoof.id}`)).status==='uncertain')
  assert.equal(calls,0,'unbound peer input cannot start inference')
  const inputIds=[],published=[],runs=[]
  const peer=await call('sessions',{session_id:'untrusted-worker',title:'Worker',runtime:'external'})
  const peerClient=hub.client.forSession(peer.owner_token)
  const recovering=process.env.KODE_TEST_COORDINATOR_RESUME==='1',followup=process.env.KODE_TEST_COORDINATOR_FOLLOWUP==='1'
  let cancelledPrior
  for(const [index,content] of ['Implement the requirement',followup?'Also preserve existing behavior. Start a new attempt linked to the task I just cancelled.':'Also preserve existing behavior'].entries()){
   if(recovering&&index===1){
    await owned.run.finish();await owned.dispose()
    const accounting=await call(`operations/${op.id}/budget?attempt=1`),reservation=accounting.reservation
    if(!reservation.finalized)await call(`budget-reservations/${reservation.request.id}/settle`,{event_id:'recovery-finalize',expected_revision:reservation.revision,total_charge:reservation.charged,finalized:true,basis:'manual'})
    resumeInput={team_id:'team',command_id:'resume',provider:'fixture',start:{request_id:'resume',expected_control_revision:1,team_revision:1,activation_revision:1,target_id:'control',price_id:'price',operation:{...operationRequest,request_key:'resume'}}}
    const resume=host.resumeCoordinator.bind(host);let loseResume=true
    host.resumeCoordinator=async command=>{const result=await resume(command);if(loseResume){loseResume=false;throw Error('fixture resume response lost')}return result}
    await assert.rejects(host.startCoordinator(resumeInput),/resume response lost/)
    host.resumeCoordinator=resume
    resumeReceipt=await host.startCoordinator(resumeInput)
    assert.equal(resumeReceipt.state,'resumed');assert.deepEqual(await host.startCoordinator(resumeInput),resumeReceipt)
    assert.equal(calls,6,'restoring history does not execute prior model or tools')
    assert.equal(publicationWrites,1);assert.equal(workflowWrites,1)
    op=await call(`operations/${resumeReceipt.request.operation.id}`);controlRevision=2
    owned=host.handles.get('coordinator')
    assert.ok(owned.agent.session.snapshotEvents().some(e=>e.type==='user/message'&&e.data.id===inputIds[0]))
   }
   if(followup&&index===1){
    const previous=runs[0]
    await assert.rejects(call(previous.startPath,{...previous.start,request_id:'active-prior',prior_run_id:previous.run.id}),/prior run must be terminal/)
    cancelledPrior=await call(`work-runs/${previous.run.id}`,{action:'cancel',request_id:'owner-cancel',expected_revision:previous.run.revision})
    assert.equal(cancelledPrior.state,'cancelled')
   }
   const human=await call(`conversations/${team.conversation_id}/messages`,{request_id:`request-${index}`,content,...(followup&&index===1?{prior_run_id:runs[0].run.id}:{})})
   currentReply={request_id:`reply-${index}`,source_message_id:human.id,content:'WorkRun accepted; execution is pending.'}
   currentStart={request_id:`run-${index}`,source_message_id:human.id,binding_id:'local',inputs:{request:content}}
   if(followup&&index===1)currentStart.prior_run_id=runs[0].run.id
   const inputPath=`conversations/${team.conversation_id}/messages/${human.id}/coordinator-input`
   const input={operation_id:op.id,control_revision:controlRevision,attempt:1,epoch:1}
   const [queued,retry]=await Promise.all([call(inputPath,input),call(inputPath,input)])
   assert.deepEqual(retry,queued)
   const inputId=deliveryInputId(queued.receipt.message_id);inputIds.push(inputId)
   await waitFor(()=>owned.agent.session.snapshotEvents().some(e=>e.type==='user/message'&&e.data.id===inputId))
   await owned.agent.whenIdle()
   await waitFor(async()=>(await call(`messages/${queued.receipt.message_id}/delivery`)).delivery?.phase==='consumed')
   assert.deepEqual(errors,[]);assert.equal(calls,(index+1)*6)
   assert.equal(owned.agent.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id===inputId).length,1)
   assert.deepEqual(await call(inputPath,input),queued)
   assert.equal(calls,(index+1)*6)
   const replyPath=`conversations/${team.conversation_id}/coordinator-replies`
   const reply={...input,request_id:`reply-${index}`,source_message_id:human.id,content:'WorkRun accepted; execution is pending.'}
   await assert.rejects(peerClient.call(`/api/v1/messaging/${replyPath}`,reply),/403/)
   await assert.rejects(call(replyPath,{...reply,request_id:'wrong-control',control_revision:controlRevision+1}),/binding mismatch/)
   await assert.rejects(call(replyPath,{...reply,actor:{kind:'human'}}),/422/)
   const [sent,replayed]=await Promise.all([call(replyPath,reply),call(replyPath,reply)])
   assert.deepEqual(sent,replayed);assert.equal(sent.actor.kind,'superagent');assert.equal(sent.in_reply_to,human.id)
   assert.equal(sent.state,'published');assert.equal(sent.operation_id,op.id)
   assert.deepEqual((await call(`${replyPath}/${reply.request_id}`)).message,sent)
   await assert.rejects(call(replyPath,{...reply,content:'changed'}),/identity conflict/)
   published.push({replyPath,reply,sent})
   const startPath=`conversations/${team.conversation_id}/work-runs`,start={...currentStart,...input}
   const run=(await call(`${startPath}/requests/${start.request_id}`)).run
   assert.equal(run.state,'waiting_resource');assert.equal(run.owner.kind,'superagent')
   assert.equal(run.coordinator.source_message_id,human.id);assert.equal(run.context.binding.id,'local')
   assert.deepEqual(await call(startPath,start),run)
   await assert.rejects(peerClient.call(`/api/v1/messaging/${startPath}`,start),/403/)
   await assert.rejects(call(startPath,{...start,inputs:{request:'changed'}}),/identity conflict/)
   await assert.rejects(call(startPath,{...start,request_id:'bad-binding',binding_id:'foreign'}),/unknown team delivery binding/)
   assert.equal(run.prior_run_id,followup&&index===1?runs[0].run.id:null)
   if(followup&&index===1){
    await assert.rejects(call(startPath,{...start,request_id:'lost-human-link',prior_run_id:null}),/preserve the human follow-up/)
    assert.deepEqual(await call(`work-runs/${runs[0].run.id}`),cancelledPrior)
    await assert.rejects(call(startPath,{...start,prior_run_id:run.id}),/identity conflict/)
    await assert.rejects(call(startPath,{...start,request_id:'missing-prior',prior_run_id:'missing'}),/prior run must be terminal/)
   }
   runs.push({startPath,start,run})
  }
  assert.equal((await call('budgets/budget')).budget.spent,24)
  assert.equal(publicationWrites,2,'lost committed response recovered without repeating writes')
  assert.equal(lostPublication,true)
  assert.equal(lostWorkflow,true);assert.equal(workflowWrites,2)
  if(!followup)await assert.rejects(call(runs[1].startPath,{...runs[1].start,request_id:'over-capacity'}),/capacity exhausted/)
  const conversation=await call(`conversations/${team.conversation_id}/messages`)
  assert.equal(conversation.items.length,4)
  assert.deepEqual(conversation.items.map(m=>m.actor.kind),['human','superagent','human','superagent'])
  await owned.run.finish();await owned.dispose()
  const stored=await ctx.sessionPersistence.open('coordinator','read')
  try{
   const {events}=await stored.read(0,4096)
   assert.equal(events.filter(e=>e.type==='plugin:kode/official-creation').length,1)
   assert.equal(events.filter(e=>e.type==='plugin:kode/coordinator-resume').length,recovering?1:0)
   for(const inputId of inputIds)assert.equal(events.filter(e=>e.type==='user/message'&&e.data.id===inputId).length,1)
   assert.match(JSON.stringify(events),/execution is pending/)
  }finally{await stored.close()}
  if(recovering){assert.deepEqual(await host.startCoordinator(resumeInput),resumeReceipt);assert.equal(calls,12)}
  assert.equal(ctx.agents.get('coordinator'),undefined)
  await call('teams/team/activation',{action:'deactivate',request_id:'off',expected_revision:1})
  await hub.stop('SIGKILL');await hub.start()
  for(const {replyPath,reply,sent} of published){
   assert.deepEqual(await call(replyPath,reply),sent,'historical publication survives stop and restart')
   assert.deepEqual((await call(`${replyPath}/${reply.request_id}`)).message,sent)
   await assert.rejects(call(replyPath,{...reply,request_id:'new-after-stop'}),/active local lease|authority unavailable|binding mismatch|control changed|control mismatch/)
  }
  assert.equal((await call(`conversations/${team.conversation_id}/messages`)).items.length,4)
  if(followup)assert.deepEqual(await call(`work-runs/${runs[0].run.id}`),cancelledPrior)
  for(const {startPath,start,run} of runs){
   assert.deepEqual(await call(startPath,start),run)
   assert.deepEqual((await call(`${startPath}/requests/${start.request_id}`)).run,run)
   await assert.rejects(call(startPath,{...start,request_id:'after-stop'}),/active local lease|authority unavailable|binding mismatch|control changed|control mismatch/)
  }
 }finally{await host?.close();await execution?.close();await ctx.fiber.dispose();await hub.close()}
})

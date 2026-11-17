/** Real native owner-discussion acceptance; only formal Hub replies count. */
import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {pluginRecordOf} from '@deepseek-ai/dsh-session'
import {deliveryInputId} from '../../src/delivery-tracker.js'
export function nativeDiscussionOwnerText(name){
 assert.ok(['A','B'].includes(name))
 return name==='A'
  ? '我们先只讨论，不要开始做任务。请在这条讨论里只回“REQ-DISC-A”，我想确认这个讨论串能单独跟进。'
  : '这条和另一个讨论串分开跟进，我们先只讨论，不要开始做任务。请在这条讨论里只回“REQ-DISC-B”。'
}
export function assertDiscussionReply(message,reply,marker){
 assert.equal(reply.in_reply_to,message.id);assert.equal(reply.thread_id,message.thread_id)
 assert.equal(reply.surface_id,message.surface_id)
 assert.equal(reply.content,marker);assert.equal(reply.actor.kind,'superagent')
}
export async function nativeDiscussionPipeline({t,hub,ctx,profiles,execution,host,team,workspace,call,errors,model}){
 assert.equal(process.env.KODE_TEST_LIVE_NATIVE_DISCUSSION,'1');assert.equal(process.env.KODE_TEST_LIVE_FREE_WRAPPER,'1')
 const save=(name,value)=>writeFile(join(process.env.KODE_TEST_LIVE_EVIDENCE_DIR,name),JSON.stringify(value,null,2)+'\n',{mode:0o600})
 const scope={home_hub:hub.node,...workspace},scenes=[]
 let owned,closed
 const noWork=async()=>{
  const page=await call(`teams/${team.id}/work-runs?limit=20`)
  assert.equal(page.items.length,0);assert.ok(!page.has_more)
  assert.equal(Object.values(profiles.bindings).filter(b=>b.managedAssignment).length,0)
 }
 const settle=async()=>{
  await host.coordinatorCloseRecovery.close()
  const op=profiles.binding(owned.agent.id).managedOperation
  const state=await call(`operations/${op.id}/coordinator-close`)
  const command=state.intent?.request??{request_id:'native-discussion-close',attempt:op.attempt,epoch:op.epoch,price_id:'price',settlement:'internal_price'}
  closed=await host.closeCoordinator({operation_id:op.id,command})
  assert.equal(closed.state,'closed','Formal close must settle before Host disposal')
  const budget=(await call('budgets/budget')).budget;assert.equal(budget.reserved,0)
  return budget
 }
 try{
  await call('workbench/documents/workspaces',{expected_revision:0,value:{version:2,tables:{workspaces:{workspace:{path:workspace.root_ref,title:'Native discussion acceptance',sessionIds:[]}}},global:{initialized:true,workspaceIds:['workspace']}}})
  for(const name of ['A','B']){
   const surface='discussion-'+name
   await call(`collaboration/surfaces/${surface}`,{request_id:'create',expected_revision:0,scope,kind:name==='A'?'dm':'channel',title:surface,team_ids:[team.id],enabled:true})
   scenes.push({surface,marker:'REQ-DISC-'+name,input:{request_id:'owner-'+name,expected_revision:1,content:nativeDiscussionOwnerText(name),mentions:[{team_id:team.id,team_revision:team.revision,worker_id:null}]}})
  }
  const initial=(await call('budgets/budget')).budget
  assert.equal(initial.reserved,0);assert.equal(initial.spent,0);assert.equal(host.handles.size,0);assert.equal(execution.active.size,0)
  await noWork()
  if(process.env.KODE_TEST_NATIVE_DISCUSSION_SETUP_ONLY==='1'){
   // Queue genuine owner discussion, but do not bootstrap/mount any loop.
   for(const scene of scenes){
    scene.message=await call(`collaboration/surfaces/${scene.surface}/messages`,scene.input)
    assert.equal(scene.message.delivery_state,'pending_coordinator')
    assert.deepEqual(await call(`collaboration/surfaces/${scene.surface}/messages`,scene.input),scene.message)
    await assert.rejects(call(`collaboration/surfaces/${scene.surface}/messages`,{...scene.input,content:'conflicting retry'}))
   }
   assert.notEqual(scenes[0].message.thread_id,scenes[1].message.thread_id)
   assert.equal((await call(`conversations/${team.conversation_id}/messages`)).items.length,0)
   assert.equal(host.handles.size,0);assert.equal(execution.active.size,0);await noWork()
   const budget=(await call('budgets/budget')).budget;assert.equal(budget.reserved,0);assert.equal(budget.spent,0)
   const summary={phase:'setup_only',provider_calls:0,workflow_runs:0,worker_sessions:0,budget,scenes}
   await save('setup-only.json',summary);t.diagnostic(JSON.stringify({native_discussion_summary:summary}));return
  }
  for(const scene of scenes){
   scene.message=await call(`collaboration/surfaces/${scene.surface}/messages`,scene.input)
   if(!owned){
    const result=await host.coordinatorBootstrap.scan()
    assert.equal(result.length,1);assert.equal(result[0].state,'started',JSON.stringify(result.map(x=>({state:x.state,error:x.error?.message}))))
    assert.equal(host.handles.size,1);owned=[...host.handles.values()][0]
   }
   await host.coordinatorInbox.scan()
   let last='',progressAt=Date.now()
   while(true){
    t.signal.throwIfAborted();assert.deepEqual(errors,[]);await noWork()
    const page=await call(`collaboration/surfaces/${scene.surface}/messages?thread_id=${scene.message.thread_id}`)
    const replies=page.items.filter(x=>x.in_reply_to===scene.message.id)
    assert.ok(replies.length<=1,'Exactly one reply per source')
    if(replies.length){assertDiscussionReply(scene.message,replies[0],scene.marker);scene.reply=replies[0];break}
    const progress=JSON.stringify(owned.agent.session.snapshotEvents().at(-1)?.seq)
    const inferring=[...execution.active.values()].some(slot=>Boolean(slot.currentCallId))
    if(last!==progress||inferring){last=progress;progressAt=Date.now()}
    assert.ok(Date.now()-progressAt<60000,'Native discussion idle without formal reply; assistant text is not publication')
    await new Promise(r=>setTimeout(r,250))
   }
   await owned.agent.whenIdle()
   const intake=(await call(`conversations/${team.conversation_id}/messages/${scene.message.id}/coordinator-input`)).input
   assert.equal((await call(`messages/${intake.receipt.message_id}/delivery`)).delivery.phase,'consumed')
   const inputs=owned.agent.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id===deliveryInputId(intake.receipt.message_id))
   assert.equal(inputs.length,1);assert.ok(JSON.stringify(inputs[0]).includes(scene.input.content))
   scene.intake=intake
   assert.equal((await call(`conversations/${team.conversation_id}/messages`)).items.length,0)
   await save('thread-'+scene.marker+'.json',scene)
  }
  assert.notEqual(scenes[0].message.thread_id,scenes[1].message.thread_id)
  const reader=await ctx.sessionPersistence.open(owned.agent.id,'read');let events
  try{events=(await reader.read(0,16384)).events;assert.ok(events.length<16384)}finally{await reader.close()}
  const decisions=events.map(pluginRecordOf).filter(r=>r?.type==='plugin:kode/managed-cli-decision').map(r=>r.data)
  assert.ok(decisions.length>=2)
  for(const d of decisions){assert.equal(d.failure_code,null);assert.equal(d.configuration.model,model);assert.ok(d.usage.input_tokens+d.usage.output_tokens>0);assert.equal(d.stop.leader_exited,true);assert.equal(d.stop.process_group_empty,true);assert.deepEqual(d.stop.signal_failures,[])}
  await save('native-events.json',events)
  const budget=await settle();assert.ok(budget.spent>0&&budget.spent<=budget.limit)
  await host.coordinatorInbox.close();await hub.stop();await hub.start()
  for(const scene of scenes){
   assert.deepEqual(await call(`collaboration/surfaces/${scene.surface}/messages`,scene.input),scene.message)
   const page=await call(`collaboration/surfaces/${scene.surface}/messages?thread_id=${scene.message.thread_id}`)
   assert.equal(page.items.length,2);assertDiscussionReply(scene.message,page.items[1],scene.marker)
  }
  await noWork()
  const summary={phase:'native_complete',workflow_runs:0,worker_sessions:0,decisions:decisions.length,budget,closed,scenes,ui:'not_exercised'}
  await save('final.json',summary);t.diagnostic(JSON.stringify({native_discussion_summary:summary}))
 }catch(error){
  let cleanup={state:'not_started'}
  try{
   // Preserve live ownership until the official close/settlement attempt has completed.
   owned??=[...host.handles.values()].find(h=>profiles.binding(h.agent.id)?.managedCoordinator)
   if(owned)cleanup={state:'confirmed',budget:await settle(),closed}
  }catch(failure){cleanup={state:'unconfirmed',error:failure.message,closed:closed??null}}
  const failure={original_error:{name:error.name,message:error.message},cleanup}
  await save('failure-cleanup.json',failure);t.diagnostic(JSON.stringify({native_discussion_failure:failure}));throw error
 }
}

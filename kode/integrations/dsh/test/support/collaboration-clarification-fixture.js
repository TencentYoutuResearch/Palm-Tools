/** Controlled model, real Hub/Host: task-scoped owner answers must never cross runs. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
const root='/api/v1/messaging',base=root+'/collaboration'
const sleep=()=>new Promise(resolve=>setTimeout(resolve,25))
export async function createClarificationFixture(hub,workspace){
 const scope={home_hub:hub.node,...workspace}, tasks=[], asked=new Map(), consumed=new Set()
 await hub.client.call(root+'/workbench/documents/workspaces',{expected_revision:0,value:{version:2,tables:{workspaces:{[workspace.workspace_id]:{path:workspace.root_ref,title:'Controlled clarification fixture',sessionIds:[]}}},global:{initialized:true,workspaceIds:[workspace.workspace_id]}}})
 for(const kind of ['dm','channel'])await hub.client.call(`${base}/surfaces/${kind}`,{request_id:'create',expected_revision:0,scope,kind,title:kind,team_ids:['team'],enabled:true})
 for(const label of ['A','B']){
  const summary=`Requirement ${label}: Change source.txt to repaired source.`
  const origin=await hub.client.call(`${base}/surfaces/dm/messages`,{request_id:'private-'+label,expected_revision:1,content:'SECRET_DM_NOT_PUBLISHED '+summary,mentions:[]})
  const task=await hub.client.call(base+'/tasks',{request_id:'create-'+label,origin_surface_id:'dm',origin_message_id:origin.id,origin_revision:1,archive_surface_id:'channel',archive_revision:1,team_id:'team',team_revision:1,summary,publication:{destination_id:'channel',destination_revision:1,summary_sha256:createHash('sha256').update(summary).digest('hex')}})
  const preview=await hub.client.call(`${base}/tasks/${task.id}/execution`)
  const receipt=await hub.client.call(`${base}/tasks/${task.id}/execution`,{request_id:'dispatch',expected_task_revision:task.revision,binding_id:'local',activation_revision:1,context_sha256:preview.context_sha256})
  tasks.push({...task,label,runId:receipt.work_run_id,answer:`原文答复 ${label}：只修改本需求。保留换行\n确认 repaired source。`})
 }
 async function stream(execution,options){
  if(!options.tools.some(t=>t.name==='kode_capture_output'))return false
  const slot=execution.active.get(options.sessionId), assignment=await hub.client.call(`${root}/work-assignments/${execution.profiles.binding(options.sessionId).managedAssignment.id}`)
  const task=tasks.find(t=>t.runId===assignment.run_id);assert.ok(task)
  if(!asked.has(task.id)){
   const call=await execution.assertModelRequest(slot.agent)
   const question=await execution.clarifications.record(slot.agent,call,[{id:'scope-'+task.label,question:`请确认需求 ${task.label} 的具体改动范围。`}])
   asked.set(task.id,{question,assignment,call,session:options.sessionId});return true
  }
  const answers=options.messages.filter(m=>m.role==='user').flatMap(m=>m.content??[]).filter(b=>b.type==='text').map(b=>b.text)
  const envelope=answers.filter(text=>text.includes('kode.assignment.clarification-answer.v1')).map(text=>JSON.parse(text.slice(text.indexOf('{'))))
  assert.equal(envelope.length,1,'Worker receives exactly its own answer')
  assert.equal(envelope[0].answer.content,task.answer)
  assert.equal(envelope[0].run_id,task.runId);assert.equal(envelope[0].assignment_id,assignment.id)
  assert.ok(!JSON.stringify(options.messages).includes('SECRET_DM_NOT_PUBLISHED'))
  consumed.add(task.id);return false
 }
 async function finish(execution,service,states,errors){
  const until=Date.now()+45000
  while(asked.size<2||[...asked.values()].some(row=>execution.active.get(row.session)?.currentCallId)){
   assert.ok(Date.now()<until,'both Worker questions must finish: '+JSON.stringify({asked:asked.size,states:states.slice(-5),errors}));await sleep()
  }
  const archive=task=>hub.client.call(`${base}/surfaces/channel/messages?thread_id=${task.thread_id}`)
  const [a,b]=tasks,qa=asked.get(a.id),qb=asked.get(b.id)
  const command=(t,q)=>({request_id:'answer-'+t.label,source_surface_id:'channel',thread_id:t.thread_id,run_id:t.runId,assignment_id:q.assignment.id,question_request_id:q.question.request.request_id,content:t.answer})
  for(const t of tasks){const preview=await hub.client.call(`${base}/tasks/${t.id}/execution`);assert.equal(preview.work_run.clarifications.length,1);assert.ok(JSON.stringify(await archive(t)).includes('worker_clarification'))}
  const before=[await archive(a),await archive(b),await hub.client.call(`${root}/work-assignments/${qb.assignment.id}`)]
  await assert.rejects(hub.client.call(`${base}/tasks/${b.id}/clarification-answers`,{...command(b,qb),assignment_id:qa.assignment.id,question_request_id:qa.question.request.request_id}),/scope mismatch/)
  assert.deepEqual([await archive(a),await archive(b),await hub.client.call(`${root}/work-assignments/${qb.assignment.id}`)],before,'wrong task answer must leave no partial archive or assignment write')
  const observer=await hub.client.call(root+'/sessions',{session_id:'answer-observer',title:'Observer',runtime:'external'})
  await assert.rejects(hub.client.forSession(observer.owner_token).call(`${base}/tasks/${a.id}/clarification-answers`,command(a,qa)),/403/)
  const cancelled=process.env.KODE_TEST_CLARIFICATION_CANCEL==='1'
  if(cancelled){
   const path=`${base}/tasks/${b.id}`,current=await hub.client.call(path)
   await hub.client.call(path+'/commands',{request_id:'cancel-question-b',expected_revision:current.revision,source_surface_id:'channel',action:'cancel',content:null,worker_id:null})
   const snapshot=await archive(b)
   await assert.rejects(hub.client.call(path+'/clarification-answers',command(b,qb)))
   assert.deepEqual(await archive(b),snapshot,'cancelled task answer must leave no partial archive message')
   assert.equal((await hub.client.call(`${root}/work-assignments/${qb.assignment.id}`)).clarification_answers?.length??0,0)
  }
  for(const task of cancelled?[a]:tasks){
   const input=command(task,asked.get(task.id)),path=`${base}/tasks/${task.id}/clarification-answers`
   const receipt=await hub.client.call(path,input)
   assert.equal(receipt.provenance_version,2);assert.equal(receipt.human_source.kind,'collaboration_owner')
   assert.deepEqual(await hub.client.call(path,input),receipt)
   const snapshot=await archive(task)
   await assert.rejects(hub.client.call(path,{...input,request_id:'duplicate-new-id'}))
   assert.deepEqual(await archive(task),snapshot,'duplicate new request must not leave an archive message')
  }
  let runs
  while(true){
   runs=await Promise.all(tasks.map(t=>hub.client.call(`${root}/work-runs/${t.runId}`)))
   if(runs.every((r,i)=>r.state===(cancelled&&i===1?'cancelled':'completed')))break
   assert.ok(Date.now()<until,'clarification continuation deadline: '+JSON.stringify({runs:runs.map(r=>({state:r.state,reason:r.waiting_reason,stages:r.stages})),states:states.slice(-6),errors}));await sleep()
  }
  await service.close();assert.deepEqual(errors,[]);assert.equal(consumed.size,cancelled?1:2)
  for(const run of cancelled?[runs[0]]:runs){assert.equal(run.completion_authorized,true);assert.ok(run.stages.every(s=>s.state==='passed'))}
  if(cancelled)assert.equal(runs[1].completion_authorized,false)
  return {adapter:'controlled_fixture',external_provider_calls:0,parallel_tasks:2,wrong_task_zero_partial_write:true,owner_only:true,idempotent:true,exact_answer_consumed:consumed.size,completed_runs:cancelled?1:2,cancelled_task_rejects_answer:cancelled}
 }
 return {runId:tasks[0].runId,stream,finish}
}

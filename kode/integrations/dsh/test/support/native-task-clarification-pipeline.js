/** Real questions only. No model output/question injection. */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {pluginRecordOf} from '@deepseek-ai/dsh-session'
export const taskRequirement='请在此需求独立工作区创建 implemented.txt，内容是我选定的最终短语，不含换行。最终短语尚未提供，请先向我确认，不要自行猜测或写入。确认后按已配置的实现、独立审查、验证三阶段交付。'
export const taskAnswer='最终短语是 implemented。请将 implemented.txt 的内容精确写为 implemented，不含换行。\n只处理本需求。'
export function answerCommand(task,q,content=taskAnswer){
 assert.equal(q.run_id,task.runId);assert.equal(q.state,'pending');assert.ok(q.assignment_id&&q.request?.request_id&&q.request.questions?.length)
 return {request_id:'native-owner-answer',source_surface_id:task.archive_surface_id,thread_id:task.thread_id,run_id:task.runId,assignment_id:q.assignment_id,question_request_id:q.request.request_id,content}
}
export function consumedAnswer(events,input){
 const envelopes=events.filter(e=>e.type==='user/message').flatMap(e=>e.data?.content??[]).filter(b=>b.type==='text'&&b.text.includes('kode.assignment.clarification-answer.v1')).map(b=>JSON.parse(b.text.slice(b.text.indexOf('{'))))
 assert.equal(envelopes.length,1,'Exactly one scoped owner answer must reach the Worker')
 const envelope=envelopes[0]
 for(const key of ['run_id','assignment_id','question_request_id'])assert.equal(envelope[key],input[key])
 assert.equal(envelope.answer.content,input.content)
 return envelope
}
export async function nativeTaskClarificationPipeline({t,hub,ctx,profiles,execution,host,runService,team,workspace,call,errors,model}){
 assert.equal(process.env.KODE_TEST_LIVE_TASK_CLARIFICATION,'1');assert.equal(process.env.KODE_TEST_LIVE_FREE_WRAPPER,'1')
 const save=(name,value)=>writeFile(join(process.env.KODE_TEST_LIVE_EVIDENCE_DIR,name),JSON.stringify(value,null,2)+'\n',{mode:0o600})
 const scope={home_hub:hub.node,...workspace},base='collaboration'
 if(process.env.KODE_TEST_NATIVE_TASK_ZERO_PROVIDER_FAILURE==='idle'){
  assert.equal(profiles.get('profile').type,'dsh','Controlled cleanup must never select native adapter')
  const configured=await call('teams/'+team.id)
  assert.ok(configured.spec.execution_targets.every(target=>target.provider_id==='fixture'&&target.effort===null),'Controlled cleanup requires explicitly supported adapter and null effort before task dispatch')
 }
 await call('workbench/documents/workspaces',{expected_revision:0,value:{version:2,tables:{workspaces:{workspace:{path:workspace.root_ref,title:'Native clarification acceptance',sessionIds:[]}}},global:{initialized:true,workspaceIds:['workspace']}}})
 for(const kind of ['dm','channel'])await call(`${base}/surfaces/${kind}`,{request_id:'create',expected_revision:0,scope,kind,title:kind,team_ids:[team.id],enabled:true})
 const origin=await call(`${base}/surfaces/dm/messages`,{request_id:'private',expected_revision:1,content:taskRequirement,mentions:[]})
 const task=await call(base+'/tasks',{request_id:'create',origin_surface_id:'dm',origin_message_id:origin.id,origin_revision:1,archive_surface_id:'channel',archive_revision:1,team_id:team.id,team_revision:team.revision,summary:taskRequirement,publication:{destination_id:'channel',destination_revision:1,summary_sha256:createHash('sha256').update(taskRequirement).digest('hex')}})
 const path=`${base}/tasks/${task.id}`,preview=await call(path+'/execution')
 const initialBudget=(await call('budgets/budget')).budget
 assert.equal(initialBudget.reserved,0);assert.equal(initialBudget.spent,0);assert.equal(preview.work_run,null)
 assert.deepEqual((await call('budgets/budget/reservations')).reservations,[])
 assert.equal(Object.values(profiles.bindings).filter(b=>b.managedAssignment||b.managedCoordinator).length,0)
 assert.equal(execution.active.size,0);assert.equal(host.handles.size,0)
 if(process.env.KODE_TEST_NATIVE_TASK_SETUP_ONLY==='1'){
  const summary={phase:'setup_only',provider_calls:0,dispatches:0,budget_reserved:0,task_id:task.id,thread_id:task.thread_id,execution_preview:preview}
  await save('setup-only.json',summary);t.diagnostic(JSON.stringify({native_task_summary:summary}));return
 }
 const dispatched=await call(path+'/execution',{request_id:'dispatch',expected_task_revision:task.revision,binding_id:'local',activation_revision:1,context_sha256:preview.context_sha256});task.runId=dispatched.work_run_id
 const wait=async predicate=>{let previous='',lastProgress=Date.now();while(true){
  t.signal.throwIfAborted();assert.deepEqual(errors,[]);if(await predicate())return
  const progress=JSON.stringify({runRevision:run?.revision,bindings:Object.values(profiles.bindings).filter(b=>b.managedAssignment),sessions:[...host.handles.values()].map(h=>h.agent.session.snapshotEvents().at(-1)?.seq)})
  const inferring=[...execution.active.values()].some(slot=>Boolean(slot.currentCallId))
  if(progress!==previous||inferring){previous=progress;lastProgress=Date.now()}
  assert.ok(Date.now()-lastProgress<60000,'Native task idle without state, session, or inference progress; inspect retained scene')
  await new Promise(r=>setTimeout(r,250))
 }}
 const records=async session=>{const reader=await ctx.sessionPersistence.open(session,'read');try{const result=await reader.read(0,16384);assert.ok(result.events.length<16384,'Evidence must not truncate');return result.events}finally{await reader.close()}}
 runService.start();let q,run
 if(process.env.KODE_TEST_NATIVE_TASK_ZERO_PROVIDER_FAILURE==='idle'){
  await wait(async()=>[...host.handles.values()].some(h=>h.agent.status==='idle'&&h.agent.session.snapshotEvents().some(e=>e.type==='assistant/message')))
  throw Error('Injected controlled idle failure: zero provider calls')
 }
 await wait(async()=>{const current=await call(path+'/execution');run=await call(`work-runs/${task.runId}`);q=current.work_run?.clarifications?.find(q=>q.state==='pending');assert.ok(!['completed','failed','cancelled'].includes(run.state),'Worker must ask before finishing');return Boolean(q)})
 const assignment=await call(`work-assignments/${q.assignment_id}`);assert.equal(assignment.run_id,task.runId);assert.equal(assignment.team_id,team.id)
 await host.handles.get(assignment.worker.session_id)?.agent.whenIdle()
 const decisions=(await records(assignment.worker.session_id)).map(pluginRecordOf).filter(r=>r?.type==='plugin:kode/managed-cli-decision')
 const asked=decisions.find(r=>r.data.failure_code==='worker_clarification_required');assert.ok(asked,'Must originate from native request_user_input');assert.deepEqual(asked.data.owner_question,q.request.questions)
 const input=answerCommand(task,q),archive=()=>call(`${base}/surfaces/channel/messages?thread_id=${task.thread_id}`)
 await save('question.json',{task,question:q,native:asked.data,archive:await archive()})
 const before=await archive();await assert.rejects(call(path+'/clarification-answers',{...input,thread_id:'foreign-thread'}));assert.deepEqual(await archive(),before)
 const answer=await call(path+'/clarification-answers',input)
 assert.equal(answer.state,'queued');assert.equal(answer.human_source.kind,'collaboration_owner');assert.equal(answer.human_source.task_id,task.id)
 assert.deepEqual(answer.request,input);assert.deepEqual(await call(path+'/clarification-answers',input),answer)
 await save('answer.json',{input,receipt:answer})
 await wait(async()=>{run=await call(`work-runs/${task.runId}`);assert.ok(!['failed','cancelled'].includes(run.state),'Native task failed');return run.state==='completed'})
 await runService.close();assert.equal(run.completion_authorized,true);assert.deepEqual(run.stages.map(s=>s.state),['passed','passed','passed'])
 assert.equal(await readFile(join(run.task_workspaces.code.root,'implemented.txt'),'utf8'),'implemented')
 const roles=[]
 for(const stage of run.stages){
  const row=await call(`work-assignments/${stage.assignment_id}`);assert.equal(row.run_id,run.id);assert.equal(row.resources.state,'released');assert.equal(row.accounting.receipt.reservation.finalized,true)
  const ev=await records(row.worker.session_id),native=ev.map(pluginRecordOf).filter(r=>r?.type==='plugin:kode/managed-cli-decision').map(r=>r.data);assert.ok(native.length)
  for(const d of native){assert.ok([null,'worker_clarification_required'].includes(d.failure_code));assert.equal(d.configuration.model,model);assert.ok(d.usage.input_tokens+d.usage.output_tokens>0);assert.equal(d.stop.leader_exited,true);assert.equal(d.stop.process_group_empty,true);assert.deepEqual(d.stop.signal_failures,[])}
  if(stage.stage_id==='implement')consumedAnswer(ev,input)
  await save('native-'+stage.stage_id+'.json',ev);roles.push({stage:stage.stage_id,session:row.worker.session_id,decisions:native.length})
 }
 const budget=(await call('budgets/budget')).budget;assert.equal(budget.reserved,0);assert.ok(budget.spent>0&&budget.spent<=budget.limit)
 const summary={phase:'native_complete',task_id:task.id,run_id:run.id,thread_id:task.thread_id,roles,budget,question_origin:'native_request_user_input',answer_target:input,completion_authorized:run.completion_authorized,ui:'not_exercised',coordinator:'not_started'}
 await save('final.json',{summary,run,archive:await archive()});t.diagnostic(JSON.stringify({native_task_summary:summary}))
}

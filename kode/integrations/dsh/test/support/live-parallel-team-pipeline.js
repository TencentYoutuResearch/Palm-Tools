/** Opt-in real Coordinator inbox + native Workers. Never creates a Run on the model's behalf. */
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {pluginRecordOf} from '@deepseek-ai/dsh-session'
import {deliveryInputId} from '../../src/delivery-tracker.js'

/** Failure evidence excludes raw messages, prompts, assertion values and local absolute paths. */
export function parallelFailure(error){
 const message=String(error?.message??'')
 const reasons=[['Terminal reply omitted requirement marker:','terminal_marker_missing'],['Coordinator became idle after consuming terminal update','terminal_reply_missing_after_idle'],['official Coordinator drain and accounting must complete','coordinator_close_incomplete'],['one consumed human request must not produce duplicate Runs','duplicate_run'],['native evidence must not be silently truncated','evidence_truncated'],['expected runtime evidence before timeout','fixture_observation_timeout']]
 return {name:['Error','AssertionError','TypeError','AbortError','TimeoutError'].includes(error?.name)?error.name:'Error',
  code:typeof error?.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(error.code)?error.code:null,
  reason:reasons.find(([prefix])=>message.includes(prefix))?.[1]??'inspect_failure_site',
  operator:['strictEqual','deepStrictEqual','==','!=','rejects','throws'].includes(error?.operator)?error.operator:null,
  actual:typeof error?.actual==='number'||typeof error?.actual==='boolean'?error.actual:null,
  expected:typeof error?.expected==='number'||typeof error?.expected==='boolean'?error.expected:null,
  sites:[...String(error?.stack??'').matchAll(/(?:live-parallel-team-pipeline|coordinator-parallel-live-native|\.parallel-live-[a-f0-9-]+)\.(?:js|mjs):\d+:\d+/g)].slice(0,6).map(match=>match[0])}
}

export const parallelRequirements=Object.freeze([
 {marker:'REQ-A',output:'REQ-A: avatar',request:'REQ-A：请在已选项目的独立任务工作区创建 implemented.txt，内容恰好是 REQ-A: avatar，不含换行。按已配置的实现、独立审查、验证流程交付。请独立跟踪这个需求，最终回复保留 REQ-A 标记。不要处理其他需求的内容。'},
 {marker:'REQ-B',output:'REQ-B: models',request:'REQ-B：这是第二个独立需求，请同时跟进，不要覆盖或重启 REQ-A。在这个需求自己的任务工作区创建 implemented.txt，内容恰好是 REQ-B: models，不含换行。按已配置流程交付，最终回复保留 REQ-B 标记并定向回复这条请求。'},
])
export function scopedRun(rows,team,human,marker){
 const matches=rows.filter(run=>run.coordinator?.source_message_id===human.id)
 assert.ok(matches.length<=1,'one consumed human request must not produce duplicate Runs')
 const run=matches[0];if(!run)return null
 assert.equal(run.team_id,team.id);assert.equal(run.coordinator.conversation_id,team.conversation_id)
 assert.ok(JSON.stringify(run.inputs).includes(marker),'Run inputs must preserve the intended requirement marker')
 return run
}
export function terminalReply(messages,team,human,run,marker){
 const replies=messages.filter(message=>message.actor?.kind==='superagent'&&message.in_reply_to===human.id
  &&message.source_update?.run_id===run.id&&message.source_update?.revision===run.revision
  &&(run.state!=="completed"||message.created_at>=run.delivery?.at))
 for(const reply of replies){assert.equal(reply.team_id,team.id);assert.equal(reply.conversation_id,team.conversation_id)}
 const marked=replies.find(reply=>reply.content.includes(marker))
 if(replies.length&&!marked)throw Error('Terminal reply omitted requirement marker: '+marker)
 return marked??null
}
/** A consumed terminal update plus two settled idle observations is evidence of omission, not a time limit. */
export async function detectMissingTerminalReply({owned,team,humans,runs,call,readMessages,settle=()=>new Promise(r=>setTimeout(r,250))}){
 const consumed=[]
 for(let i=0;i<runs.length;i++){
  const {update}=await call(`work-runs/${runs[i].id}/coordinator-updates/${runs[i].revision}`)
  if(!update)continue
  const receipt=update.receipt
  assert.equal(receipt.run_id,runs[i].id);assert.equal(receipt.revision,runs[i].revision)
  assert.equal(receipt.team_id,team.id);assert.equal(receipt.conversation_id,team.conversation_id)
  assert.equal(update.summary.source_message_id,humans[i].id)
  const inputId=deliveryInputId(receipt.message_id)
  const seen=()=>owned.agent.session.snapshotEvents().some(event=>event.type==='user/message'&&event.data?.id===inputId
   &&event.data.source?.form==='kode-coordinator-run-update'&&event.data.source.runId===runs[i].id
   &&event.data.source.revision===runs[i].revision&&event.data.source.sourceMessageId===humans[i].id)
  if(seen())consumed.push({i,seen})
 }
 if(!consumed.length)return
 // whenIdle waits through genuine native activity. No hard overall timeout is introduced.
 await owned.agent.whenIdle()
 const last=()=>owned.agent.session.snapshotEvents().at(-1)?.seq??-1
 const settledSequence=last()
 await settle();await owned.agent.whenIdle()
 if(last()!==settledSequence)return // new work arrived; observe its result on the next pass
 const messages=await readMessages()
 for(const {i,seen}of consumed){
  if(seen()&&!terminalReply(messages,team,humans[i],runs[i],parallelRequirements[i].marker))
   throw Error('Coordinator became idle after consuming terminal update but omitted exact final reply: '+parallelRequirements[i].marker)
 }
}

export function assertExpectedTerminal(run,expected){
 if(['completed','cancelled','failed'].includes(run.state))assert.equal(run.state,expected,'Run reached unexpected terminal state')
}
export async function detectMissingIntake({owned,team,human,call,readRun,settle=()=>new Promise(r=>setTimeout(r,250))}){
 const {input}=await call(`conversations/${team.conversation_id}/messages/${human.id}/coordinator-input`)
 if(!input)return
 assert.equal(input.receipt.source_message_id,human.id);assert.equal(input.receipt.team_id,team.id);assert.equal(input.receipt.conversation_id,team.conversation_id)
 const seen=()=>owned.agent.session.snapshotEvents().some(e=>e.type==='user/message'&&e.data?.id===deliveryInputId(input.receipt.message_id))
 if(!seen())return
 await owned.agent.whenIdle()
 const last=()=>owned.agent.session.snapshotEvents().at(-1)?.seq??-1,seq=last()
 await settle();await owned.agent.whenIdle()
 if(seq!==last())return
 if(seen()&&!await readRun())throw Error('Coordinator became idle after consuming human input but omitted Run')
}

export async function settleParallelCoordinator({host,profiles,owned,call}){
 await owned.agent.whenIdle()
 await host.coordinatorCloseRecovery.close()
 const binding=profiles.binding(owned.agent.id),op=binding?.managedOperation
 assert.ok(op?.id,'Coordinator operation binding required for official close')
 const current=await call(`operations/${op.id}/coordinator-close`)
 assert.equal(current.operation.id,op.id);assert.equal(current.operation.attempt,op.attempt);assert.equal(current.operation.epoch,op.epoch)
 const command=current.intent?.request??{request_id:'parallel-team-final-close',attempt:op.attempt,epoch:op.epoch,price_id:'price',settlement:'internal_price'}
 assert.equal(command.attempt,op.attempt);assert.equal(command.epoch,op.epoch)
 assert.equal(command.price_id,'price');assert.equal(command.settlement,'internal_price')
 const closed=await host.closeCoordinator({operation_id:op.id,command})
 assert.equal(closed.state,'closed','official Coordinator drain and accounting must complete')
 const budget=(await call('budgets/budget')).budget
 assert.ok(budget.spent>0&&budget.spent<=budget.limit);assert.equal(budget.reserved,0)
 return {closed,budget}
}

export async function liveParallelTeamPipeline({t,hub,ctx,profiles,host,runService,owned,team,root,model,call,errors,evidence}){
 assert.equal(process.env.KODE_TEST_LIVE_FREE_WRAPPER,'1')
 assert.equal(process.env.KODE_TEST_LIVE_PARALLEL_COORDINATOR,'1')
 const scenario=process.env.KODE_TEST_LIVE_PARALLEL_SCENARIO??'complete-both'
 assert.ok(['complete-both','cancel-a-before-dispatch'].includes(scenario))
 const directory=process.env.KODE_TEST_LIVE_EVIDENCE_DIR;assert.ok(directory)
 await mkdir(directory,{recursive:true,mode:0o700})
 const save=(name,value)=>writeFile(join(directory,name),JSON.stringify(value,null,2)+'\n',{mode:0o600})
 const wait=async(predicate)=>{while(true){t.signal.throwIfAborted();assert.deepEqual(errors,[]);if(await predicate())return;await new Promise(r=>setTimeout(r,250))}}
 const allRuns=async()=>{
  const page=await call(`teams/${team.id}/work-runs?limit=20`)
  assert.ok(page.items.length<=2,'unexpected additional Run')
  return Promise.all(page.items.map(row=>call(`work-runs/${row.id}`)))
 }
 const conversationMessages=async()=>{
  const items=[];let after=0
  while(true){const page=await call(`conversations/${team.conversation_id}/messages?after=${after}&limit=50`);assert.ok(Array.isArray(page.items));items.push(...page.items);if(!page.has_more)return items;const next=page.items.at(-1)?.sequence;assert.ok(Number.isSafeInteger(next)&&next>after,'conversation cursor must advance');after=next}
 }
 const humans=[],runs=[],finals=[]
 const send=async i=>{
  const human=await call(`conversations/${team.conversation_id}/messages`,{request_id:'parallel-'+parallelRequirements[i].marker,content:parallelRequirements[i].request})
  assert.equal(human.actor.kind,'human');humans[i]=human
  await evidence?.capture('parallel_'+parallelRequirements[i].marker+'_human_received')
  const readRun=async()=>runs[i]=scopedRun(await allRuns(),team,human,parallelRequirements[i].marker)
  await wait(async()=>{if(await readRun())return true;await detectMissingIntake({owned,team,human,call,readRun});return Boolean(runs[i])})
  return runs[i]
 }
 await send(0)
 assert.notEqual(runs[0].state,'completed','second demand must be sent while A is still outstanding')
 assert.ok(runs[0].coordinator?.operation_id,'real Coordinator must own intake')
 // The Host intentionally has not started Worker scheduling yet. The Coordinator is native and live.
 await send(1)
 assert.notEqual(runs[0].id,runs[1].id)
 assert.equal(runs[0].coordinator.operation_id,runs[1].coordinator.operation_id,'one Coordinator owns both demands')
 assert.equal(runs[0].coordinator.conversation_id,runs[1].coordinator.conversation_id)
 if(scenario==='cancel-a-before-dispatch'){
  const beforeB=await call(`work-runs/${runs[1].id}`),a=await call(`work-runs/${runs[0].id}`)
  assert.ok(a.stages.every(stage=>stage.assignment_id===null),'cancellation scenario is intentionally before Worker dispatch')
  await call(`work-runs/${a.id}`,{action:'request_cancel',request_id:'owner-cancel-REQ-A',expected_revision:a.revision,reason:'Cancel REQ-A only; REQ-B remains authorized.'})
  assert.deepEqual(await call(`work-runs/${beforeB.id}`),beforeB,'A cancellation must not revise B')
 }
 runService.start()
 let previous=''
 await wait(async()=>{
  const rows=await allRuns();for(let i=0;i<2;i++)runs[i]=scopedRun(rows,team,humans[i],parallelRequirements[i].marker)
  assert.ok(runs.every(Boolean))
  const state=runs.map(run=>({id:run.id,revision:run.revision,state:run.state,stages:run.stages.map(s=>({id:s.stage_id,state:s.state}))}))
  const key=JSON.stringify(state)
  if(key!==previous){previous=key;await save('parallel-status.json',{scenario,state});t.diagnostic(JSON.stringify({live_parallel_progress:state}));for(const run of runs)await evidence?.capture('parallel_progress',{run})}
  for(let i=0;i<runs.length;i++)assertExpectedTerminal(runs[i],i===0&&scenario==='cancel-a-before-dispatch'?'cancelled':'completed')
  return runs.every((run,i)=>run.state===(i===0&&scenario==='cancel-a-before-dispatch'?'cancelled':'completed'))
 })
 for(let i=0;i<2;i++){
  const run=runs[i],expected=parallelRequirements[i]
  if(i===0&&scenario==='cancel-a-before-dispatch'){
   assert.equal(run.completion_authorized,false);assert.equal(run.cancellation.stop_confirmed,true);assert.equal(run.cancellation.resources_released,true)
   assert.ok(run.stages.every(stage=>stage.assignment_id===null))
  }else{
   assert.equal(run.completion_authorized,true);assert.deepEqual(run.stages.map(s=>s.state),['passed','passed','passed'])
   const taskRoot=run.task_workspaces?.code?.root;assert.ok(taskRoot);assert.notEqual(taskRoot,root)
   assert.equal(await readFile(join(taskRoot,'implemented.txt'),'utf8'),expected.output)
   for(const stage of run.stages){const assignment=await call(`work-assignments/${stage.assignment_id}`);assert.equal(assignment.run_id,run.id);assert.equal(assignment.team_id,team.id);assert.equal(assignment.resources.state,'released');assert.equal(assignment.accounting.receipt.reservation.finalized,true)}
  }
 }
 if(scenario==='complete-both')assert.notEqual(runs[0].task_workspaces.code.root,runs[1].task_workspaces.code.root)
 await assert.rejects(readFile(join(root,'implemented.txt')),error=>error.code==='ENOENT')
 await wait(async()=>{
  const messages=await conversationMessages()
  for(let i=0;i<2;i++)finals[i]=terminalReply(messages,team,humans[i],runs[i],parallelRequirements[i].marker)
  if(!finals.every(Boolean))await detectMissingTerminalReply({owned,team,humans,runs,call,readMessages:conversationMessages})
  return finals.every(Boolean)
 })
 assert.notEqual(finals[0].id,finals[1].id)
 for(const run of runs)await evidence?.capture('parallel_final_reply_verified',{run})
 await owned.agent.whenIdle()
 const roles=[]
 for(const [session,binding]of Object.entries(profiles.bindings)){
  if(!binding.managedCoordinator&&!binding.managedAssignment)continue
  const run=binding.managedAssignment?runs.find(run=>run.stages.some(stage=>stage.assignment_id===binding.managedAssignment.id)):null
  assert.ok(binding.managedCoordinator||run,'Worker must belong to exactly one requested Run')
  const reader=await ctx.sessionPersistence.open(session,'read')
  try{
   const events=(await reader.read(0,4096)).events;assert.ok(events.length<4096,'native evidence must not be silently truncated')
   const decisions=events.map(pluginRecordOf).filter(row=>row?.type==='plugin:kode/managed-cli-decision')
   assert.ok(decisions.length>0)
   for(const {data}of decisions){assert.equal(data.failure_code,null);assert.equal(data.configuration.model,model);assert.equal(data.configuration.reasoningEffort,'low');assert.ok(data.usage.input_tokens+data.usage.output_tokens>0);assert.equal(data.stop.leader_exited,true);assert.equal(data.stop.process_group_empty,true)}
   roles.push({session,role:binding.managedCoordinator?'coordinator':run.stages.find(s=>s.assignment_id===binding.managedAssignment.id).stage_id,run_id:run?.id??null,decisions:decisions.length})
  }finally{await reader.close()}
 }
 assert.equal(roles.filter(r=>r.role==='coordinator').length,1)
 assert.equal(roles.length,scenario==='complete-both'?7:4)
 await runService.close()
 const {budget}=await settleParallelCoordinator({host,profiles,owned,call})
 await hub.stop('SIGKILL');await hub.start()
 for(let i=0;i<2;i++){const restored=await call(`work-runs/${runs[i].id}`);assert.equal(restored.state,runs[i].state);assert.deepEqual(restored.delivery,runs[i].delivery)}
 const summary={scenario,model,model_roles:'all_actual_native',controlled_roles:[],coordinator_count:1,requests:humans.map((h,i)=>({marker:parallelRequirements[i].marker,message_id:h.id,run_id:runs[i].id,final_reply_id:finals[i].id,source_update:finals[i].source_update,state:runs[i].state})),roles,budget:{limit:budget.limit,spent:budget.spent,reserved:budget.reserved},restart_verified:true,cancellation_scope:scenario==='cancel-a-before-dispatch'?'owner_run_cancellation_before_worker_dispatch':'not_exercised',setup:'owner_configured_fixture_not_model_generated_builder'}
 await save('parallel-final.json',summary);t.diagnostic(JSON.stringify({live_parallel_summary:summary}))
}

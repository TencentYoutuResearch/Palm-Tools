/** Real isolated Hub and Host; deterministic adapters, never claims live-model reasoning. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,rm,mkdir} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {randomUUID,createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {join,dirname} from 'node:path'
import {isolatedHub} from './support/discussion-hub.js'
import {versionedProject} from './support/versioned-project.js'
import {parallelRequirementScreenshots} from './support/parallel-requirement-browser.js'
import {conversationTeam} from './support/conversation-team.js'
const evidence=async(name,value)=>{if(process.env.KODE_TEST_PARALLEL_EVIDENCE){await mkdir(process.env.KODE_TEST_PARALLEL_EVIDENCE,{recursive:true});await writeFile(join(process.env.KODE_TEST_PARALLEL_EVIDENCE,name),JSON.stringify(value,null,2)+'\n')}}

test('same Superagent binds concurrent task threads to distinct Runs and cancels only the selected requirement', {skip:!process.env.KODE_TEST_HUB_BIN,timeout:60000},async t=>{
 const hub=await isolatedHub('parallel-requirements'),call=(p,b)=>hub.client.call('/api/v1/messaging/'+p,b)
 try{
  const root=await versionedProject(hub.root)
  await call('workbench/workspaces',{action:'create',path:root,title:'Parallel requirements fixture'})
  const w=(await call('workbench/workspaces')).workspaces.find(x=>x.path===root),workspace={host_id:hub.node,workspace_id:w.id,root_ref:root}
  const team=await conversationTeam(hub,{workspace}),scope={home_hub:hub.node,...workspace}
  await call('collaboration/surfaces/channel',{request_id:'create',expected_revision:0,scope,kind:'channel',title:'Two independent requirements',team_ids:[team.id],enabled:true})
  const summaries=['REQ-A: Fix historical avatar display.','REQ-B: Add independent default model selection.']
  const tasks=await Promise.all(summaries.map(async(summary,i)=>{
   const origin=await call('collaboration/surfaces/channel/messages',{request_id:'origin-'+i,expected_revision:1,content:summary,mentions:[]})
   return call('collaboration/tasks',{request_id:'task-'+i,origin_surface_id:'channel',origin_message_id:origin.id,origin_revision:1,archive_surface_id:'channel',archive_revision:1,team_id:team.id,team_revision:team.revision,summary,publication:{destination_id:'channel',destination_revision:1,summary_sha256:createHash('sha256').update(summary).digest('hex')}})
  }))
  assert.equal(new Set(tasks.map(x=>x.id)).size,2);assert.equal(new Set(tasks.map(x=>x.thread_id)).size,2)
  const receipts=await Promise.all(tasks.map(async task=>{
   const path='collaboration/tasks/'+task.id+'/execution',preview=await call(path),input={request_id:'dispatch',expected_task_revision:task.revision,binding_id:'local',activation_revision:1,context_sha256:preview.context_sha256}
   const [first,retry]=await Promise.all([call(path,input),call(path,input)]);assert.deepEqual(first,retry);return first
  }))
  assert.equal(new Set(receipts.map(x=>x.work_run_id)).size,2)
  const runs=await Promise.all(receipts.map(x=>call('work-runs/'+x.work_run_id)))
  assert.ok(runs.every(x=>x.team_id===team.id));assert.equal((await call('teams/'+team.id+'/work-runs?limit=10')).items.length,2)
  for(let i=0;i<2;i++){assert.ok(JSON.stringify(runs[i]).includes(summaries[i]));assert.ok(!JSON.stringify(runs[i]).includes(summaries[1-i]))}
  const beforeB=await call('collaboration/tasks/'+tasks[1].id)
  const question=await call('collaboration/tasks/'+tasks[0].id+'/commands',{request_id:'question-a',expected_revision:tasks[0].revision,source_surface_id:'channel',action:'question',content:'REQ-A only: progress?',worker_id:null})
  assert.equal(question.command.delivery_state,'stored_only');assert.equal(question.command.payload.execution_delivery.state,'not_delivered')
  assert.deepEqual(await call('collaboration/tasks/'+tasks[1].id),beforeB)
  const cancel={request_id:'cancel-a',expected_revision:question.task.revision,source_surface_id:'channel',action:'cancel',content:null,worker_id:null}
  const stopped=await call('collaboration/tasks/'+tasks[0].id+'/commands',cancel)
  assert.deepEqual(await call('collaboration/tasks/'+tasks[0].id+'/commands',cancel),stopped)
  assert.deepEqual(await call('work-runs/'+runs[1].id),runs[1],'B must not be revised or cancelled by A command')
  assert.equal((await call('work-runs/'+runs[0].id)).state,'cancelling')
  const pages=await Promise.all(tasks.map(task=>call('collaboration/surfaces/channel/messages?thread_id='+task.thread_id)))
  assert.ok(pages.every(page=>page.items.every(message=>JSON.stringify(message.scope)===JSON.stringify(page.surface.scope))),'every task command must include its authoritative workspace scope');
  assert.ok(JSON.stringify(pages[0]).includes('REQ-A only'));assert.ok(!JSON.stringify(pages[1]).includes('REQ-A only'));assert.ok(!JSON.stringify(pages[1]).includes('cancel-a'))
  await hub.stop('SIGKILL');await hub.start()
  assert.deepEqual(await call('work-runs/'+runs[1].id),runs[1]);assert.equal((await call('work-runs/'+runs[0].id)).state,'cancelling')
  const proof={adapter:'no_model_started',real_components:['Rust Hub','persisted tasks','execution intake','owner cancellation','restart'],team_id:team.id,tasks:tasks.map((x,i)=>({id:x.id,thread_id:x.thread_id,run_id:runs[i].id,summary:x.summary})),question_delivery:'stored_only/not_delivered',cancel_requested_run:runs[0].id,unaffected_run:runs[1].id,restart_verified:true}
  await parallelRequirementScreenshots(hub,w,tasks,process.env.KODE_TEST_PARALLEL_EVIDENCE);await evidence('task-thread-isolation.json',proof);t.diagnostic(JSON.stringify(proof))
 }finally{await hub.close()}
})

for(const parallel of [true,false])test(`same Superagent ${parallel?'executes concurrently':'queues at capacity and resumes'} two requirements into separate verified worktrees`, {skip:!process.env.KODE_TEST_BACKEND_URL||!process.env.KODE_TEST_HOST_NODE,timeout:90000},async t=>{
 const here=dirname(fileURLToPath(import.meta.url));let source=await readFile(join(here,'fixture-automatic-workflow.js'),'utf8')
 const replace=(from,to)=>{assert.ok(source.includes(from),'Fixture seam changed: '+from.slice(0,90));source=source.replace(from,to)}
 replace("if(!collaborationTask)await hub.client.call(runs, request)","// Both same-team intakes follow frozen revision 2 below.")
 const begin=source.indexOf("      await hub.client.call(`${root}/budgets`,{id:'budget-b'"),end=source.indexOf('\n    }\n    await ctx.plugin(SessionStore)',begin)
 assert.ok(begin>0&&end>begin)
 source=source.slice(0,begin)+`      const sameTeamSpec={...spec,delivery_bindings:[...spec.delivery_bindings,{id:'second-binding',workflow:versionRef(workflow),project:versionRef(projectB),delivery_policy:versionRef(deliveryB)}]}
      await hub.client.call(root+'/teams',{id:'team',request_id:'add-second-binding',expected_revision:1,spec:sameTeamSpec})
      await hub.client.call(path,{...command,request_id:'activate-second-revision',expected_revision:1,team_revision:2})
      await hub.client.call(runs,{...request,team_revision:2})
      await hub.client.call(runs,{...request,id:'second',request_id:'second',team_revision:2,binding_id:'second-binding',inputs:{request:'Change source.txt to team-b source.'}})
`+source.slice(end)
 replace("sessionTeams.set(options.sessionId,assignment.team_id)","assert.equal(assignment.team_id,'team');sessionTeams.set(options.sessionId,assignment.run_id===runId?'team':'team-b')")
 source=source.replaceAll("row.assignment.team_id==='team'","row.assignment.run_id===runId").replaceAll("row.assignment.team_id==='team-b'","row.assignment.run_id==='second'")
 replace("[['budget',sharedExpert?58:24],['budget-b',sharedExpert?58:24],['shared-budget',sharedExpert?116:48]]","[['budget',48],['shared-budget',48]]")
 replace("progression.push({ run_id: id, name: error.name,","progression.push({ run_id: id, message: error.message, name: error.name,")
 if(!parallel)replace("await service.close()\n      assert.deepEqual(errors","const capacityWaits=(await hub.client.call(runs+'/second/events')).events.filter(row=>row.data.kind==='work_run_capacity_wait');assert.ok(capacityWaits.length>=1,'second requirement must encounter and recover from real same-team capacity pressure');t.diagnostic(JSON.stringify({capacity_wait_events:capacityWaits.length,automatic_recovery:true}));await service.close()\n      assert.deepEqual(errors")
 replace("assert.deepEqual(errors,[]);assert.equal(inferenceCalls,sharedExpert?48:24)","assert.deepEqual(errors,[]);assert.equal(inferenceCalls,24);assert.ok(completed.every(run=>run.team_id==='team'));assert.equal(new Set(completed.map(run=>run.id)).size,2)")
 const script=join(here,'.parallel-requirements-'+randomUUID()+'.mjs'),env={...process.env,KODE_TEST_AUTOMATIC_SCENARIO:'shared-teams',KODE_TEST_TASK_WORKTREE_PARALLEL:parallel?'1':'0'};delete env.NODE_TEST_CONTEXT
 await writeFile(script,source,{flag:'wx'})
 try{const {stdout}=await promisify(execFile)(process.env.KODE_TEST_HOST_NODE,['--test','--test-reporter=spec',script],{env,timeout:85000,maxBuffer:2*1024*1024});assert.match(stdout,/pass 1/);assert.match(stdout,/fail 0/);const line=stdout.split('\n').find(x=>x.includes('task_worktree_evidence'));assert.ok(line);t.diagnostic('controlled_model_real_host: '+line);await evidence(parallel?'parallel-host-verification.json':'queued-host-verification.json',{model:'controlled_fixture',capacity:parallel?2:1,external_provider_calls:0,stdout})}
 catch(error){await evidence('parallel-host-failure.json',{stdout:error.stdout,stderr:error.stderr});throw error}
 finally{await rm(script,{force:true})}
})

import { remoteWorkflowRuntime } from './support/remote-workflow-runtime.js'
import { nativeDecisionProvider } from './support/native-decision-provider.js'
import { managedCodexRoute } from '../src/managed-codex-profile.js'
import { validReviewRequest } from '../src/assignment-evidence-tools.js'
import { verifyHomeTrace } from './support/home-trace.js'
import { createHash } from 'node:crypto'
import { createHook } from 'node:async_hooks'
// Opt-in resource origins only; never capture request bodies, credentials or model content.
const exitResources = new Map()
const exitHook = process.env.KODE_TEST_EXIT_DIAGNOSTICS === '1' ? createHook({
 init(id, type, trigger, resource) {
  if (!['Timeout', 'TCPWRAP', 'TCPSERVERWRAP', 'PROCESSWRAP', 'PIPEWRAP'].includes(type)) return
  exitResources.set(id, { type, resource: new WeakRef(resource), sites: new Error().stack.split('\n').slice(2, 9) })
 },
 destroy(id) { exitResources.delete(id) },
}).enable() : undefined
import { fullPipelineBrowser } from './support/full-pipeline-browser.js'
import { pipelineBrowser } from './support/coordinator-pipeline-browser.js'
import { pairedContactTeam } from './support/paired-contact-team.js'
import { pipelineBuilder } from './support/pipeline-builder.js'
import { OFFICIAL_BUILDER_TOOLS } from '../src/official-builder-tools.js'
import { BUILDER_PROMPT_VERSION } from '../src/builder-prompt.js'
import { teamOwnerHttp } from './support/team-owner-http.js'
import { teamRuntimeReadiness } from '../src/team-runtime-readiness.js'
import { CoordinatorTransfers } from '../src/coordinator-transfers.js'
import { coordinatorBootstrapInput } from '../src/coordinator-bootstrap.js'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { registerCoordinatorPlannedStart } from '../src/coordinator-start-route.js'
import { coordinatorInput } from '../src/coordinator-input.js'
import { CoordinatorUpdates } from '../src/coordinator-updates.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AssignmentDispatchHost } from '../src/assignment-dispatch-host.js'
import { WorkRunController } from '../src/work-run-controller.js'
import { WorkRunService } from '../src/work-run-service.js'
import { prepareWorkRunAssignment } from '../src/work-run-preparation.js'
import { verificationExecutableHash } from '../src/verification-runners.js'
/** Actual official runtime and Host inbox with a controlled adapter; no paid inference. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { pluginRecordOf } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import { createRequire } from 'node:module'
const loopRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { default: Tools } = await import(loopRequire.resolve('@deepseek-ai/dsh-tools'))
const { default: SystemPrompt } = await import(loopRequire.resolve('@deepseek-ai/dsh-system-prompt'))
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { realpath, mkdir, writeFile, readFile, readdir, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { isolatedHub, pairHubs } from './support/isolated-hub.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { OfficialExecution } from '../src/official-execution.js'
import { OfficialLoopHost } from '../src/official-loop-host.js'
import { OfficialToolPolicies } from '../src/official-grant-guard.js'
import { apply as applyHost } from '../src/host.js'
import * as persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { deliveryInputId } from '../src/delivery-tracker.js'

import { COORDINATOR_PROMPT_VERSION } from '../src/coordinator-context.js'
import { ASSIGNMENT_PROMPT_VERSION } from '../src/assignment-prompt.js'
import { readAssignmentOutputs } from '../src/assignment-outputs.js'
import { liveTeamPipeline } from './support/live-team-pipeline.js'

// Positive authority covers local cases and the longer cross-Hub case plus claim time.
// Lease expiry/revocation negatives have their own explicit tests.
const liveCoordinatorScenario=process.env.KODE_TEST_LIVE_COORDINATOR==='1'
const slowScenario=process.env.KODE_TEST_REMOTE_ANSWER==='1'||process.env.KODE_TEST_LIVE_WORKER==='1'||liveCoordinatorScenario
const FIXTURE_VALIDITY_MS=slowScenario?1200000:120000
test('Coordinator requests automatically execute implementation, independent review and real verification', {skip:!process.env.KODE_TEST_BACKEND_URL,timeout:slowScenario?900000:90000},async t=>{
 const remoteAnswer=process.env.KODE_TEST_REMOTE_ANSWER==='1'
 const nativeAnswer=process.env.KODE_TEST_NATIVE_ANSWER==='1'
 const nativeCoordinator=process.env.KODE_TEST_NATIVE_COORDINATOR==='1'||liveCoordinatorScenario
 const omittedPublication=process.env.KODE_TEST_OMIT_OUTPUT_PUBLICATION
 if(omittedPublication)assert.ok(['artifact','reviewed','checked','all'].includes(omittedPublication))
 const recoveryDiscount=omittedPublication?(omittedPublication==='all'?6:2):0
 const liveWorker=process.env.KODE_TEST_LIVE_WORKER==='1'
 const allLiveWorkers=liveWorker&&process.env.KODE_TEST_LIVE_ALL_WORKERS==='1'
 const liveEffort=process.env.KODE_TEST_NATIVE_EFFORT??'high'
 const nativeWorker=nativeAnswer||liveWorker
 if(liveWorker){assert.equal(nativeAnswer,false);assert.equal(process.env.KODE_TEST_LIVE_FREE_WRAPPER,'1');for(const key of ['KODE_TEST_WRAPPER_PROVIDER','KODE_TEST_WRAPPER_HOME','KODE_TEST_MANAGED_CODEX_BOOTSTRAP_ENGINE'])assert.ok(process.env[key],`Explicit ${key} required`)}
 const fixtureModel=process.env.KODE_TEST_NATIVE_MODEL??'model'
 const nativeBuilderSetup=process.env.KODE_TEST_COORDINATOR_BUILDER_SETUP==='1'
 const dependencyScenario=process.env.KODE_TEST_WORKFLOW_DEPENDENCIES==='1'
 const dependencyMarker='WORKFLOW_DEPENDENCY_FIXTURE: preserve independent review and verification.'
 let dependencyArtifact,dependencyNegativesChecked=false
 const dependencyProofs=[]
 const hub=await isolatedHub('official-coordinator'),ctx=new Context()
 let execution,host,runService,startServer,ownerHttp,imBrowser,nativeProvider,nativeDecide,remoteHub,remoteRuntime,remoteRoot,profiles
 const liveStagesByAssignment=new Map()
 try{
  await ctx.plugin(SessionStore);await ctx.plugin(AgentRegistry);await ctx.plugin(Projections)
  await ctx.plugin(SystemPrompt,{includeHarnessIdentity:false,includeRuntimeContext:false})
  await ctx.plugin(Tools);await ctx.plugin(LlmRuntime)
  const runtimeRoot=await realpath(hub.root),root=join(runtimeRoot,'project'),call=(p,b)=>hub.client.call(`/api/v1/messaging/${p}`,b),at=Date.now()
  await mkdir(root)
  const git=args=>promisify(execFile)('/usr/bin/git',['-C',root,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.com',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.com'}})
  await git(['init','-q']);await writeFile(join(root,'README.md'),'Fixture project');await git(['add','.']);await git(['commit','-qm','fixture baseline'])
  if(remoteAnswer){
   assert.equal(nativeAnswer,false,'remote and native scenarios have separate evidence gates')
   remoteHub=await isolatedHub('coordinator-remote-worker');await pairHubs(hub,remoteHub)
   remoteRoot=await realpath(remoteHub.root);remoteRoot=join(remoteRoot,'project');await mkdir(remoteRoot)
   const remoteGit=args=>promisify(execFile)('/usr/bin/git',['-C',remoteRoot,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.com',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.com'}})
   await remoteGit(['init','-q']);await writeFile(join(remoteRoot,'README.md'),'Remote fixture project');await remoteGit(['add','.']);await remoteGit(['commit','-qm','fixture baseline'])
  }
  await ctx.plugin(persistence,{root:join(runtimeRoot,'sessions'),compression:'zstd'})
  const pairedScenario=process.env.KODE_TEST_COORDINATOR_FRESH_SUCCESSOR==='1',otherRoot=join(runtimeRoot,'other-project')
  if(nativeWorker){
   assert.ok(process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE,'native answer test requires an explicit installed engine')
   if(!liveWorker)nativeProvider=await nativeDecisionProvider(options=>nativeDecide(options))
  }
  if(nativeCoordinator){
   assert.equal(nativeWorker,false)
   assert.ok(process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE)
   if(liveCoordinatorScenario){
    assert.equal(process.env.KODE_TEST_LIVE_FREE_WRAPPER,'1')
    for(const key of ['KODE_TEST_MANAGED_CODEX_WRAPPER','KODE_TEST_WRAPPER_PROVIDER','KODE_TEST_WRAPPER_HOME','KODE_TEST_NATIVE_MODEL'])assert.ok(process.env[key],`Explicit ${key} required`)
   }else nativeProvider=await nativeDecisionProvider(options=>nativeDecide(options))
  }
  const nativeProfile=nativeWorker?{id:'native-worker',name:'Native implementation Worker',type:'codex',
   executable:process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE,args:[],defaultModel:fixtureModel,
   ...(process.env.KODE_TEST_MANAGED_CODEX_BOOTSTRAP_ENGINE?{env:{TCODEX_SKIP_UPDATE:'1',TCODEX_DISABLE_TELEMETRY:'1'}}:{}),
   managedInference:{...(liveWorker?{reasoningEfforts:[liveEffort]}:{endpoint:nativeProvider.endpoint}),...(process.env.KODE_TEST_MANAGED_CODEX_BOOTSTRAP_ENGINE?{bootstrap:{
    executable:process.env.KODE_TEST_MANAGED_CODEX_BOOTSTRAP_ENGINE,pathVariable:'TCODEX_CODEX_PATH',...(liveWorker?{provider:process.env.KODE_TEST_WRAPPER_PROVIDER,home:process.env.KODE_TEST_WRAPPER_HOME}:{})}}:{})}}:null
  profiles=await new AgentProfiles(join(runtimeRoot,'profiles.json')).open([...(nativeProfile?[nativeProfile]:[]),{id:'profile',name:'Coordinator',
   ...(nativeCoordinator?{type:'codex',executable:liveCoordinatorScenario?process.env.KODE_TEST_MANAGED_CODEX_WRAPPER:process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE,
    ...(liveCoordinatorScenario?{defaultModel:fixtureModel,defaultReasoningEffort:'low',env:{TCODEX_SKIP_UPDATE:'1',TCODEX_DISABLE_TELEMETRY:'1'}}:{}),
    managedInference:{roles:['coordinator','worker'],...(liveCoordinatorScenario?{reasoningEfforts:['low'],bootstrap:{
     executable:process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE,pathVariable:'TCODEX_CODEX_PATH',
     provider:process.env.KODE_TEST_WRAPPER_PROVIDER,home:process.env.KODE_TEST_WRAPPER_HOME,
    }}:{endpoint:nativeProvider.endpoint})}}:{type:'dsh'})},...(pairedScenario?[{id:'other-profile',name:'Other Coordinator',type:'dsh'}]:[]),...(nativeBuilderSetup?[{id:'builder-profile',name:'Creation assistant',type:'dsh'}]:[])])
  await profiles.bind('probe','profile');const profileHash=profiles.binding('probe').revision
  ctx.provide('workspaceRegistry',{list:()=>[{id:'workspace',path:root},...(pairedScenario?[{id:'other-workspace',path:otherRoot}]:[])]})
  ctx.provide('kodeOfficialToolPolicies',new OfficialToolPolicies())
  const ownerSetup=nativeBuilderSetup||process.env.KODE_TEST_COORDINATOR_OWNER_SETUP==='1'
  const followupScenario=process.env.KODE_TEST_COORDINATOR_REVISED_DELIVERY==='1'
  let followup=null
  const rejectHuman=process.env.KODE_TEST_COORDINATOR_HUMAN_CHOICE==='reject'
  const humanScenario=process.env.KODE_TEST_COORDINATOR_HUMAN_ACCEPTANCE==='1'
  const answerScenario=process.env.KODE_TEST_COORDINATOR_ANSWER==='1'
  const invalidArgumentsScenario=['1','review','read'].includes(process.env.KODE_TEST_INVALID_WORKER_ARGUMENTS)
  const readErrorScenario=process.env.KODE_TEST_INVALID_WORKER_ARGUMENTS==='read'
  const invalidArgumentOutput=['review','read'].includes(process.env.KODE_TEST_INVALID_WORKER_ARGUMENTS)?'reviewed':'artifact'
  const questionScenario=process.env.KODE_TEST_COORDINATOR_QUESTION==='1'||answerScenario
  let questionReceipt,answerNoticePhase=0,answerNoticeId=0,answerStatusId,answerProgressNotices=0
  let liveNoticePhase=0,liveNoticeId=0,liveStatusId
  const interventionScenario=process.env.KODE_TEST_COORDINATOR_INTERVENTION==='1'
  const blockedScenario=process.env.KODE_TEST_COORDINATOR_BLOCKED==='1'||interventionScenario,transferScenario=process.env.KODE_TEST_COORDINATOR_TRANSFER==='1'
  const recheckScenario=process.env.KODE_TEST_EXECUTION_RECHECK==='1';let injectedRecheckFailure=false,recheckRevision
  const waitFor=async predicate=>{const until=Date.now()+(slowScenario?720000:30000);while(!await predicate()){assert.ok(Date.now()<until,`expected runtime evidence before timeout; calls=${calls}; native_calls=${nativeProvider?.calls??0}; errors=${JSON.stringify(errors)}`);await new Promise(r=>setTimeout(r,10))}}
  let builderCalls=0,builderProposal=null,builderWorkflow,builderHandle,builderAccounting
  let calls=0,currentReply,currentStart,currentRunId;const errors=[]
  ctx.on('agent/error',e=>{
   errors.push(e.error.message)
   if((liveWorker||liveCoordinatorScenario)&&e.error.managedInferenceFailure)t.diagnostic(JSON.stringify({managed_inference_failure:e.error.managedInferenceFailure}))
  })
  if(humanScenario&&followupScenario)ctx.on('tools/result',(request,result)=>{
   if(!result.isError)return
   const message=result.error?.message??'',info=result.error?.info??{}
   const reasons=[['Source write conflict:','source_write_conflict'],['Official tool outcome requires reconciliation','official_tool_unresolved'],
    ['expected runtime evidence','fixture_timeout'],['fixture workflow reply lost','fixture_lost_workflow_reply'],
    ['fixture start reply lost','fixture_lost_start_reply'],['task owner resume intent','owner_resume_scope'],
    ['WorkRun revision','run_revision'],['operation','operation_fence'],['kode backend','backend_rejection']]
   const name=value=>['Error','AssertionError','TypeError','AbortError'].includes(value)?value:null
   const code=value=>['ERR_ASSERTION','ABORT_ERR','ENOENT','INVALID_TOOL_ARGUMENTS'].includes(value)?value:null
   t.diagnostic(JSON.stringify({revised_tool_failure:{tool:request.name,phase:followup?.kind??'initial',
    error_name:name(info.name),error_code:code(info.code),cause_name:name(info.cause?.name),cause_code:code(info.cause?.code),
    reason:reasons.find(([prefix])=>message.includes(prefix))?.[1]??'other'}}))
  })
  const workerSteps=new Map(),workerSessions=new Set()
  const assertRecoveredOutputs=async completed=>{
   for(const stage of completed.stages){
    const assignment=await call(`work-assignments/${stage.assignment_id}`)
    const output=Object.keys(stage.evidence.outputs)[0]
    if(omittedPublication!=='all'&&omittedPublication!==output)continue
    const executor=assignment.worker.node_id===hub.node?execution:remoteRuntime.execution
    const reopened=await new AgentProfiles(executor.profiles.path).open()
    const binding=reopened.binding(assignment.worker.session_id)
    assert.equal(binding.assignmentOutputs,undefined)
    assert.equal(Object.values(binding.officialTools).some(row=>row.tool==='kode_publish_output'),false)
    assert.deepEqual(readAssignmentOutputs({profiles:reopened,tools:executor.tools},assignment),stage.evidence.outputs)
   }
   t.diagnostic(JSON.stringify({recovered_output_scope:omittedPublication,remote_workers:remoteAnswer,
    recovery_source:'unique_trusted_tool_candidate',stages:completed.stages.map(stage=>stage.state)}))
  }
  class Fixture extends LlmAdapter{
   async *stream(options){
    if(options.tools.some(t=>t.name===OFFICIAL_BUILDER_TOOLS[4])){
     assert.equal(nativeBuilderSetup,true)
     assert.deepEqual(options.tools.map(t=>t.name).sort(),[...OFFICIAL_BUILDER_TOOLS].sort())
     assert.match(JSON.stringify(options.messages.filter(m=>m.role==='system')),new RegExp(BUILDER_PROMPT_VERSION))
     const step=builderCalls++
     assert.ok(step<4)
     if(step%2===0){
      yield {type:'block-start',index:0,blockType:'tool-call'}
      yield {type:'block-end',index:0,block:{type:'tool-call',id:`builder-${step}`,name:OFFICIAL_BUILDER_TOOLS[4],arguments:JSON.stringify({expected_revision:step===0?2:3,request_id:step===0?'workflow-proposal':'team-proposal',questions:[],proposed_team:builderProposal,proposed_workflow:builderWorkflow})}}
     }else{
      yield {type:'block-start',index:0,blockType:'text'}
      yield {type:'block-end',index:0,block:{type:'text',text:'Configuration proposal saved for owner confirmation.'}}
     }
     yield {type:'usage',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}
     yield {type:'finish',reason:{kind:step%2===0?'tool-calls':'stop'}}
     return
    }

    if(!options.tools.some(t=>t.name==='kode_coordinator_configuration')){
     assert.ok(JSON.stringify(options.messages.filter(m=>m.role==='system')).includes(ASSIGNMENT_PROMPT_VERSION),'Worker procedure must reach its scoped model context')
     assert.ok(!options.tools.some(t=>t.name.startsWith('kode_sessions_')),'Worker cannot inherit general messaging tools')
     assert.ok(!JSON.stringify(options.messages.filter(m=>m.role==='system')).includes(COORDINATOR_PROMPT_VERSION),'Coordinator procedure cannot leak to Workers')
     workerSessions.add(options.sessionId)
     const rawStep=workerSteps.get(options.sessionId)??0;workerSteps.set(options.sessionId,rawStep+1)
     let step=rawStep
     const names=options.tools.map(t=>t.name)
     const output=names.includes('kode_write_source')?'artifact':names.includes('kode_review_output')?'reviewed':'checked'
     if(invalidArgumentsScenario&&output===invalidArgumentOutput){
      if(rawStep===0){
       yield {type:'block-start',index:0,blockType:'tool-call'}
       const name=readErrorScenario?'kode_read_source':output==='reviewed'?'kode_review_output':'kode_capture_output'
       const args=readErrorScenario?{path:'missing-source.txt'}:output==='reviewed'?{output:'reviewed',request_id:'invalid-shape',verdict:'passed',findings:[{id:'finding',blocking:false}]}:{output:'a narrative instead of an output ID',request_id:'invalid-shape'}
       yield {type:'block-end',index:0,block:{type:'tool-call',id:'invalid-worker-arguments',name,arguments:JSON.stringify(args)}}
       yield {type:'usage',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}
       yield {type:'finish',reason:{kind:'tool-calls'}}
       return
      }
      const rejected=options.messages.find(message=>message.role==='tool'&&message.source?.callId==='invalid-worker-arguments')
      assert.equal(rejected?.isError,true)
      assert.match(JSON.stringify(rejected.content),readErrorScenario?/ENOENT/:/Arguments do not match/)
      step=rawStep-1
     }
     if(questionScenario&&output==='artifact'){
      if(rawStep===0){
       const workerExecution=remoteRuntime?.execution??execution
       const agent=(remoteRuntime?.host??host).handles.get(options.sessionId).agent
       const call=await workerExecution.assertModelRequest(agent)
       questionReceipt=await workerExecution.clarifications.record(agent,call,[{id:'wording',question:'Which output wording should I use?'}])
       yield {type:'usage',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}
       yield {type:'finish',reason:{kind:'stop'}}
       return
      }
      assert.equal(answerScenario,true,'a pending question cannot restart model inference')
      step=rawStep-1
      const answer=options.messages.find(message=>message.role==='user'&&JSON.stringify(message.content).includes('kode.assignment.clarification-answer.v1'))
      assert.ok(answer,'resumed Worker answer missing '+JSON.stringify(options.messages.filter(message=>message.role==='user').map(message=>({id:message.id,source:message.source,text:JSON.stringify(message.content).slice(0,400)}))))
      assert.match(JSON.stringify(answer),/Use implemented/)
      if(rawStep===1){
       const workerExecution=remoteRuntime?.execution??execution
       const agent=(remoteRuntime?.host??host).handles.get(options.sessionId).agent
       const current=await workerExecution.assertModelRequest(agent)
       const modelCall=await call(`official-calls/${current.call_id}`)
       const assignment=await call(`work-assignments/${questionReceipt.assignment_id}`)
       assert.deepEqual(modelCall.request.prompt_provenance.instruction.answers,assignment.clarification_answers.map(({question_request_id,message_id,content_hash})=>({question_request_id,message_id,content_hash})))
       assert.equal(assignment.clarification_progress.ready_to_report,false,'a started answer-bearing model call cannot finalize prior outputs')
       const operation=await call(`operations/${current.operation.id}`)
       const report={expected_revision:operation.revision,attempt:operation.attempt,epoch:operation.epoch,action:{kind:'report',report_id:'premature-answer-report',content:'Outputs were ready before the answer.'}}
       const rejected=remoteAnswer?await remoteHub.client.call(`/api/v1/messaging/operation-relay/${hub.node}`,{operation_id:operation.id,worker_session:options.sessionId,command:report}):await call(`operations/${operation.id}`,report)
       assert.equal(rejected.applied,false);assert.equal(rejected.operation.state,'active')
       const original=await call(`official-calls/${questionReceipt.request.call_id}`)
       const begin=request=>remoteAnswer?workerExecution.outbox.transport({home_node:hub.node,request},{kind:'official_begin',request}):call('official-calls',request)
       await assert.rejects(begin({...modelCall.request,call_id:'answer-missing-proof',prompt_provenance:null}),/answer prompt provenance/)
       await assert.rejects(begin({...modelCall.request,call_id:'answer-stale-proof',prompt_provenance:original.request.prompt_provenance}),/answer prompt provenance/)
      }
     }
     if(answerScenario&&output!=='artifact'){
      const mandateInput=options.messages.find(message=>message.role==='user'&&JSON.stringify(message.content).includes('kode.assignment.mandate.v1'))
      assert.ok(mandateInput,'downstream mandate missing')
      const text=mandateInput.content.filter(block=>block.type==='text').map(block=>block.text).join('')
      const mandate=JSON.parse(text.slice(text.indexOf('{')))
      const source=Object.values(mandate.input_manifest.binding.sources).find(source=>source.clarifications?.length)
      assert.ok(source,'downstream stage must receive frozen clarification context')
      assert.equal(source.clarifications.length,1)
      const clarification=source.clarifications[0]
      assert.equal(clarification.response.answer.content,'Use implemented.')
      assert.equal(clarification.response.question_request_id,questionReceipt.request.request_id)
      assert.deepEqual(clarification.response.questions,questionReceipt.request.questions)
      assert.equal(clarification.receipt.content_hash,createHash('sha256').update(JSON.stringify(clarification.response)).digest('hex'))
      assert.deepEqual(clarification.question,questionReceipt)
      assert.equal(mandate.input_manifest.hash,createHash('sha256').update(JSON.stringify(mandate.input_manifest.binding)).digest('hex'))
     }
     if(dependencyScenario){
      const text=JSON.stringify(options.messages)
      assert.equal(text.includes(dependencyMarker),output==='artifact','only the assigned stage receives its domain instructions')
      if(output==='artifact')assert.match(text,/Apply the frozen dependencies/)
     }
     const result=id=>{const message=options.messages.find(m=>m.role==='tool'&&m.source?.callId===id);assert.ok(message);return JSON.parse(message.content.filter(b=>b.type==='text').map(b=>b.text).join(''))}
     let tool,args
     if(process.env.KODE_TEST_FULL_DESKTOP==='1'&&output==='artifact'&&step===0)await imBrowser.switchDuring(currentRunId)
     if(output==='artifact'&&step===0){tool='kode_write_source';args={path:'implemented.txt',expected_sha256:null,content:followupScenario&&followup?'implemented revised':'implemented'}
      if(humanScenario&&followupScenario){
       const binding=profiles.binding(options.sessionId),assignment=await call(`work-assignments/${binding.managedAssignment.id}`),receipt=assignment.execution_workspace?.receipt
       const current=await readFile(join(receipt.root,'implemented.txt')).catch(error=>{if(error.code==='ENOENT')return null;throw error})
       assert.equal(current,null,'each new Run starts from its own pinned Git base, not an unintegrated prior output')
       t.diagnostic(JSON.stringify({revised_write_precondition:{phase:followup?.kind??'initial',run_id:assignment.run_id,assignment_id:assignment.id,
        state:assignment.state,admission_state:assignment.admission?.state??null,resources_state:assignment.resources?.state??null,
        task_key:receipt.key,starting_basis:receipt.starting_snapshot?.basis??null,expected_sha256:args.expected_sha256,
        observed_sha256:current===null?null:createHash('sha256').update(current).digest('hex'),
        binding_matches:binding.managedOperation.id===receipt.operation_id}}))
      }
     }
     else if(output==='reviewed'&&step===0){tool='kode_read_source';args={path:'implemented.txt'}}
     else if(output==='checked'&&step===0){tool='kode_verify_output';args={output,request_id:'verify'}}
     else if(output==='artifact'&&step===1){tool='kode_capture_output';args={output,request_id:'capture'}}
     else if(output==='reviewed'&&step===1){assert.equal(result('worker-0').text,followupScenario&&followup?'implemented revised':'implemented');tool='kode_review_output';args={output,request_id:'review',verdict:'passed',findings:[]}}
     else if(step===(output==='checked'?1:2)){const evidence=result(`worker-${step-1}`);assert.ok(evidence.evidence_id);tool='kode_publish_output';args={output,evidence_id:evidence.evidence_id}}
     const omit=tool==='kode_publish_output'&&(omittedPublication==='all'||omittedPublication===output)
     if(omit)tool=undefined
     if(tool){yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id:`worker-${step}`,name:tool,arguments:JSON.stringify(args)}}}
     else {yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:omit?'Evidence prepared; ending without publishing.':'Stage evidence published'}}}
     yield {type:'usage',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}
     yield {type:'finish',reason:{kind:tool?'tool-calls':'stop'}}
     return
    }

    assert.ok(!JSON.stringify(options.messages.filter(m=>m.role==='system')).includes(ASSIGNMENT_PROMPT_VERSION),'Worker procedure cannot leak to the Coordinator')
    if(followup){
     calls++
     const step=followup.step++,prefix=`followup-${followup.kind}`
     const result=n=>{const m=options.messages.find(m=>m.role==='tool'&&m.source?.callId===`${prefix}-${n}`);assert.ok(m);return JSON.parse(m.content.filter(b=>b.type==='text').map(b=>b.text).join(''))}
     let name,args
     if(followup.kind==='start'){
      if(step===0){name='kode_coordinator_workflow_status';args={run_id:followup.prior.id}}
      else if(step===1){const old=result(0);assert.equal(old.state,'cancelled');assert.equal(old.inputs.request,'Implement the requirement');assert.equal(old.human_acceptance.decision.reason,'Please correct the output wording');name='kode_coordinator_configuration';args={binding_id:'local'}}
      else if(step===2){assert.equal(result(1).binding.id,'local');name='kode_coordinator_workflow_start';args=currentStart}
      else if(step===3){assert.equal(result(2).prior_run_id,followup.prior.id);name='kode_coordinator_workflow_status';args={run_id:currentRunId}}
      else if(step===4){assert.equal(result(3).completion_authorized,false);name='kode_coordinator_publish_reply';args={request_id:'revised-started',source_message_id:currentReply.source_message_id,content:'Linked modification accepted; execution is pending.'}}
      else assert.equal(step,5)
     }else{
      if(step===0){name='kode_coordinator_workflow_status';args={run_id:currentRunId}}
      else if(step===1){
       const status=result(0)
       assert.equal(status.state,followup.kind==='cancel'?'cancelled':followup.kind==='pending'?'waiting_user':'completed')
       assert.equal(status.completion_authorized,followup.kind==='complete')
       if(followup.kind==='pending')assert.equal(status.human_acceptance.state,'pending')
       if(followup.kind==='complete')assert.equal(status.human_acceptance.decision.reason,'Revised output inspected')
       name='kode_coordinator_publish_reply';args={request_id:`revised-${followup.kind}`,source_message_id:currentReply.source_message_id,content:`Observed revised task status: ${status.state}`}
      }else assert.equal(step,2)
     }
     if(name){yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id:`${prefix}-${step}`,name,arguments:JSON.stringify(args)}}}
     else{yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:'Observed status published.'}}}
     yield {type:'usage',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}
     yield {type:'finish',reason:{kind:name?'tool-calls':'stop'}}
     return
    }
    assert.match(JSON.stringify(options.messages.filter(m=>m.role==='system')),new RegExp(COORDINATOR_PROMPT_VERSION))
    if(options.sessionId==='coordinator-successor'){
     assert.match(JSON.stringify(options.messages),/Hub workflow event/)
     assert.doesNotMatch(JSON.stringify(options.messages.filter(m=>m.role==='user')),/Implement the requirement/)
    }else assert.match(JSON.stringify(options.messages),/Implement the requirement/)

    assert.deepEqual(options.tools.map(t=>t.name).sort(),['kode_coordinator_publish_reply','kode_coordinator_workflow_start','kode_coordinator_configuration','kode_coordinator_workflow_status',...(answerScenario?['kode_coordinator_answer_clarification']:[])].sort())
    assert.match(JSON.stringify(options.messages),new RegExp(currentReply.source_message_id))
    calls++
    if(liveWorker&&calls>6){
     let tool,args,text
     if(liveNoticePhase===0){
      liveStatusId=`live-status-${liveNoticeId++}`;liveNoticePhase=1
      tool='kode_coordinator_workflow_status';args={run_id:currentRunId}
     }else if(liveNoticePhase===1){
      const result=options.messages.find(message=>message.source?.callId===liveStatusId)
      const status=JSON.parse(result.content.filter(block=>block.type==='text').map(block=>block.text).join(''))
      if(status.state==='completed'){
       assert.equal(status.completion_authorized,true);liveNoticePhase=2
       tool='kode_coordinator_publish_reply';args={request_id:'final-result',source_message_id:currentReply.source_message_id,content:'Implementation, independent review and verification completed.'}
      }else{assert.equal(status.completion_authorized,false);liveNoticePhase=0;text='Execution is continuing.'}
     }else{liveNoticePhase=0;text='Observed result published.'}
     yield {type:'block-start',index:0,blockType:tool?'tool-call':'text'}
     yield {type:'block-end',index:0,block:tool?{type:'tool-call',id:liveStatusId+(liveNoticePhase===2?'-publish':''),name:tool,arguments:JSON.stringify(args)}:{type:'text',text}}
     yield {type:'usage',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}
     yield {type:'finish',reason:{kind:tool?'tool-calls':'stop'}}
     return
    }
    if(answerScenario&&calls>=10){
     if(calls===10){
      const human=options.messages.filter(message=>message.role==='user').at(-1)
      const reference=JSON.stringify(human).match(/Hub request reference: ([A-Za-z0-9_.-]+)/)?.[1]
      assert.ok(reference,'answer tool must use the real consumed human input')
      yield {type:'block-start',index:0,blockType:'tool-call'}
      yield {type:'block-end',index:0,block:{type:'tool-call',id:'answer-human',name:'kode_coordinator_answer_clarification',arguments:JSON.stringify({request_id:'forward-answer',assignment_id:questionReceipt.assignment_id,question_request_id:questionReceipt.request.request_id,source_message_id:reference})}}
     }else if(calls===11){
      yield {type:'block-start',index:0,blockType:'text'}
      yield {type:'block-end',index:0,block:{type:'text',text:'Human answer forwarded.'}}
     }else if(answerNoticePhase===0){
      answerStatusId=`after-answer-status-${answerNoticeId++}`;answerNoticePhase=1
      yield {type:'block-start',index:0,blockType:'tool-call'}
      yield {type:'block-end',index:0,block:{type:'tool-call',id:answerStatusId,name:'kode_coordinator_workflow_status',arguments:JSON.stringify({run_id:currentRunId})}}
     }else if(answerNoticePhase===1){
      const result=options.messages.find(message=>message.source?.callId===answerStatusId)
      const status=JSON.parse(result.content.filter(block=>block.type==='text').map(block=>block.text).join(''))
      if(status.state==='completed'){
       assert.equal(status.completion_authorized,true);answerNoticePhase=2
       yield {type:'block-start',index:0,blockType:'tool-call'}
       yield {type:'block-end',index:0,block:{type:'tool-call',id:'after-answer-publish',name:'kode_coordinator_publish_reply',arguments:JSON.stringify({request_id:'after-answer-result',source_message_id:currentReply.source_message_id,content:'Implementation, independent review and verification completed after your clarification.'})}}
      }else{
       assert.equal(status.completion_authorized,false);answerProgressNotices++;answerNoticePhase=0
       yield {type:'block-start',index:0,blockType:'text'}
       yield {type:'block-end',index:0,block:{type:'text',text:'The answer is recorded and execution is continuing.'}}
      }
     }else{
      assert.equal(answerNoticePhase,2);answerNoticePhase=0
      yield {type:'block-start',index:0,blockType:'text'}
      yield {type:'block-end',index:0,block:{type:'text',text:'Recorded workflow response.'}}
     }
     yield {type:'usage',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}
     yield {type:'finish',reason:{kind:calls===10||answerNoticePhase>0?'tool-calls':'stop'}}
     return
    }
    if(calls>6){
     assert.match(JSON.stringify(options.messages),/Hub workflow event/)
     const blockedTurn=(blockedScenario||humanScenario||questionScenario)&&calls<=9,offset=(blockedScenario||humanScenario||questionScenario)&&!blockedTurn?3:0,step=calls-offset
     const rejectedTurn=humanScenario&&rejectHuman&&!blockedTurn
     const prefix=blockedTurn?'blocked':rejectedTurn?'rejected':'completion'
     if(step===7){
      yield {type:'block-start',index:0,blockType:'tool-call'}
      yield {type:'block-end',index:0,block:{type:'tool-call',id:`${prefix}-status`,name:'kode_coordinator_workflow_status',arguments:JSON.stringify({run_id:currentRunId})}}
     }else if(step===8){
      const statusMessage=options.messages.find(m=>m.role==='tool'&&m.source?.callId===`${prefix}-status`)
      const status=JSON.parse(statusMessage.content.filter(b=>b.type==='text').map(b=>b.text).join(''))
      if(blockedTurn){
       assert.notEqual(status.completion_authorized,true)
       if(questionScenario){assert.equal(status.waiting_reason,'worker_clarification_required');assert.equal(status.worker_clarification.questions[0].question,'Which output wording should I use?');assert.equal(status.worker_clarifications.count,1)}
       else if(humanScenario){assert.equal(status.state,'waiting_user');assert.equal(status.waiting_reason,'human_delivery_acceptance_required');assert.equal(status.human_acceptance.state,'pending');assert.equal(status.human_acceptance.decision,null);assert.equal(status.human_acceptance.evidence_included,false);assert.deepEqual(status.stages.map(s=>s.state),['passed','passed','passed'])}
       else if(interventionScenario){assert.equal(status.state,'paused');assert.equal(status.intervention.stop_confirmed,true);assert.equal(status.intervention.accounting,'finalized')}
       else{assert.equal(status.state,'waiting_resource');assert.equal(status.waiting_reason,'execution_adapters_not_ready')}
      }
      else if(rejectedTurn){assert.equal(status.state,'waiting_user');assert.equal(status.waiting_reason,'human_delivery_rejected');assert.equal(status.completion_authorized,false);assert.equal(status.human_acceptance.state,'rejected');assert.equal(status.human_acceptance.decision.reason,'Please correct the output wording');assert.equal(status.human_acceptance.decision.actor.kind,'human')}
      else{assert.equal(status.state,'completed');assert.equal(status.completion_authorized,true);assert.deepEqual(status.stages.map(s=>s.state),['passed','passed','passed'])}
      yield {type:'block-start',index:0,blockType:'tool-call'}
      yield {type:'block-end',index:0,block:{type:'tool-call',id:`${prefix}-publish`,name:'kode_coordinator_publish_reply',arguments:JSON.stringify({request_id:blockedTurn?'waiting-result':rejectedTurn?'rejected-result':'final-result',source_message_id:currentReply.source_message_id,content:blockedTurn?(questionScenario?'Which output wording should I use?':humanScenario?'Implementation, independent review and verification passed. Please inspect the evidence and record your acceptance decision in work-process details; delivery is not yet confirmed.':interventionScenario?'The task is paused for your workspace intervention. Resume it from work-process details after your changes. Delivery is pending.':'Waiting for execution resources; work is not complete.'):rejectedTurn?'Your acceptance decision requests: Please correct the output wording. Delivery remains unaccepted; no new attempt has started.':'Implementation, independent review and verification completed.'})}}
     }else{assert.equal(step,9);yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:'Observed result published.'}}}
     yield {type:'usage',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}
     yield {type:'finish',reason:{kind:step<9?'tool-calls':'stop'}}
     return
    }
    if(calls%6===1||calls%6===2){
     yield {type:'block-start',index:0,blockType:'tool-call'}
     yield {type:'block-end',index:0,block:{type:'tool-call',id:`config-${calls}`,name:'kode_coordinator_configuration',arguments:JSON.stringify({binding_id:calls%6===1?'':'local'})}}
    }else if(calls%6===3){
     assert.match(JSON.stringify(options.messages),/completion_stages/)

     yield {type:'block-start',index:0,blockType:'tool-call'}
     yield {type:'block-end',index:0,block:{type:'tool-call',id:`start-${calls}`,name:'kode_coordinator_workflow_start',arguments:JSON.stringify(currentStart)}}
    }else if(calls%6===4){
     yield {type:'block-start',index:0,blockType:'tool-call'}
     yield {type:'block-end',index:0,block:{type:'tool-call',id:`status-${calls}`,name:'kode_coordinator_workflow_status',arguments:JSON.stringify({run_id:currentRunId})}}
    }else if(calls%6===5){
     assert.match(JSON.stringify(options.messages),/waiting_resource/)

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
  const fixtureAdapter=new Fixture()
  ctx.llm.registerAdapter(['fixture'],fixtureAdapter)
  if(nativeCoordinator&&!liveCoordinatorScenario)nativeDecide=async({messages,tools,model,instructions})=>{
   const actors=[...execution.managedCodex.active.entries()].filter(([,actor])=>actor.input===JSON.stringify(messages))
   assert.equal(actors.length,1,'native inference must match its original workflow context')
   const sessionId=actors[0][0]
   const input={sessionId,model,tools,messages:[{role:'system',content:[{type:'text',text:instructions}]},...messages]}
   const blocks=[]
   for await(const event of fixtureAdapter.stream(input))if(event.type==='block-end')blocks.push(event.block)
   assert.equal(blocks.length,1)
   const block=blocks[0]
   return block.type==='tool-call'?{call:block}:{text:block.text}
  }
  if(nativeAnswer){
   nativeDecide=async options=>{
    const sessions=[...execution.managedCodex.active.keys()]
    assert.equal(sessions.length,1)
    const sessionId=sessions[0]
    if(!workerSteps.has(sessionId)){
     workerSessions.add(sessionId);workerSteps.set(sessionId,1)
     return {question:[{id:'wording',header:'Wording',question:'Which output wording should I use?',options:[{label:'Current',description:'Use implemented.'},{label:'Other',description:'Owner clarifies'}]}]}
    }
    const chunks=[]
    const messages=[{role:'system',content:[{type:'text',text:options.instructions}]},...options.messages]
    for await(const chunk of fixtureAdapter.stream({...options,messages,sessionId,signal:new AbortController().signal}))chunks.push(chunk)
    const call=chunks.find(chunk=>chunk.type==='block-end'&&chunk.block.type==='tool-call')?.block
    return call?{call}:{text:chunks.filter(chunk=>chunk.type==='block-end'&&chunk.block.type==='text').map(chunk=>chunk.block.text).join('')}
   }
  }
  let lostAnswer=false,answerWrites=0
  let lostPublication=false,publicationWrites=0,lostWorkflow=false,workflowWrites=0,lostStart=false,transferWrites=0,lostTransfer=false,lostRecovery=false
  const transport={call:async(path,body,...rest)=>{
   if(dependencyScenario&&!dependencyNegativesChecked&&path.endsWith('/official-calls')&&body?.prompt_provenance?.instruction?.dependencies?.length){
    dependencyNegativesChecked=true
    const missing={...structuredClone(body),call_id:'dependency-missing-proof'};delete missing.prompt_provenance
    await assert.rejects(hub.client.call(path,missing),/dependency prompt provenance required/)
    const changed={...structuredClone(body),call_id:'dependency-wrong-proof'};changed.prompt_provenance.instruction.dependencies[0].content_hash='0'.repeat(64)
    await assert.rejects(hub.client.call(path,changed),/dependency prompt provenance required/)
    for(const id of [missing.call_id,changed.call_id])await assert.rejects(call(`official-calls/${id}`),/404/)
   }
   const result=await hub.client.call(path,body,...rest)
   if(body&&path.endsWith('/clarification-answers')){answerWrites++;if(!lostAnswer){lostAnswer=true;throw Error('fixture lost committed answer response')}}
   if(body&&path.endsWith('/coordinator-transfer')){transferWrites++;if(!lostTransfer){lostTransfer=true;throw Error('fixture committed transfer reply lost')}}
   if(body&&path.endsWith('/coordinator-starts')&&body.request_id.startsWith('recover-')&&!lostRecovery){lostRecovery=true;throw Error('fixture recovery commit reply lost')}
   if(body&&path.endsWith('/coordinator-starts')&&!lostStart){lostStart=true;throw Error('fixture start reply lost')}
   if(body&&path.endsWith('/coordinator-replies')){publicationWrites++;if(!lostPublication){lostPublication=true;throw Error('fixture publication reply lost')}}
   if(body&&path.endsWith('/work-runs')){currentRunId=result.id;workflowWrites++;if(!lostWorkflow){lostWorkflow=true;throw Error('fixture workflow reply lost')}}
   return result
  }}
  execution=new OfficialExecution(ctx,profiles,transport,{host:hub.node});host=new OfficialLoopHost(ctx,execution)
  ctx.provide('kodeAgents',{profiles,officialExecution:execution,officialLoops:host})
  if(remoteAnswer)remoteRuntime=await remoteWorkflowRuntime({hub:remoteHub,root:remoteRoot,adapter:fixtureAdapter,errors})
  if(ownerSetup)ownerHttp=await teamOwnerHttp(ctx,hub.client)
  await applyHost(ctx,{url:hub.url,tokenFile:join(hub.root,'admin.token'),stateFile:join(hub.root,'host-state.json'),agentRuntime:false,runtimeBridge:false,pollMs:10})
  const workspace={host_id:hub.node,workspace_id:'workspace',root_ref:root},target={host:hub.node,workspace:'workspace',root}
  const remoteWorkspace=remoteAnswer?{host_id:remoteHub.node,workspace_id:'remote-workspace',root_ref:remoteRoot}:null
  const version=r=>({id:r.id,version:r.version,hash:r.hash}),policy=r=>({id:r.id,revision:r.revision,hash:r.hash})
  const executable=await realpath(process.execPath)
  const verificationDefinition={runner_id:'check',command_id:'verify-file',revision:'1',executable,executable_hash:await verificationExecutableHash(executable),args:['-e',"if(require('node:fs').readFileSync('implemented.txt','utf8')!=='implemented')process.exit(3);process.stdout.write('verified')"],env:{},timeout_ms:5000,max_output_bytes:65536,scenario_ids:['smoke'],capabilities:['read'],network:false,tool_id:'kode_verify_output'}
  if(followupScenario)verificationDefinition.args[1]="if(!/^implemented( revised)?$/.test(require('node:fs').readFileSync('implemented.txt','utf8')))process.exit(3);process.stdout.write('verified')"
  const verification=ownerSetup?(await ownerHttp.post('verification/definitions',{definition:verificationDefinition})).reference:execution.verificationRunners.register(verificationDefinition)
  if(remoteAnswer)remoteRuntime.execution.verificationRunners.register(verificationDefinition)
  const stage=(id,requires,produces,independent_from,tools,capabilities=['read'])=>({id,role:'coordinator',requires,produces,independent_from,execution:{task_tag:'inspection',repository_binding:'code',capabilities,tools,network:false}})
  const flowInput={id:'flow',version:'1',inputs:['request'],stages:[
   stage('implement',['request'],['artifact'],[],['kode_write_source','kode_capture_output','kode_publish_output'],['read','workspace_write']),
   stage('review',['implement'],['reviewed'],['implement'],['kode_read_source','kode_review_output','kode_publish_output']),
   stage('verify',['review'],['checked'],['implement','review'],['kode_verify_output','kode_publish_output'])],completion_stages:['verify'],evidence_rules:{artifact:{kind:'artifact',repository_binding:'code'},reviewed:{kind:'review',artifact_output:'artifact'},checked:{kind:'verification',artifact_output:'artifact',command_binding:'check',environment_binding:'local',required_scenarios:['smoke']}}}
  if(nativeWorker)flowInput.stages[0].role='implementer'
  if(allLiveWorkers){flowInput.stages[1].role='reviewer';flowInput.stages[2].role='verifier'}
  if(remoteAnswer)for(const stage of flowInput.stages)stage.role='remote-worker'
  const projectInput={id:'project',version:'1',spec:{kind:'project_bindings',repositories:{code:{repository_id:'repo',workspace}},environments:{local:{host_id:hub.node,adapter_id:'local_process_v1',configuration_hash:verification.environment_hash}},commands:{check:{id:verification.id,revision:verification.revision,definition_hash:verification.definition_hash,repository_binding:'code',environment_binding:'local',runner_id:verification.runner_id,scenario_ids:verification.scenario_ids}},connections:{}}}
  if(remoteAnswer){projectInput.spec.repositories.code.workspace=remoteWorkspace;projectInput.spec.environments.local.host_id=remoteHub.node}
  if(dependencyScenario){
   dependencyArtifact=await call('project-configs',{id:'implementation-method',version:'1',spec:{kind:'workflow_dependency',artifact:{kind:'skill',source:'fixture://reviewed-workflow/implementation',source_version:'1',content_hash:createHash('sha256').update(dependencyMarker).digest('hex'),instructions:dependencyMarker,hosts:[hub.node],tools:['kode_write_source'],capabilities:['workspace_write'],network:false}}})
   flowInput.stages[0].execution.dependencies=[version(dependencyArtifact)]
  }
  let flow,project,delivery
  const deliveryInput={id:'delivery',version:'1',targets:[{kind:'local',repository_binding:'code'}],required_outputs:['checked']}
  if(ownerSetup){
   const interview={purpose:'Configure delivery',workspace_refs:[workspace],answers:{},questions:[],proposed_workflow:{workflow:flowInput,project:projectInput,delivery:deliveryInput}}
   builderWorkflow=interview.proposed_workflow
   if(nativeBuilderSetup)delete interview.proposed_workflow
   await call('superagents/drafts',{id:'owner-draft',request_id:'draft',expected_revision:0,revoked:false,interview})
   let workflowRevision=1
   if(nativeBuilderSetup){
    builderHandle=await pipelineBuilder({hub,profiles,ownerHttp,host,workspace,at})
    const draft=await builderHandle.input('workflow','Create a development team for this project and propose its workflow.')
    assert.equal(draft.actor.kind,'builder');assert.equal(draft.actor.operation_id,builderHandle.operation.id)
    assert.deepEqual(draft.interview.proposed_workflow,builderWorkflow);assert.equal(builderCalls,2)
    workflowRevision=draft.revision
   }
   const registered=await ownerHttp.post('builder/configure-workflow',{draft_id:'owner-draft',expected_revision:workflowRevision,request_id:'workflow'})
   assert.equal(registered.activation_performed,false)
   flow=registered.workflow;project=registered.project;delivery=registered.delivery_policy
  }else{
   flow=await call('workflows',flowInput);project=await call('project-configs',projectInput)
   delivery=await call('project-configs',{id:deliveryInput.id,version:deliveryInput.version,spec:{kind:'delivery_policy',project:version(project),workflow:version(flow),targets:deliveryInput.targets,required_outputs:deliveryInput.required_outputs,...(humanScenario?{human_acceptance:true}:{})}})
  }
  const capabilityCommand={id:'capability',expected_revision:0,host:hub.node,profile:'profile',model:fixtureModel,assessments:{fit:{evaluation:{kind:'task_fit',tag:'inspection',score:80},source:'user',confidence:0.9,evidence:[],pinned:false,updated_at:at-1000,valid_until:at+FIXTURE_VALIDITY_MS}}}
  const budgetCommand={id:'budget',scope:'team',scope_id:'team',unit:'credits',limit:followupScenario?200:transferScenario?150:100,starts_at:at-1000,ends_at:at+FIXTURE_VALIDITY_MS,expected_revision:0}
  const budgetPolicyCommand={id:'budget-policy',team_id:'team',expected_revision:0,policy:{kind:'budget',budget_ids:['budget'],unit:'credits',max_assignment_charge:followupScenario?80:40,settlement:'internal_price'}}
  const resource={host:hub.node,profile:'profile',account_id:'account',account_epoch:1,binding_revision:1,limit_ids:['daily'],unknown_quota:'team_budget'}
  const tokenPrice=liveCoordinatorScenario?1:1000000
  const priceCommand={id:'price',model:fixtureModel,model_policy:'requested_model',unit:'credits',input_per_million:tokenPrice,cached_per_million:tokenPrice,output_per_million:tokenPrice}
  const scheduleCommand={id:'schedule',team_id:'team',expected_revision:0,policy:{kind:'scheduling',targets:{control:{resource,capability_id:'capability',capability_revision:1,preferred:false,internal_price_id:'price'}},weights:{quality:1,cost:0,latency:0},minimum_quality:0,minimum_confidence:0}}
  let nativeProfileHash
  if(nativeWorker){
   await profiles.bind('native-probe','native-worker');nativeProfileHash=profiles.binding('native-probe').revision
   scheduleCommand.policy.targets.native={resource:{...resource,profile:'native-worker'},capability_id:'native-capability',capability_revision:1,preferred:false,internal_price_id:liveWorker?'native-price':'price'}
  }
  if(remoteAnswer)scheduleCommand.policy.targets.remote={resource:{...resource,host:remoteHub.node},capability_id:'remote-capability',capability_revision:1,preferred:false,internal_price_id:'price'}
  let budget,schedule
  if(!ownerSetup){
   await call('resource-accounts',{id:'account',expected_epoch:0,enabled:true})
   await call('assignment-capacities',{account_id:'account',expected_revision:0,max_active_assignments:1})
   await call('resource-bindings',{host:hub.node,profile:'profile',account_id:'account',account_epoch:1,expected_revision:0})
   await call('capability-profiles',capabilityCommand)
   if(remoteAnswer){await call('resource-bindings',{host:remoteHub.node,profile:'profile',account_id:'account',account_epoch:1,expected_revision:0});await call('capability-profiles',{...capabilityCommand,id:'remote-capability',host:remoteHub.node})}
   if(nativeWorker){await call('resource-bindings',{host:hub.node,profile:'native-worker',account_id:'account',account_epoch:1,expected_revision:0});await call('capability-profiles',{...capabilityCommand,id:'native-capability',profile:'native-worker'})}
   await call('budgets',budgetCommand)
   budget=await call('team-policies',budgetPolicyCommand)
   await call('price-versions',priceCommand)
   if(liveWorker)await call('price-versions',{...priceCommand,id:'native-price',input_per_million:1,cached_per_million:1,output_per_million:1})
   schedule=await call('team-policies',scheduleCommand)
  }
  const spec={coordinator_startup:{workspace_id:'workspace',task_tag:'inspection'},name:'Team',purpose:'Work',kind:'coordinator',workspace_refs:[workspace],execution_targets:[{id:'control',host_id:hub.node,executor_profile_id:'profile',executor_profile_revision:profileHash,provider_id:nativeCoordinator?managedCodexRoute('profile'):'fixture',model_id:fixtureModel,effort:liveCoordinatorScenario?'low':null,account_binding_id:'account',capability_profile_revision:'1'}],workers:[],coordinator_targets:['control'],workflow_pack_refs:[version(flow)],delivery_bindings:[{id:'local',workflow:version(flow),project:version(project),delivery_policy:version(delivery)}],grant_id:'grant',budget_policy_id:'budget-policy',scheduling_policy_id:'schedule',limits:{max_active_assignments:1,max_active_runs:2},proactive_mode:'off'}
  if(nativeWorker){
   spec.execution_targets.push({...spec.execution_targets[0],id:'native',executor_profile_id:'native-worker',executor_profile_revision:nativeProfileHash,provider_id:managedCodexRoute('native-worker'),...(liveWorker?{effort:liveEffort}:{})})
   spec.workers.push({id:'implementation-worker',role:'implementer',responsibilities:['Implement the assigned requirement'],allowed_target_ids:['native'],required_capabilities:[],workspace_refs:[workspace],max_parallel:1})
   if(allLiveWorkers)for(const [role,responsibility]of [['reviewer','Independently review the frozen source artifact'],['verifier','Execute the configured verification and publish its evidence']])spec.workers.push({id:`${role}-worker`,role,responsibilities:[responsibility],allowed_target_ids:['native'],required_capabilities:[],workspace_refs:[workspace],max_parallel:1})
  }
  if(remoteAnswer){
   spec.workspace_refs.push(remoteWorkspace)
   spec.execution_targets.push({...spec.execution_targets[0],id:'remote',host_id:remoteHub.node})
   spec.workers.push({id:'remote-worker',role:'remote-worker',responsibilities:['Execute the assigned workflow stage'],allowed_target_ids:['remote'],required_capabilities:[],workspace_refs:[remoteWorkspace],max_parallel:1})
  }
  let team
  if(ownerSetup){
   let draft=await call('superagents/drafts/owner-draft')
   if(nativeBuilderSetup){
    builderProposal=spec
    draft=await builderHandle.input('team','Use the confirmed workflow versions to propose the team configuration.')
    assert.equal(draft.actor.kind,'builder');assert.deepEqual(draft.interview.proposed_team,spec);assert.equal(builderCalls,4)
    assert.equal((await call('budgets/creation-budget')).budget.spent,8,'creation assistant usage remains separate from team delivery budget')
   }else draft=await call('superagents/drafts',{id:draft.id,request_id:'propose-team',expected_revision:draft.revision,revoked:false,interview:{...draft.interview,proposed_team:spec}})
   const accepted=await ownerHttp.post('builder/accept-proposal',{draft_id:draft.id,request_id:'accept',expected_revision:draft.revision,team_id:'team',team_revision:0})
   if(nativeBuilderSetup){
    const id=builderHandle.operation.id,path=`operations/${id}/builder-accounting`
    const live=await call(`operations/${id}`)
    const command={request_id:'creation-final',attempt:live.attempt,epoch:live.epoch,expected_revision:live.revision,price_id:'creation-price',settlement:'internal_price'}
    await assert.rejects(call(path,command),/reported/)
    const {expected_revision,...closeCommand}=command
    await assert.rejects(call(`operations/${id}/builder-close`,{...closeCommand,price_id:'wrong'}),/price mismatch/)
    await waitFor(async()=>(await call(`operations/${id}/builder-close`)).pending_inputs===0)
    const closed=await ownerHttp.post('builder/close',{operation_id:id,command:closeCommand})
    assert.equal(closed.state,'closed');assert.equal(host.handles.has('builder'),false)
    const reported=await call(`operations/${id}`);command.expected_revision=reported.revision
    const settled=closed.accounting
    builderAccounting={id,path,command,settled,closeCommand,closed}
    assert.deepEqual(await ownerHttp.post('builder/close',{operation_id:id,command:closeCommand}),closed)
    await assert.rejects(call(`operations/${id}/builder-inputs`,{request_id:'after-close',draft_id:draft.id,attempt:command.attempt,epoch:command.epoch,content:'More work'}),/closing/)
    assert.equal(settled.reservation.finalized,true);assert.equal(settled.reservation.held,0)
    assert.equal(settled.reservation.charged,8);assert.equal(settled.provider_cost_status,'unconfirmed')
    assert.equal(settled.completion_authorized,false);assert.equal(settled.calls.length,4)
    const retries=await Promise.all([ownerHttp.post('builder/accounting',{operation_id:id,command}),ownerHttp.post('builder/accounting',{operation_id:id,command})])
    for(const receipt of retries)assert.deepEqual(receipt,settled)
    await assert.rejects(call(path,{...command,request_id:'different'}),/identity conflict/)
    const creationBudget=(await call('budgets/creation-budget')).budget
    assert.equal(creationBudget.reserved,0);assert.equal(creationBudget.spent,8)
   }
   assert.equal(accepted.activation_performed,false);team=accepted.team
  }else team=await call('teams',{id:'team',request_id:'create',expected_revision:0,spec})
  const grantCommand={expected_revision:0,policy:{id:'grant',team_id:'team',enabled:true,expires_at:at+FIXTURE_VALIDITY_MS,targets:[target],capabilities:['read','delegate','workspace_write'],tools:['kode_write_source','kode_capture_output','kode_publish_output','kode_read_source','kode_review_output','kode_verify_output','kode_coordinator_publish_reply','kode_coordinator_workflow_start','kode_coordinator_configuration','kode_coordinator_workflow_status',...(answerScenario?['kode_coordinator_answer_clarification']:[])],network:false,budget_ids:['budget']}}
  if(remoteAnswer)grantCommand.policy.targets.push({host:remoteHub.node,workspace:'remote-workspace',root:remoteRoot})
  let grant
  if(ownerSetup){
   const funded=await ownerHttp.post('teams/budget',{team_id:'team',command:{request_id:'allowance',team_revision:1,budget:budgetCommand}})
   assert.equal(funded.label,'团队预算');assert.equal(funded.activation_performed,false)
   const configured=await ownerHttp.post('teams/resource',{team_id:'team',command:{request_id:'resource',team_revision:1,target_id:'control',create_account:true,binding:{host:hub.node,profile:'profile',account_id:'account',account_epoch:1,expected_revision:0},capability_profile:capabilityCommand,internal_price:priceCommand}})
   assert.equal(configured.internal_price.provider_invoice,false);assert.equal(configured.eligible_for_execution,false)
   await call('assignment-capacities',{account_id:'account',expected_revision:0,max_active_assignments:1})
   const authority=await ownerHttp.post('teams/authority',{team_id:'team',command:{request_id:'authority',team_revision:1,budget_policy:budgetPolicyCommand,scheduling_policy:scheduleCommand,grant:grantCommand}})
   budget=authority.budget_policy;schedule=authority.scheduling_policy;grant=authority.grant
   assert.equal(authority.activation_performed,false)
  }else grant=(await call('team-grants',grantCommand)).grant

  const readiness=await call('teams/team/activation-review',{team_revision:1,request_id:'review'})
  assert.equal(teamRuntimeReadiness(execution,readiness).default_adapter_checks_complete,!remoteAnswer,JSON.stringify(teamRuntimeReadiness(execution,readiness)))
  if(remoteAnswer)assert.equal(teamRuntimeReadiness(remoteRuntime.execution,readiness).default_adapter_checks_complete,true)
  assert.equal(readiness.resources.coordinator_startup.configuration_checks_complete,true,JSON.stringify(readiness.resources.coordinator_startup.issues))
  assert.equal(readiness.resources.coordinator_startup.eligible_for_execution,false)
  assert.equal((await call('budgets/budget')).budget.reserved,0,'startup diagnostics do not reserve')
  const activationCommand={action:'activate',request_id:'activate',expected_revision:0,team_revision:1,grant_revision:grant.revision,budget_policy:policy(budget),scheduling_policy:policy(schedule)}
  if(ownerSetup)await ownerHttp.post('teams/activation',{team_id:'team',command:activationCommand})
  else await call('teams/team/activation',activationCommand)
  const automatic=process.env.KODE_TEST_COORDINATOR_BOOTSTRAP==='1'
  let otherTeam
  if(process.env.KODE_TEST_COORDINATOR_FRESH_SUCCESSOR==='1'){
   otherTeam=await pairedContactTeam({call,root,otherRoot,hub,profiles,spec,projectInput,deliveryInput,version,flow,budgetCommand,budgetPolicyCommand,scheduleCommand,capabilityCommand,grantCommand,activationCommand,policy})
   assert.notEqual(otherTeam.superagent_id,team.superagent_id)
   assert.notEqual(otherTeam.conversation_id,team.conversation_id)
   const cancelledDraft={id:'cancelled-interview',request_id:'create',expected_revision:0,revoked:false,interview:{purpose:'Unused third team',workspace_refs:[],answers:{},questions:[],proposed_team:null}}
   const draft=await call('superagents/drafts',cancelledDraft)
   await call('superagents/drafts',{...cancelledDraft,request_id:'cancel',expected_revision:draft.revision,revoked:true})
   assert.equal(calls,0);assert.equal(workerSessions.size,0)
  }
  const planInput=automatic?coordinatorBootstrapInput(hub.node,await call('teams/team/activation')):{team_id:'team',command_id:'create',request_id:'start',owner_session:'owner',session_id:'coordinator',workspace_id:'workspace',task_tag:'inspection'}
  const originalCoordinatorId=planInput.session_id
  let coordinatorId=originalCoordinatorId
  const freshSuccessor=process.env.KODE_TEST_COORDINATOR_FRESH_SUCCESSOR==='1'
  let earlyHuman
  const plan=await host.planCoordinatorStart(planInput)
  assert.equal(plan.state,'planned');assert.equal(plan.dispatch_authorized,false)
  const start=plan.command.start,operationRequest=start.operation
  assert.deepEqual(operationRequest.grant_scope.capabilities,['read','delegate'])
  assert.equal(operationRequest.grant_scope.network,false)
  assert.equal((await call('budgets/budget')).budget.reserved,0,'planning does not reserve funds')
  await assert.rejects(call('teams/team/coordinator-starts',{...start,request_id:'invalid',target_id:'foreign'}),/configured Coordinator/)
  assert.equal((await call('budgets/budget')).budget.reserved,0,'failed control binding rolls back funding')
  assert.deepEqual((await call('budgets/budget/reservations')).reservations,[])
  assert.deepEqual(await call('teams/team/coordinator-control'),{control:null})
  for(const bad of [{...start,activation_revision:2},{...start,operation:{...operationRequest,grant_scope:{...operationRequest.grant_scope,tools:[]}}}]){
   await assert.rejects(call('teams/team/coordinator-starts',bad),/activation changed|complete Coordinator/)
   assert.equal((await call('budgets/budget')).budget.reserved,0)
  }
  let startRoute
  registerCoordinatorPlannedStart({webServer:{register:r=>{startRoute=r}},get:()=>({officialLoops:host}),connection:{admit:req=>req.headers['x-fixture-principal']==='owner'?{peer:{principal:{kind:'owner'}}}:{rejection:401}}})
  startServer=createServer((req,res)=>startRoute.handler(req,res));startServer.listen(0,'127.0.0.1');await once(startServer,'listening')
  const startHttp=async input=>{const response=await fetch(`http://127.0.0.1:${startServer.address().port}/api/kode/coordinator/bootstrap`,{method:'POST',headers:{'content-type':'application/json','x-fixture-principal':'owner'},body:JSON.stringify(input)});const result=await response.json();if(!response.ok)throw Error(result.error);return result}
  const startCommand=planInput
  if(process.env.KODE_TEST_COORDINATOR_BROWSER==='1') imBrowser=await (process.env.KODE_TEST_FULL_DESKTOP==='1'?fullPipelineBrowser:pipelineBrowser)(hub,human=>{
   currentReply={request_id:'reply-0',source_message_id:human.id,content:'WorkRun accepted; execution is pending.'}
   currentStart={request_id:'run-0',source_message_id:human.id,binding_id:'local',inputs:{request:human.content}}
  },{agents:()=>({officialExecution:execution,workRuns:runService}),recheckResponseLoss:recheckScenario,contactNames:otherTeam?['Team','Other team']:['Team']})
  if(otherTeam)await imBrowser.verifyContacts()
  if(automatic){
   await host.coordinatorBootstrap.scan()
   assert.equal((await call('budgets/budget')).budget.reserved,0,'no request means no automatic startup')
   earlyHuman=imBrowser?await imBrowser.send('Implement the requirement'):await call(`conversations/${team.conversation_id}/messages`,{request_id:'request-0',content:'Implement the requirement'})
   currentReply={request_id:'reply-0',source_message_id:earlyHuman.id,content:'WorkRun accepted; execution is pending.'}
   currentStart={request_id:'run-0',source_message_id:earlyHuman.id,binding_id:'local',inputs:{request:'Implement the requirement'}}
   host.coordinatorBootstrap.start()
   try{await waitFor(()=>host.handles.has(coordinatorId))}
   catch(error){
    const bootstrap=host.coordinatorBootstrap
    throw Error('Coordinator bootstrap deadline: '+JSON.stringify({calls,errors,expected_session:coordinatorId,owned_sessions:[...host.handles.keys()],
      bootstrap_error:bootstrap.error?.message?.slice(0,500),results:bootstrap.results?.map(row=>({team_id:row.team_id,state:row.state,error:row.error?.message?.slice(0,500)})),
      control:(await call('teams/team/coordinator-control')).control?.revision,
      pending_inputs:(await call(`conversations/${team.conversation_id}/pending-inputs?after=0&limit=1`)).items?.length}),{cause:error})
   }
   if(imBrowser) assert.equal((await call('budgets/budget/reservations')).reservations.length,1,'IM input starts Coordinator before any manual start request')
  }else{
   await assert.rejects(startHttp(startCommand),/start was not confirmed/)
   assert.equal(calls,0);assert.equal(profiles.binding(coordinatorId),undefined)
   assert.equal((await call('budgets/budget')).budget.reserved,followupScenario?80:40)
   assert.equal((await call('sessions')).sessions.some(s=>s.address.session_id===coordinatorId),false)
  }
  const creations=await Promise.all([startHttp(startCommand),startHttp(startCommand)])
  const creation=creations[0];assert.deepEqual(creations[1],creation)
  assert.equal(creation.state,'created');assert.deepEqual(await startHttp(startCommand),creation)
  assert.equal((await call('budgets/budget/reservations')).reservations.length,1)
  await assert.rejects(call('teams/team/coordinator-starts',{...start,request_id:'competitor',operation:{...operationRequest,request_key:'competitor',worker:{node_id:hub.node,session_id:'competitor'}}}),/control revision conflict/)
  assert.equal((await call('budgets/budget/reservations')).reservations.length,1,'losing start leaves no reservation')
  const command=creation.request;let op=await call(`operations/${command.operation.id}`)
  if(!automatic)assert.equal(calls,0)
  assert.equal((await call(`operations/${op.id}`)).state,'active')
  assert.equal((await call('sessions')).sessions.find(s=>s.address.session_id===coordinatorId).runtime,'dsh')
  assert.ok(!JSON.stringify(await ctx.systemPrompt.assemble({})).includes(COORDINATOR_PROMPT_VERSION))
  let owned=host.handles.get(coordinatorId)
  const controller=new WorkRunController(new AssignmentDispatchHost(host),{prepare:(assignment,options)=>prepareWorkRunAssignment(execution,assignment,options)})
  const states=[]
  const advance=controller.advance.bind(controller);controller.advance=async id=>{try{if(recheckScenario&&!injectedRecheckFailure){injectedRecheckFailure=true;recheckRevision=(await call(`work-runs/${id}`)).revision;throw Error('fixture recoverable execution preflight failure')}return await advance(id)}catch(error){states.push({state:'fixture_error',message:error.message});throw error}}
  runService=await new WorkRunService(controller,{intervalMs:100,onState:s=>states.push(s)}).open();if(blockedScenario){if(!interventionScenario)runService.coordinatorUpdates.start()}else if(!transferScenario)runService.start()
  if(process.env.KODE_TEST_COORDINATOR_UPDATE_RECOVERY==='1')await runService.coordinatorUpdates.close()
  if(liveCoordinatorScenario){
   await liveTeamPipeline({t,hub,ctx,profiles,execution,host,runService,owned,team,root,model:fixtureModel,call,waitFor,errors})
   return
  }

  if(!automatic){
  const spoof=await call('messages',{source:coordinatorId,target:{node_id:hub.node,session_id:coordinatorId},idempotency_key:'spoof',content:JSON.stringify({format:'kode.coordinator.input.v1',operation_id:op.id,conversation_id:team.conversation_id,source_message_id:'fake'})})
  await waitFor(async()=>(await call(`messages/${spoof.id}`)).status==='uncertain')
  assert.equal(calls,0,'unbound peer input cannot start inference')
  }
  const inputIds=[],published=[],runs=[]
  const peer=await call('sessions',{session_id:'untrusted-worker',title:'Worker',runtime:'external'})
  const peerClient=hub.client.forSession(peer.owner_token)
  for(const [index,content] of [liveWorker?'Implement the requirement. Create implemented.txt with the exact content implemented, without a trailing newline. Capture and publish the artifact evidence.':'Implement the requirement'].entries()){
   const human=earlyHuman??(imBrowser?await imBrowser.send(content):await call(`conversations/${team.conversation_id}/messages`,{request_id:`request-${index}`,content}))
   currentReply={request_id:`reply-${index}`,source_message_id:human.id,content:'WorkRun accepted; execution is pending.'}
   currentStart={request_id:`run-${index}`,source_message_id:human.id,binding_id:'local',inputs:{request:content}}
   const inputPath=`conversations/${team.conversation_id}/messages/${human.id}/coordinator-input`
   const input={operation_id:op.id,control_revision:1,attempt:1,epoch:1}
   let queued
   await waitFor(async()=>{queued=(await call(inputPath)).input;return queued!==null})
   assert.equal(queued.request.operation_id,op.id,'Host automatically dispatches persisted human input')
   assert.deepEqual((await call(inputPath)).input,queued)
   const inputId=deliveryInputId(queued.receipt.message_id);inputIds.push(inputId)
   await waitFor(()=>owned.agent.session.snapshotEvents().some(e=>e.type==='user/message'&&e.data.id===inputId))
   await owned.agent.whenIdle()
   await waitFor(async()=>(await call(`messages/${queued.receipt.message_id}/delivery`)).delivery?.phase==='consumed')
   assert.ok(errors.every(error=>questionScenario&&error==='Worker clarification requires owner information'),JSON.stringify(errors));assert.ok(questionScenario?[6,9].includes(calls):calls===(index+1)*6)
   assert.equal(owned.agent.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id===inputId).length,1)
   assert.deepEqual(await call(inputPath,input),queued)
   assert.ok(questionScenario?[6,9].includes(calls):calls===(index+1)*6)
   const replyPath=`conversations/${team.conversation_id}/coordinator-replies`
   const reply={...input,request_id:`reply-${index}`,source_message_id:human.id,content:'WorkRun accepted; execution is pending.'}
   await assert.rejects(peerClient.call(`/api/v1/messaging/${replyPath}`,reply),/403/)
   await assert.rejects(call(replyPath,{...reply,request_id:'wrong-control',control_revision:2}),/binding mismatch/)
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
   runs.push({startPath,start,run})
  }
  assert.ok((await call('budgets/budget')).budget.spent>=12,'Coordinator and concurrently running Workers share budget')
  assert.ok(questionScenario?[1,2].includes(publicationWrites):publicationWrites===1,'lost committed response recovered without repeating writes')
  assert.equal(lostPublication,true)
  assert.equal(lostWorkflow,true);assert.equal(workflowWrites,1)
  if(questionScenario){
   const path=`conversations/${team.conversation_id}/coordinator-replies/waiting-result`
   await waitFor(async()=>(await call(path)).message!==null)
   await owned.agent.whenIdle()
   const run=await call(`work-runs/${runs[0].run.id}`)
   const question=run.pending_clarification
   if(nativeAnswer)questionReceipt=question
   const updatePath=`work-runs/${run.id}/coordinator-updates`
   const notice=(await call(`${updatePath}/${run.revision}`)).update
   assert.equal(notice.summary.event_kind,'blocked')
   assert.equal(notice.summary.worker_clarification_count,1)
   assert.equal(notice.summary.worker_clarification.request_id,question.request.request_id)
   assert.equal(notice.summary.worker_clarification.command,undefined)
   assert.equal((await call(`messages/${notice.receipt.message_id}/delivery`)).delivery.phase,'consumed')
   const response=(await call(path)).message
   assert.equal(response.actor.kind,'superagent')
   assert.equal(response.content,'Which output wording should I use?')
   assert.equal(response.in_reply_to,currentReply.source_message_id)
   assert.equal(run.completion_authorized,false)
   assert.equal(workerSessions.size,1)
   assert.equal(calls,9)
   assert.deepEqual(errors,[])
   assert.deepEqual(await call(updatePath,{expected_revision:run.revision}),notice)
   if(!answerScenario){
    await assert.rejects(call(`work-assignments/${question.assignment_id}/clarification-answers`,{
     request_id:'not-granted',question_request_id:question.request.request_id,source_message_id:currentReply.source_message_id,
     conversation_id:team.conversation_id,operation_id:op.id,control_revision:1,attempt:1,epoch:1,
    }),/answer tool not granted/)
   }
   if(answerScenario){
    if(remoteAnswer){
     await waitFor(async()=>{
      const questionCall=await call(`official-calls/${question.request.call_id}`)
      return questionCall.state==='finished'&&questionCall.accounting_status==='estimated_pending_reconciliation'
     }).catch(async error=>{throw Error(JSON.stringify({question_call:await call(`official-calls/${question.request.call_id}`),remote_states:remoteRuntime.states.slice(-12),errors}),{cause:error})})
    }
    const answerPath=`work-assignments/${question.assignment_id}/clarification-answers`
    const authority={request_id:'invalid-answer',question_request_id:question.request.request_id,source_message_id:currentReply.source_message_id,conversation_id:team.conversation_id,operation_id:op.id,control_revision:1,attempt:1,epoch:1}
    await assert.rejects(call(answerPath,authority),/new human response/)
    await assert.rejects(peerClient.call(`/api/v1/messaging/${answerPath}`,authority),/403/)
    const human=await call(`conversations/${team.conversation_id}/messages`,{request_id:'human-answer',content:'Use implemented.'})
    await waitFor(async()=>(await call(`conversations/${team.conversation_id}/coordinator-replies/after-answer-result`)).message!==null).catch(async error=>{throw Error(JSON.stringify({calls,errors,states:states.slice(-8),answerWrites,lostAnswer,...(remoteAnswer?{run:await call(`work-runs/${run.id}`),remote_states:remoteRuntime.states.slice(-12),requests:[...remoteRuntime.requests.values()],recent_requests:remoteRuntime.completed,workers:Object.entries(remoteRuntime.profiles.bindings).filter(([,binding])=>binding.managedAssignment).map(([id,binding])=>({id,assignment:binding.managedAssignment.id,lifecycle:binding.remoteLifecycle,status:remoteRuntime.ctx.agents.get(id)?.status,steps:workerSteps.get(id)}))}:{})}),{cause:error})})
    await owned.agent.whenIdle()
    const final=await call(`work-runs/${run.id}`)
    assert.equal(final.state,'completed');assert.equal(final.completion_authorized,true)
    assert.deepEqual(final.stages.map(stage=>stage.state),['passed','passed','passed'])
    assert.equal(final.pending_clarification,undefined)
    const answer=(await call(`${answerPath}/${question.request.request_id}`)).answer
    assert.equal(answer.source_message_id,human.id)
    if(remoteAnswer){assert.equal(answer.worker.node_id,remoteHub.node);assert.equal(answer.home_hub,hub.node);assert.equal(question.home_hub,hub.node)}
    assert.equal(answerWrites,1);assert.equal(lostAnswer,true)
    if(nativeAnswer){
     assert.equal(nativeProvider.calls,5);assert.deepEqual(nativeProvider.errors,[])
     const bindings=Object.entries(profiles.bindings).filter(([,binding])=>binding.managedAssignment&&binding.profile.id==='native-worker')
     assert.equal(bindings.length,1,'question and answer keep the same native Worker session')
     const [session,binding]=bindings[0]
     const reader=await ctx.get('sessionPersistence').open(session,'read')
     try{
      const records=(await reader.read(0,4096)).events.map(pluginRecordOf).filter(Boolean)
      const starts=records.filter(record=>record.type==='plugin:kode/managed-cli-start')
      const decisions=records.filter(record=>record.type==='plugin:kode/managed-cli-decision')
      assert.equal(starts.length,5);assert.equal(decisions.length,5)
      assert.equal(decisions[0].data.outcome,'requires_clarification')
      assert.equal(decisions[0].data.failure_code,'worker_clarification_required')
      assert.equal(decisions.filter(record=>record.data.outcome==='completed').length,4)
      assert.ok(decisions.filter(record=>record.data.outcome==='completed').every(record=>record.data.failure_code===null))
      for(const decision of decisions){
       if(process.env.KODE_TEST_MANAGED_CODEX_BOOTSTRAP_ENGINE){
        assert.equal(decision.data.configuration.bootstrap.version,1)
        assert.ok(decision.data.configuration.bootstrap.model_count>0)
        assert.match(decision.data.configuration.bootstrap.source_hash,/^[a-f0-9]{64}$/)
        assert.match(decision.data.configuration.bootstrap.effective_hash,/^[a-f0-9]{64}$/)
       }
       assert.deepEqual(decision.data.operation,binding.managedOperation)
       assert.equal(decision.data.stop.leader_exited,true);assert.equal(decision.data.stop.process_group_empty,true)
       assert.deepEqual(decision.data.stop.signal_failures,[])
      }
     }finally{await reader.close()}
    }
    assert.equal((await call(`messages/${answer.message_id}/delivery`)).delivery.phase,'consumed')
    assert.equal(calls,14+2*answerProgressNotices);assert.equal(workerSessions.size,3);assert.deepEqual(errors,[])
    assert.equal((await call('budgets/budget')).budget.spent,52+4*answerProgressNotices-recoveryDiscount)
    if(omittedPublication)await assertRecoveredOutputs(final)
    assert.deepEqual(await call(answerPath,answer.request),answer)
    await assert.rejects(call(answerPath,{...answer.request,request_id:'changed'}),/identity conflict/)
    const downstreamInputs=[]
    for(const stage of final.stages.slice(1)){
     const downstream=await call(`work-assignments/${stage.assignment_id}`)
     const source=Object.values(downstream.inputs.binding.sources).find(source=>source.assignment_id===question.assignment_id)
     assert.ok(source,'both downstream stages retain the original producer context')
     assert.deepEqual(source.clarifications[0].receipt,answer)
     assert.equal(source.clarifications[0].response.answer.source_message_id,human.id)
     downstreamInputs.push({id:downstream.id,inputs:downstream.inputs})
    }
    await hub.stop('SIGKILL');await hub.start()
    for(const snapshot of downstreamInputs){
     assert.deepEqual((await call(`work-assignments/${snapshot.id}`)).inputs,snapshot.inputs,'restart preserves frozen clarification inputs and hashes')
    }
    assert.deepEqual((await call(`${answerPath}/${question.request.request_id}`)).answer,answer)
    assert.deepEqual(await call(answerPath,answer.request),answer)
    assert.equal((await call(`work-runs/${run.id}`)).state,'completed')
    return
   }
   await hub.stop('SIGKILL');await hub.start()
   assert.deepEqual((await call(`${updatePath}/${run.revision}`)).update,notice)
   assert.deepEqual((await call(path)).message,response)
   assert.deepEqual((await call('coordinator-updates/pending')).items,[])
   assert.equal(calls,9)
   return
  }
  if(recheckScenario){
   const id=runs[0].run.id
   await waitFor(()=>runService.rows[id]?.blocked===true)
   const fenced=await call(`work-runs/${id}`)
   assert.equal(fenced.revision,recheckRevision);assert.equal(workerSessions.size,0);assert.equal(calls,6)
   for(let i=0;i<3;i++)await runService.scan()
   assert.deepEqual(await call(`work-runs/${id}`),fenced,'same-version fence cannot silently resume')
   const command=await imBrowser.recheckExecution(id)
   assert.equal(command.expected_revision,recheckRevision)
   const events=(await call(`work-runs/${id}/events`)).events
   assert.equal(events.filter(e=>e.data.kind==='execution_recheck_requested').length,1)
   await waitFor(()=>runService.rows[id]?.revision>recheckRevision&&!runService.rows[id].blocked)
  }
  let transferReceipt,transferRequest
  if(transferScenario){
   await host.coordinatorTransfers.close()
   const run=await call(`work-runs/${runs[0].run.id}`),originalInput=await call(`conversations/${team.conversation_id}/messages/${run.coordinator.source_message_id}/coordinator-input`)
   await owned.run.finish();await owned.dispose()
   const reservation=(await call(`operations/${op.id}/budget?attempt=1`)).reservation
   if(!reservation.finalized)await call(`budget-reservations/${reservation.request.id}/settle`,{event_id:'transfer-finalize',expected_revision:reservation.revision,total_charge:reservation.charged,finalized:true,basis:'manual'})
   assert.equal((await call('teams/team/coordinator-recovery')).recovery.pending_work_count,1)
   if(freshSuccessor){
    await host.coordinatorBootstrap.close()
    const successor={...planInput,command_id:'recover-fresh',request_id:'recover-fresh',session_id:'coordinator-successor',expected_control_revision:1}
    await assert.rejects(host.startPlannedCoordinator(successor),/fixture recovery commit reply lost/)
    const created=await host.startPlannedCoordinator(successor)
    assert.equal(created.state,'created')
    coordinatorId=successor.session_id
    assert.notEqual(coordinatorId,originalCoordinatorId)
    assert.equal(ctx.agents.get(originalCoordinatorId),undefined)
    op=await call(`operations/${created.request.operation.id}`);owned=host.handles.get(coordinatorId)
   }else{
   host.coordinatorBootstrap.start()
   await waitFor(()=>host.handles.has(coordinatorId)&&Object.values(profiles.binding(coordinatorId)?.coordinatorResumeReceipts??{}).some(r=>r.state==='resumed'))
   const resume=Object.values(profiles.binding(coordinatorId).coordinatorResumeReceipts)[0]
   assert.equal(lostRecovery,true);assert.equal((await call('budgets/budget/reservations')).reservations.length,2,'recovery response loss creates only one new reservation')
   assert.equal(resume.state,'resumed');op=await call(`operations/${resume.request.operation.id}`);owned=host.handles.get(coordinatorId)
   }
   assert.equal(lostRecovery,true);assert.equal((await call('budgets/budget/reservations')).reservations.length,2)
   assert.equal(calls,6);assert.equal(workerSessions.size,0)
   const reply={request_id:'before-transfer',source_message_id:run.coordinator.source_message_id,operation_id:op.id,control_revision:2,attempt:1,epoch:1,content:'Cannot reply before transfer'}
   await assert.rejects(call(`conversations/${team.conversation_id}/coordinator-replies`,reply),/input binding mismatch/)
   transferRequest={request_id:`handover-2-${run.revision}`,expected_revision:run.revision,control_revision:2}
   const path=`work-runs/${run.id}/coordinator-transfer`
   await assert.rejects(peerClient.call(`/api/v1/messaging/${path}`,transferRequest),/403/)
   await assert.rejects(call(path,{...transferRequest,control_revision:3}),/successor/)
   const pendingPath='teams/team/coordinator-transfers/pending'
   await assert.rejects(peerClient.call(`/api/v1/messaging/${pendingPath}`),/403/)
   assert.deepEqual((await call(pendingPath)).items,[{run_id:run.id,revision:run.revision}])
   host.coordinatorTransfers=new CoordinatorTransfers(host,{intervalMs:100});host.coordinatorTransfers.start()
   await waitFor(async()=>(await call(`work-runs/${run.id}`)).coordinator.control_revision===2)
   await host.coordinatorTransfers.scan()
   assert.equal(transferWrites,1,'committed response loss never triggers an automatic repeated transfer')
   assert.equal(lostTransfer,true);assert.deepEqual((await call(pendingPath)).items,[])
   transferReceipt=await call(path,transferRequest)
   assert.deepEqual(await call(path,transferRequest),transferReceipt)
   await assert.rejects(call(path,{...transferRequest,expected_revision:run.revision+1}),/identity conflict/)
   const transferred=await call(`work-runs/${run.id}`)
   assert.equal(transferred.state,run.state);assert.deepEqual(transferred.stages,run.stages);assert.equal(transferred.coordinator.operation_id,op.id)
   assert.deepEqual(await call(`conversations/${team.conversation_id}/messages/${run.coordinator.source_message_id}/coordinator-input`),originalInput,'source receipt never rebound or replayed')
   assert.equal(transferReceipt.replayed_input,false)
   if(freshSuccessor){
    await assert.rejects(call(`conversations/${team.conversation_id}/coordinator-replies`,{...reply,request_id:'unconsumed-successor-update'}),/consumed successor update/)
   }
   runService.start()
  }
  if(blockedScenario){
   let run=await call(`work-runs/${runs[0].run.id}`);const path=`work-runs/${run.id}/coordinator-updates`
   assert.deepEqual((await call('coordinator-updates/pending')).items,[],'brief resource wait is not a notice')
   await assert.rejects(call(path,{expected_revision:run.revision}),/terminal or blocked/)
   if(interventionScenario){
    const intent=await call(`work-runs/${run.id}`,{action:'takeover',request_id:'notice-takeover',expected_revision:run.revision,reason:'Inspect the selected workspace'})
    assert.deepEqual((await call('coordinator-updates/pending')).items,[{run_id:run.id,revision:intent.revision}])
    run=await call(`work-runs/${run.id}`,{action:'finalize_takeover',request_id:'notice-paused',expected_revision:intent.revision})
    assert.equal(run.state,'paused');assert.equal(workerSessions.size,0)
    await hub.stop('SIGKILL');await hub.start()
    assert.deepEqual((await call('coordinator-updates/pending')).items,[{run_id:run.id,revision:run.revision}])
    runService.coordinatorUpdates.start()
   }
   const until=Date.now()+40000
   while((await call(`conversations/${team.conversation_id}/coordinator-replies/waiting-result`)).message===null){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,100))}
   await owned.agent.whenIdle();assert.equal(calls,9);assert.equal(workerSessions.size,0)
   const notice=(await call(`${path}/${run.revision}`)).update
   assert.equal(notice.summary.event_kind,'blocked')
   if(interventionScenario){assert.equal(notice.summary.state,'paused');assert.equal(notice.summary.intervention.stop_confirmed,true);assert.equal(notice.summary.intervention.reason,'Inspect the selected workspace')}
   else assert.equal(notice.summary.waiting_reason,'execution_adapters_not_ready')
   assert.notEqual(notice.summary.completion_authorized,true)
   assert.deepEqual(await call(path,{expected_revision:run.revision}),notice)
   assert.deepEqual((await call('coordinator-updates/pending')).items,[],'same blocked revision is notified once')
   if(interventionScenario){
    const delivered=(await call(`messages/${notice.receipt.message_id}/delivery`)).delivery
    assert.equal(delivered.phase,'consumed')
    await call(`work-runs/${run.id}`,{action:'resume',request_id:'notice-resume',expected_revision:run.revision,reason:'Continue the configured workflow'})
   }
   runService.start()
  }
  if(humanScenario){
   await waitFor(async()=>(await call(`conversations/${team.conversation_id}/coordinator-replies/waiting-result`)).message!==null)
   await owned.agent.whenIdle()
   const awaiting=await call(`work-runs/${runs[0].run.id}`)
   assert.equal(awaiting.state,'waiting_user');assert.equal(awaiting.human_acceptance.state,'pending')
   assert.equal(awaiting.completion_authorized,false);assert.equal(calls,9);assert.equal(workflowWrites,1)
   const humanNotice=(await call(`work-runs/${awaiting.id}/coordinator-updates/${awaiting.revision}`)).update
   assert.equal(humanNotice.summary.waiting_reason,'human_delivery_acceptance_required')
   assert.equal((await call(`teams/${team.id}/work-runs`)).items.length,1)
   const command={request_id:'owner-acceptance',expected_revision:awaiting.revision,evidence_hash:awaiting.human_acceptance.evidence_hash,choice:rejectHuman?'reject':'accept',reason:rejectHuman?'Please correct the output wording':'Checked the artifact and independent review/verification evidence'}
   const accepted=await call(`work-runs/${awaiting.id}/delivery-decision`,command)
   assert.equal(accepted.completion_authorized,false)
   assert.deepEqual(await call(`work-runs/${awaiting.id}/delivery-decision`,command),accepted)
   if(rejectHuman){
    await waitFor(async()=>(await call(`conversations/${team.conversation_id}/coordinator-replies/rejected-result`)).message!==null)
    await owned.agent.whenIdle();await runService.close();runService=undefined
    const rejected=await call(`work-runs/${awaiting.id}`)
    assert.deepEqual(rejected,accepted,'a rejection notice cannot advance the task')
    assert.equal(calls,12);assert.equal(workflowWrites,1);assert.equal(workerSessions.size,3)
    assert.equal((await call(`teams/${team.id}/work-runs`)).items.length,1)
    assert.equal((await call(`conversations/${team.conversation_id}/coordinator-replies/final-result`)).message,null)
    const reply=(await call(`conversations/${team.conversation_id}/coordinator-replies/rejected-result`)).message
    assert.match(reply.content,/Please correct the output wording/)
    const notice=(await call(`work-runs/${rejected.id}/coordinator-updates/${rejected.revision}`)).update
    assert.equal(notice.summary.waiting_reason,'human_delivery_rejected')
    await waitFor(async()=>(await call(`messages/${notice.receipt.message_id}/delivery`)).delivery?.phase==='consumed')
    assert.equal((await call(`work-runs/${rejected.id}/events`)).events.filter(e=>e.data.kind==='work_run_delivered').length,0)
    assert.equal((await call('budgets/budget')).budget.spent,46);assert.deepEqual(errors,[])
    if(followupScenario){
     followup={kind:'cancel',step:0,prior:rejected}
     const cancelled=await call(`work-runs/${rejected.id}`,{action:'cancel_settled',request_id:'close-rejected',expected_revision:rejected.revision,reason:'Close rejected delivery before requested modification'})
     const nextController=new WorkRunController(new AssignmentDispatchHost(host),{prepare:(assignment,options)=>prepareWorkRunAssignment(execution,assignment,options)})
     runService=await new WorkRunService(nextController,{intervalMs:100,onState:s=>states.push(s)}).open();runService.start()
     const replyReady=async id=>{try{await waitFor(async()=>(await call(`conversations/${team.conversation_id}/coordinator-replies/${id}`)).message!==null)}catch(error){const run=await call(`work-runs/${currentRunId}`);throw Error(JSON.stringify({expected_reply:id,phase:followup.kind,step:followup.step,calls,errors,state:run.state,waiting_reason:run.waiting_reason,stages:run.stages,inbox_error:host.coordinatorInbox.error?.message,inbox_results:host.coordinatorInbox.results?.map(row=>({state:row.state,message_id:row.message_id,error:row.error?.message})),coordinator_status:owned.agent.status,operation_closed:profiles.binding(coordinatorId)?.operationClosed,run_aborted:owned.run.signal.aborted}),{cause:error})}}
     await replyReady('revised-cancel');await owned.agent.whenIdle()
     followup={kind:'start',step:0,prior:cancelled}
     const human=await call(`conversations/${team.conversation_id}/messages`,{request_id:'revise-request',content:'Create implemented.txt with the exact full content implemented revised in a new task. Address the recorded wording feedback and retain the prior task reference.',prior_run_id:cancelled.id})
     currentReply={source_message_id:human.id}
     currentStart={request_id:'revise-run',source_message_id:human.id,binding_id:'local',prior_run_id:cancelled.id,inputs:{request:human.content}}
     await replyReady('revised-started');await owned.agent.whenIdle()
     followup={kind:'pending',step:0,prior:cancelled}
     await replyReady('revised-pending');await owned.agent.whenIdle()
     const revised=await call(`work-runs/${currentRunId}`)
     assert.notEqual(revised.id,cancelled.id);assert.equal(revised.prior_run_id,cancelled.id)
     assert.equal(revised.inputs.request,human.content)
     assert.deepEqual(revised.stages.map(s=>s.state),['passed','passed','passed'])
     assert.equal(workerSessions.size,6);assert.equal(workflowWrites,2)
     assert.notEqual(revised.human_acceptance.evidence_hash,rejected.human_acceptance.evidence_hash)
     assert.notEqual(revised.task_workspaces.code.key,cancelled.task_workspaces.code.key)
     assert.notEqual(revised.task_workspaces.code.root,cancelled.task_workspaces.code.root)
     assert.equal(await readFile(join(cancelled.task_workspaces.code.root,'implemented.txt'),'utf8'),'implemented')
     assert.equal(await readFile(join(revised.task_workspaces.code.root,'implemented.txt'),'utf8'),'implemented revised')
     await assert.rejects(readFile(join(root,'implemented.txt')),error=>error.code==='ENOENT')
     assert.equal(revised.human_acceptance.decision,undefined)
     assert.ok(revised.stages.every(s=>!cancelled.stages.some(old=>old.assignment_id===s.assignment_id)))
     followup={kind:'complete',step:0,prior:cancelled}
     await call(`work-runs/${revised.id}/delivery-decision`,{request_id:'revised-accept',expected_revision:revised.revision,evidence_hash:revised.human_acceptance.evidence_hash,choice:'accept',reason:'Revised output inspected'})
     await replyReady('revised-complete');await owned.agent.whenIdle();await runService.close();runService=undefined
     const final=await call(`work-runs/${revised.id}`)
     assert.equal(final.completion_authorized,true);assert.equal(final.state,'completed')
     assert.deepEqual(await call(`work-runs/${cancelled.id}`),cancelled)
     assert.equal((await call('budgets/budget')).budget.spent,98);assert.deepEqual(errors,[])
     await host.coordinatorCloseRecovery.close()
     if(!profiles.binding(owned.agent.id)?.operationClosed)await owned.run.finish()
     await owned.dispose()
     await hub.stop('SIGKILL');await hub.start()
     assert.deepEqual(await call(`work-runs/${revised.id}`),final)
     assert.deepEqual(await call(`work-runs/${cancelled.id}`),cancelled)
     return
    }
    await host.coordinatorCloseRecovery.close()
    if(!profiles.binding(owned.agent.id)?.operationClosed)await owned.run.finish()
    await owned.dispose()
    await hub.stop('SIGKILL');await hub.start()
    assert.deepEqual(await call(`work-runs/${rejected.id}`),rejected)
    assert.deepEqual((await call(`conversations/${team.conversation_id}/coordinator-replies/rejected-result`)).message,reply)
    assert.deepEqual(await call(`work-runs/${rejected.id}/delivery-decision`,command),accepted)
    return
   }

  }
  let liveProgress
  try{
   await waitFor(async()=>{
    if(liveWorker)assert.deepEqual(errors,[])
    const run=await call(`work-runs/${runs[0].run.id}`)
    if(liveWorker){
     for(const stage of run.stages)if(stage.assignment_id)liveStagesByAssignment.set(stage.assignment_id,stage.stage_id)
     const progress={state:run.state,stages:run.stages.map(stage=>({stage:stage.stage_id,state:stage.state}))}
     const serialized=JSON.stringify(progress)
     if(serialized!==liveProgress){liveProgress=serialized;t.diagnostic(JSON.stringify({live_workflow_progress:progress}))}
    }
    assert.ok(!states.some(s=>s.state==='progression_failed'&&(!recheckScenario||s.revision!==recheckRevision)),JSON.stringify(states))
    return run.state==='completed'
   })
  }catch(error){
   if(liveWorker)t.diagnostic(JSON.stringify({live_workflow_wait_failed:{progress:liveProgress?JSON.parse(liveProgress):null,
    active_native:[...execution.managedCodex.active.entries()].map(([session,actor])=>({
     stage:liveStagesByAssignment.get(profiles.binding(session)?.managedAssignment?.id)??null,
     gate_state:actor.gate?.state??null,forwarded:actor.gate?.forwarded??0,
    }))}}))
   throw error
  }
  const completed=await call(`work-runs/${runs[0].run.id}`)
  assert.deepEqual(completed.stages.map(s=>s.state),['passed','passed','passed'])
  assert.ok(!JSON.stringify(await ctx.systemPrompt.assemble({})).includes(ASSIGNMENT_PROMPT_VERSION),'Worker procedure cannot leak to ordinary Sessions')
  if(liveWorker)for(const [session,binding]of Object.entries(profiles.bindings))if(binding.managedAssignment&&binding.profile.id==='native-worker')workerSessions.add(session)
  assert.equal(completed.completion_authorized,true);assert.equal(workerSessions.size,3)
  if(omittedPublication){
   await assertRecoveredOutputs(completed)
  }
  if(nativeCoordinator){
   assert.ok(nativeProvider.calls>0)
   assert.deepEqual(nativeProvider.errors,[])
   t.diagnostic(JSON.stringify({native_coordinator_protocol_decisions:nativeProvider.calls,model_response_source:'owned_synthetic_responses',stages:completed.stages.map(stage=>stage.state)}))
  }
  if(dependencyScenario){
   for(const session of workerSessions){
    const binding=profiles.binding(session),implementation=completed.stages[0].assignment_id===binding.managedAssignment.id
    const rows=Object.values(binding.officialCalls??{})
    assert.ok(rows.length>0)
    for(const row of rows){
     const persisted=await call(`official-calls/${row.request.call_id}`)
     dependencyProofs.push(persisted)
     const dependencies=persisted.request.prompt_provenance.instruction.dependencies??[]
     assert.equal(dependencies.length,implementation?1:0)
     if(implementation){assert.equal(dependencies[0].hash,dependencyArtifact.hash);assert.equal(dependencies[0].content_hash,dependencyArtifact.config.spec.artifact.content_hash)}
    }
   }
   assert.equal(dependencyNegativesChecked,true)
   assert.deepEqual(completed.context.binding.workflow_dependencies.implement,[dependencyArtifact])
   const revised=structuredClone(dependencyArtifact.config);revised.version='2';revised.spec.artifact.instructions+=' New owner version.';revised.spec.artifact.content_hash=createHash('sha256').update(revised.spec.artifact.instructions).digest('hex')
   await call('project-configs',revised)
   assert.deepEqual((await call(`work-runs/${completed.id}`)).context,completed.context,'later artifact versions cannot migrate an existing run')
  }
  assert.deepEqual(errors,[])
  if(process.env.KODE_TEST_COORDINATOR_UPDATE_RECOVERY==='1'){
   const pending=await call('coordinator-updates/pending')
   assert.deepEqual(pending.items,[{run_id:completed.id,revision:completed.revision}])
   assert.equal((await call(`work-runs/${completed.id}/coordinator-updates/${completed.revision}`)).update,null)
   runService.coordinatorUpdates=new CoordinatorUpdates(execution,{intervalMs:100});runService.coordinatorUpdates.start()
  }
  try{await waitFor(async()=>(await call(`conversations/${team.conversation_id}/coordinator-replies/final-result`)).message!==null)}
  catch(error){throw Error('Final reply missing: '+JSON.stringify({calls,errors,inbox:host.coordinatorInbox.error?.message,updates:runService.coordinatorUpdates.results?.map(r=>({state:r.state,error:r.error?.message})),owned:host.handles.has(coordinatorId)}),{cause:error})}
  await owned.agent.whenIdle()
  if(liveWorker)assert.ok(calls>=9)
  else assert.equal(calls,(blockedScenario||humanScenario)?12:9)
  assert.deepEqual(errors,[])
  if(liveWorker){
   const budget=(await call('budgets/budget')).budget
   assert.ok(budget.spent>0&&budget.spent<=budget.limit)
   const entries=Object.entries(profiles.bindings).filter(([,binding])=>binding.managedAssignment&&binding.profile.id==='native-worker')
   assert.equal(entries.length,allLiveWorkers?3:1)
   const stageDecisions=[]
   for(const [session,binding]of entries){
    const stage=completed.stages.find(stage=>stage.assignment_id===binding.managedAssignment.id)
    assert.ok(stage)
    const reader=await ctx.sessionPersistence.open(session,'read')
    try{
    const records=(await reader.read(0,4096)).events.map(pluginRecordOf).filter(Boolean)
    const decisions=records.filter(row=>row.type==='plugin:kode/managed-cli-decision')
    assert.ok(decisions.length>=3)
    for(const row of decisions){assert.equal(row.data.outcome,'completed');assert.ok(row.data.usage.input_tokens>0);assert.equal(row.data.stop.process_group_empty,true);assert.equal(row.data.configuration.model,fixtureModel);assert.equal(row.data.configuration.reasoningEffort,liveEffort)}
     stageDecisions.push({stage:stage.stage_id,decisions:decisions.length,
      terminal_peer_closes:decisions.filter(row=>row.data.transport_completion==='response_completed_peer_closed').length,
      schema_rejections:Object.values(binding.officialTools??{}).filter(row=>row.reason==='arguments_rejected_before_dispatch').length})
    }finally{await reader.close()}
   }
   t.diagnostic(JSON.stringify({live_worker_decisions:stageDecisions.reduce((sum,row)=>sum+row.decisions,0),live_worker_stages:stageDecisions,controlled_roles:allLiveWorkers?['coordinator']:['coordinator','reviewer','verifier'],stages:completed.stages.map(stage=>stage.state),completion_authorized:completed.completion_authorized,team_budget_spent:budget.spent,price_basis:'internal_test_credits',cost_basis:'owner_authorized_free_hy4'}))
  }else assert.equal((await call('budgets/budget')).budget.spent,((blockedScenario||humanScenario)?46:40)
    +(invalidArgumentsScenario?2:0)-recoveryDiscount)
  const updatePath=`work-runs/${completed.id}/coordinator-updates`
  const update=(await call(`${updatePath}/${completed.revision}`)).update
  assert.equal(update.receipt.control_revision,transferScenario?2:1)
  if(transferScenario){const reply=(await call(`conversations/${team.conversation_id}/coordinator-replies/final-result`)).message;assert.equal(reply.control_revision,2);assert.equal(reply.authority_transfer.run_id,completed.id)}
  assert.equal(update.summary.state,'completed');assert.equal(update.summary.completion_authorized,true)
  await waitFor(async()=>(await call(`messages/${update.receipt.message_id}/delivery`)).delivery?.phase==='consumed')
  assert.deepEqual(await call(updatePath,{expected_revision:completed.revision}),update)
  const notice=await call(`messages/${update.receipt.message_id}`)
  await assert.rejects(coordinatorInput(hub.client,profiles.binding(coordinatorId),{...notice,id:'forged'},'input'),/receipt mismatch/)
  await assert.rejects(peerClient.call(`/api/v1/messaging/${updatePath}`,{expected_revision:completed.revision}),/403/)
  assert.deepEqual((await call('coordinator-updates/pending')).items,[])
  assert.equal(publicationWrites,(blockedScenario||humanScenario)?3:2)

  await runService.close();runService=undefined
  await imBrowser?.verifyResult()
  const conversation=await call(`conversations/${team.conversation_id}/messages`)
  assert.equal(conversation.items.length,(blockedScenario||humanScenario)?4:3)
  assert.deepEqual(conversation.items.map(m=>m.actor.kind),(blockedScenario||humanScenario)?['human','superagent','superagent','superagent']:['human','superagent','superagent'])
  // Quiesce the mounted automatic closer before manual fixture teardown.
  // It may already have closed/reported this exact operation after the final
  // consumed notice; a second finish must never compete with that action.
  await host.coordinatorCloseRecovery.close()
  if(!profiles.binding(coordinatorId)?.operationClosed)await owned.run.finish()
  await owned.dispose()
  if(transferScenario){
   const reservation=(await call(`operations/${op.id}/budget?attempt=1`)).reservation
   if(!reservation.finalized)await call(`budget-reservations/${reservation.request.id}/settle`,{event_id:'next-finalize',expected_revision:reservation.revision,total_charge:reservation.charged,finalized:true,basis:'manual'})
   await call('teams/team/coordinator-starts',{...start,request_id:'next-control',expected_control_revision:2,operation:{...operationRequest,request_key:'next-control'}})
   const pending=await call('teams/team/coordinator-transfers/pending')
   assert.equal(pending.control_revision,3);assert.deepEqual(pending.items,[],'consumed terminal notice is not automatically replayed to another successor')
  }
  const stored=await ctx.sessionPersistence.open(originalCoordinatorId,'read')
  try{
   const {events}=await stored.read(0,4096)
   assert.equal(events.filter(e=>e.type==='plugin:kode/official-creation').length,1)
   for(const inputId of inputIds)assert.equal(events.filter(e=>e.type==='user/message'&&e.data.id===inputId).length,1)
   assert.match(JSON.stringify(events),/execution is pending/)
  }finally{await stored.close()}
  if(freshSuccessor){
   const successorHistory=await ctx.sessionPersistence.open(coordinatorId,'read')
   try{
    const {events}=await successorHistory.read(0,4096)
    assert.equal(events.filter(e=>e.type==='plugin:kode/official-creation').length,1)
    for(const inputId of inputIds)assert.equal(events.filter(e=>e.type==='user/message'&&e.data.id===inputId).length,0,'fresh successor never replays original intake')
    assert.match(JSON.stringify(events),/Implementation, independent review and verification completed/)
   }finally{await successorHistory.close()}
  }
  assert.equal(ctx.agents.get(coordinatorId),undefined)
  await call('teams/team/activation',{action:'deactivate',request_id:'off',expected_revision:1})
  await hub.stop('SIGKILL');await hub.start()
  if(dependencyScenario)for(const proof of dependencyProofs)assert.deepEqual(await call(`official-calls/${proof.request.call_id}`),proof)
  if(builderAccounting){
   const {id,path,command,settled,closeCommand,closed}=builderAccounting
   await assert.rejects(peerClient.call(`/api/v1/messaging/${path}`,command),/403/)
   assert.deepEqual(await ownerHttp.post('builder/close',{operation_id:id,command:closeCommand}),closed,'closed Builder is never resumed after restart')
   assert.deepEqual(await ownerHttp.post('builder/accounting',{operation_id:id,command}),settled,'creation settlement survives Hub restart')
   const events=await call(`operations/${id}/events?after=0`)
   assert.equal(events.events.filter(e=>e.data.kind==='builder_team_budget_finalized').length,1)
   assert.equal((await call('budgets/creation-budget')).budget.reserved,0)
  }
  assert.deepEqual(await startHttp(startCommand),creation,'historical start never resumes a stopped Coordinator')
  assert.equal(ctx.agents.get(coordinatorId),undefined)
  assert.deepEqual(await call(updatePath,{expected_revision:completed.revision}),update)
  assert.deepEqual((await call(`${updatePath}/${completed.revision}`)).update,update)
  assert.deepEqual((await call('coordinator-updates/pending')).items,[])
  if(transferScenario)assert.deepEqual(await call(`work-runs/${completed.id}/coordinator-transfer`,transferRequest),transferReceipt,'transfer receipt survives Hub restart')
  for(const {replyPath,reply,sent} of published){
   assert.deepEqual(await call(replyPath,reply),sent,'historical publication survives stop and restart')
   assert.deepEqual((await call(`${replyPath}/${reply.request_id}`)).message,sent)
   await assert.rejects(call(replyPath,{...reply,request_id:'new-after-stop'}),/active local lease|authority unavailable|control changed/)
  }
  assert.equal((await call(`conversations/${team.conversation_id}/messages`)).items.length,(blockedScenario||humanScenario)?4:3)
  await imBrowser?.verifyResult({reload:true})
  assert.equal(ctx.agents.get(coordinatorId),undefined,'browsing persisted delivery does not restart execution')
  if(otherTeam){
   await imBrowser.verifyContacts()
   for(const original of [team,otherTeam]){
    const current=await call(`teams/${original.id}`)
    assert.equal(current.superagent_id,original.superagent_id);assert.equal(current.conversation_id,original.conversation_id)
   }
   assert.deepEqual((await call(`conversations/${otherTeam.conversation_id}/messages`)).items,[])
   assert.deepEqual(await call('teams/other-team/coordinator-control'),{control:null})
   const unused=(await call('budgets/other-budget')).budget
   assert.equal(unused.spent,0);assert.equal(unused.reserved,0)
   await assert.rejects(readFile(join(otherRoot,'implemented.txt')),error=>error.code==='ENOENT')
   assert.equal(ctx.agents.get(originalCoordinatorId),undefined)
  }
  if(process.env.KODE_TEST_HOME_TRACE==='1')await verifyHomeTrace(hub,await call(`work-runs/${completed.id}`),peerClient,{suffix:transferScenario?'transfer':'local'})
  if(process.env.KODE_TEST_HOME_TRACE_BROWSER==='1')await imBrowser.verifyTraceUI(completed.id)
  for(const {startPath,start,run} of runs){
   assert.deepEqual(await call(startPath,start),run)
   assert.deepEqual((await call(`${startPath}/requests/${start.request_id}`)).run,run)
   await assert.rejects(call(startPath,{...start,request_id:'after-stop'}),/active local lease|authority unavailable|control changed/)
  }
 }finally{
  if(liveWorker&&profiles){
   for(const [session,binding]of Object.entries(profiles.bindings)){
    if(!binding.managedAssignment||binding.profile.id!=='native-worker')continue
    let reader
    try{
     reader=await ctx.sessionPersistence.open(session,'read')
     const events=(await reader.read(0,4096)).events
     const records=events.map(pluginRecordOf).filter(Boolean)
     const failures=records.filter(row=>row.type==='plugin:kode/managed-cli-decision'&&row.data.failure_code)
       .map(row=>({code:row.data.failure_code,details:row.data.failure_details??null,stopped:row.data.stop?.process_group_empty===true}))
     if(failures.length)t.diagnostic(JSON.stringify({managed_inference_failures:failures}))
     const toolFailures=Object.values(binding.officialTools??{}).filter(row=>row.status!=='returned')
       .map(row=>({tool:row.tool,status:row.status,reason:row.reason??null,home_reconciled:row.home_reconciled===true}))
     if(toolFailures.length)t.diagnostic(JSON.stringify({managed_tool_failures:toolFailures}))
     const lastTool=events.findLast(row=>row.type==='tool/call')
     if(lastTool?.data.name==='kode_review_output'){
      let args
      try{args=JSON.parse(lastTool.data.arguments)}catch{}
      t.diagnostic(JSON.stringify({review_argument_shape:{valid:Boolean(validReviewRequest(args)),
       declared_output:args?.output==='reviewed',findings_array:Array.isArray(args?.findings)}}))
     }
     const completions=records.filter(row=>row.type==='plugin:kode/managed-cli-decision')
     t.diagnostic(JSON.stringify({managed_decision_summary:{stage:liveStagesByAssignment.get(binding.managedAssignment.id)??null,
       decisions:completions.length,terminal_peer_closes:completions.filter(row=>row.data.transport_completion==='response_completed_peer_closed').length}}))
    }catch{t.diagnostic('Live decision failure metadata unavailable')}
    finally{await reader?.close()}
   }
  }
  try{await remoteRuntime?.close();await remoteHub?.close()}finally{await imBrowser?.close();await ownerHttp?.close();if(startServer){startServer.closeAllConnections();await new Promise(resolve=>startServer.close(resolve))}await runService?.close();await host?.close();await execution?.close();await nativeProvider?.close();await ctx.fiber.dispose();for(const name of await readdir(join(hub.root,'artifact-workspaces')).catch(e=>{if(e.code==='ENOENT')return [];throw e})){await chmod(join(hub.root,'artifact-workspaces',name,'source'),0o700).catch(e=>{if(e.code!=='ENOENT')throw e})}await hub.close()}}
})

// Diagnostic timer is unreferenced: it reports only if another resource prevents exit.
test.after(() => {
 const timer=setTimeout(()=>{
  const handles=process._getActiveHandles().map(handle=>({type:handle.constructor?.name,has_ref:typeof handle.hasRef==='function'?handle.hasRef():null,
   destroyed:typeof handle.destroyed==='boolean'?handle.destroyed:null,local_port:handle.localPort??null,remote_port:handle.remotePort??null,
   listening:typeof handle.listening==='boolean'?handle.listening:null}))
  const origins = [...exitResources.values()].filter(row => row.resource.deref()?.hasRef?.()).slice(0, 40).map(({ type, sites }) => ({ type, sites }))
  exitHook?.disable()
  process.stdout.write(`fixture post-cleanup resources: ${JSON.stringify({resources:process.getActiveResourcesInfo(),handles,origins})}\n`)
 },1500)
 timer.unref()
})

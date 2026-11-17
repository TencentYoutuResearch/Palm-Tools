/** Retained, disposable feature replay. Production runtime/authority; controlled UI shell only.
 * No provider fallbacks, automatic retry, private CLI credentials, or business workspaces. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { realpath, writeFile, open, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { AgentProfiles, profileRevision } from '../../src/agent-profiles.js'
import { OfficialExecution } from '../../src/official-execution.js'
import { OfficialLoopHost } from '../../src/official-loop-host.js'
import { OfficialToolPolicies } from '../../src/official-grant-guard.js'
import { managedCodexRoute } from '../../src/managed-codex-profile.js'
import { apply as applyHost } from '../../src/host.js'
import { AssignmentDispatchHost } from '../../src/assignment-dispatch-host.js'
import { WorkRunController } from '../../src/work-run-controller.js'
import { WorkRunService } from '../../src/work-run-service.js'
import { prepareWorkRunAssignment } from '../../src/work-run-preparation.js'
import { advanceWorkRunCancellation } from '../../src/work-run-cancellation.js'
import { verificationExecutableHash } from '../../src/verification-runners.js'
import { registerCollabTeams, registerCollabRuns, registerCollabEvidence } from '../../src/collab-api.js'
import { registerCollaboration } from '../../src/collaboration-route.js'
import { registerConversation } from '../../src/conversation-route.js'
import { registerConversationRead } from '../../src/conversation-read-route.js'
import { registerCollabBudgets } from '../../src/collab-budgets-route.js'
import { registerWorkRun } from '../../src/work-run-route.js'
import { registerWorkRunExecution } from '../../src/work-run-execution-route.js'
import { registerWorkRunReceipt } from '../../src/work-run-receipt-route.js'
import { registerWorkRunTrace } from '../../src/work-run-trace-route.js'
import { registerWorkDeliveryDecision } from '../../src/work-delivery-decision-route.js'
import { teamOwnerHttp } from './team-owner-http.js'
import { collabRenderPage } from './collab-render-page.js'
import { headlessBrowser } from './headless-browser.js'
import { createLiveEvidenceRecorder } from './live-evidence.js'
const requireLoop=createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const {default:Tools}=await import(requireLoop.resolve('@deepseek-ai/dsh-tools'))
const {default:SystemPrompt}=await import(requireLoop.resolve('@deepseek-ai/dsh-system-prompt'))
const policy=row=>({id:row.id,revision:row.revision,hash:row.hash})
const cleanError=error=>({name:['Error','TimeoutError','AbortError','TypeError'].includes(error?.name)?error.name:'Error',code:typeof error?.code==='number'?error.code:null})

/** Host-owned derived instructions, never a claim that the original skill/plugin executed. */
export async function freezeReplayTaskMethod(input){
 if(input===undefined)return null
 const spec=typeof input==='string'?{path:input}:input
 assert.ok(spec&&typeof spec.path==='string'&&isAbsolute(spec.path),'task_method requires an absolute path')
 if(spec.sha256!==undefined)assert.match(spec.sha256,/^[a-f0-9]{64}$/,'Invalid task_method sha256')
 const file=await open(spec.path,constants.O_RDONLY|constants.O_NOFOLLOW)
 let bytes
 try{const stat=await file.stat();assert.ok(stat.isFile()&&stat.size>0&&stat.size<=16384,'task_method must fit the existing 16KiB artifact bound');bytes=await file.readFile()}finally{await file.close()}
 const instructions=bytes.toString('utf8')
 assert.ok(bytes.length<=16384&&instructions.trim()&&!instructions.includes('\0')&&Buffer.from(instructions).equals(bytes),'Invalid task_method text')
 const hash=createHash('sha256').update(bytes).digest('hex')
 if(spec.sha256!==undefined)assert.equal(hash,spec.sha256,'task_method changed after owner freeze')
 return Object.freeze({instructions,content_hash:hash,source:'fixture://retained-feature/owner-derived-task-method',source_version:hash})
}

/** Additional narrowing only. Original implementation, schema, ownership and grant checks remain. */
export function replayToolPolicies(allowedPaths,assertAdmission){
 const allowed=new Set(allowedPaths),policies=new OfficialToolPolicies(),register=policies.register.bind(policies)
 policies.register=(name,definition,agent)=>register(name,{...definition,authorize:async(request,scope)=>{
  assertAdmission()
  if(['kode_write_source','kode_patch_source'].includes(name)&&!allowed.has(request.arguments?.path))return false
  return definition.authorize(request,scope)
 }},agent)
 return policies
}
export function replayProfile(mode,deadlines,env){
 assert.equal(deadlines.decisionMs,300000,'Use the bounded product-default decision deadline')
 if(mode==='controlled')return{id:'replay-engine',name:'Controlled replay adapter',type:'dsh'}
 assert.equal(mode,'hy4')
 for(const key of ['KODE_TEST_MANAGED_CODEX_WRAPPER','KODE_TEST_MANAGED_CODEX_EXECUTABLE','KODE_TEST_WRAPPER_PROVIDER','KODE_TEST_WRAPPER_HOME','KODE_TEST_NATIVE_MODEL'])assert.ok(env[key],`Explicit ${key} required`)
 return{id:'replay-engine',name:'Hy4 retained replay',type:'codex',executable:env.KODE_TEST_MANAGED_CODEX_WRAPPER,args:[],defaultModel:env.KODE_TEST_NATIVE_MODEL,defaultReasoningEffort:'low',
  env:{TCODEX_SKIP_UPDATE:'1',TCODEX_DISABLE_TELEMETRY:'1'},managedInference:{roles:['coordinator','worker'],reasoningEfforts:['low'],timeoutMs:deadlines.decisionMs,
   bootstrap:{executable:env.KODE_TEST_MANAGED_CODEX_BOOTSTRAP_ENGINE??env.KODE_TEST_MANAGED_CODEX_EXECUTABLE,pathVariable:'TCODEX_CODEX_PATH',provider:env.KODE_TEST_WRAPPER_PROVIDER,home:env.KODE_TEST_WRAPPER_HOME}}}
}

/** Use the product close flow: an operation report alone does not settle its reservation. */
export async function closeReportedCoordinators({host,profiles,call,budgetId,priceId,requestId}){
 await host.coordinatorCloseRecovery.close()
 for(const [id,owned] of [...host.handles]){
  const binding=profiles.binding(id);if(!binding?.managedCoordinator)continue
  await owned.agent.whenIdle()
  const op=binding.managedOperation,state=await call(`operations/${op.id}/coordinator-close`)
  const command=state.intent?.request??{request_id:requestId,attempt:op.attempt,epoch:op.epoch,price_id:priceId,settlement:'internal_price'}
  assert.equal((await host.closeCoordinator({operation_id:op.id,command})).state,'closed','Coordinator accounting must finish before fixture teardown')
 }
 const budget=(await call(`budgets/${budgetId}`)).budget
 assert.equal(budget.reserved,0,'Test completion must release known-usage reservations through official accounting')
 return budget
}

export function createFeatureRuntimeFactory({controlledAdapter,environment=process.env,browserBin=environment.KODE_TEST_BROWSER_BIN,diagnostic=()=>{}}={}){
 return async function createFeatureRuntime({hub,manifest,snapshot,mode,deadlines,admit,teamId,observeStage=()=>{}}){
  snapshot={...snapshot,root:await realpath(snapshot.root)}
  const taskMethod=await freezeReplayTaskMethod(manifest.task_method)
  const ctx=new Context(),profile=replayProfile(mode,deadlines,environment),model=mode==='hy4'?environment.KODE_TEST_NATIVE_MODEL:'controlled-model'
  assert.ok(mode!=='controlled'||controlledAdapter,'Controlled integration requires an explicit adapter; never fall back from Hy4')
  const call=(path,body,signal)=>hub.client.call('/api/v1/messaging/'+path,body,signal)
  const errors=[],setupReceipts=[],at=Date.now(),expires=at+deadlines.grantValidityMs
  let execution,host,service,controller,owner,uiServer,browser,page,evidence,team,paused=false,pausePromise,closePromise,human,sendPromise,reportedClose
  const assertAdmission=()=>{if(paused)throw Error('Retained replay is paused');admit()}
  let screenshotSequence=0
  const capture=async(phase,state={})=>{
   const run=await currentRun();const result=await evidence?.capture(phase,{...state,run:run??undefined})
   if(page){
    const directory=join(hub.root,'evidence','screenshots');await mkdir(directory,{recursive:true,mode:0o700})
    await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false})
    if(run)await page.evaluate(`(async()=>{const open=!!document.querySelector('.kode-collab-process');if(${JSON.stringify(phase)}==='completed_conversation'){if(open)document.querySelector('[aria-label="工作过程"]')?.click();return}if(!open)document.querySelector('[aria-label="工作过程"]')?.click();document.querySelector('[aria-label="刷新工作过程"]')?.click();await new Promise(r=>setTimeout(r,400));document.querySelector('[aria-label="查看详情"]')?.click();document.querySelector('[aria-label="刷新详情"]')?.click();await new Promise(r=>setTimeout(r,400))})()`)

    const screenshot=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})
    await writeFile(join(directory,String(++screenshotSequence).padStart(3,'0')+'-'+phase+'.png'),Buffer.from(screenshot.data,'base64'),{mode:0o600})
   }
   return result
  }
  const currentRun=async()=>{
   if(!team)return null
   const rows=(await call(`teams/${team.id}/work-runs?limit=25`)).items
   if(rows.length>1)throw Error('One user intake must not create multiple feature Runs')
   return rows[0]?call(`work-runs/${rows[0].id}`):null
  }
  const pauseAutomatic=()=>pausePromise??=(async()=>{paused=true;await service?.close();await host?.coordinatorBootstrap.close();await host?.coordinatorInbox.close();await host?.coordinatorTransfers.close()})()
  const close=()=>closePromise??=(async()=>{
   paused=true;await pauseAutomatic().catch(()=>{});await browser?.close()
   if(uiServer){uiServer.closeAllConnections();await new Promise(resolve=>uiServer.close(resolve))}
   await owner?.close();await host?.close();await execution?.close();await ctx.fiber.dispose()
  })()
  try{
   await ctx.plugin(SessionStore);await ctx.plugin(AgentRegistry);await ctx.plugin(Projections)
   await ctx.plugin(SystemPrompt,{includeHarnessIdentity:false,includeRuntimeContext:false});await ctx.plugin(Tools);await ctx.plugin(LlmRuntime)
   await ctx.plugin(persistence,{root:join(hub.root,'sessions'),compression:'zstd'})
   if(mode==='controlled'){
    const stream=controlledAdapter.stream.bind(controlledAdapter)
    ctx.llm.registerAdapter(['replay-controlled'],Object.assign(Object.create(controlledAdapter),{async *stream(options){assertAdmission();yield* stream(options)}}))
   }
   await call('workbench/workspaces',{action:'create',path:snapshot.root,title:manifest.title??teamId})
   const catalogue=await call('workbench/workspaces'),workspaceRow=catalogue.workspaces.find(row=>row.path===snapshot.root)
   assert.ok(workspaceRow,'Replay must use an actual persisted workspace identity')
   const workspace={host_id:hub.node,workspace_id:workspaceRow.id,root_ref:snapshot.root},target={host:hub.node,workspace:workspaceRow.id,root:snapshot.root}
   ctx.provide('workspaceRegistry',{list:()=>[{id:workspace.workspace_id,path:snapshot.root}]})
   ctx.provide('kodeOfficialToolPolicies',replayToolPolicies(manifest.allowed_write_paths,assertAdmission))
   const profiles=await new AgentProfiles(join(hub.root,'profiles.json')).open([profile])
   execution=new OfficialExecution(ctx,profiles,hub.client,{host:hub.node});host=new OfficialLoopHost(ctx,execution)
   if(mode==='hy4'){
    const decision=execution.managedCodex.decision.bind(execution.managedCodex)
    execution.managedCodex.decision=(binding,config,agent,signal,originalAdmit)=>decision(binding,config,agent,signal,async()=>{assertAdmission();return originalAdmit()})
   }
   const agents={profiles,officialExecution:execution,officialLoops:host}
   ctx.provide('kodeAgents',agents)
   ctx.on('agent/error',event=>{errors.push(cleanError(event.error));void pauseAutomatic().catch(()=>{})})
   await applyHost(ctx,{url:hub.url,tokenFile:join(hub.root,'admin.token'),stateFile:join(hub.root,'host-state.json'),agentRuntime:false,runtimeBridge:false,pollMs:100})
   owner=await teamOwnerHttp(ctx,hub.client)
   const verification=await owner.post('verification/definitions',{definition:{runner_id:'replay-check',command_id:'frozen-acceptance',revision:'1',...manifest.verification,
    executable:await realpath(manifest.verification.executable),executable_hash:await verificationExecutableHash(await realpath(manifest.verification.executable)),capabilities:['read'],network:false,tool_id:'kode_verify_output'}})
   const check=verification.reference,stage=(id,role,requires,produces,independent_from,tools,capabilities=['read'])=>({id,role,requires,produces,independent_from,execution:{task_tag:'feature-replay',repository_binding:'code',capabilities,tools,network:false}})
   const workflow={id:'replay-flow',version:'1',inputs:['request'],stages:[
    stage('implement','implementer',['request'],['artifact'],[],['kode_list_source','kode_read_source','kode_write_source','kode_patch_source','kode_capture_output','kode_publish_output'],['read','workspace_write']),
    stage('review','reviewer',['implement'],['reviewed'],['implement'],['kode_list_source','kode_read_source','kode_review_output','kode_publish_output']),
    stage('verify','verifier',['review'],['checked'],['implement','review'],['kode_verify_output','kode_publish_output'])],completion_stages:['verify'],
    evidence_rules:{artifact:{kind:'artifact',repository_binding:'code'},reviewed:{kind:'review',artifact_output:'artifact'},checked:{kind:'verification',artifact_output:'artifact',command_binding:'check',environment_binding:'local',required_scenarios:check.scenario_ids}}}
   if(taskMethod){
    const artifact=await call('project-configs',{id:'replay-task-method',version:'1',spec:{kind:'workflow_dependency',artifact:{kind:'skill',...taskMethod,hosts:[hub.node],tools:[],capabilities:['read'],network:false}}})
    for(const stage of workflow.stages)stage.execution.dependencies=[{id:artifact.id,version:artifact.version,hash:artifact.hash}]
   }
   const project={id:'replay-project',version:'1',spec:{kind:'project_bindings',repositories:{code:{repository_id:'replay-repo',workspace}},environments:{local:{host_id:hub.node,adapter_id:'local_process_v1',configuration_hash:check.environment_hash}},commands:{check:{id:check.id,revision:check.revision,definition_hash:check.definition_hash,repository_binding:'code',environment_binding:'local',runner_id:check.runner_id,scenario_ids:check.scenario_ids}},connections:{}}}
   const delivery={id:'replay-delivery',version:'1',targets:[{kind:'local',repository_binding:'code'}],required_outputs:['checked']}
   const draft=await call('superagents/drafts',{id:'replay-draft',request_id:'create',expected_revision:0,revoked:false,interview:{purpose:manifest.request,workspace_refs:[workspace],answers:{delivery:'本地隔离归档并通过冻结验收；不推送、不部署'},questions:[],proposed_workflow:{workflow,project,delivery},proposed_team:null}})
   const configured=await owner.post('builder/configure-workflow',{draft_id:draft.id,expected_revision:draft.revision,request_id:'configure-workflow'})
   const resource={host:hub.node,profile:profile.id,account_id:'replay-account',account_epoch:1,binding_revision:1,limit_ids:['test-window'],unknown_quota:'team_budget'}
   const price={id:'replay-price',model,model_policy:'requested_model',unit:'credits',input_per_million:1,cached_per_million:1,output_per_million:1}
   await call('resource-accounts',{id:resource.account_id,expected_epoch:0,enabled:true})
   await call('assignment-capacities',{account_id:resource.account_id,expected_revision:0,max_active_assignments:1})
   await call('resource-bindings',{host:hub.node,profile:profile.id,account_id:resource.account_id,account_epoch:1,expected_revision:0})
   await call('capability-profiles',{id:'replay-capability',expected_revision:0,host:hub.node,profile:profile.id,model,assessments:{fit:{evaluation:{kind:'task_fit',tag:'feature-replay',score:80},source:'user',confidence:0.9,evidence:[],pinned:false,updated_at:at,valid_until:expires}}})
   await call('price-versions',price)
   const spec={name:manifest.title??teamId,purpose:manifest.request,kind:'coordinator',workspace_refs:[workspace],coordinator_startup:{workspace_id:workspace.workspace_id,task_tag:'feature-replay'},
    execution_targets:[{id:'engine',host_id:hub.node,executor_profile_id:profile.id,executor_profile_revision:profileRevision(profiles.get(profile.id)),provider_id:mode==='hy4'?managedCodexRoute(profile.id):'replay-controlled',model_id:model,effort:mode==='hy4'?'low':null,account_binding_id:resource.account_id,capability_profile_revision:'1'}],
    workers:['implementer','reviewer','verifier'].map(role=>({id:role+'-worker',role,responsibilities:[role==='implementer'?'按需求修改隔离代码并补针对测试':'独立核对冻结产物及真实证据'],allowed_target_ids:['engine'],required_capabilities:[],workspace_refs:[workspace],max_parallel:1})),
    coordinator_targets:['engine'],workflow_pack_refs:[configured.workflow],delivery_bindings:[{id:'local',workflow:configured.workflow,project:configured.project,delivery_policy:configured.delivery_policy}],grant_id:'replay-grant',budget_policy_id:'replay-budget-policy',scheduling_policy_id:'replay-schedule',limits:{max_active_assignments:1,max_active_runs:1},proactive_mode:'off'}
   const proposed=await call('superagents/drafts',{id:draft.id,request_id:'owner-reviewed-proposal',expected_revision:draft.revision,revoked:false,interview:{...draft.interview,proposed_team:spec}})
   const accepted=await owner.post('builder/accept-proposal',{draft_id:draft.id,request_id:'accept',expected_revision:proposed.revision,team_id:teamId,team_revision:0})
   assert.equal(accepted.activation_performed,false);team=accepted.team
   const budgetCommand={id:'replay-budget',scope:'team',scope_id:teamId,unit:'credits',limit:100,starts_at:at-1000,ends_at:expires,expected_revision:0}
   await owner.post('teams/budget',{team_id:teamId,command:{request_id:'budget',team_revision:team.revision,budget:budgetCommand}})
   const grant={expected_revision:0,policy:{id:spec.grant_id,team_id:teamId,enabled:true,expires_at:expires,targets:[target],capabilities:['read','delegate','workspace_write'],tools:[...new Set(workflow.stages.flatMap(row=>row.execution.tools)), 'kode_coordinator_publish_reply','kode_coordinator_workflow_start','kode_coordinator_configuration','kode_coordinator_workflow_status'],network:false,budget_ids:['replay-budget']}}
   const authority=await owner.post('teams/authority',{team_id:teamId,command:{request_id:'authority',team_revision:team.revision,
    budget_policy:{id:spec.budget_policy_id,team_id:teamId,expected_revision:0,policy:{kind:'budget',budget_ids:['replay-budget'],unit:'credits',max_assignment_charge:40,settlement:'internal_price'}},
    scheduling_policy:{id:spec.scheduling_policy_id,team_id:teamId,expected_revision:0,policy:{kind:'scheduling',targets:{engine:{resource,capability_id:'replay-capability',capability_revision:1,preferred:false,internal_price_id:price.id}},weights:{quality:1,cost:0,latency:0},minimum_quality:0,minimum_confidence:0}},grant}})
   const activated=await owner.post('teams/activation',{team_id:teamId,command:{action:'activate',request_id:'activate',expected_revision:0,team_revision:team.revision,grant_revision:authority.grant.revision,budget_policy:policy(authority.budget_policy),scheduling_policy:policy(authority.scheduling_policy)}})
   setupReceipts.push({draft_id:draft.id,team_id:teamId,builder_model_started:false,formal_test_team:true,business_team:false,task_method_sha256:taskMethod?.content_hash??null,activation_revision:activated.revision})
   controller=new WorkRunController(new AssignmentDispatchHost(host),{prepare:(assignment,options)=>prepareWorkRunAssignment(execution,assignment,options)})
   service=await new WorkRunService(controller,{intervalMs:250,onState:async result=>{const run=await currentRun();for(const stage of run?.stages??[])if(stage.assignment_id&&!['passed','waived'].includes(stage.state))observeStage(stage.stage_id);if(result.state==='progression_failed'){errors.push(cleanError(result.error));void pauseAutomatic().catch(()=>{})}}}).open()
   agents.workRuns=service
   evidence=createLiveEvidenceRecorder({directory:join(hub.root,'evidence'),team,profiles,ctx,call,diagnostic})
   await writeFile(join(hub.root,'setup-receipts.json'),JSON.stringify(setupReceipts,null,2)+'\n',{mode:0o600})
   const routes=new Map(),carrier={get:name=>ctx.get(name),webServer:{register:route=>routes.set(route.path,route)},connection:{admit:req=>req.headers['x-fixture-owner']==='yes'?{peer:{principal:{kind:'owner'}}}:{rejection:401}}}
   for(const register of [registerCollaboration,registerCollabTeams,registerCollabRuns,registerCollabEvidence,registerConversation,registerConversationRead,registerCollabBudgets,registerWorkRun,registerWorkRunExecution,registerWorkRunReceipt,registerWorkRunTrace,registerWorkDeliveryDecision])register(carrier,{backendClient:hub.client,quotaHost:hub.node})
   uiServer=createServer(async(req,res)=>{try{const route=routes.get(new URL(req.url,'http://fixture.invalid').pathname);if(route)return await route.handler(req,res);if(await collabRenderPage(req,res,{hub}))return;res.writeHead(404);res.end('{}')}catch{if(!res.headersSent)res.writeHead(500);res.end('{}')}})
   uiServer.listen(0,'127.0.0.1');await once(uiServer,'listening')
   const ui={get page(){return page},url:`http://127.0.0.1:${uiServer.address().port}`,send(request){return sendPromise??=(async()=>{
    assertAdmission();assert.equal(request,manifest.request);assert.ok(browserBin,'Explicit browser binary required for real UI intake')
    browser=await headlessBrowser(browserBin,join(hub.root,'browser-profile'));page=await browser.page(ui.url)
    const wait=expression=>page.evaluate(`(async()=>{const until=Date.now()+15000;while(Date.now()<until){if(${expression})return;await new Promise(r=>setTimeout(r,30))}throw Error('Feature UI state not reached')})()`)
    await wait(`globalThis.fixture&&Array.from(document.querySelectorAll('.kode-collab-contact-name')).some(n=>n.textContent===${JSON.stringify(team.spec.name)})`)
    await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-contact-name')).find(n=>n.textContent===${JSON.stringify(team.spec.name)}).click()`)
    await wait(`document.querySelector('.kode-collab-composer textarea')`)
    service.start();host.coordinatorBootstrap.start()
    await page.evaluate(`document.querySelector('.kode-collab-composer textarea').focus()`);await page.call('Input.insertText',{text:request})
    await page.evaluate(`document.querySelector('.kode-collab-composer button[type="submit"]').click()`)
    await wait(`document.body.innerText.includes('Hub 已接收')`)
    const messages=await call(`conversations/${team.conversation_id}/messages`)
    const inputs=messages.items.filter(row=>row.actor?.kind==='human');assert.equal(inputs.length,1,'UI is the only intake')
    human=inputs[0];return{message_id:human.id,conversation_id:team.conversation_id,team_id:team.id}
   })()}}
   return{ui,async status(){const run=await currentRun();let completionReported=false;if(run?.state==='completed'&&human){const messages=await call(`conversations/${team.conversation_id}/messages`);completionReported=messages.items.some(message=>message.actor?.kind==='superagent'&&message.in_reply_to===human.id&&message.created_at>=run.delivery?.at)}
    if(completionReported&&!errors.length){reportedClose??=(async()=>{await service.close();return closeReportedCoordinators({host,profiles,call,budgetId:'replay-budget',priceId:price.id,requestId:'fixture-final-close-'+teamId})})();await reportedClose}
    return{completion_reported:completionReported,state:errors.length?'failed':run?.state??'ready',team_id:team.id,team_revision:team.revision,formal_test_team:true,builder_model_started:false,task_method_sha256:taskMethod?.content_hash??null,all_model_roles:mode==='hy4'?'managed-hy4':'explicit-controlled-adapter',
    run_id:run?.id??null,run_revision:run?.revision??null,stages:run?.stages.map(stage=>({id:stage.stage_id,state:stage.state,assignment_id:stage.assignment_id??null}))??[],errors:[...errors],owned_handles:host.handles.size,active_decisions:execution.managedCodex.active.size,paused}},pauseAutomatic,capture,close,
    async requestOwnerCancel(){const run=await currentRun();if(!run)throw Error('No run exists to cancel');if(['cancelling','cancel_unconfirmed','cancelled'].includes(run.state))return{state:run.state};return call(`work-runs/${run.id}`,{action:'request_cancel',request_id:'owner-cancel-retained',expected_revision:run.revision,reason:'隔离验证暂停，保留现场并核对停止和计量。'})},
    async reconcileCancellation(){const run=await currentRun();if(!run||!['cancelling','cancel_unconfirmed'].includes(run.state))throw Error('Hub owner cancellation required');return advanceWorkRunCancellation(controller,run,(path,body)=>hub.client.call(path,body))},
   }
  }catch(error){await close().catch(()=>{});throw error}
 }
}

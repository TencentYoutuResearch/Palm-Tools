import { BUILDER_PROMPT_VERSION } from '../src/builder-prompt.js'
import { COORDINATOR_PROMPT_VERSION } from '../src/coordinator-context.js'
import { OFFICIAL_COORDINATOR_TOOLS, OPTIONAL_COORDINATOR_TOOLS } from '../src/official-coordinator-tools.js'
/** Isolated metadata provider; opt-in Builder read flow uses no paid network calls. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
export const inject=['llm','webServer','connection','systemPrompt']
const ALLOW_BUILDER_READ=false
export function apply(ctx){
 let calls=0,lastModel,tools=[],startError,agentError,toolError,diagnosticHost,progressionError,diagnosticController
 ctx.on('tools/result',(request,result)=>{if(result.isError)toolError={tool:request.name,message:String(result.error?.message).slice(0,700).replace(/[a-f0-9]{32,}/gi,'[hash]')}})
 const workerSteps=new Map(),coordinatorTurns=new Map();let runId
 ctx.inject(['kodeAgents'],scope=>{const host=scope.get('kodeAgents')?.officialLoops;if(!host)return;diagnosticHost=host;const original=host.startBuilder;host.startBuilder=async function(...args){try{return await original.apply(this,args)}catch(error){startError={sites:String(error.stack).split('\n').slice(1,9).map(line=>line.replace(/(?:file:\/\/)?[^ ()]+\//g,'')),name:error.name,message:String(error.message).slice(0,500).replace(/[a-f0-9]{32,}/gi,'[hash]')};throw error}};scope.effect(()=>()=>{host.startBuilder=original;diagnosticHost=undefined})})
 class Metadata extends LlmAdapter{
  listModels(provider){return Promise.resolve([{provider,id:'fixture-model',name:'Fixture metadata model'}])}
  async *stream(options){
   calls++
   if(!ALLOW_BUILDER_READ)throw Error('Metadata-only desktop test must not infer')
   lastModel=options.model;tools=options.tools.map(t=>t.name)
   const system=JSON.stringify(options.messages.filter(m=>m.role==='system'))
   const toolResult=id=>{
    const message=options.messages.find(m=>m.role==='tool'&&m.source?.callId===id)
    if(!message)throw Error('Actual execution tool result missing: '+id)
    return JSON.parse(message.content.filter(b=>b.type==='text').map(b=>b.text).join(''))
   }
   if(tools.includes('kode_publish_output')){
    if(system.includes('kode.builder.interview')||system.includes(COORDINATOR_PROMPT_VERSION)||tools.some(t=>t.startsWith('kode_sessions_')))throw Error('Worker inherited another role authority')
    const step=workerSteps.get(options.sessionId)??0;workerSteps.set(options.sessionId,step+1)
    const kind=tools.includes('kode_write_source')?'artifact':tools.includes('kode_review_output')?'reviewed':'checked'
    let name,args
    if(kind==='artifact'&&step===0){name='kode_write_source';args={path:'implemented.txt',expected_sha256:null,content:'implemented'}}
    else if(kind==='reviewed'&&step===0){name='kode_read_source';args={path:'implemented.txt'}}
    else if(kind==='checked'&&step===0){name='kode_verify_output';args={output:kind,request_id:'desktop-verify'}}
    else if(kind==='artifact'&&step===1){name='kode_capture_output';args={output:kind,request_id:'desktop-capture'}}
    else if(kind==='reviewed'&&step===1){if(toolResult('desktop-worker-0').text!=='implemented')throw Error('Reviewer did not read actual implementation');name='kode_review_output';args={output:kind,request_id:'desktop-review',verdict:'passed',findings:[]}}
    else if(step===(kind==='checked'?1:2)){const evidence=toolResult('desktop-worker-'+(step-1));if(!evidence.evidence_id)throw Error('Actual stage evidence missing');name='kode_publish_output';args={output:kind,evidence_id:evidence.evidence_id}}
    else if(step!==(kind==='checked'?2:3))throw Error('Unexpected extra Worker call')
    yield* response(name,args,'desktop-worker-'+step,'阶段证据已归档。');return
   }
   if(tools.includes('kode_coordinator_workflow_start')){
    if(!system.includes(COORDINATOR_PROMPT_VERSION)||system.includes('kode.builder.interview')
     ||JSON.stringify([...tools].sort())!==JSON.stringify([...OFFICIAL_COORDINATOR_TOOLS,...OPTIONAL_COORDINATOR_TOOLS].sort()))throw Error('Coordinator role boundary mismatch')
    const latest=options.messages.filter(m=>m.role==='user'&&['user','human'].includes(m.source?.kind)).at(-1)
    if(!latest)throw Error('Actual Coordinator input missing')
    const text=latest.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')
    let turn=coordinatorTurns.get(latest.id)
    if(!turn){turn={index:coordinatorTurns.size,step:0};coordinatorTurns.set(latest.id,turn)}
    const step=turn.step++,prefix='desktop-coordinator-'+turn.index+'-',source=text.match(/Hub request reference: (\S+)/)?.[1].replace(/\.$/,'')
    if(!source)throw Error('Authoritative owner request reference missing')
    let name,args
    if(text.startsWith('Hub workflow event')){
     if(step===0){if(!runId)throw Error('Workflow event without start receipt');name='kode_coordinator_workflow_status';args={run_id:runId}}
     else if(step===1){const status=toolResult(prefix+'0'),complete=status.completion_authorized===true&&status.state==='completed'
      if(complete&&JSON.stringify(status.stages.map(s=>s.state))!==JSON.stringify(['passed','passed','passed']))throw Error('Delivery claimed without three actual stage results')
      name='kode_coordinator_publish_reply';args={request_id:prefix+'reply',source_message_id:source,content:complete?'桌面需求已完成实现、独立评审和实际命令验证，交付证据已归档。':'流程仍在进行，尚未确认交付。'}
     }else if(step!==2)throw Error('Unexpected extra Coordinator update call')
    }else{
     if(step<2){name='kode_coordinator_configuration';args={binding_id:step===0?'':'local'}}
     else if(step===2){if(toolResult(prefix+'1').binding.id!=='local')throw Error('Configured delivery binding missing');name='kode_coordinator_workflow_start';args={request_id:'desktop-requirement',source_message_id:source,binding_id:'local',inputs:{request:'Implement the desktop requirement'}}}
     else if(step===3){runId=toolResult(prefix+'2').id;if(!runId)throw Error('Actual WorkRun start receipt missing');name='kode_coordinator_publish_reply';args={request_id:'desktop-started',source_message_id:source,content:'需求已进入团队配置的流程，正在执行。'}}
     else if(step!==4)throw Error('Unexpected extra Coordinator input call')
    }
    yield* response(name,args,prefix+step,'协调消息已发布。');return
   }
   if(!JSON.stringify(options.messages.filter(m=>m.role==='system')).includes(BUILDER_PROMPT_VERSION))throw Error('Scoped Builder procedure missing')
   if(!tools.includes('kode_builder_read_draft')||tools.some(t=>t.startsWith('kode_sessions_')||t==='bash'))throw Error('Expected isolated Builder tools')
   const result=id=>{
    const message=options.messages.find(m=>m.role==='tool'&&m.source?.callId===id)
    if(!message)throw Error('Actual Builder tool result missing: '+id)
    return JSON.parse(message.content.filter(b=>b.type==='text').map(b=>b.text).join(''))
   }
   let name,args,id
   if(calls===1){
    name='kode_builder_read_draft';args={};id='desktop-builder-read'
   }else if(calls===2){
    name='kode_builder_catalog';id='desktop-command-reference';args={expected_revision:result('desktop-builder-read').revision,kind:'verification_command',after_id:'local',after_version:'desktop-check',command_revision:'1',limit:1}
   }else if(calls===3){
    const draft=result('desktop-builder-read')
    const command=result('desktop-command-reference').items[0].reference
    if(draft.interview.purpose!=='UI command setup fixture')throw Error('Actual draft identity missing')
    name='kode_builder_save_draft';id='desktop-builder-save'
    args={expected_revision:draft.revision,request_id:'desktop-proposal',questions:[{id:'delivery',prompt:'这支团队完成任务时，你希望收到哪些交付物？'}],proposed_team:{
     name:'桌面创建的团队草案',purpose:draft.interview.purpose,kind:'coordinator',workspace_refs:draft.interview.workspace_refs,
     execution_targets:[],workers:[],coordinator_targets:[],workflow_pack_refs:[],delivery_bindings:[],
     ...draft.candidate_configuration.proposed_policy_ids,limits:{max_active_assignments:1,max_active_runs:1},proactive_mode:'off',
    },proposed_workflow:desktopWorkflow(draft.interview.workspace_refs[0],command)}
   }else if(calls===4){
    const saved=result('desktop-builder-save')
    if(saved.interview.proposed_team?.name!=='桌面创建的团队草案')throw Error('Authoritative proposal save missing')
    name='kode_builder_preflight';id='desktop-builder-preflight';args={expected_revision:saved.revision}
   }else if(calls===6){
    if(!JSON.stringify(options.messages).includes('请使用刚登记的流程版本更新团队方案'))throw Error('Second owner instruction missing')
    name='kode_builder_read_draft';args={};id='desktop-builder-reread'
   }else if(calls>=7&&calls<=9){
    const kind=['workflow','project','delivery'][calls-7]
    name='kode_builder_catalog';id='desktop-catalog-'+kind;args={expected_revision:result('desktop-builder-reread').revision,kind,after_id:'',after_version:'',limit:10}
   }else if(calls===10){
    const current=result('desktop-current-resource').items[0]
    if(current.executor_profile_id!=='official'||current.provider_id!=='fixture'||current.model_id!=='fixture-model'||current.account?.id!=='owner-account'||!current.account.current
      ||current.eligible_for_execution!==false||current.role_fit_status!=='not_assessed'||current.quota_status!=='not_checked')throw Error('Actual current execution projection missing or overclaims readiness')
    const draft=result('desktop-builder-reread'),ref=kind=>{
     const catalog=result('desktop-catalog-'+kind)
     if(catalog.has_more||catalog.items.length!==1||catalog.items[0].details_omitted)throw Error('Expected complete registered version catalog')
     const {id,version,hash}=catalog.items[0]
     if(!/^[a-f0-9]{64}$/.test(hash))throw Error('Authoritative version hash missing')
     return {id,version,hash}
    }
    const workflow=ref('workflow'),project=ref('project'),delivery=ref('delivery')
    name='kode_builder_save_draft';id='desktop-team-linked'
    if(current.capability_configuration?.configuration_created!==false||current.capability_configuration?.requires_owner_assessment!==true)throw Error('Pending capability setup must be explicit')
    const target={id:'local',host_id:current.host_id,executor_profile_id:current.executor_profile_id,executor_profile_revision:current.executor_profile_revision,provider_id:current.provider_id,model_id:current.model_id,effort:current.effort,account_binding_id:current.account.id,capability_profile_revision:current.capability_configuration.proposed_initial_revision}
    args={expected_revision:draft.revision,request_id:'desktop-linked-proposal',questions:draft.interview.questions,proposed_workflow:draft.interview.proposed_workflow,proposed_team:{...draft.interview.proposed_team,
     execution_targets:[target],coordinator_targets:['local'],coordinator_startup:{workspace_id:draft.interview.workspace_refs[0].workspace_id,task_tag:'development'},
     workers:['author','reviewer','verifier'].map(role=>({id:role,role,responsibilities:[role],allowed_target_ids:['local'],required_capabilities:role==='author'?['read','workspace_write']:['read'],workspace_refs:draft.interview.workspace_refs,max_parallel:1})),
     workflow_pack_refs:[workflow],delivery_bindings:[{id:'local',workflow,project,delivery_policy:delivery}]}}
   }else if(calls===11){
    name='kode_builder_preflight';id='desktop-linked-preflight';args={expected_revision:result('desktop-team-linked').revision}
   }else{
    if(![5,12].includes(calls))throw Error('Unexpected extra Builder model call')
    const preflight=result(calls===5?'desktop-builder-preflight':'desktop-linked-preflight')
    if(!JSON.stringify(preflight).includes('runtime_readiness'))throw Error('Actual preflight diagnostics missing')
    yield {type:'block-start',index:0,blockType:'text'}
    yield {type:'block-end',index:0,block:{type:'text',text:calls===5?'已保存团队草案。流程、执行资源和交付条件仍需配置，团队尚未激活。':'团队方案已引用实际登记的流程、项目和交付版本，执行资源仍待配置，尚未激活。'}}
   }
   if(name){
    yield {type:'block-start',index:0,blockType:'tool-call'}
    yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:JSON.stringify(args)}}
    if(calls===7){
     yield {type:'block-start',index:1,blockType:'tool-call'}
     yield {type:'block-end',index:1,block:{type:'tool-call',id:'desktop-current-resource',name:'kode_builder_catalog',arguments:JSON.stringify({expected_revision:result('desktop-builder-reread').revision,kind:'current_execution',after_id:'',after_version:'',limit:1})}}
    }
   }
   yield {type:'usage',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}
   yield {type:'finish',reason:{kind:name?'tool-calls':'stop'}}
  }
 }
 ctx.on('agent/error',event=>{agentError={name:event.error?.name,message:String(event.error?.message).slice(0,500).replace(/[a-f0-9]{32,}/gi,'[hash]'),sites:String(event.error?.stack).split('\n').slice(1,7).map(line=>line.replace(/(?:file:\/\/)?[^ ()]+\//g,''))}})
 ctx.llm.registerAdapter(['fixture'],new Metadata())
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/kode/test-metadata',handler:async(req,res)=>{
  const admitted=ctx.connection.admit(req)
  if('rejection'in admitted||admitted.peer.principal.kind!=='owner'){res.writeHead(403);return res.end()}
  const bootstrap=diagnosticHost?.coordinatorBootstrap,closeRecovery=diagnosticHost?.coordinatorCloseRecovery
  const diagnostic=error=>error?String(error.message).slice(0,500).replace(/[a-f0-9]{32,}/gi,'[hash]'):undefined
  const workRuns=diagnosticHost?.execution.ctx.get('kodeAgents')?.workRuns,controller=workRuns?.controller
  if(controller&&!diagnosticController){
   diagnosticController=controller
   const original=controller.advance
   const wrapped=function(...args){return original.apply(this,args).catch(error=>{progressionError={message:diagnostic(error),...(error.contextDiagnostic?{context: error.contextDiagnostic}:{}),sites:String(error.stack).split('\n').slice(1,8).map(line=>line.replace(/(?:file:\/\/)?[^ ()]+\//g,''))};throw error})}
   controller.advance=wrapped;ctx.effect(()=>()=>{if(controller.advance===wrapped)controller.advance=original})
  }
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({calls,...(calls?{lastModel,tools,workers:[...workerSteps.values()],workRunStates:Object.values(workRuns?.rows??{}).slice(-8),coordinatorClose:{error:diagnostic(closeRecovery?.error),results:closeRecovery?.results?.slice(-8).map(row=>({state:row.state,reason:row.reason,error:diagnostic(row.error)}))},...(progressionError?{progressionError}:{}),globalHasBuilder:JSON.stringify(await ctx.systemPrompt.assemble({})).includes('kode.builder.interview'),artifactError:diagnostic(diagnosticHost?.execution.artifacts.lastError?.error),artifactStates:Object.values(diagnosticHost?.execution.profiles.bindings??{}).flatMap(b=>Object.values(b.artifactOutbox??{}).map(r=>({id:r.evidence.id,home_reconciled:r.home_reconciled,archive_present:!!r.archive,home_archive_reconciled:r.home_archive_reconciled??null}))).slice(-8),bootstrap:{error:diagnostic(bootstrap?.error),results:bootstrap?.results?.map(row=>({team_id:row.team_id,state:row.state,error:diagnostic(row.error)}))}}:{}),...(startError?{startError}:{}),...(agentError?{agentError}:{}),...(toolError?{toolError}:{})}))
 }}))
}

async function* response(name,args,id,text){
 yield {type:'block-start',index:0,blockType:name?'tool-call':'text'}
 yield {type:'block-end',index:0,block:name?{type:'tool-call',id,name,arguments:JSON.stringify(args)}:{type:'text',text}}
 yield {type:'usage',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}
 yield {type:'finish',reason:{kind:name?'tool-calls':'stop'}}
}

function desktopWorkflow(workspace,command){
 const stage=(id,role,requires,produces,independent_from,tools,capabilities=['read'])=>({id,role,requires,produces,independent_from,execution:{task_tag:'development',repository_binding:'code',capabilities,tools,network:false}})
 return {
  workflow:{id:'desktop-flow',version:'1',inputs:['request'],stages:[
   stage('implement','author',['request'],['artifact'],[],['kode_write_source','kode_capture_output','kode_publish_output'],['read','workspace_write']),
   stage('review','reviewer',['implement'],['reviewed'],['implement'],['kode_read_source','kode_review_output','kode_publish_output']),
   stage('verify','verifier',['review'],['checked'],['implement','review'],['kode_verify_output','kode_publish_output']),
  ],completion_stages:['verify'],evidence_rules:{artifact:{kind:'artifact',repository_binding:'code'},reviewed:{kind:'review',artifact_output:'artifact'},checked:{kind:'verification',artifact_output:'artifact',command_binding:'check',environment_binding:'local',required_scenarios:command.scenario_ids}}},
  project:{id:'desktop-project',version:'1',spec:{kind:'project_bindings',repositories:{code:{repository_id:'desktop-repo',workspace}},environments:{local:{host_id:workspace.host_id,adapter_id:'local_process_v1',configuration_hash:command.environment_hash}},commands:{check:{id:command.id,revision:command.revision,definition_hash:command.definition_hash,repository_binding:'code',environment_binding:'local',runner_id:command.runner_id,scenario_ids:command.scenario_ids}},connections:{}}},
  delivery:{id:'desktop-delivery',version:'1',targets:[{kind:'local',repository_binding:'code'}],required_outputs:['checked']},
 }
}

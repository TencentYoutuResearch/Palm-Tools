/** Read activated configuration and authoritative status only within fixed Coordinator authority. */
import { readCoordinatorResources } from './coordinator-resources.js'
import { readWorkRunAccounting } from './work-run-accounting-status.js'
import { isDeepStrictEqual } from 'node:util'
export function clarificationPage(run,after=''){
 const active=!['completed','failed','cancelled'].includes(run.state)
 const questions=active?(run.clarifications??(run.pending_clarification?[run.pending_clarification]:[])):[]
 let offset=0
 if(after!==''){
  if(typeof after!=='string'||!/^[0-9]{1,20}:[0-9]{1,3}$/.test(after))throw Error('Invalid clarification cursor')
  const [revision,index]=after.split(':')
  offset=Number(index)
  if(revision!==String(run.revision))throw Error('Clarification cursor revision changed; restart pagination')
  if(offset<1||offset>=questions.length)throw Error('Clarification cursor outside pending questions')
 }
 const q=questions[offset]
 return {worker_clarification:q?{assignment_id:q.assignment_id,stage_id:q.stage_id,stage_attempt:q.stage_attempt,
  request_id:q.request.request_id,call_id:q.request.call_id,questions:q.request.questions,context_hash:q.context_hash}:null,
  worker_clarifications:{count:questions.length,revision:run.revision,next_cursor:offset+1<questions.length?`${run.revision}:${offset+1}`:null}}
}
export async function readCoordinatorState(runtime,agent,scope,operation,kind,args){
 const call=p=>runtime.client.call(`/api/v1/messaging/${p}`)
 const authority=async()=>{
  const binding=runtime.profiles.binding(agent.id)
  if(binding?.operationClosed||binding?.managedBuilder||binding?.managedAssignment||!isDeepStrictEqual(binding?.managedOperation,operation)||!isDeepStrictEqual(binding?.managedCoordinator,scope))throw Error('Coordinator read binding changed')
  const {control}=await call(`teams/${encodeURIComponent(scope.team_id)}/coordinator-control`)
  if(!control||control.revision!==scope.control_revision||control.conversation_id!==scope.conversation_id||control.team_id!==scope.team_id||control.home_hub!==runtime.host
   ||control.request?.operation_id!==operation.id||control.request.attempt!==operation.attempt||control.request.epoch!==operation.epoch||control.worker?.session_id!==agent.id||control.worker.node_id!==runtime.host)throw Error('Coordinator read control changed')
  const activation=await call(`teams/${encodeURIComponent(scope.team_id)}/activation`)
  if(!activation.active||activation.authority_valid!==true||activation.revision!==control.request.activation_revision||activation.team_revision!==control.request.team_revision)throw Error('Coordinator read activation changed')
  return activation
 }
 const activation=await authority()
 let result
 if(kind==='configuration'){
  const bindings=activation.snapshot.bindings
  if(!Array.isArray(bindings))throw Error('Coordinator activated bindings unavailable')
  if(args.binding_id==='')result={team_id:scope.team_id,activation_revision:activation.revision,team_revision:activation.team_revision,
   bindings:bindings.map(b=>({id:b.id,workflow:{id:b.workflow.id,version:b.workflow.version,hash:b.workflow.hash},inputs:b.workflow.pack.inputs,completion_stages:b.workflow.pack.completion_stages})),details_included:false,resources:await readCoordinatorResources(call,activation,scope.team_id,args.resource_after??'')}
  else{
   const binding=bindings.find(b=>b.id===args.binding_id)
   if(!binding)throw Error('Unknown activated Coordinator binding')
   result={team_id:scope.team_id,activation_revision:activation.revision,team_revision:activation.team_revision,binding,details_included:true}
  }
 }else if(kind==='status'){
  const run=await call(`work-runs/${encodeURIComponent(args.run_id)}`)
  if(run.id!==args.run_id||run.home_hub!==runtime.host||run.team_id!==scope.team_id)throw Error('Coordinator run outside fixed team')
  result={id:run.id,team_id:run.team_id,revision:run.revision,state:run.state,waiting_reason:run.waiting_reason??null,
   team_revision:run.team_revision,activation_revision:run.authorization?.revision??null,context_hash:run.context_hash,
   prior_run_id:run.prior_run_id??null,inputs:args.omit_inputs===true?null:run.inputs??null,inputs_included:args.omit_inputs!==true,
   ...clarificationPage(run,args.clarification_after??''),
   human_acceptance:run.human_acceptance?{state:run.human_acceptance.state,revision:run.human_acceptance.revision,
    evidence_hash:run.human_acceptance.evidence_hash,requested_at:run.human_acceptance.requested_at,
    decision:run.human_acceptance.decision??null,evidence_included:false}:null,
   completion_authorized:run.completion_authorized,stages:run.stages,delivery:run.delivery??null,task_workspaces:run.task_workspaces??null,cancellation:run.cancellation??null,intervention:run.intervention??null,
   coordinator:run.coordinator??null,execution_accounting:await readWorkRunAccounting(runtime,run),observed_at:Date.now(),details_included:true}
 }else throw Error('Invalid Coordinator read kind')
 await authority()
 if(Buffer.byteLength(JSON.stringify(result))>65536)throw Error('Coordinator result exceeds bounded detail limit; result is incomplete and was not returned')
 return result
}
export function mountCoordinatorReadTools(agentCtx,agent,runtime,scope){
 const op=structuredClone(runtime.profiles.binding(agent.id)?.managedOperation),tools=agentCtx.get('tools').forScope(agentCtx),policies=agentCtx.get('kodeOfficialToolPolicies'),disposers=[]
 const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(v)
 const definitions=[
  {name:'kode_coordinator_configuration',kind:'configuration',key:'binding_id',empty:true,description:'Read only the activated configuration of your fixed team. Empty binding_id lists workflow choices, input names and paged current budget/provider facts; pass resource_after from resources.next_cursor until all targets are covered; a returned binding ID reads full frozen workflow/project/delivery details. This does not activate, reserve or dispatch anything.'},
  {name:'kode_coordinator_workflow_status',kind:'status',key:'run_id',description:'Read current Hub state, original inputs, prior-task reference, stages, human acceptance decision and delivery receipt for a WorkRun of your fixed team. Acceptance evidence bodies are omitted; decision reason and exact evidence hash are retained. A pending stage or accepted run is not completion. Worker questions are paged one request at a time. Pass worker_clarifications.next_cursor as clarification_after until null; if revision changes, restart from the first page. Set omit_inputs=true to avoid repeating large original inputs. This does not advance or retry work.'},
 ]
 try{
  for(const d of definitions){
   const valid=a=>a&&typeof a==='object'&&!Array.isArray(a)&&Object.keys(a).every(k=>k===d.key||d.kind==='configuration'&&k==='resource_after'||d.kind==='status'&&['clarification_after','omit_inputs'].includes(k))&&(id(a[d.key])||d.empty&&a[d.key]==='')
    &&(!('resource_after' in a)||d.kind==='configuration'&&a.binding_id===''&&(a.resource_after===''||id(a.resource_after)))
    &&(!('omit_inputs' in a)||typeof a.omit_inputs==='boolean')
    &&(!('clarification_after' in a)||a.clarification_after===''||/^[0-9]{1,20}:[0-9]{1,3}$/.test(a.clarification_after))
   disposers.push(tools.register({name:d.name,description:d.description,parameters:{type:'object',additionalProperties:false,properties:{[d.key]:{type:'string'},...(d.kind==='configuration'?{resource_after:{type:'string'}}:{clarification_after:{type:'string'},omit_inputs:{type:'boolean'}})},required:[d.key]},output:{schema:{type:'object'},render:(_args,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:args=>{
    runtime.entry.assertToolBody(agent,d.name,args);if(!valid(args))throw Error('Invalid Coordinator read arguments')
    return readCoordinatorState(runtime,agent,scope,op,d.kind,args)
   }}))
   disposers.push(policies.register(d.name,{capabilities:['read'],network:false,workspaceLock:false,implementation:tools.get(d.name,agent),validateArguments:valid,authorize:request=>request.agent===agent&&valid(request.arguments)},agent))
  }
 }catch(error){for(const d of disposers.reverse())d();throw error}
 return()=>{for(const d of disposers.splice(0).reverse())d()}
}

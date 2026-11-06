import { isDeepStrictEqual } from 'node:util'
import { createDeliveryTracker } from './delivery-tracker.js'
/** Create only from the fixed consumed conversation request and activated binding. */
export function mountCoordinatorWorkflowTool(agentCtx,agent,runtime,scope){
 const name='kode_coordinator_workflow_start',tools=agentCtx.get('tools').forScope(agentCtx),policies=agentCtx.get('kodeOfficialToolPolicies')
 const op=structuredClone(runtime.profiles.binding(agent.id)?.managedOperation)
 const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(v)
 const valid=a=>a&&typeof a==='object'&&!Array.isArray(a)&&Object.keys(a).filter(k=>k!=='prior_run_id').sort().join(',')==='binding_id,inputs,request_id,source_message_id'
  &&(!('prior_run_id' in a)||id(a.prior_run_id))
  &&['binding_id','request_id','source_message_id'].every(k=>id(a[k]))&&a.inputs&&typeof a.inputs==='object'&&!Array.isArray(a.inputs)
  &&Object.keys(a.inputs).length<=64&&Object.entries(a.inputs).every(([k,v])=>id(k)&&typeof v==='string'&&v.trim()&&!v.includes('\0'))&&Buffer.byteLength(JSON.stringify(a))<=60000
 const dispose=tools.register({name,description:'Start a WorkRun using an activated delivery binding of your fixed team and a consumed Hub request reference. Inputs must match that configured workflow. For a user-requested follow-up to terminal work, supply prior_run_id to preserve its lineage; this never resumes old work or bypasses workflow gates. A receipt means accepted, not executed or completed. Reuse identical request_id and arguments for recovery.',
  parameters:{type:'object',additionalProperties:false,properties:{request_id:{type:'string'},source_message_id:{type:'string'},binding_id:{type:'string'},prior_run_id:{type:'string'},inputs:{type:'object',additionalProperties:{type:'string'}}},required:['request_id','source_message_id','binding_id','inputs']},
  output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
  execute:async args=>{
   runtime.entry.assertToolBody(agent,name,args);if(!valid(args))throw Error('Invalid Coordinator workflow arguments')
   const b=runtime.profiles.binding(agent.id)
   if(b?.operationClosed||b?.managedBuilder||b?.managedAssignment||!isDeepStrictEqual(b?.managedOperation,op)||!isDeepStrictEqual(b?.managedCoordinator,scope))throw Error('Coordinator workflow binding changed')
   const base=`/api/v1/messaging/conversations/${encodeURIComponent(scope.conversation_id)}`
   const recover=async()=>{
    const {run}=await runtime.client.call(`${base}/work-runs/requests/${encodeURIComponent(args.request_id)}`)
    if(!run)return null
    const origin=run.coordinator
    if((run.prior_run_id??null)!==(args.prior_run_id??null)||run.team_id!==scope.team_id||run.context?.binding?.id!==args.binding_id||!isDeepStrictEqual(run.inputs,args.inputs)
     ||origin?.conversation_id!==scope.conversation_id||origin.source_message_id!==args.source_message_id||origin.operation_id!==op.id||origin.attempt!==op.attempt||origin.epoch!==op.epoch||origin.control_revision!==scope.control_revision)throw Error('Coordinator workflow receipt conflict')
    return run
   }
   const prior=await recover();if(prior)return prior
   const {input}=await runtime.client.call(`${base}/messages/${encodeURIComponent(args.source_message_id)}/coordinator-input`)
   if(input?.request?.operation_id!==op.id||input.request.control_revision!==scope.control_revision||input.request.attempt!==op.attempt||input.request.epoch!==op.epoch||input.receipt?.worker?.session_id!==agent.id)throw Error('Coordinator workflow input mismatch')
   await createDeliveryTracker(agent,runtime.client).confirm({id:input.receipt.message_id})
   try{return await runtime.client.call(`${base}/work-runs`,{...args,operation_id:op.id,attempt:op.attempt,epoch:op.epoch,control_revision:scope.control_revision})}
   catch(error){const saved=await recover();if(saved)return saved;throw error}
  }})
 try{const policy=policies.register(name,{capabilities:['read','delegate'],network:false,workspaceLock:false,implementation:tools.get(name,agent),validateArguments:valid,authorize:request=>request.agent===agent&&valid(request.arguments)},agent);return()=>{policy();dispose()}}
 catch(error){dispose();throw error}
}

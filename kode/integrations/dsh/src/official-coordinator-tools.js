/** Scoped publication uses fixed Host authority and the existing durable delivery tracker. */
import { isDeepStrictEqual } from 'node:util'
import { createDeliveryTracker } from './delivery-tracker.js'
import { mountCoordinatorWorkflowTool } from './coordinator-workflow-tool.js'
import { mountCoordinatorReadTools } from './coordinator-read-tools.js'
import { mountCoordinatorAnswerTool, COORDINATOR_ANSWER_TOOL } from './coordinator-answer-tool.js'
import { coordinatorReplyUpdate } from './coordinator-reply-update.js'
export const OFFICIAL_COORDINATOR_TOOLS=Object.freeze(['kode_coordinator_publish_reply','kode_coordinator_workflow_start','kode_coordinator_configuration','kode_coordinator_workflow_status'])
export const OPTIONAL_COORDINATOR_TOOLS=Object.freeze([COORDINATOR_ANSWER_TOOL])
export function coordinatorToolNames(granted){
 return [...OFFICIAL_COORDINATOR_TOOLS,...OPTIONAL_COORDINATOR_TOOLS.filter(name=>granted.includes(name))]
}
export function mountOfficialCoordinatorTools(agentCtx,agent,runtime,scope,allowedTools=OFFICIAL_COORDINATOR_TOOLS){
 const operation=structuredClone(runtime.profiles.binding(agent.id)?.managedOperation)
 const tools=agentCtx.get('tools').forScope(agentCtx),policies=agentCtx.get('kodeOfficialToolPolicies'),name=OFFICIAL_COORDINATOR_TOOLS[0]
 const valid=args=>args&&typeof args==='object'&&!Array.isArray(args)&&Object.keys(args).sort().join(',')==='content,request_id,source_message_id'
  &&['request_id','source_message_id'].every(k=>typeof args[k]==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(args[k]))
  &&typeof args.content==='string'&&args.content.trim().length>0&&!args.content.includes('\0')&&Buffer.byteLength(args.content)<=65536
 const dispose=tools.register({name,description:'Publish a user-visible reply for a consumed request in your fixed conversation. Supply its Hub request reference and a stable request_id. Repeat identical arguments after an uncertain result; do not claim publication without its receipt. Publication does not complete a workflow.',
  parameters:{type:'object',additionalProperties:false,properties:{request_id:{type:'string'},source_message_id:{type:'string'},content:{type:'string'}},required:['request_id','source_message_id','content']},
  output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
  execute:async args=>{
   runtime.entry.assertToolBody(agent,name,args)
   if(!valid(args))throw Error('Invalid Coordinator publication arguments')
   const binding=runtime.profiles.binding(agent.id)
   if(binding?.operationClosed||binding?.managedBuilder||binding?.managedAssignment||!isDeepStrictEqual(binding?.managedOperation,operation)||!isDeepStrictEqual(binding?.managedCoordinator,scope))throw Error('Coordinator publication binding changed')
   const base=`/api/v1/messaging/conversations/${encodeURIComponent(scope.conversation_id)}`
   const body={...args,operation_id:operation.id,attempt:operation.attempt,epoch:operation.epoch,control_revision:scope.control_revision}
   const recover=async()=>{
    const {message}=await runtime.client.call(`${base}/coordinator-replies/${encodeURIComponent(args.request_id)}`)
    if(!message)return null
    if(message.conversation_id!==scope.conversation_id||message.team_id!==scope.team_id||message.actor?.kind!=='superagent'
     ||message.in_reply_to!==args.source_message_id||message.content!==args.content
     ||body.source_update&&!isDeepStrictEqual(message.source_update,body.source_update)
     ||['request_id','operation_id','attempt','epoch','control_revision'].some(k=>message[k]!==body[k]))throw Error('Coordinator publication receipt conflict')
    return message
   }
   const prior=await recover();if(prior)return prior
   const {authority}=await runtime.client.call(`${base}/messages/${encodeURIComponent(args.source_message_id)}/reply-authorities/${scope.control_revision}`)
   const input=authority?.source,request=authority?.request
   if(request?.operation_id!==operation.id||request.attempt!==operation.attempt||request.epoch!==operation.epoch||request.control_revision!==scope.control_revision)throw Error('Coordinator publication input mismatch')
   const fresh=input?.receipt?.worker?.session_id!==agent.id
   if(!fresh)await createDeliveryTracker(agent,runtime.client).confirm({id:input.receipt.message_id})
   const update=await coordinatorReplyUpdate(runtime,agent,scope,args.source_message_id)
   if(fresh&&(!authority.transfer||!update||authority.transfer.run_id!==update.run_id))throw Error('Coordinator publication requires consumed successor update')
   if(update){
    await createDeliveryTracker(agent,runtime.client).confirm({id:update.message_id})
    body.source_update={run_id:update.run_id,revision:update.revision}
   }
   // Recover a committed lost reply by reading, never automatically repeat the write.
   try{return await runtime.client.call(`${base}/coordinator-replies`,body)}
   catch(error){const saved=await recover();if(saved)return saved;throw error}
  }})
 try{
  const policy=policies.register(name,{capabilities:['read'],network:false,workspaceLock:false,implementation:tools.get(name,agent),validateArguments:valid,authorize:request=>request.agent===agent&&valid(request.arguments)},agent)
  let workflow,reads,answers
  try{workflow=mountCoordinatorWorkflowTool(agentCtx,agent,runtime,scope);reads=mountCoordinatorReadTools(agentCtx,agent,runtime,scope);if(allowedTools.includes(COORDINATOR_ANSWER_TOOL))answers=mountCoordinatorAnswerTool(agentCtx,agent,runtime,scope)}catch(error){reads?.();workflow?.();policy();throw error}
  return ()=>{answers?.();reads();workflow();policy();dispose()}
 }catch(error){dispose();throw error}
}

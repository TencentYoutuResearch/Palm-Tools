/** Resolve only a home-recorded human conversation input bound to this control operation. */
import { createHash } from 'node:crypto'
export async function coordinatorInput(client,binding,message,inputId,signal){
 const scope=binding?.managedCoordinator
 if(!scope)return null
 if(binding.operationClosed||binding.managedBuilder||binding.managedAssignment)throw Error('Coordinator runtime binding unavailable')
 const op=binding.managedOperation,valid=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v)
 let envelope
 try{envelope=JSON.parse(message.content)}catch{throw Error('Coordinator requires bound conversation input')}
 if(!valid(scope.team_id)||!valid(scope.conversation_id)||!Number.isSafeInteger(scope.control_revision)||scope.control_revision<1
  ||!envelope||!['kode.coordinator.input.v1','kode.coordinator.run-update.v1'].includes(envelope.format)||envelope.operation_id!==op?.id||envelope.conversation_id!==scope.conversation_id
  ||message.source.node_id!==message.target.node_id||message.source.session_id!==`coordinator-owner-${createHash('sha256').update(scope.team_id).digest('hex')}`)throw Error('Coordinator input identity mismatch')
 if(envelope.format==='kode.coordinator.run-update.v1'){
  if(!valid(envelope.run_id)||!Number.isSafeInteger(envelope.revision)||envelope.revision<1)throw Error('Invalid Coordinator update reference')
  const {update}=await client.call(`/api/v1/messaging/work-runs/${encodeURIComponent(envelope.run_id)}/coordinator-updates/${envelope.revision}`,undefined,signal)
  const receipt=update?.receipt,summary=update?.summary
  if(receipt?.message_id!==message.id||receipt.run_id!==envelope.run_id||receipt.revision!==envelope.revision||receipt.team_id!==scope.team_id||receipt.conversation_id!==scope.conversation_id
   ||receipt.operation_id!==op.id||receipt.attempt!==op.attempt||receipt.epoch!==op.epoch||receipt.control_revision!==scope.control_revision||receipt.home_hub!==message.target.node_id
   ||receipt.worker?.node_id!==message.target.node_id||receipt.worker?.session_id!==message.target.session_id||summary?.run_id!==envelope.run_id||summary.revision!==envelope.revision
   ||summary.team_id!==scope.team_id||summary.conversation_id!==scope.conversation_id||!valid(summary.source_message_id))throw Error('Coordinator update receipt mismatch')
  return {id:inputId,role:'user',source:{kind:'user',form:'kode-coordinator-run-update',runId:envelope.run_id,revision:envelope.revision,sourceMessageId:summary.source_message_id,teamId:scope.team_id,conversationId:scope.conversation_id},content:[{type:'text',text:`Hub workflow event (not a new human request): ${JSON.stringify(summary)}\nRead current workflow status before replying. For blocked work, explain the observed waiting reason and any required decision; do not claim completion, bypass stages, enlarge permissions or repeat side effects. For terminal work, publish only the verified result. Reply for the original Hub request reference: ${summary.source_message_id}. Do not start the workflow again. Event reference: ${message.id}`} ]}
 }
 if(!valid(envelope.source_message_id))throw Error('Invalid Coordinator source reference')
 const {input}=await client.call(`/api/v1/messaging/conversations/${encodeURIComponent(scope.conversation_id)}/messages/${encodeURIComponent(envelope.source_message_id)}/coordinator-input`,undefined,signal)
 const request=input?.request,receipt=input?.receipt,human=input?.message
 if(receipt?.message_id!==message.id||receipt.source_message_id!==envelope.source_message_id||receipt.conversation_id!==scope.conversation_id||receipt.team_id!==scope.team_id
  ||receipt.operation_id!==op.id||receipt.actor?.kind!=='human'||receipt.home_hub!==message.target.node_id||receipt.worker?.node_id!==message.target.node_id||receipt.worker?.session_id!==message.target.session_id
  ||request?.operation_id!==op.id||request.control_revision!==scope.control_revision||request.attempt!==op.attempt||request.epoch!==op.epoch
  ||human?.id!==envelope.source_message_id||human.conversation_id!==scope.conversation_id||human.team_id!==scope.team_id||human.actor?.kind!=='human'||typeof human.content!=='string')throw Error('Coordinator input receipt mismatch')
 if (human.prior_run_id !== undefined && !valid(human.prior_run_id)) throw Error('Invalid human follow-up reference')
 return {id:inputId,role:'user',source:{kind:'user'},content:[{type:'text',text:human.content},{type:'text',text:`Hub request reference: ${human.id}${human.prior_run_id ? `\nHuman follow-up to settled WorkRun: ${human.prior_run_id}. Preserve this exact prior_run_id when starting the revised task. Use the currently authorized workflow and resource/budget checks; the prior task does not grant permission to skip stages or reuse its completion verdict.` : ''}`} ]}
}

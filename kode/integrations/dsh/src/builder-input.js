/** Resolve human input from its owner-only Hub record, never from an Agent-supplied envelope. */
export async function builderInput(client,binding,message,inputId,signal){
  if(!binding?.managedBuilder)return null
  const op=binding.managedOperation
  let envelope
  try{envelope=JSON.parse(message.content)}catch{throw new Error('Builder requires bound owner input')}
  if(!envelope||envelope.format!=='kode.builder.input.v1'||envelope.operation_id!==op?.id
      ||typeof envelope.request_id!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(envelope.request_id)
      ||message.source.node_id!==message.target.node_id||message.source.session_id!==`builder-owner-${op.id}`)throw new Error('Builder input identity mismatch')
  const {input}=await client.call(`/api/v1/messaging/operations/${encodeURIComponent(op.id)}/builder-inputs/${encodeURIComponent(envelope.request_id)}`,undefined,signal)
  const request=input?.request,receipt=input?.receipt
  if(receipt?.message_id!==message.id||receipt.operation_id!==op.id||receipt.actor?.kind!=='human'
      ||receipt.home_hub!==message.target.node_id||receipt.worker?.node_id!==message.target.node_id||receipt.worker?.session_id!==message.target.session_id
      ||request?.draft_id!==binding.managedBuilder.draft_id||request.attempt!==op.attempt||request.epoch!==op.epoch
      ||request.request_id!==envelope.request_id||typeof request.content!=='string')throw new Error('Builder owner input receipt mismatch')
  return {id:inputId,role:'user',source:{kind:'user'},content:[{type:'text',text:request.content}]}
}

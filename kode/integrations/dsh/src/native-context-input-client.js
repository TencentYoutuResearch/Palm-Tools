/** Exact native admission transport. Existing authenticated Session client only.
 * It never creates credentials, claims a lease, installs tools or invokes a CLI.
 * An uncertain Begin is fenced locally: status reads cannot grant execution.
 */
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
const fail=message=>Object.assign(Error(message),{code:'NATIVE_CONTEXT_RECEIPT_REJECTED'})
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function createNativeContextInputClient({client,binding}){
  binding=structuredClone(binding)
  if(typeof client?.call!=='function'||!binding||!['context_key','manifest_sha256'].every(k=>/^[a-f0-9]{64}$/.test(binding[k]))
    ||binding.session_id!==`context-${binding.context_key}`||!binding.journal_id||!binding.host_binding_id
    ||!binding.operation?.id||![binding.operation.attempt,binding.operation.epoch].every(n=>Number.isSafeInteger(n)&&n>0))throw fail('Exact frozen native binding required')
  const path=`/api/v1/messaging/context-v2/contexts/${encodeURIComponent(binding.context_key)}`
  let attempted=false,command,admission,terminalAttempted=false
  const check=value=>{
    const expected={context_key:binding.context_key,request_id:command.request_id,entry_id:command.entry_id,claim_id:command.claim_id,
      operation_id:binding.operation.id,attempt:binding.operation.attempt,epoch:binding.operation.epoch,
      session_id:binding.session_id,journal_id:binding.journal_id,profile_id:'conversation_reply_v1',tools:[]}
    if(!value||typeof value.admission_id!=='string'||!value.admission_id||Object.entries(expected).some(([k,v])=>!isDeepStrictEqual(value[k],v)))throw fail('Native receipt differs from frozen source')
    return structuredClone(value)
  }
  return Object.freeze({
    async begin(source,signal){
      if(attempted)throw fail('Native input already attempted; status lookup only')
      source=structuredClone(source)
      if(source?.authority?.context_key!==binding.context_key||source.authority.session_id!==binding.session_id
        ||source.authority.journal_id!==binding.journal_id||source.authority.operation_id!==binding.operation.id
        ||source.authority.attempt!==binding.operation.attempt||source.authority.epoch!==binding.operation.epoch
        ||source.entry?.context_key!==binding.context_key||source.entry.journal_id!==binding.journal_id
        ||source.entry.operation_id!==binding.operation.id||source.entry.state!=='claimed'||!source.entry.id||!source.entry.claim_id
        ||source.message?.id!==source.entry.source_message_id||typeof source.message.content!=='string'
        ||createHash('sha256').update(source.message.content).digest('hex')!==source.entry.source_content_sha256)throw fail('Native source differs from owned claim')
      command={request_id:`native:${hash(['native-turn-v1',binding.session_id,binding.journal_id,source.entry.id,source.entry.claim_id])}`,
        host_binding_id:binding.host_binding_id,context_key:binding.context_key,session_id:binding.session_id,journal_id:binding.journal_id,
        entry_id:source.entry.id,claim_id:source.entry.claim_id,source_message_id:source.entry.source_message_id,
        source_content_sha256:source.entry.source_content_sha256,manifest_sha256:binding.manifest_sha256}
      attempted=true // Reserve before await, including unknown transport outcomes.
      const response=check(await client.call(`${path}/native-inputs`,structuredClone(command),signal))
      if(response.new_admission!==true||response.dispatch_allowed!==true||response.state!=='admitted')throw fail('Receipt does not permit a new native dispatch')
      admission=response
      return structuredClone(response)
    },
    async status(signal){
      if(!command)throw fail('No native request to reconcile')
      const result=await client.call(`${path}/native-requests/${encodeURIComponent(command.request_id)}`,undefined,signal)
      if(result?.state==='not_found'&&result.new_admission===false&&result.dispatch_allowed===false)return structuredClone(result)
      const receipt=check(result)
      if(admission&&receipt.admission_id!==admission.admission_id)throw fail('Native admission identity changed')
      if(receipt.new_admission!==false||receipt.dispatch_allowed!==false)throw fail('Status cannot authorize inference')
      return receipt // Never restores local dispatch permission.
    },
    async finish({request_id,usage_event_id,text},signal){
      if(!admission||terminalAttempted)throw fail('No fresh admitted turn to finish')
      if(!request_id||!usage_event_id||typeof text!=='string'||!text.trim())throw fail('Exact native outcome required')
      terminalAttempted=true
      const receipt=check(await client.call(`${path}/native-inputs/${encodeURIComponent(admission.admission_id)}/finish`,
        {request_id,admission_id:admission.admission_id,outcome:{kind:'completed',usage_event_id,text}},signal))
      if(receipt.admission_id!==admission.admission_id||receipt.new_admission!==false||receipt.dispatch_allowed!==false||receipt.state!=='outbox')throw fail('Native completion receipt mismatch')
      return receipt
    },
  })
}

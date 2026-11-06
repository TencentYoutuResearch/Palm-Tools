import { verifyBuilderCreation } from './builder-start-command.js'
import { canonical } from './builder-accept-command.js'
const valid=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
export const builderCloseKey=(draft,startup)=>JSON.stringify(['builder-close',draft.home_hub,draft.id,startup.receipt.request.operation.id])
function identity(draft,startup){
 if(startup?.state!=='created'||startup.home_hub!==draft.home_hub||startup.command?.start?.draft_id!==draft.id||startup.command.start.operation?.worker?.node_id!==draft.home_hub)throw Error('Confirmed local Builder startup required')
 verifyBuilderCreation(startup.receipt,startup.command,draft.home_hub)
 const operation=startup.receipt.request.operation,price=startup.command.start.price_id
 const funding=startup.command.start.operation.funding
 if(!valid(operation.id)||!valid(price)||!Number.isSafeInteger(funding?.amount)||funding.amount<1||!valid(funding.unit))throw Error('Confirmed Builder accounting identity unavailable')
 return {operation_id:operation.id,attempt:operation.attempt,epoch:operation.epoch,price_id:price,settlement:'internal_price'}
}
function verifySlot(slot,draft,startup){
 const fixed=identity(draft,startup),command=slot?.command?.command
 if(!slot||slot.home_hub!==draft.home_hub||slot.draft_id!==draft.id||slot.command?.operation_id!==fixed.operation_id||Object.keys(slot.command).sort().join(',')!=='command,operation_id'||!valid(command?.request_id)
  ||Object.keys(command).sort().join(',')!=='attempt,epoch,price_id,request_id,settlement'||!['prepared','closing','waiting_accounting','closed'].includes(slot.state)
  ||['attempt','epoch','price_id','settlement'].some(key=>command[key]!==fixed[key]))throw Error('Wrong Builder close scope')
 return slot
}
function verifyResult(result,slot,draft,startup){
 const input=slot.command,intent=result?.intent
 if(result?.home_hub!==draft.home_hub||!['closing','waiting_accounting','closed'].includes(result.state)||intent?.operation_id!==input.operation_id||intent.draft_id!==draft.id||intent.state!=='closing'
  ||canonical(intent.request)!==canonical(input.command))throw Error('Builder close receipt identity mismatch')
 if(result.state==='closing'){
  if(!['pending_inputs','execution_running'].includes(result.reason)||(result.reason==='pending_inputs'&&(!Number.isSafeInteger(result.pending_inputs)||result.pending_inputs<1)))throw Error('Invalid Builder closing state')
 }else if(result.state==='waiting_accounting'){
  const accounting=result.accounting,budget=accounting?.budget,funding=startup.command.start.operation.funding,calls=accounting?.unresolved_calls
  if(result.execution_resumed!==false||result.reason!=='needs_reconciliation'||result.retryable!==false
   ||accounting?.state!=='waiting_accounting'||accounting.reason!=='needs_reconciliation'||accounting.retryable!==false
   ||accounting.recovery!=='blocked_until_trusted_usage_is_reconciled'
   ||!valid(budget?.reservation_id)||budget.unit!==funding.unit||budget.finalized!==false
   ||!Number.isSafeInteger(budget.charged)||budget.charged<0||!Number.isSafeInteger(budget.held)||budget.held<0
   ||!Number.isSafeInteger(budget.charged+budget.held)||budget.charged+budget.held!==funding.amount||budget.frozen!==(budget.held>0)
   ||!Array.isArray(calls)||!calls.length||new Set(calls.map(call=>call?.call_id)).size!==calls.length
   ||calls.some(call=>!valid(call?.call_id)||!['finished','uncertain'].includes(call.state)||call.accounting_status!=='usage_unresolved'))throw Error('Builder unresolved usage not confirmed')
 }else{
  const accounting=result.accounting,reservation=accounting?.reservation,funding=startup.command.start.operation.funding
  if(!accounting||result.execution_resumed!==false||accounting.operation_id!==input.operation_id||accounting.attempt!==input.command.attempt||accounting.draft_id!==draft.id
   ||accounting.price_id!==input.command.price_id||accounting.label!=='团队预算'||accounting.basis!=='configured_internal_price'||accounting.provider_cost_status!=='unconfirmed'||accounting.completion_authorized!==false
   ||reservation?.finalized!==true||reservation.held!==0||!Number.isSafeInteger(reservation.charged)||reservation.charged<0||reservation.charged>funding.amount
   ||reservation.request?.amount!==funding.amount||reservation.request.unit!==funding.unit)throw Error('Builder budget release not confirmed')
 }
 return result
}
export async function readBuilderClose(storage,draft,startup){
 identity(draft,startup)
 const slot=await storage.read(builderCloseKey(draft,startup))
 if(!slot)return null
 verifySlot(slot,draft,startup)
 if(slot.state==='closed')verifyResult(slot.receipt,slot,draft,startup)
 if(slot.state==='waiting_accounting')verifyResult(slot.last_observation,slot,draft,startup)
 return slot
}
export async function confirmBuilderClose({storage,draft,startup,request,signal,uuid=()=>crypto.randomUUID(),onPrepared=()=>{}}){
 const fixed=identity(draft,startup),{operation_id,...fields}=fixed,key=builderCloseKey(draft,startup)
 const slot=verifySlot(await storage.reserve(key,{state:'prepared',home_hub:draft.home_hub,draft_id:draft.id,command:{operation_id,command:{request_id:uuid(),...fields}}}),draft,startup)
 if(signal?.aborted)throw Error('Disposed')
 if(slot.state==='closed'){const receipt=verifyResult(slot.receipt,slot,draft,startup);onPrepared(slot);return receipt}
 if(slot.state==='waiting_accounting'){const receipt=verifyResult(slot.last_observation,slot,draft,startup);onPrepared(slot);return receipt}
 onPrepared(slot)
 const receipt=verifyResult(await request(slot.command,{signal}),slot,draft,startup)
 if(signal?.aborted)throw Error('Disposed')
 await storage.save(key,{...slot,state:receipt.state,...(receipt.state==='closed'?{receipt}:{last_observation:receipt})})
 return receipt
}
export async function requestBuilderClose(command,{signal}={}){
 const response=await fetch('/api/kode/builder/close',{method:'POST',credentials:'same-origin',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),headers:{'content-type':'application/json'},body:JSON.stringify(command)})
 if(!response.ok)throw Error('Builder close not confirmed')
 return response.json()
}

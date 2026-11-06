/** Graceful creation-assistant close. A durable Hub intent fences new owner inputs. */
import { isDeepStrictEqual } from 'node:util'
import { readBuilderCloseStatus } from './builder-close-status.js'
export async function closeBuilder(host,input){
 const valid=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(v)
 const c=input?.command
 if(!input||Object.keys(input).some(k=>!['operation_id','command'].includes(k))||!valid(input.operation_id)||!c
  ||Object.keys(c).some(k=>!['request_id','attempt','epoch','price_id','settlement'].includes(k))
  ||!valid(c.request_id)||!valid(c.price_id)||!['attempt','epoch'].every(k=>Number.isSafeInteger(c[k])&&c[k]>0)||c.settlement!=='internal_price')throw Error('Invalid Builder close command')
 input=structuredClone(input)
 host.builderCloses??=new Map()
 const prior=host.builderCloses.get(input.operation_id)
 if(prior){if(!isDeepStrictEqual(prior.input,input))throw Error('Builder pending close conflict');return prior.task}
 const task=perform(host,input);host.builderCloses.set(input.operation_id,{input,task})
 try{return await task}finally{if(host.builderCloses.get(input.operation_id)?.task===task)host.builderCloses.delete(input.operation_id)}
}
async function perform(host,{operation_id,command}){
 const runtime=host.execution,path=`/api/v1/messaging/operations/${encodeURIComponent(operation_id)}`
 const intent=await runtime.client.call(`${path}/builder-close`,command)
 let state=await runtime.client.call(`${path}/builder-close`)
 const check=op=>{if(op.id!==operation_id||op.attempt!==command.attempt||op.epoch!==command.epoch)throw Error('Builder close execution changed')}
 check(state.operation)
 if(state.pending_inputs)return {home_hub:runtime.host,state:'closing',reason:'pending_inputs',pending_inputs:state.pending_inputs,intent}
 const id=state.operation.worker.session_id,owned=host.handles.get(id)
 const binding=runtime.profiles.binding(id)
 if(owned&&(binding?.managedOperation?.id!==operation_id||binding.managedOperation.attempt!==command.attempt||binding.managedOperation.epoch!==command.epoch||binding.managedBuilder?.draft_id!==intent.draft_id))throw Error('Builder close runtime identity mismatch')
 if(state.operation.state==='active'){
  if(!owned)throw Error('Builder close requires its live runtime; no execution was resumed')
  let timer
  try{
   const idle=await Promise.race([owned.agent.whenIdle().then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),10000)})])
   if(!idle)return {home_hub:runtime.host,state:'closing',reason:'execution_running',intent}
  }finally{clearTimeout(timer)}
  state=await runtime.client.call(`${path}/builder-close`);check(state.operation)
  if(state.pending_inputs)return {home_hub:runtime.host,state:'closing',reason:'pending_inputs',pending_inputs:state.pending_inputs,intent}
  await owned.run.finish()
 }
 const reported=await runtime.client.call(path);check(reported)
 if(reported.state!=='reported')throw Error('Builder close execution is not reported')
 // A lost report response is recovered from Hub state without replaying inference.
 if(owned){await runtime.profiles.patchBinding(id,{operationClosed:true});await owned.dispose()}
 let accounting
 try{
  accounting=await runtime.client.call(`${path}/builder-accounting`,{...command,expected_revision:reported.revision})
 }catch(error){
  // A missing usage event is a durable accounting blocker, not a transient
  // close failure. Read Home's owner-scoped status; never retry execution.
  if(error?.status===400&&error.message==='kode backend (400): official usage remains unresolved'){
   const status=await readBuilderCloseStatus(runtime.client,operation_id,runtime.host)
   if(status.operation?.id!==operation_id||status.operation.attempt!==command.attempt||status.operation.epoch!==command.epoch
      ||status.accounting?.state!=='waiting_accounting'||status.accounting.reason!=='needs_reconciliation')throw error
   return {home_hub:runtime.host,state:'waiting_accounting',reason:'needs_reconciliation',retryable:false,
    intent,accounting:status.accounting,execution_resumed:false}
  }
  throw error
 }
 return {home_hub:runtime.host,state:'closed',intent,accounting,execution_resumed:false}
}

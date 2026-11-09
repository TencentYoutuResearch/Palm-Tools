/** Graceful Coordinator drain and accounting. A durable Hub intent fences new owner inputs. */
import { isDeepStrictEqual } from 'node:util'
export async function closeCoordinator(host,input){
 const valid=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(v)
 const c=input?.command
 if(!input||Object.keys(input).some(k=>!['operation_id','command'].includes(k))||!valid(input.operation_id)||!c
  ||Object.keys(c).some(k=>!['request_id','attempt','epoch','price_id','settlement','idle_only'].includes(k))
  ||!valid(c.request_id)||!valid(c.price_id)||!['attempt','epoch'].every(k=>Number.isSafeInteger(c[k])&&c[k]>0)||c.settlement!=='internal_price'||(c.idle_only!==undefined&&typeof c.idle_only!=='boolean'))throw Error('Invalid Coordinator close command')
 input=structuredClone(input)
 host.coordinatorCloses??=new Map()
 const prior=host.coordinatorCloses.get(input.operation_id)
 if(prior){if(!isDeepStrictEqual(prior.input,input))throw Error('Coordinator pending close conflict');return prior.task}
 const task=perform(host,input);host.coordinatorCloses.set(input.operation_id,{input,task})
 try{return await task}finally{if(host.coordinatorCloses.get(input.operation_id)?.task===task)host.coordinatorCloses.delete(input.operation_id)}
}
async function perform(host,{operation_id,command}){
 const runtime=host.execution,path=`/api/v1/messaging/operations/${encodeURIComponent(operation_id)}`
 const intent=await runtime.client.call(`${path}/coordinator-close`,command)
 let state=await runtime.client.call(`${path}/coordinator-close`)
 const check=op=>{if(op.id!==operation_id||op.attempt!==command.attempt||op.epoch!==command.epoch)throw Error('Coordinator close execution changed')}
 check(state.operation)
 if(state.pending_runs)return {state:'closing',reason:'pending_runs',pending_runs:state.pending_runs,intent}
 if(state.pending_inputs)return {state:'closing',reason:'pending_inputs',pending_inputs:state.pending_inputs,intent}
 const id=state.operation.worker.session_id,owned=host.handles.get(id)
 const binding=runtime.profiles.binding(id)
 if(owned&&(binding?.managedOperation?.id!==operation_id||binding.managedOperation.attempt!==command.attempt||binding.managedOperation.epoch!==command.epoch||binding.managedCoordinator?.team_id!==intent.team_id))throw Error('Coordinator close runtime identity mismatch')
 if(state.operation.state==='active'){
  if(!owned)throw Error('Coordinator close requires its live runtime; no execution was resumed')
  let timer
  try{
   const idle=await Promise.race([owned.agent.whenIdle().then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),10000)})])
   if(!idle)return {state:'closing',reason:'execution_running',intent}
  }finally{clearTimeout(timer)}
  state=await runtime.client.call(`${path}/coordinator-close`);check(state.operation)
  if(state.pending_runs)return {state:'closing',reason:'pending_runs',pending_runs:state.pending_runs,intent}
 if(state.pending_inputs)return {state:'closing',reason:'pending_inputs',pending_inputs:state.pending_inputs,intent}
  await owned.run.finish()
 }
 const reported=await runtime.client.call(path);check(reported)
 if(reported.state!=='reported')throw Error('Coordinator close execution is not reported')
 // A lost report response is recovered from Hub state without replaying inference.
 if(owned){await runtime.profiles.patchBinding(id,{operationClosed:true});await owned.dispose()}
 const {idle_only,...accountingCommand}=command
 const accounting=await runtime.client.call(`${path}/coordinator-accounting`,{...accountingCommand,expected_revision:reported.revision})
 return {state:'closed',intent,accounting,execution_resumed:false}
}

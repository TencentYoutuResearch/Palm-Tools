/** At-most-once history restoration under a newly bound Coordinator operation. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { mountCoordinatorContext } from './coordinator-context.js'
import { mountOfficialCoordinatorTools } from './official-coordinator-tools.js'
export async function resumeCoordinator(host,command){
 command=structuredClone(command)
 const key=JSON.stringify([command.session_id,command.command_id]),fingerprint=createHash('sha256').update(JSON.stringify(command)).digest('hex')
 const pending=host.coordinatorResumes.get(key)
 if(pending){if(pending.fingerprint!==fingerprint)throw Error('Coordinator resume identity conflict');return pending.task}
 const task=perform(host,command,fingerprint)
 host.coordinatorResumes.set(key,{fingerprint,task})
 try{return await task}finally{if(host.coordinatorResumes.get(key)?.task===task)host.coordinatorResumes.delete(key)}
}
async function perform(host,command,fingerprint){
 const runtime=host.execution,profiles=runtime.profiles
 host.stop.signal.throwIfAborted()
 const prior=await profiles.update(state=>{
  const binding=state.bindings[command.session_id]
  const rows=binding?.coordinatorResumeReceipts??{}
  if(Object.hasOwn(rows,command.command_id)){
   if(rows[command.command_id].fingerprint!==fingerprint)throw Error('Coordinator resume identity conflict')
   return rows[command.command_id]
  }
  if(!binding?.coordinatorPredecessor||binding.operationClosed||!isDeepStrictEqual(binding.managedOperation,command.operation)
    ||!isDeepStrictEqual(binding.managedCoordinator,command.coordinator))throw Error('Coordinator authorized predecessor required')
  binding.coordinatorResumeReceipts=rows
  Object.defineProperty(rows,command.command_id,{value:{state:'resuming',fingerprint,request:command,updated_at:Date.now()},enumerable:true,writable:true,configurable:true})
  return null
 })
 if(prior)return {...prior,state:prior.state==='resuming'?'uncertain':prior.state}
 const save=state=>profiles.update(snapshot=>{
  const row=snapshot.bindings[command.session_id]?.coordinatorResumeReceipts?.[command.command_id]
  if(row?.fingerprint!==fingerprint)throw Error('Coordinator resume receipt changed')
  row.state=state;row.updated_at=Date.now();return row
 })
 const validateAdmission=agent=>{
  const binding=profiles.binding(command.session_id)
  if(binding?.operationClosed||binding?.revision!==command.profile_revision||!isDeepStrictEqual(binding?.managedOperation,command.operation)
   ||!isDeepStrictEqual(binding?.managedCoordinator,command.coordinator)||agent.options.provider!==command.provider
   ||agent.options.model!==command.model||(agent.options.reasoningEffort??null)!==(command.effort??null))throw Error('Coordinator resume admission changed')
 }
 try{
  const persistence=host.ctx.get('sessionPersistence')
  if(!persistence)throw Error('Coordinator history persistence unavailable')
  const history=await persistence.open(command.session_id,'read',{signal:host.stop.signal})
  try{if(history.header.id!==command.session_id||history.header.cwd!==command.cwd||history.header.isSeeded)throw Error('Coordinator restored history identity mismatch')}
  finally{await history.close()}
  const owned=await host.resume({resumeSessionId:command.session_id,
   agentOptions:{provider:command.provider,model:command.model,...(command.effort==null?{}:{reasoningEffort:command.effort})},
   validateAdmission,signal:host.stop.signal,setup:async(ctx,agent)=>{
    const dispose=await mountCoordinatorContext(ctx,agent,runtime,command.coordinator);ctx.effect(()=>dispose)
    ctx.effect(()=>mountOfficialCoordinatorTools(ctx,agent,runtime,command.coordinator,command.tools))
   }},{tools:command.tools})
  appendPluginRecord(owned.agent.session,'plugin:kode/coordinator-resume',{command_id:command.command_id,fingerprint})
  await host.ctx.sessions.flush(owned.agent.session)
  return await save('resumed')
 }catch(error){await save('uncertain').catch(()=>{});throw error}
}

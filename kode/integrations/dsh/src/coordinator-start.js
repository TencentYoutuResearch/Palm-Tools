/** Owner start uses atomic Hub funding/control and the existing durable official creation ledger. */
import { isDeepStrictEqual } from 'node:util'
import { OFFICIAL_COORDINATOR_TOOLS, coordinatorToolNames } from './official-coordinator-tools.js'
export async function startCoordinator(host,input){
 const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(v)
 if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['command_id','team_id','provider','start'].includes(k))
  ||!id(input.command_id)||!id(input.team_id)||!id(input.start?.request_id)||!id(input.start?.operation?.worker?.session_id)
  ||typeof input.provider!=='string'||!input.provider||input.provider.length>4096||input.provider.includes('\0'))throw Error('Invalid Coordinator start command')
 input=structuredClone(input);host.stop.signal.throwIfAborted()
 const key=JSON.stringify([input.team_id,input.start.request_id]),pending=host.coordinatorStarts.get(key)
 if(pending){if(!isDeepStrictEqual(pending.input,input))throw Error('Coordinator pending start identity conflict');return pending.task}
 const task=perform(host,input);host.coordinatorStarts.set(key,{input,task})
 try{return await task}finally{if(host.coordinatorStarts.get(key)?.task===task)host.coordinatorStarts.delete(key)}
}
async function perform(host,input){
 const runtime=host.execution,result=await runtime.client.call(`/api/v1/messaging/teams/${encodeURIComponent(input.team_id)}/coordinator-starts`,input.start,host.stop.signal)
 const op=result.bundle.operation,selection=op.selection_policy,control=result.control
 const command={command_id:input.command_id,session_id:op.worker.session_id,operation:{id:op.id,attempt:op.attempt,epoch:op.epoch},profile_revision:selection.profile_revision,
  provider:input.provider,model:selection.model,effort:selection.effort??null,cwd:input.start.operation.grant_scope.target.root,tools:coordinatorToolNames(input.start.operation.grant_scope.tools),
  coordinator:{team_id:input.team_id,conversation_id:control.conversation_id,control_revision:control.revision}}
 // Historical creation receipts never trigger another preparation, claim or resume.
 if(runtime.profiles.binding(op.worker.session_id)?.coordinatorResumeReceipts?.[input.command_id])return host.resumeCoordinator(command)
 if(host.dispatches.get(op.worker.session_id,input.command_id))return host.dispatches.dispatch(command)
 const prepared=await host.prepareCoordinator({command_id:input.command_id,team_id:input.team_id,control_revision:control.revision,operation_revision:op.revision,
  profile_id:input.start.operation.resource.profile,provider:input.provider})
 return isDeepStrictEqual(control.predecessor?.worker,op.worker)?host.resumeCoordinator(prepared):host.dispatches.dispatch(prepared)
}

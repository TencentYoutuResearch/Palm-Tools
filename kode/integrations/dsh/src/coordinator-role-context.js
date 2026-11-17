/** User role configuration appended after the unchanged legacy procedure. */
import {isDeepStrictEqual} from 'node:util'
import {Session,appendPluginRecord} from '@deepseek-ai/dsh-session'
import {snapshotTeamRolePrompt,validateRolePromptSnapshot,rolePromptInstructions} from './team-role-prompts.js'
const pending=new WeakMap()
const MARKER='plugin:kode/coordinator-role-prompt'
export function coordinatorRoleSection(binding){
 const value=binding.coordinatorRolePrompt
 if(value==null)return ''
 const snapshot=validateRolePromptSnapshot(value)
 if(snapshot.team_id!==binding.managedCoordinator?.team_id||snapshot.role.kind!=='coordinator')throw Error('Coordinator role identity mismatch')
 return rolePromptInstructions(snapshot)
}
export async function mountCoordinatorRoleContext(agentCtx,agent,runtime,scope,control){
 const path=`/api/v1/messaging/teams/${encodeURIComponent(scope.team_id)}/activation`
 const read=async()=>{
  const activation=await runtime.client.call(path),team=activation?.snapshot?.team
  if(activation.active!==true||activation.authority_valid!==true||activation.home_hub!==runtime.host
   ||activation.team_id!==scope.team_id||activation.team_revision!==control.request.team_revision
   ||team?.id!==scope.team_id||team.home_hub!==runtime.host||team.revision!==control.request.team_revision)throw Error('Coordinator role activation changed')
  return snapshotTeamRolePrompt({home_hub:runtime.host,team_id:team.id,team_revision:team.revision,spec:team.spec})
 }
 const operation=structuredClone(runtime.profiles.binding(agent.id).managedOperation)
 const snapshot=await read(),data={version:1,session_id:agent.id,team_id:scope.team_id,conversation_id:scope.conversation_id,snapshot}
 const events=Session.prototype.snapshotEvents.call(agent.session),records=events.filter(e=>e.type===MARKER)
 if(records.length>1||records.length===1&&!isDeepStrictEqual(records[0].data,data))throw Error('Coordinator role snapshot changed; new context required')
 if(!records.length){
  if(snapshot&&events.some(e=>['user/message','assistant/message'].includes(e.type)))throw Error('Existing Coordinator history needs explicit new role context')
  appendPluginRecord(agent.session,MARKER,data)
 }
 if(!isDeepStrictEqual(await read(),snapshot))throw Error('Coordinator role changed during persistence')
 const latest=(await runtime.client.call(`/api/v1/messaging/teams/${encodeURIComponent(scope.team_id)}/coordinator-control`)).control
 if(!isDeepStrictEqual(latest,control))throw Error('Coordinator role control changed')
 const binding=runtime.profiles.binding(agent.id)
 if(!isDeepStrictEqual(binding.managedCoordinator,scope)||!isDeepStrictEqual(binding.managedOperation,operation)||binding.operationClosed)throw Error('Coordinator role binding changed')
 if(binding.coordinatorRolePrompt!==undefined&&!isDeepStrictEqual(binding.coordinatorRolePrompt,snapshot))throw Error('Coordinator role profile snapshot changed')
 await runtime.profiles.patchBinding(agent.id,{coordinatorRolePrompt:snapshot})
 const text=coordinatorRoleSection(runtime.profiles.binding(agent.id))
 pending.set(agent.session,{data,read,scope:structuredClone(scope),operation})
 const dispose=text?agentCtx.get('systemPrompt').section({name:'kode.coordinator.role',order:81,interpolate:false,text}):()=>{}
 return ()=>{pending.delete(agent.session);dispose()}
}

/** Called after the original factory enters its live Session, before execution.open. */
export async function assertCoordinatorRolePromptDurable(agent,runtime){
 const row=pending.get(agent.session),binding=runtime.profiles.binding(agent.id)
 if(!row||!isDeepStrictEqual(binding.managedCoordinator,row.scope)||!isDeepStrictEqual(binding.managedOperation,row.operation)||binding.operationClosed)throw Error('Coordinator role publication identity changed')
 const records=Session.prototype.snapshotEvents.call(agent.session).filter(e=>e.type===MARKER)
 if(records.length!==1||!isDeepStrictEqual(records[0].data,row.data)||!isDeepStrictEqual(binding.coordinatorRolePrompt,row.data.snapshot)||!isDeepStrictEqual(await row.read(),row.data.snapshot))throw Error('Coordinator role publication snapshot changed')
 if(await agent.ctx.sessions.flush(agent.session)!==true)throw Error('Coordinator role snapshot not durable')
 if(!isDeepStrictEqual(await row.read(),row.data.snapshot))throw Error('Coordinator role changed during publication')
}

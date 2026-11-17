/** Only the current, newly committed Composer Send may trigger interactive work.
 * Persisted selection belongs to the original message receipt, not a later caller.
 */
import {isDeepStrictEqual as equal} from 'node:util'
const keys=['team_id','team_revision','participant_id','target_id','workspace_id','audience_revision']
const token=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(v)
export function validInteractiveSelection(value){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k)&&(['team_revision','audience_revision'].includes(k)?Number.isSafeInteger(value[k])&&value[k]>0:token(value[k])))}
export async function dispatchNewInteractiveMessage({runtime,input,message,surface_id}){
 if(!input?.interactive_selection)return message
 const state=(value)=>({...message,interactive_delivery:{execution_mode:'interactive_native',usage:{state:'unknown'},automatic_replay_allowed:false,...value}})
 if(message?.newly_stored!==true)return state({state:'stored_only',reason:'original_request_already_stored'})
 const selected=input.interactive_selection
 if(!validInteractiveSelection(selected)||!equal(message.interactive_selection,selected)||message.surface_id!==surface_id||!token(message.id)||!token(message.thread_id)||!equal(message.actor,{kind:'human',id:'local_owner'})||message.content!==input.content||message.thread_id!==(input.thread_id??message.id))return state({state:'not_ready',reason:'source_confirmation_mismatch'})
 if(!runtime?.open||!runtime?.deliver)return state({state:'not_ready',reason:'interactive_runtime_unavailable'})
 try{
  const opened=await runtime.open({...selected,request_id:`composer:${message.id}`,surface_id,thread_id:message.thread_id,context_epoch:1,first_source_message_id:message.id})
  const b=opened?.binding
  if(opened.state!=='ready'||!b?.binding_id||keys.some(k=>k==='workspace_id'?b.workspace?.workspace_id!==selected[k]:b[k]!==selected[k])||b.surface_id!==surface_id||b.thread_id!==message.thread_id||b.execution_mode!=='interactive_native')throw Error('Interactive open differs')
  const delivered=await runtime.deliver({binding_id:b.binding_id,source_message_id:message.id,request_id:`composer-source:${message.id}`})
  if(delivered?.state!=='published'||!equal(delivered.binding,b)||!token(delivered.message_id))throw Error('Interactive completion unconfirmed')
  return state({state:'published',reply_message_id:delivered.message_id})
 }catch{return state({state:'uncertain',reason:'inspect_original_source_before_retry'})}
}

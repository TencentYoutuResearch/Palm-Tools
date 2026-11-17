/** Owner-reviewed task dispatch. Stored messages and mentions never imply execution. */
import {sameDiscussionScope,discussionKey} from './discussion-model.js'
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
export const taskRequestKey = (scope,surface,message) => 'kode.task.v1:'+JSON.stringify([discussionKey(scope),surface,message])
export function validateTask(task,scope,surface){
 if(!validId(task?.id)||!sameDiscussionScope(task.scope,scope)||![task.origin_surface_id,task.archive_surface_id].includes(surface))throw Error('任务范围不匹配')
 return task
}
export async function taskCreation({surface,message,archive,team,summary,requestId=crypto.randomUUID()}){
 if(!surface.enabled||!archive?.enabled||archive.kind!=='channel'||!sameDiscussionScope(surface.scope,archive.scope)||message.surface_id!==surface.id||!sameDiscussionScope(message.scope,surface.scope)||message.actor?.kind!=='human'||message.actor.id!=='local_owner'||message.kind!=='discussion')throw Error('只能从当前空间的本人消息创建任务')
 if(!surface.team_ids.includes(team?.id)||!archive.team_ids.includes(team.id)||team.home_hub!==surface.scope.home_hub||!Number.isSafeInteger(team.revision)||team.revision<1)throw Error('团队或频道已变化')
 const text=summary.trim();if(!text||new TextEncoder().encode(text).length>16384)throw Error('任务说明不能为空或超过限制')
 const input={request_id:requestId,origin_surface_id:surface.id,origin_message_id:message.id,origin_revision:surface.revision,archive_surface_id:archive.id,archive_revision:archive.revision,team_id:team.id,team_revision:team.revision,summary:text,publication:null}
 if(archive.id!==surface.id){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));input.publication={destination_id:archive.id,destination_revision:archive.revision,summary_sha256:Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('')}}
 return input
}
export function dispatchRequest(task,execution,team,activation,binding,requestId=crypto.randomUUID()){
 if(execution?.task_id!==task.id||execution.task_revision!==task.revision||execution.context?.task_id!==task.id||execution.context.team_id!==task.team_id||!sameDiscussionScope(execution.context.scope,task.scope)||execution.work_run||execution.context_basis!=='current_task'||!/^[a-f0-9]{64}$/.test(execution.context_sha256))throw Error('任务执行上下文已经变化')
 if(team.id!==task.team_id||team.revision!==task.team_revision||team.home_hub!==task.scope.home_hub||!team.spec?.delivery_bindings?.some(b=>b.id===binding))throw Error('执行方案已变化')
 if(!activation?.active||activation.team_id!==team.id||activation.home_hub!==team.home_hub||activation.team_revision!==team.revision||!Number.isSafeInteger(activation.revision)||activation.revision<1)throw Error('请先在团队设置中完成当前版本授权')
 return{request_id:requestId,expected_task_revision:task.revision,binding_id:binding,activation_revision:activation.revision,context_sha256:execution.context_sha256}
}
export function executionLabel(execution){
 const r=execution?.work_run;if(!r)return '待确认执行'
 if(r.completion_authorized===true&&r.state==='completed')return '已完成 · 交付条件已验证'
 return ({completed:'执行结束 · 交付尚未验证',cancelled:'已取消',cancelling:'正在取消 · 等待停止确认',failed:'执行失败',running:'执行中',pending:'等待执行',waiting:'等待执行条件'})[r.state]||'执行状态：'+r.state
}
export function persistedTaskRequest(storage,key){
 return{read(){const raw=storage.getItem(key);return raw?JSON.parse(raw):{}},reserve(phase,input){const old=this.read();if(old[phase])return old[phase];storage.setItem(key,JSON.stringify({...old,[phase]:input}));return input},saveTask(task){storage.setItem(key,JSON.stringify({...this.read(),task}))}}
}

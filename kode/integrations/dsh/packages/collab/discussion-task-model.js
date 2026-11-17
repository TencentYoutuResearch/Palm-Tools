/** Owner review journal only. Tasks and WorkRuns remain authoritative on the Rust Hub. */
import {discussionKey,sameDiscussionScope} from './discussion-model.js'
export const taskDraftKey=(scope,surface,thread)=>'kode.discussion.task.v1:'+JSON.stringify([discussionKey(scope),surface,thread])
export const taskActionKey=(scope,task,action)=>'kode.discussion.task-action.v1:'+JSON.stringify([discussionKey(scope),task,action])
export const summaryHash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('')
export function createTaskJournal(storage,key){
 const read=()=>JSON.parse(storage.getItem(key)||'{"summary":"","team":"","archive":"","pending":null,"receipt":null}')
 const save=value=>{storage.setItem(key,JSON.stringify(value));return value}
 return {read,edit(patch){const row=read();if(row.pending||row.receipt)throw Error('原请求尚未确认，不能覆盖。');return save({...row,...patch})},
  prepare(input){const row=read();if(row.pending)return row.pending;if(row.receipt)throw Error('此操作已记录，请刷新任务。');save({...row,pending:input});return input},
  accept(input,receipt){const row=read();if(JSON.stringify(row.pending)!==JSON.stringify(input))throw Error('本地请求已改变。');save({...row,pending:null,receipt})}}
}
export function validateTask(task,scope){
 if(!task?.id||!sameDiscussionScope(task.scope,scope)||!Number.isSafeInteger(task.revision)||task.revision<1||!task.thread_id||!task.team_id||!task.context_id)throw Error('任务归属不匹配，请重新打开原讨论串。')
 return task
}
export function tasksForThread(page,scope,surface,thread){
 if(page?.surface_id!==surface||!Array.isArray(page.items))throw Error('任务目录不匹配。')
 return page.items.map(t=>validateTask(t,scope)).filter(t=>(t.origin_surface_id===surface&&t.origin_message_id===thread)||(t.archive_surface_id===surface&&t.thread_id===thread))
}
export async function prepareTaskReview({scope,surface,root,archive,team,summary}){
 if(root?.id!==root?.thread_id||root?.surface_id!==surface.id||root?.kind!=='discussion'||root?.actor?.kind!=='human'||root?.actor?.id!=='local_owner'||!sameDiscussionScope(root?.scope,scope))throw Error('只能从你发起的讨论创建任务。')
 if(!surface.enabled||!archive?.enabled||archive.kind!=='channel'||!sameDiscussionScope(surface.scope,scope)||!sameDiscussionScope(archive.scope,scope)||team?.home_hub!==scope.home_hub||!surface.team_ids.includes(team.id)||!archive.team_ids.includes(team.id))throw Error('工作区、频道或团队权限已变化，请刷新。')
 const text=summary.trim();if(!text||new TextEncoder().encode(text).length>16384)throw Error('请填写不超过 16 KB 的任务摘要。')
 const hash=await summaryHash(text)
 return {scope,source:surface.id,thread:root.id,archiveTitle:archive.title,teamName:team.spec?.name||team.id,hash,input:{request_id:crypto.randomUUID(),origin_surface_id:surface.id,origin_message_id:root.id,origin_revision:surface.revision,archive_surface_id:archive.id,archive_revision:archive.revision,team_id:team.id,team_revision:team.revision,summary:text,publication:{destination_id:archive.id,destination_revision:archive.revision,summary_sha256:hash}}}
}
export function validateCreatedTask(task,review){
 validateTask(task,review.scope)
 if(['origin_surface_id','origin_message_id','origin_revision','archive_surface_id','archive_revision','team_id','team_revision','summary'].some(k=>task[k]!==review.input[k]))throw Error('任务回执与批准摘要不一致，请恢复原请求。')
 return task
}
export function validateExecution(preview,task,scope){
 validateTask(task,scope)
 const context=preview?.context
 if(preview?.task_id!==task.id||preview.task_revision!==task.revision||!context||context.task_id!==task.id||context.context_id!==task.context_id||context.team_id!==task.team_id||context.summary!==task.summary||!sameDiscussionScope(context.scope,scope)||!/^([a-f0-9]{64})$/.test(preview.context_sha256)||preview.execution_authorized!==false||preview.automatic_coordinator_dispatch!==false||(task.work_run_id??null)!==(preview.work_run?.id??null))throw Error('执行快照与任务不一致，请刷新后重新核对。')
 return preview
}
export function executionBindings(activation,task){
 if(!activation?.active||!activation.authority_valid||activation.home_hub!==task.scope.home_hub||activation.team_id!==task.team_id||activation.team_revision!==task.team_revision||!Number.isSafeInteger(activation.revision))throw Error('团队授权已失效或版本改变。请先在团队配置中重新核对授权。')
 const bindings=activation.snapshot?.bindings
 if(!Array.isArray(bindings))throw Error('团队流程配置不可用。')
 return bindings.filter(binding=>{
  const repositories=Object.values(binding.project?.config?.spec?.repositories??{}),stages=binding.workflow?.pack?.stages??[],targets=binding.delivery_policy?.config?.spec?.targets??[]
  return binding.workflow?.pack?.inputs?.length===1&&binding.workflow.pack.inputs[0]==='request'&&repositories.length&&repositories.every(r=>sameDiscussionScope({...r.workspace,home_hub:task.scope.home_hub},task.scope))&&targets.length&&targets.every(t=>t.kind==='local')&&stages.length&&stages.every(s=>s.execution?.network===false&&s.execution.capabilities?.length&&s.execution.capabilities.every(c=>['read','workspace_write'].includes(c)))
 })
}
export function prepareExecution(task,preview,activation,bindingId){
 validateExecution(preview,task,task.scope)
 if(task.state!=='recorded'||task.work_run_id||!executionBindings(activation,task).some(b=>b.id===bindingId))throw Error('任务状态或本地流程已变化，请重新核对。')
 return {request_id:crypto.randomUUID(),expected_task_revision:task.revision,binding_id:bindingId,activation_revision:activation.revision,context_sha256:preview.context_sha256}
}
export function validateExecutionReceipt(receipt,task,input){
 if(receipt?.task_id!==task.id||!receipt.work_run_id||receipt.context_sha256!==input.context_sha256||receipt.completion_authorized!==false)throw Error('执行回执不匹配，请恢复原请求。')
 return receipt
}
export function taskError(error){
 if([401,403].includes(error?.status))return '访问权限已失效，请恢复 owner 权限后重新打开原讨论串。'
 if(error?.status===404)return '后端接口或任务不可用，请检查后端版本和访问权限。'
 if([400,409,422].includes(error?.status))return '任务版本、受众或团队授权可能已变化。请刷新核对；未确认的操作只能恢复原请求，不能另建执行。'
 return error?.message||'请求尚未确认。请恢复原请求，不要重复创建。'
}

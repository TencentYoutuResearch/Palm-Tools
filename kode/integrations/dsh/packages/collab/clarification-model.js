/** Explicit question identity, isolated durable drafts, and verified queue receipts. */
import {discussionKey,sameDiscussionScope} from './discussion-model.js'
export const clarificationTarget=m=>({run_id:m.run_id,assignment_id:m.assignment_id,question_request_id:m.question_request_id})
export const clarificationKey=(scope,surface,thread,m)=>'kode.clarification.v1:'+JSON.stringify([discussionKey(scope),surface,thread,m.task_id,...Object.values(clarificationTarget(m))])
export function validateClarification(task,execution,message,scope,surface,thread){
 if(!thread||task.id!==message.task_id||task.archive_surface_id!==surface||task.thread_id!==thread||!sameDiscussionScope(task.scope,scope)||execution.task_id!==task.id||execution.work_run?.id!==message.run_id)throw Error('问题归属已变化，请重新打开原需求讨论串。')
 const question=execution.work_run.clarifications?.find(q=>q.run_id===message.run_id&&q.assignment_id===message.assignment_id&&q.request?.request_id===message.question_request_id&&q.state==='pending')
 if(!question)throw Error('此问题已不再等待回答。请刷新需求进度。')
 return {task,question}
}
export function createClarificationDraft(storage,key){
 const read=()=>{const raw=storage.getItem(key);return raw?JSON.parse(raw):{text:'',pending:null,receipt:null}}
 return {read,edit(text){const d=read();if(d.pending||d.receipt)throw Error('answer locked');storage.setItem(key,JSON.stringify({...d,text}))},
 prepare(message,surface,thread){const d=read();if(d.pending)return d.pending;if(d.receipt||!d.text.trim())throw Error('empty or answered');const pending={request_id:crypto.randomUUID(),source_surface_id:surface,thread_id:thread,...clarificationTarget(message),content:d.text.trim()};storage.setItem(key,JSON.stringify({...d,pending}));return pending},
 accept(input,receipt,scope,task){const source=receipt?.human_source;if(receipt?.snapshot!=='assignment_answer_receipt.v1'||receipt.state!=='queued'||receipt.completion_authorized!==false||!receipt.message_id||!receipt.source_message_id||source?.kind!=='collaboration_owner'||source.task_id!==task||source.surface_id!==input.source_surface_id||source.thread_id!==input.thread_id||!sameDiscussionScope(source.scope,scope)||Object.keys(input).some(k=>receipt.request?.[k]!==input[k])||Object.entries(clarificationTarget(input)).some(([k,v])=>receipt[k]!==v))throw Error('answer receipt mismatch');const d=read();if(d.pending?.request_id!==input.request_id)throw Error('draft changed');storage.setItem(key,JSON.stringify({text:'',pending:null,receipt}));return true}}
}

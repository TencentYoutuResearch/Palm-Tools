/** Discussion cannot borrow an older human request's execution authority. */
export function guardDiscussionTool(agent,name,args){
 // The installed loop/time plugins append user/message snapshots with these exact
 // non-authorizing source kinds and ordinary UUID IDs. They do not replace owner intent.
 const latest=(agent.session?.snapshotEvents?.()??[]).filter(e=>e.type==='user/message'
  &&!['runtime-context','time-context'].includes(e.data?.source?.kind)).at(-1)?.data
 const source=latest?.source
 if(source?.form==='kode-coordinator-clarification-answer'){
  const target=source.clarificationTarget
  if(name==='kode_coordinator_publish_reply'&&args?.source_message_id===source.sourceMessageId)return
  if(name==='kode_coordinator_workflow_status'&&target?.run_id&&args?.run_id===target.run_id)return
  if(name==='kode_coordinator_answer_clarification'&&target?.assignment_id&&target?.question_request_id
   &&args?.source_message_id===source.sourceMessageId&&args?.assignment_id===target.assignment_id&&args?.question_request_id===target.question_request_id)return
  throw Object.assign(Error('Clarification-answer turn permits only its exact target answer, own reply and bound run observation; a new workflow requires a separate owner request'),{code:'CLARIFICATION_AUTHORITY_REQUIRED'})
 }
 if(source?.form!=='kode-coordinator-discussion')return
 if(name==='kode_coordinator_publish_reply'&&args?.source_message_id===source.sourceMessageId)return
 if(name==='kode_coordinator_configuration')return
 if(name==='kode_coordinator_workflow_status'&&source.discussion?.run_id&&args?.run_id===source.discussion.run_id)return
 throw Object.assign(Error('Discussion turn permits only its own reply and bound run observation; execution and clarification require a separate owner action'),{code:'DISCUSSION_AUTHORITY_REQUIRED'})
}

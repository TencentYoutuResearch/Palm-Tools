import { createUserMessage } from '@deepseek-ai/dsh-llm'
import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {coordinatorInput} from '../src/coordinator-input.js'
import {guardDiscussionTool} from '../src/coordinator-discussion-guard.js'
function fixture(){
 const scope={team_id:'team',conversation_id:'conversation',control_revision:1},binding={managedOperation:{id:'op',attempt:1,epoch:1},managedCoordinator:scope}
 const message={id:'delivery',source:{node_id:'home',session_id:'coordinator-owner-'+createHash('sha256').update('team').digest('hex')},target:{node_id:'home',session_id:'coordinator'},content:JSON.stringify({format:'kode.coordinator.input.v1',operation_id:'op',conversation_id:'conversation',source_message_id:'source'})}
 const input={request:{operation_id:'op',control_revision:1,attempt:1,epoch:1},receipt:{message_id:'delivery',source_message_id:'source',conversation_id:'conversation',team_id:'team',operation_id:'op',actor:{kind:'human',id:'local_owner'},home_hub:'home',worker:message.target},message:{id:'source',conversation_id:'conversation',team_id:'team',actor:{kind:'human',id:'local_owner'},content:'REQ-A only: progress?',thread_context:[],execution_authorized:false,discussion:{surface_id:'surface',thread_id:'thread-a',team_id:'team',task_id:'task-a',run_id:'run-a',audience_revision:1,scope:{home_hub:'home',host_id:'home',workspace_id:'workspace',root_ref:'/fixture'}}}}
 return {binding,message,input,client:{call:async()=>({input})}}
}
test('discussion transport retains exact task/thread/run and no execution authority',async()=>{
 const f=fixture(),result=await coordinatorInput(f.client,f.binding,f.message,'kode-message-delivery')
 assert.equal(result.source.form,'kode-coordinator-discussion');assert.deepEqual(result.source.discussion,f.input.message.discussion)
 assert.equal(result.content[2].text,f.input.message.content);assert.match(result.content[0].text,/not execution authorization/)
 for(const mutate of [i=>i.message.actor.id='peer',i=>i.message.execution_authorized=true,i=>i.message.discussion.team_id='other',i=>i.message.discussion.task_id=null,i=>i.message.discussion.scope.home_hub='other']){
  const f=fixture();mutate(f.input);await assert.rejects(coordinatorInput(f.client,f.binding,f.message,'input'),/Discussion input route mismatch/)
 }
})
test('discussion cannot borrow old source to execute, answer, read B, or reply in B',async()=>{
 const f=fixture(),data=await coordinatorInput(f.client,f.binding,f.message,'kode-message-delivery'),events=[{type:'user/message',data}],agent={session:{snapshotEvents:()=>events}}
 for(const [name,args] of [['kode_coordinator_workflow_start',{source_message_id:'old-owner'}],['kode_coordinator_answer_clarification',{source_message_id:'old-owner'}],['kode_coordinator_publish_reply',{source_message_id:'other-thread'}],['kode_coordinator_workflow_status',{run_id:'run-b'}]])assert.throws(()=>guardDiscussionTool(agent,name,args),/Discussion turn/)
 guardDiscussionTool(agent,'kode_coordinator_publish_reply',{source_message_id:'source'});guardDiscussionTool(agent,'kode_coordinator_workflow_status',{run_id:'run-a'})
 events.push({type:'user/message',data:{source:{kind:'user'},content:[]}});guardDiscussionTool(agent,'kode_coordinator_workflow_start',{source_message_id:'new-owner'})
})

test('explicit answer turn cannot borrow old owner authority or answer another target',()=>{
 const data={source:{kind:'user',form:'kode-coordinator-clarification-answer',sourceMessageId:'answer-a',clarificationTarget:{run_id:'run-a',assignment_id:'assignment-a',question_request_id:'question-a'}}}
 const events=[{type:'user/message',data}],agent={session:{snapshotEvents:()=>events}}
 const answer={source_message_id:'answer-a',assignment_id:'assignment-a',question_request_id:'question-a'}
 guardDiscussionTool(agent,'kode_coordinator_answer_clarification',answer)
 guardDiscussionTool(agent,'kode_coordinator_publish_reply',{source_message_id:'answer-a'})
 guardDiscussionTool(agent,'kode_coordinator_workflow_status',{run_id:'run-a'})
 for(const [name,args] of [['kode_coordinator_workflow_start',{source_message_id:'old-owner'}],['kode_coordinator_answer_clarification',{...answer,source_message_id:'old-owner'}],['kode_coordinator_answer_clarification',{...answer,assignment_id:'assignment-b'}],['kode_coordinator_answer_clarification',{...answer,question_request_id:'question-b'}],['kode_coordinator_publish_reply',{source_message_id:'old-owner'}],['kode_coordinator_workflow_status',{run_id:'run-b'}]])assert.throws(()=>guardDiscussionTool(agent,name,args),{code:'CLARIFICATION_AUTHORITY_REQUIRED'})
 events.push({type:'user/message',data:{source:{kind:'user'},content:[]}})
 guardDiscussionTool(agent,'kode_coordinator_workflow_start',{source_message_id:'new-owner'})
 const failure=Error('History unavailable')
 assert.throws(()=>guardDiscussionTool({session:{snapshotEvents(){throw failure}}},'kode_coordinator_workflow_start',{}),error=>error===failure&&!error.code)
})

for(const form of ['kode-coordinator-discussion','kode-coordinator-clarification-answer'])test(`${form} authority survives actual runtime/time context shapes but a later owner resets it`,()=>{
 const owner=()=>({type:'user/message',data:createUserMessage({source:{kind:'user'},content:[{type:'text',text:'New owner request'}]})})
 const contexts=()=>[
  {kind:'runtime-context'},
  {kind:'runtime-context',form:'snapshot',sections:[{name:'runtime',text:'Context changed'}]},
  {kind:'time-context',form:'snapshot',sections:[{name:'time-context',text:'Current time'}]},
 ].map(source=>({type:'user/message',data:createUserMessage({source,content:[{type:'text',text:'Non-authorizing system context'}]})}))
 const events=[owner(),...contexts()],agent={session:{snapshotEvents:()=>events}}
 guardDiscussionTool(agent,'kode_coordinator_workflow_start',{source_message_id:'owner'})
 events.push({type:'user/message',data:createUserMessage({source:{kind:'user',form,sourceMessageId:'restricted',discussion:{run_id:'run-a'},clarificationTarget:{run_id:'run-a',assignment_id:'assignment-a',question_request_id:'question-a'}},content:[{type:'text',text:'Bound input'}]})})
 for(const context of contexts()){
  events.push(context)
  assert.throws(()=>guardDiscussionTool(agent,'kode_coordinator_workflow_start',{source_message_id:'old-owner'}),{code:form==='kode-coordinator-discussion'?'DISCUSSION_AUTHORITY_REQUIRED':'CLARIFICATION_AUTHORITY_REQUIRED'})
  assert.throws(()=>guardDiscussionTool(agent,'kode_coordinator_publish_reply',{source_message_id:'old-owner'}))
  guardDiscussionTool(agent,'kode_coordinator_publish_reply',{source_message_id:'restricted'})
 }
 events.push(owner(),...contexts())
 guardDiscussionTool(agent,'kode_coordinator_workflow_start',{source_message_id:'new-owner'})
 // A user saying "runtime-context" or carrying that form is still a new user input.
 events.push({type:'user/message',data:createUserMessage({source:{kind:'user',form:'runtime-context'},content:[{type:'text',text:'time-context'}]})})
 guardDiscussionTool(agent,'kode_coordinator_workflow_start',{source_message_id:'newer-owner'})
})

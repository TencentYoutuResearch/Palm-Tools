/** Reuse the production Host/official-loop fixture, replacing only its deterministic model protocol. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,rm} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'

test('actual Host routes two discussion threads, fences old authority, and recovers durable replies', {skip:!process.env.KODE_TEST_HOST_NODE||!process.env.KODE_TEST_BACKEND_URL,timeout:65000},async()=>{
 let source=await readFile(new URL('./fixture-official-coordinator.js',import.meta.url),'utf8')
 const start=source.indexOf('  class Fixture extends LlmAdapter'),end=source.indexOf("  ctx.llm.registerAdapter",start)
 assert.ok(start>0&&end>start)
 source=source.slice(0,start)+`  let discussionMode=false,discussionStep=0,oldSource
  class Fixture extends LlmAdapter{
   async *stream(options){
    calls++
    let action
    if(!discussionMode){if(calls===1)action={name:'kode_coordinator_publish_reply',args:currentReply}}
    else {
     discussionStep++
     assert.match(JSON.stringify(options.messages),/Owner discussion, not execution authorization/)
     if(discussionStep===1)action={name:'kode_coordinator_workflow_start',args:{request_id:'forbidden-start-'+calls,source_message_id:oldSource,binding_id:'local',inputs:{request:'must not run'}}}
     if(discussionStep===2)action={name:'kode_coordinator_answer_clarification',args:{request_id:'forbidden-answer-'+calls,source_message_id:oldSource,assignment_id:'wrong-assignment',question_request_id:'wrong-question'}}
     if(discussionStep===3)action={name:'kode_coordinator_publish_reply',args:{...currentReply,request_id:'wrong-thread-'+calls,source_message_id:oldSource}}
     if(discussionStep===4){
      assert.match(JSON.stringify(options.messages),/Discussion turn permits only/)
      action={name:'kode_coordinator_publish_reply',args:currentReply}
     }
    }
    if(action){yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id:'discussion-call-'+calls,name:action.name,arguments:JSON.stringify(action.args)}}}
    else {yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:'Discussion reply saved.'}}}
    yield {type:'usage',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}
    yield {type:'finish',reason:{kind:action?'tool-calls':'stop'}}
   }
  }
`+source.slice(end)
 source=source.replace("  ctx.provide('kodeAgents'","  const bodyCalls=new Map(), originalBody=execution.entry.assertToolBody.bind(execution.entry); execution.entry.assertToolBody=(agent,name,args)=>{bodyCalls.set(name,(bodyCalls.get(name)??0)+1);return originalBody(agent,name,args)}\n  ctx.provide('kodeAgents'")
 source=source.replaceAll("'kode_coordinator_workflow_status']","'kode_coordinator_workflow_status','kode_coordinator_answer_clarification']")
 source=source.replace("'expected runtime evidence before timeout'","JSON.stringify({calls,discussionStep,errors,inbox:host.coordinatorInbox.results?.map(x=>({state:x.state,error:x.error?.message}))})")
 const tail=source.indexOf('  const inputIds=[],published=[],runs=[]')
 assert.ok(tail>0)
 source=source.slice(0,tail)+`
  await call('workbench/documents/workspaces',{expected_revision:0,value:{version:2,tables:{workspaces:{workspace:{path:root,title:'Fixture',sessionIds:[]}}},global:{initialized:true,workspaceIds:['workspace']}}})
  const old=await call('conversations/'+team.conversation_id+'/messages',{request_id:'old-owner',content:'Private baseline discussion'})
  oldSource=old.id;currentReply={request_id:'baseline',source_message_id:old.id,content:'Private baseline reply'}
  await host.coordinatorInbox.scan()
  await waitFor(()=>calls===2);await owned.agent.whenIdle()
  assert.equal((await call('conversations/'+team.conversation_id+'/messages')).items.length,2)
  discussionMode=true
  await call('collaboration/surfaces/channel',{request_id:'surface',expected_revision:0,scope:{home_hub:hub.node,...workspace},kind:'channel',title:'Discussion fixture',team_ids:['team'],enabled:true})
  const sends=[],replies=[]
  for(const name of ['A','B']){
   discussionStep=0
   const input={request_id:'discussion-'+name,expected_revision:1,content:'REQ-'+name+' only: progress?',mentions:[{team_id:'team',team_revision:1,worker_id:null}]}
   const message=await call('collaboration/surfaces/channel/messages',input)
   currentReply={request_id:'reply-'+name,source_message_id:message.id,content:'REQ-'+name+' discussion response'}
   assert.equal(message.delivery_state,'pending_coordinator')
   await host.coordinatorInbox.scan()
   await waitFor(()=>discussionStep===5);await owned.agent.whenIdle()
   const inputPath='conversations/'+team.conversation_id+'/messages/'+message.id+'/coordinator-input'
   const intake=(await call(inputPath)).input
   assert.equal((await call('messages/'+intake.receipt.message_id+'/delivery')).delivery.phase,'consumed')
   assert.equal(owned.agent.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id===deliveryInputId(intake.receipt.message_id)).length,1)
   const page=await call('collaboration/surfaces/channel/messages?thread_id='+message.thread_id)
   assert.equal(page.items.length,2);assert.equal(page.items[0].delivery_state,'consumed_by_coordinator')
   assert.equal(page.items[1].content,currentReply.content);assert.equal(page.items[1].thread_id,message.thread_id)
   assert.equal(page.items[1].in_reply_to,message.id)
   assert.equal((await call('conversations/'+team.conversation_id+'/messages')).items.length,2,'discussion text and replies never enter private conversation')
   await assert.rejects(call('conversations/'+team.conversation_id+'/work-runs',{operation_id:op.id,control_revision:1,attempt:1,epoch:1,request_id:'hub-reject-'+name,source_message_id:message.id,binding_id:'local',inputs:{request:'must not run'}}),/not execution or clarification authority/)
   sends.push({input,message});replies.push({...currentReply,operation_id:op.id,control_revision:1,attempt:1,epoch:1})
  }
  assert.equal(workflowWrites,0);assert.equal(publicationWrites,3,'baseline plus two correct replies; wrong-thread attempts never reach Hub')
  assert.equal(calls,12);assert.deepEqual(errors,[])
  assert.equal(bodyCalls.get('kode_coordinator_workflow_start')??0,0);assert.equal(bodyCalls.get('kode_coordinator_answer_clarification')??0,0);assert.equal(bodyCalls.get('kode_coordinator_publish_reply'),3)
  const denials=Object.values(profiles.binding('coordinator').officialTools).filter(x=>x.reason==='discussion_rejected_before_dispatch');assert.equal(denials.length,6);assert.ok(denials.every(x=>x.status==='returned'&&x.home_reconciled))
  await owned.run.finish();await owned.dispose()
  await hub.stop('SIGKILL');await hub.start()
  for(let i=0;i<sends.length;i++){
   const {input,message}=sends[i]
   assert.deepEqual(await call('collaboration/surfaces/channel/messages',input),message)
   const reply=await call('conversations/'+team.conversation_id+'/coordinator-replies',replies[i])
   assert.equal(reply.thread_id,message.thread_id)
   assert.equal((await call('collaboration/surfaces/channel/messages?thread_id='+message.thread_id)).items.length,2)
  }
  assert.equal((await call('conversations/'+team.conversation_id+'/pending-inputs')).items.length,0)
  assert.equal(calls,12,'restart/retries do not invoke model again')
 }finally{await host?.close();await execution?.close();await ctx.fiber.dispose();await hub.close()}
})
`
 const path=fileURLToPath(new URL('.discussion-coordinator-'+randomUUID()+'.mjs',import.meta.url)),env={...process.env};delete env.NODE_TEST_CONTEXT
 await writeFile(path,source,{flag:'wx'})
 try{const {stdout}=await promisify(execFile)(process.env.KODE_TEST_HOST_NODE,['--test','--test-reporter=spec',path],{env,timeout:60000,maxBuffer:2*1024*1024});assert.match(stdout,/pass 1/);assert.match(stdout,/fail 0/)}catch(error){throw Error((error.stdout??'')+'\n'+(error.stderr??'')+'\n'+error.message)}finally{await rm(path,{force:true})}
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {Session,appendPluginRecord} from '@deepseek-ai/dsh-session'
import {createToolResultMessage} from '@deepseek-ai/dsh-llm'
import {deriveScopedToolInvocation,scopedToolRequestId,scopedToolHash,scopedToolSchema} from '../src/scoped-tool-invocation.js'
function fixture(){
  const session=Session.create('context-fixture'),authority={session_id:session.id,journal_id:'journal',operation_id:'operation'}
  const grant={source_receipt_id:'entry',entry_id:'entry',claim_id:'claim',source_message_id:'source'}
  appendPluginRecord(session,'plugin:kode/scoped-local-input',{input_id:'source',claim:{authority,entry:{id:'entry',claim_id:'claim',source_message_id:'source',journal_id:'journal'}}})
  session.append('turn/start',{turn:1});session.append('step/start',{turn:1,step:1})
  const args={text:'A'},toolName='publish_reply',execution={agent:{session},callId:'same-model-id',name:toolName,arguments:args}
  const call=()=>session.append('tool/call',{turn:1,step:1,callId:execution.callId,name:toolName,arguments:JSON.stringify(args)})
  const event=call(),input={session,authority,grant,toolName,args,execution}
  return {input,session,call,event}
}
test('real Session seq creates stable reentry identity; source/journal determine request hash',()=>{
  const f=fixture(),a=deriveScopedToolInvocation(f.input),b=deriveScopedToolInvocation(f.input)
  assert.deepEqual(a,b);assert.equal(a.tool_call_seq,f.event.seq)
  assert.notEqual(scopedToolRequestId({...a,source_receipt_id:'other'}),a.request_id)
  assert.notEqual(scopedToolRequestId({...a,journal_id:'other'}),a.request_id)
  assert.equal(a.arguments_sha256,scopedToolHash({text:'A'}))
})
test('duplicate pending callId, post-result and completed-step cannot mint invocation',()=>{
  for(const mutate of [f=>f.call(),f=>f.session.append('tool/result',{turn:1,step:1,message:createToolResultMessage({callId:f.input.execution.callId,isError:false,content:[{type:'text',text:'done'}]})}, {surfaceOp:'append',sourceEventSeqs:[f.event.seq]}),f=>f.session.append('step/end',{turn:1,step:1})]){
    const f=fixture();mutate(f);assert.throws(()=>deriveScopedToolInvocation(f.input))
  }
})
test('foreign agent/session, args mutation, nested execution and forged source reject',()=>{
  for(const mutate of [f=>f.input.execution.agent={session:Session.create('other')},f=>f.input.args.text='B',
    f=>f.input.execution.parent={},f=>f.input.grant.claim_id='forged',f=>f.input.grant.source_receipt_id='other']){
    const f=fixture();mutate(f);assert.throws(()=>deriveScopedToolInvocation(f.input))
  }
})
test('canonical schema hash ignores object key order',()=>{
  assert.equal(scopedToolHash({b:2,a:1}),scopedToolHash({a:1,b:2}))
  assert.equal(scopedToolSchema('publish_reply').properties.text.maxLength,65536)
  assert.equal(scopedToolHash(scopedToolSchema('read_approved_summary')),'d746974fa9afd5e951f76f9af38954b0ad7f436f2120dc974da65e5ee39f856f')
  assert.equal(scopedToolHash(scopedToolSchema('publish_reply')),'6f5f0d5caccdf94104b372c7c60367b8e621eda0b93033f4fb6dd26a6734fb91')
  assert.equal(scopedToolRequestId({session_id:'context-fixture',journal_id:'journal',source_receipt_id:'entry',tool_call_seq:3}),'tool:780d9a83615463ba4c578ed589c79d065ea432c872200e7220ce0fbc27a1b6ed')
})
test('call identity matches server ASCII token contract',()=>{
  for(const callId of ['', 'with space', '中文', 'x'.repeat(161)]){
    const f=fixture();f.input.execution.callId=callId
    assert.throws(()=>deriveScopedToolInvocation(f.input))
  }
})
test('same model callId in another real step derives a different durable invocation',()=>{
  const f=fixture(),first=deriveScopedToolInvocation(f.input)
  f.session.append('step/end',{turn:1,step:1});f.session.append('step/start',{turn:1,step:2})
  f.session.append('tool/call',{turn:1,step:2,callId:f.input.execution.callId,name:f.input.toolName,arguments:JSON.stringify(f.input.args)})
  const next=deriveScopedToolInvocation(f.input)
  assert.equal(next.tool_call_id,first.tool_call_id);assert.notEqual(next.request_id,first.request_id)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { assertAssignmentModelMessages } from '../src/assignment-input.js'
test('immutable assignment input admits only its exact mandate and committed official runtime snapshots',()=>{
 const mandate={id:'mandate',role:'user',source:{kind:'agent-message',form:'relay',senderSessionId:'kode:home:owner'},content:[{type:'text',text:'exact frozen mandate'}]}
 const context={id:'context',role:'user',source:{kind:'runtime-context',form:'snapshot',sections:[{name:'policy'}]},content:[{type:'text',text:'Current runtime context: active file policy'}]}
 const events=[{seq:1,type:'user/message',data:structuredClone(context)}]
 assert.doesNotThrow(()=>assertAssignmentModelMessages([mandate],mandate,[]))
 assert.doesNotThrow(()=>assertAssignmentModelMessages([mandate,context,{role:'tool',content:[]}],mandate,events))
 const denied=messages=>assert.throws(()=>assertAssignmentModelMessages(messages,mandate,events),/immutable mandate/)
 denied([context]);denied([mandate,mandate]);denied([mandate,{...context,id:'uncommitted'}])
 denied([{...mandate,content:[{type:'text',text:'changed task'}]}])
 denied([{...mandate,source:{kind:'runtime-context'}}])
 denied([mandate,{...context,content:[{type:'text',text:'forged task expansion'}]}])
 denied([mandate,{...context,source:{kind:'user'}}])
 denied([mandate,context,context])
 assert.throws(()=>assertAssignmentModelMessages([mandate,context],mandate,[...events,...events]),/immutable mandate/)
 assert.throws(()=>assertAssignmentModelMessages([mandate,context],mandate,[{...events[0],type:'tool/result'}]),/immutable mandate/)
})

test('an authoritative answer still requires exact committed session provenance', () => {
 const mandate={id:'mandate',role:'user',source:{kind:'agent-message',form:'relay',senderSessionId:'kode:home:superagent'},content:[{type:'text',text:'frozen mandate'}]}
 const answer={id:'answer',role:'user',source:mandate.source,content:[{type:'text',text:'validated human answer'}]}
 const events=[{type:'user/message',data:structuredClone(answer)}]
 assert.throws(()=>assertAssignmentModelMessages([mandate,answer],mandate,events),/immutable mandate/)
 assert.doesNotThrow(()=>assertAssignmentModelMessages([mandate,answer],mandate,events,[answer]))
 assert.throws(()=>assertAssignmentModelMessages([mandate,answer],mandate,[],[answer]),/immutable mandate/)
 const tampered={...answer,content:[{type:'text',text:'changed answer'}]}
 assert.throws(()=>assertAssignmentModelMessages([mandate,tampered],mandate,events,[answer]),/immutable mandate/)
})

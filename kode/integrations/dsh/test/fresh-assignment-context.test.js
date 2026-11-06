import test from 'node:test'
import assert from 'node:assert/strict'
import { freshAssignmentContext } from '../src/official-assignment-admission.js'
test('fresh derived context distinguishes exact initial policy metadata from any inherited or message history',()=>{
 let events=[]
 const agent={id:'worker',session:{header:{id:'worker',isSeeded:false},snapshotEvents:()=>structuredClone(events)}}
 assert.deepEqual(freshAssignmentContext(agent,true),{kind:'official_fresh_empty',session_id:'worker',event_count:0})
 events=['permission/preset','sandbox/mode','approval/policy'].map((type,seq)=>({seq,type,data:{value:'initial'}}))
 const policy=freshAssignmentContext(agent,true)
 assert.equal(policy.kind,'official_fresh_policy_metadata');assert.equal(policy.event_count,3)
 assert.deepEqual(policy.policy_metadata.event_types,events.map(e=>e.type));assert.match(policy.policy_metadata.event_hash,/^[a-f0-9]{64}$/)
 events[0].data.value='changed';assert.notEqual(freshAssignmentContext(agent,true).policy_metadata.event_hash,policy.policy_metadata.event_hash)
 assert.throws(()=>freshAssignmentContext(agent,false),/fresh empty/)
 agent.session.header.isSeeded=true;assert.throws(()=>freshAssignmentContext(agent,true),/fresh empty/);agent.session.header.isSeeded=false
 for(const type of ['user/message','assistant/message','system/message','tool/result','plugin:unknown']){
  events=[{seq:0,type,data:{}}];assert.throws(()=>freshAssignmentContext(agent,true),/fresh empty/)
 }
 events=[{type:'approval/policy'},{type:'approval/policy'}];assert.throws(()=>freshAssignmentContext(agent,true),/fresh empty/)
})

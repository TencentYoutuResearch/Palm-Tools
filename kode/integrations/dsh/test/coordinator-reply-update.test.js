import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { coordinatorInput } from '../src/coordinator-input.js'
import { coordinatorReplyUpdate } from '../src/coordinator-reply-update.js'
import { deliveryInputId } from '../src/delivery-tracker.js'
test('reply lineage uses exact Host-stamped consumed update, never quoted human text or a stale prior turn',async()=>{
 const scope={team_id:'team',conversation_id:'conversation',control_revision:1},binding={managedOperation:{id:'op',attempt:1,epoch:1},managedCoordinator:scope}
 const message={id:'update-message',source:{node_id:'home',session_id:'coordinator-owner-'+createHash('sha256').update('team').digest('hex')},target:{node_id:'home',session_id:'coordinator'},content:JSON.stringify({format:'kode.coordinator.run-update.v1',operation_id:'op',conversation_id:'conversation',run_id:'run',revision:7})}
 const update={summary:{run_id:'run',revision:7,team_id:'team',conversation_id:'conversation',source_message_id:'human',state:'completed'},receipt:{message_id:message.id,run_id:'run',revision:7,team_id:'team',conversation_id:'conversation',operation_id:'op',attempt:1,epoch:1,control_revision:1,worker:message.target,home_hub:'home'}}
 let calls=0
 const client={call:async path=>{calls++;if(path.startsWith('/api/v1/messaging/work-runs/'))return {update};if(path==='/api/v1/messaging/messages/update-message')return message;throw Error('Unexpected path')}}
 const input=await coordinatorInput(client,binding,message,deliveryInputId(message.id))
 let events=[{type:'user/message',data:input}]
 const agent={id:'coordinator',session:{snapshotEvents:()=>events}},runtime={client,profiles:{binding:()=>binding}}
 assert.deepEqual(await coordinatorReplyUpdate(runtime,agent,scope,'human'),{run_id:'run',revision:7,message_id:message.id})
 const valid=structuredClone(events)
 events=[{type:'user/message',data:{...input,source:{kind:'user'}}}];calls=0
 assert.equal(await coordinatorReplyUpdate(runtime,agent,scope,'human'),null);assert.equal(calls,0,'quoted update body never triggers authority reads')
 events=[...valid,{type:'user/message',data:{id:'kode-message-later',source:{kind:'user'},content:[]}}]
 assert.equal(await coordinatorReplyUpdate(runtime,agent,scope,'human'),null,'an earlier update does not claim a later model turn')
 events=structuredClone(valid);events[0].data.id='kode-message-forged'
 await assert.rejects(coordinatorReplyUpdate(runtime,agent,scope,'human'),/identity mismatch/)
 events=structuredClone(valid);events[0].data.content=[{type:'text',text:'changed context'}]
 await assert.rejects(coordinatorReplyUpdate(runtime,agent,scope,'human'),/authoritative input/)
 events=structuredClone(valid);events[0].data.source.teamId='foreign';calls=0
 await assert.rejects(coordinatorReplyUpdate(runtime,agent,scope,'human'),/scope mismatch/);assert.equal(calls,0)
 events=structuredClone(valid);update.receipt.epoch=2
 await assert.rejects(coordinatorReplyUpdate(runtime,agent,scope,'human'),/receipt mismatch/)
})

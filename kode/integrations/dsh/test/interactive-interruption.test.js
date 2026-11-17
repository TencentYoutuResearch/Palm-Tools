import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {interactiveInterruptionProof} from '../src/interactive-interruption-proof.js'
import {createInteractiveTeamHostRuntime} from '../src/interactive-team-host-runtime.js'
import {profileRevision} from '../src/agent-profiles.js'
import {deliveryInputId} from '../src/delivery-tracker.js'
const copy=x=>structuredClone(x),hash=s=>createHash('sha256').update(s).digest('hex')
function fixture(){
 const profile={id:'original',name:'Original',type:'codebuddy',executable:'fixture',args:[],env:{}},sid='session-12345678-1234-1234-1234-123456789abc'
 const message={id:'source',surface_id:'surface',thread_id:'thread',actor:{kind:'human',id:'local_owner'},content:'Original input'}
 const binding={version:1,execution_mode:'interactive_native',state:'bound',binding_id:'binding',revision:1,home_hub:'home',team_id:'team',team_revision:1,surface_id:'surface',surface_kind:'channel',thread_id:'thread',audience_revision:1,context_epoch:1,participant_id:'coordinator',target_id:'target',native_session_id:sid,workspace:{host_id:'home',workspace_id:'workspace',root_ref:'/fixture'},selection:{profile_id:'original',profile_revision:profileRevision(profile),model:'fixture',reasoningEffort:null},first_source_message_id:message.id,first_source_content_sha256:hash(message.content)}
 const receipt={receipt_id:'receipt',binding_id:'binding',source_message_id:message.id,source_content_sha256:hash(message.content),native_session_id:sid,state:'claimed'},input=deliveryInputId(receipt.receipt_id)
 const events=[['plugin:kode/interactive-team',{binding}],['plugin:kode/interactive-team-input',{binding_id:'binding',receipt_id:'receipt',source_message_id:'source',source_content_sha256:hash(message.content),native_session_id:sid,input_id:input}],['turn/start',{turn:1}],['user/message',{id:input,content:[{type:'text',text:message.content}]}],['tool/call',{callId:'call'}],['approval/asked',{id:'approval',callId:'call'}],['approval/decided',{id:'approval',outcome:'rejected'}],['plugin:kode/native-event',{event:{method:'kode/process_stop',params:{leader_exited:true,process_group_empty:true,stopBlocked:false,exit_code:0,exit_signal:null,signal_failures:[],inputIds:[input]}}}],['turn/end',{turn:1,reason:{kind:'interrupted'}}]].map(([type,data],seq)=>({type,data,seq}))
 const header={id:sid,cwd:'/fixture'},team_snapshot={id:'team',revision:1,home_hub:'home',spec:{execution_mode:'interactive_native'}},calls=[]
 let liveStatus='idle'
 const profiles={get:()=>copy(profile),binding:()=>undefined}
 const services={workspaceRegistry:{get:()=>({path:'/fixture'})},agents:{get:()=>({status:liveStatus})},sessionPersistence:{open:async()=>({header,read:async()=>({events}),close:async()=>{}})}}
 const backend={call:async(path,payload)=>{calls.push({path,payload});if(path.endsWith('/recovery'))return copy({binding,team_snapshot,message,receipt,never_claimed:false});if(path.endsWith('/sources/interrupted')){Object.assign(receipt,{state:'interrupted',interruption:copy(payload)});return copy({binding,receipt,new_interruption:true})}throw Error('unexpected backend call')}}
 const runtime=createInteractiveTeamHostRuntime({ctx:{get:name=>services[name]},backend,service:{profiles,hasRuntime:()=>true},home:'home',nativeBinding:()=>undefined})
 return {binding,receipt,message,header,events,calls,runtime,busy:()=>{liveStatus='busy'}}
}
test('exact rejected approval produces non-success evidence only',()=>{const f=fixture(),p=interactiveInterruptionProof(f,1);assert.equal(p.cause,'approval_rejected');assert.equal(p.turn_id,'1');assert.ok(!('text' in p));assert.match(p.terminal_sha256,/^[a-f0-9]{64}$/)})
test('wrong turn/source, missing approval, unknown process and successful turn cannot settle',()=>{
 for(const change of [f=>{f.message.id='foreign'},f=>{f.events[6].data.outcome='allowed-once'},f=>{f.events[7].data.event.params.process_group_empty=false},f=>{f.events[8].data.reason.kind='completed'},f=>{f.events.splice(5,1)},f=>{f.events.push({seq:9,type:'turn/start',data:{turn:2}})}]){const f=fixture();change(f);assert.throws(()=>interactiveInterruptionProof(f),/unavailable/)}
 assert.throws(()=>interactiveInterruptionProof(fixture(),2),/unavailable/)
})
test('owner terminal reconciliation reads original journal without activating or claiming',async()=>{
 const f=fixture(),input={binding_id:'binding',source_message_id:'source',request_id:'reconcile:source'}
 const a=await f.runtime.reconcileInterrupted(input),b=await f.runtime.reconcileInterrupted(input)
 assert.equal(a.state,'interrupted');assert.equal(a.automatic_replay_allowed,false);assert.deepEqual(a,b)
 assert.equal(f.calls.filter(c=>c.payload).length,2)
 assert.ok(f.calls.every(c=>!c.path.endsWith('/sources/claim')&&!c.path.endsWith('/sources/finish')&&!c.path.includes('/publish')))
 assert.equal((await f.runtime.inspect('binding')).state,'interrupted')
})
test('active, completed or evidence-missing original source makes zero terminal writes',async()=>{
 for(const change of [f=>f.busy(),f=>{f.receipt.state='completed'},f=>{f.events[6].data.outcome='allowed-once'}]){const f=fixture();change(f);await assert.rejects(f.runtime.reconcileInterrupted({binding_id:'binding',source_message_id:'source',request_id:'reconcile:source'}));assert.equal(f.calls.filter(c=>c.payload).length,0)}
})

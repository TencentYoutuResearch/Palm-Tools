import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createNativeContextInputClient} from '../src/native-context-input-client.js'
const digest=v=>createHash('sha256').update(v).digest('hex')
function fixture(override){
 const binding={context_key:'a'.repeat(64),manifest_sha256:'b'.repeat(64),session_id:`context-${'a'.repeat(64)}`,journal_id:'journal',host_binding_id:'host-binding',operation:{id:'operation',attempt:1,epoch:1}}
 const source={authority:{...binding,operation_id:'operation',attempt:1,epoch:1},entry:{id:'entry',claim_id:'claim',state:'claimed',context_key:binding.context_key,journal_id:'journal',operation_id:'operation',source_message_id:'message',source_content_sha256:digest('only this scope')},message:{id:'message',content:'only this scope'}}
 const calls=[];let original
 const response=body=>({admission_id:'admitted-id',context_key:binding.context_key,request_id:body.request_id,entry_id:'entry',claim_id:'claim',operation_id:'operation',attempt:1,epoch:1,session_id:binding.session_id,journal_id:'journal',state:'admitted',new_admission:true,dispatch_allowed:true,profile_id:'conversation_reply_v1',tools:[]})
 const client={async call(path,body){calls.push({path,body});if(override)return override(path,body,response)
  if(path.endsWith('/native-inputs'))return original=response(body)
  if(path.includes('/native-requests/'))return {...original,new_admission:false,dispatch_allowed:false}
  return {...original,state:'outbox',new_admission:false,dispatch_allowed:false}
 }}
 return {transport:createNativeContextInputClient({client,binding}),source,calls,binding}
}
test('exact source uses original native endpoint and confirms outbox, not publication',async()=>{
 const f=fixture();const a=await f.transport.begin(f.source);assert.equal(a.dispatch_allowed,true)
 assert.deepEqual(Object.keys(f.calls[0].body).sort(),['request_id','host_binding_id','context_key','session_id','journal_id','entry_id','claim_id','source_message_id','source_content_sha256','manifest_sha256'].sort())
 const done=await f.transport.finish({request_id:'finish-one',usage_event_id:'meter-verified',text:'answer'});assert.equal(done.state,'outbox')
 await assert.rejects(f.transport.finish({request_id:'again',usage_event_id:'meter-verified',text:'answer'}),/fresh/)
})
test('foreign source never contacts backend',async()=>{const f=fixture();f.source.entry.context_key='c'.repeat(64);await assert.rejects(f.transport.begin(f.source));assert.equal(f.calls.length,0)})
test('lost Begin response cannot retry even after status says not found',async()=>{
 const f=fixture(async path=>{if(path.includes('/native-requests/'))return {state:'not_found',new_admission:false,dispatch_allowed:false};throw Error('lost response')})
 await assert.rejects(f.transport.begin(f.source),/lost/);assert.equal((await f.transport.status()).state,'not_found');await assert.rejects(f.transport.begin(f.source),/already attempted/);assert.equal(f.calls.length,2)
})
test('duplicate admission and foreign response never grant dispatch',async()=>{
 for(const change of [{new_admission:false,dispatch_allowed:false},{session_id:'foreign'},{tools:[{name:'read_other_thread'}]},{epoch:2}]){
 const f=fixture(async(_path,body,response)=>({...response(body),...change}));await assert.rejects(f.transport.begin(f.source));await assert.rejects(f.transport.finish({request_id:'finish',usage_event_id:'meter',text:'no'}),/fresh/)
 }
})
test('concurrent Begin sends one request',async()=>{const f=fixture();const results=await Promise.allSettled([f.transport.begin(f.source),f.transport.begin(f.source)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.calls.length,1)})
test('status is read-only and cannot replace initial dispatch permission',async()=>{const f=fixture();await f.transport.begin(f.source);const r=await f.transport.status();assert.equal(r.dispatch_allowed,false);assert.equal(f.calls[1].body,undefined);await assert.rejects(f.transport.begin(f.source))})

test('source attempt and epoch mismatch fail before any request',async()=>{
 for(const change of [{attempt:2},{epoch:2},{attempt:undefined},{epoch:undefined}]){const f=fixture();Object.assign(f.source.authority,change);await assert.rejects(f.transport.begin(f.source));assert.equal(f.calls.length,0)}
})
test('status cannot substitute a different admission for an acknowledged Begin',async()=>{
 let initial;const f=fixture(async(path,body,response)=>{if(path.endsWith('/native-inputs'))return initial=response(body);return {...initial,admission_id:'foreign',new_admission:false,dispatch_allowed:false}})
 await f.transport.begin(f.source);await assert.rejects(f.transport.status(),/identity changed/)
})

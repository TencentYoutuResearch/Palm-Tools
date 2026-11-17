import test from 'node:test'
import assert from 'node:assert/strict'
import {readNativeScopedStatus} from '../src/native-scoped-status.js'
import {registerNativeScopedStatus} from '../src/native-scoped-status-route.js'
import {contextScopeKey,discussionScopeId} from '../src/context-scope.js'
const input={surface_id:'channel',thread_id:'root',source_message_id:'message'}
function fixture(){
 const scope={home_hub:'home',host_id:'home',workspace_id:'workspace',root_ref:'/fixture/private-project'}
 const surface={id:'channel',kind:'channel',enabled:true,scope,team_ids:['team'],revision:1,audience_revision:1}
 const message={id:'message',surface_id:'channel',thread_id:'root',scope,actor:{kind:'human',id:'local_owner'},kind:'discussion',execution_authorized:false,delivery_state:'stored_only',delivery_reason:'isolated_context_required',content:'PRIVATE_BODY',mentions:[{team_id:'team',team_revision:2,worker_id:null}]}
 const context_scope={version:2,home_hub:'home',team_id:'team',kind:'discussion_thread',scope_id:discussionScopeId('channel','root'),context_epoch:1}
 const context={key:contextScopeKey(context_scope),context_scope,surface_id:'channel',thread_id:'root',origin:scope,team_revision:2,audience_revision:1}
 const f={surface,message,context,calls:[],contextAvailable:false,active:{team_id:'team',home_hub:'home',active:true,authority_valid:true,team_revision:2}}
 f.client={async call(path,body){assert.equal(body,undefined);f.calls.push(path);if(path.includes('/messages?'))return f.page?.(path)??{surface:f.surface,items:[f.message],has_more:false,next_cursor:null};if(path.includes('/context-v2/contexts/')){if(!f.contextAvailable)throw Object.assign(Error('PRIVATE_DETAIL'),{status:400});return {context:f.context}};if(path.endsWith('/activation'))return f.active;throw Error('Unexpected endpoint')}}
 return f
}
test('stored source gets business status without writes or invented readiness',async()=>{
 const f=fixture(),r=await readNativeScopedStatus(f.client,input)
 assert.equal(r.state,'stored_only');assert.equal(r.bootstrap.state,'not_bootstrappable');assert.equal(r.context.state,'not_verified');assert.equal(r.activation.state,'authorized')
 assert.equal(r.credential.state,'not_verified');assert.equal(r.automatic_replay_allowed,false);assert.equal(r.execution_confirmed,false)
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE_BODY|private-project|PRIVATE_DETAIL/);assert.equal(f.calls.length,3)
})
test('context derived from trusted source does not authorize delivery',async()=>{
 const f=fixture();f.contextAvailable=true;const r=await readNativeScopedStatus(f.client,input)
 assert.equal(r.context.context_key,f.context.key);assert.equal(r.bootstrap.state,'requires_explicit_input');assert.equal(r.execution_confirmed,false)
})
test('source surface activation and context mismatches fail closed',async()=>{
 for(const mutate of [f=>f.message.thread_id='foreign',f=>f.surface.id='foreign',f=>f.message.scope={...f.message.scope,root_ref:'/foreign'},f=>f.message.actor.id='foreign',f=>{f.contextAvailable=true;f.context.audience_revision=2},f=>f.active.team_id='foreign']){
  const f=fixture();mutate(f);await assert.rejects(readNativeScopedStatus(f.client,input),{code:'SCOPED_STATUS_EVIDENCE_INVALID'})
 }
})
test('unknown or removed recipients do not cause wider discovery',async()=>{
 for(const mutate of [f=>f.message.mentions=[],f=>f.surface.team_ids=[]]){const f=fixture();mutate(f);const r=await readNativeScopedStatus(f.client,input);assert.equal(f.calls.length,1);assert.equal(r.context.state,'not_verified')}
})
test('unavailable context is not asserted nonexistent',async()=>{
 const f=fixture(),r=await readNativeScopedStatus(f.client,input);assert.equal(r.context.reason,'context_unavailable_or_revoked')
})
test('prior delivery is not reinterpreted as pending input',async()=>{
 const f=fixture();f.message.delivery_state='queued_to_coordinator';const r=await readNativeScopedStatus(f.client,input);assert.equal(r.state,'existing_delivery');assert.equal(f.calls.length,1)
})
test('bounded exact-thread pagination distinguishes absence and limit',async()=>{
 const f=fixture();f.page=path=>({surface:f.surface,items:[],has_more:true,next_cursor:Number(new URL(path,'http://fixture').searchParams.get('after'))+50})
 const r=await readNativeScopedStatus(f.client,input);assert.equal(f.calls.length,4);assert.equal(r.source.state,'outside_lookup_window');assert.ok(f.calls.every(p=>p.includes('thread_id=root')))
 const g=fixture();g.page=()=>({surface:g.surface,items:[],has_more:false,next_cursor:null});assert.equal((await readNativeScopedStatus(g.client,input)).source.state,'not_found')
})
test('cursor repetition and changing surface fail closed',async()=>{
 const f=fixture();f.page=()=>({surface:f.surface,items:[],has_more:true,next_cursor:0});await assert.rejects(readNativeScopedStatus(f.client,input))
 const g=fixture();g.page=()=>({surface:{...g.surface,revision:g.calls.length},items:[],has_more:true,next_cursor:g.calls.length*50});await assert.rejects(readNativeScopedStatus(g.client,input))
})
async function route({principal='owner',method='GET',query=new URLSearchParams(input).toString(),f=fixture()}={}){
 let handler,status,payload
 registerNativeScopedStatus({webServer:{register(r){assert.equal(r.path,'/api/kode/context-v2/status');handler=r.handler}},connection:{admit:()=>principal===null?{rejection:401}:{peer:{principal:{kind:principal}}}}},{backendClient:f.client})
 await handler({method,url:'/api/kode/context-v2/status?'+query},{writeHead(s,h){status=s;assert.equal(h['cache-control'],'no-store')},end(v){payload=JSON.parse(v)}})
 return {status,payload,calls:f.calls}
}
test('owner GET only; no credential root extra or duplicate input',async()=>{
 for(const principal of [null,'session','viewer']){const r=await route({principal});assert.equal(r.status,principal===null?401:403);assert.equal(r.calls.length,0)}
 assert.equal((await route({method:'POST'})).status,405)
 for(const extra of ['root_ref=/private','token=secret','context_key=abc','surface_id=other']){const r=await route({query:new URLSearchParams(input)+'&'+extra});assert.equal(r.status,400);assert.equal(r.calls.length,0)}
 assert.equal((await route({query:'surface_id=channel'})).status,400);assert.equal((await route()).status,200)
})
test('upstream access denial is preserved without error details',async()=>{
 const f=fixture();f.client.call=async()=>{throw Object.assign(Error('SECRET_TOKEN'),{status:403})};const r=await route({f});assert.equal(r.status,403);assert.doesNotMatch(JSON.stringify(r.payload),/SECRET_TOKEN/)
})
test('failed source lookup cannot claim stored source or execution',async()=>{
 const f=fixture();f.client.call=async()=>{throw Error('SECRET_TOKEN')};const r=await route({f});assert.equal(r.status,502);assert.equal(r.payload.state,'not_verified');assert.equal(r.payload.execution_confirmed,false);assert.doesNotMatch(JSON.stringify(r.payload),/SECRET_TOKEN/)
})

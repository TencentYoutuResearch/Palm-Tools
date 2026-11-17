import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {registerInteractiveTeamRoutes} from '../src/interactive-team-host-route.js'
function fixture(kind='owner'){
 const routes=new Map(),calls=[]
 const runtime=Object.fromEntries(['open','inspect','inspectSource','deliver','recover','reconcileInterrupted'].map(name=>[name,async input=>{calls.push({name,input});return {execution_mode:'interactive_native',state:'stored',usage:{state:'unknown'}}}]))
 const ctx={connection:{admit:()=>kind==='denied'?{rejection:401}:{peer:{principal:{kind}}}},webServer:{register:r=>{routes.set(r.path,r);return ()=>routes.delete(r.path)}}}
 registerInteractiveTeamRoutes(ctx,runtime)
 const request=async(path,body,method='POST')=>{const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);Object.assign(req,{method,url:path,headers:{'content-type':'application/json'}});let status,result;await routes.get(path.split('?')[0]).handler(req,{writeHead:s=>{status=s},end:v=>{result=JSON.parse(v)}});return {status,result}}
 return {request,calls,runtime}
}
const open={request_id:'request',team_id:'team',team_revision:1,surface_id:'channel',thread_id:'thread',audience_revision:1,participant_id:'worker',target_id:'target',workspace_id:'workspace',context_epoch:1}
test('explicit owner references only; runtime is responsible for authoritative mode admission',async()=>{const f=fixture();assert.equal((await f.request('/api/kode/interactive-teams/open',open)).status,200);assert.deepEqual(f.calls,[{name:'open',input:open}])})
test('foreign or unauthenticated callers cannot open, deliver or inspect',async()=>{for(const kind of ['session','denied']){const f=fixture(kind);for(const [path,body,method] of [['/api/kode/interactive-teams/open',open,'POST'],['/api/kode/interactive-teams/deliver',{binding_id:'b',source_message_id:'m',request_id:'r'},'POST'],['/api/kode/interactive-teams/status?binding_id=b',undefined,'GET']])assert.equal((await f.request(path,body,method)).status,kind==='denied'?401:403);assert.equal(f.calls.length,0)}})
test('caller cannot inject content, credentials, model, permissions or reply destination',async()=>{for(const key of ['content','token','model','permission_mode','target','text','execution_mode']){const f=fixture();assert.equal((await f.request('/api/kode/interactive-teams/deliver',{binding_id:'b',source_message_id:'m',request_id:'r',[key]:'forged'})).status,400);assert.equal(f.calls.length,0)}})
test('GET is status-only and duplicate query parameters are rejected',async()=>{const f=fixture();assert.equal((await f.request('/api/kode/interactive-teams/status?binding_id=b',undefined,'GET')).status,200);assert.deepEqual(f.calls,[{name:'inspect',input:'b'}]);assert.equal((await f.request('/api/kode/interactive-teams/status?binding_id=b&binding_id=c',undefined,'GET')).status,400)})
test('unknown delivery errors expose no secrets and never promise retry or a completed reply',async()=>{const f=fixture();f.runtime.deliver=async()=>{throw Error('secret internal detail')};const r=await f.request('/api/kode/interactive-teams/deliver',{binding_id:'b',source_message_id:'m',request_id:'r'});assert.equal(r.status,409);assert.equal(r.result.automatic_replay_allowed,false);assert.equal(JSON.stringify(r.result).includes('secret'),false);assert.deepEqual(r.result.usage,{state:'unknown'})})
test('optional first source accepts only an exact reference, not a message payload',async()=>{const f=fixture(),input={...open,first_source_message_id:'new-source'};assert.equal((await f.request('/api/kode/interactive-teams/open',input)).status,200);assert.deepEqual(f.calls[0].input,input);for(const value of ['',{},'../foreign'])assert.equal((await f.request('/api/kode/interactive-teams/open',{...open,first_source_message_id:value})).status,400)})

test('recovery is explicit owner-only and cannot supply new content or destination',async()=>{
 const input={binding_id:'b',source_message_id:'m',request_id:'composer-source:m'}
 for(const kind of ['session','denied']){const f=fixture(kind);assert.equal((await f.request('/api/kode/interactive-teams/recover',input)).status,kind==='denied'?401:403);assert.equal(f.calls.length,0)}
 const f=fixture();assert.equal((await f.request('/api/kode/interactive-teams/recover',{...input,content:'replacement'})).status,400)
 assert.equal((await f.request('/api/kode/interactive-teams/recover',input)).status,200);assert.deepEqual(f.calls,[{name:'recover',input}])
})

test('original source status is read-only, owner-only, and exact-query',async()=>{
 const f=fixture();assert.equal((await f.request('/api/kode/interactive-teams/source-status?source_message_id=m',undefined,'GET')).status,200);assert.deepEqual(f.calls,[{name:'inspectSource',input:'m'}])
 assert.equal((await f.request('/api/kode/interactive-teams/source-status?source_message_id=m&binding_id=b',undefined,'GET')).status,400)
 assert.equal((await fixture('session').request('/api/kode/interactive-teams/source-status?source_message_id=m',undefined,'GET')).status,403)
})

test('failed inspection exposes only a fixed safe phase, never raw error details',async()=>{
 const f=fixture();f.runtime.inspectSource=async()=>{throw Object.assign(Error('private diagnostic'),{interactive_phase:'native_storage_probe'})}
 const r=await f.request('/api/kode/interactive-teams/source-status?source_message_id=m',undefined,'GET');assert.equal(r.status,409);assert.equal(r.result.diagnostic.phase,'native_storage_probe');assert.ok(!JSON.stringify(r.result).includes('private'))
 f.runtime.inspectSource=async()=>{throw Object.assign(Error('secret'),{interactive_phase:'secret'})}
 assert.equal((await f.request('/api/kode/interactive-teams/source-status?source_message_id=m',undefined,'GET')).result.diagnostic.phase,'unknown')
})

test('failure settlement uses owner-only exact references, not caller-provided success or journal',async()=>{
 const input={binding_id:'b',source_message_id:'m',request_id:'reconcile:m'}
 for(const kind of ['session','denied'])assert.equal((await fixture(kind).request('/api/kode/interactive-teams/reconcile-interrupted',input)).status,kind==='session'?403:401)
 const f=fixture();for(const key of ['state','text','journal','cause'])assert.equal((await f.request('/api/kode/interactive-teams/reconcile-interrupted',{...input,[key]:'forged'})).status,400)
 assert.equal((await f.request('/api/kode/interactive-teams/reconcile-interrupted',input)).status,200)
})

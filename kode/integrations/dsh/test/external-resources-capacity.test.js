import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Readable} from 'node:stream'
import {ExternalInbox,CACHE_VERSION} from '../src/external-integrations/inbox.js'
import {ExternalResources} from '../src/external-integrations/service.js'
import {ReadonlyProvider,normalizeResponse} from '../src/external-integrations/providers.js'
import {CACHE_LIMITS,ExternalCacheCapacityError} from '../src/external-integrations/capacity.js'
import {registerExternalResources} from '../src/external-integrations/route.js'

const source={provider:'tapd',instance:'https://tapd.example',resource:'100'}
const scope={home_hub:'home',host_id:'host',workspace_id:'workspace',root_ref:'/fixture'}
const binding={id:'binding',scope,surface_id:'channel',audience_revision:1,connection_id:'tapd',source,enabled:true,expected_revision:0}
const sync={binding_id:'binding',expected_revision:1,request_id:'read-1',kind:'story'}
const rows=(id='1',title='Synthetic story')=>({status:1,data:[{Story:{id,workspace_id:'100',name:title,description:'中文 🧪 @agent inert'}}]})
const command={binding_id:'binding',expected_revision:1,kind:'story',page:1,parent:null}
const capacityError=resource=>error=>error instanceof ExternalCacheCapacityError&&error.resource===resource
function fixture(t,limits={}){
 let now=0,reads=0,read=async()=>rows()
 const root=mkdtempSync(join(tmpdir(),'external-capacity-')),path=join(root,'cache.sqlite')
 const inbox=new ExternalInbox(path,{capacityLimits:limits,clock:()=>now})
 const surface={id:'channel',scope,kind:'channel',enabled:true,audience_revision:1}
 const backend={call:async()=>({items:[surface]})}
 const provider=(authorizationRevision='v1',capabilities=['story'])=>new ReadonlyProvider({source,authorizationRevision,capabilities,readJson:async request=>{reads++;return read(request)}})
 const connections=new Map([['tapd',provider()]])
 const service=new ExternalResources({inbox,backendClient:backend,connections})
 t.after(()=>{inbox.close();rmSync(root,{recursive:true,force:true})})
 return {path,inbox,service,surface,backend,connections,provider,read:value=>read=value,advance:ms=>now+=ms,get reads(){return reads}}
}
function stored(inbox){return Object.fromEntries(['external_bindings','external_cards','external_events','external_receipts'].map(table=>[table,inbox.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row=>({...row}))]))}
function actual(inbox){
 const result={bindings:inbox.db.prepare('SELECT COUNT(*) n FROM external_bindings').get().n,cards:0,events:0,receipts:0,snapshot_bytes:0}
 for(const [name,columns]of [['cards',['binding','key','body']],['events',['binding','key','body']],['receipts',['binding','request','fingerprint','body']]]){
  for(const row of inbox.db.prepare(`SELECT * FROM external_${name}`).all()){result[name]++;for(const column of columns)result.snapshot_bytes+=Buffer.byteLength(row[column],'utf8')}
 }
 return result
}
function noLeases(inbox){assert.equal(inbox.db.prepare('SELECT COUNT(*) n FROM external_polls').get().n,0)}

test('bindings are bounded globally while explicit disable/rebind and CAS remain available at capacity',async t=>{
 const f=fixture(t,{bindings:1});await f.service.bind(binding);await f.service.sync(sync)
 const before=stored(f.inbox)
 await assert.rejects(f.service.bind({...binding,id:'another'}),capacityError('bindings'))
 assert.deepEqual(stored(f.inbox),before)
 await f.service.bind({...binding,expected_revision:1,enabled:false})
 assert.equal(f.inbox.get('binding').enabled,false);assert.equal(f.inbox.capacity.usage().bindings,1)
 noLeases(f.inbox);assert.equal(f.inbox.capacity.usage().snapshot_bytes,0)
 await assert.rejects(f.service.bind({...binding,expected_revision:1}),/revision/)
 await f.service.bind({...binding,expected_revision:2})
 await assert.rejects(f.service.bind({...binding,id:'still-another'}),capacityError('bindings'))
 assert.deepEqual(f.inbox.capacity.usage(),actual(f.inbox))
})

test('receipt exhaustion rejects fresh IDs before provider I/O without error records, and exact replay remains authoritative',async t=>{
 const f=fixture(t,{receipts:2});await f.service.bind(binding)
 const original=await f.service.sync(sync)
 f.read(async()=>({status:1,data:[]}));await f.service.sync({...sync,request_id:'read-2'})
 const before=stored(f.inbox),cached=f.inbox.capacity.cached
 for(let i=0;i<30;i++)await assert.rejects(f.service.sync({...sync,request_id:'flood-'+i}),capacityError('receipts'))
 assert.equal(f.reads,2);noLeases(f.inbox);assert.deepEqual(stored(f.inbox),before)
 assert.equal(f.inbox.capacity.cached,cached,'read-only quota failures do not force repeated full scans')
 assert.deepEqual(await f.service.sync(sync),original)
 assert.equal(f.inbox.get('binding').last_sync.request_id,'read-2')
 await assert.rejects(f.service.sync({...sync,page:2}),/changed operation/)
 assert.equal(f.inbox.cards('binding').length,1,'missing single-page rows never delete old cards')
})

test('event and card limits reject the entire changed page but permit unchanged and empty observations',async t=>{
 for(const [resource,limits]of [['events',{events:1}],['cards',{cards:1}]]){
  const f=fixture(t,limits);await f.service.bind(binding);await f.service.sync(sync)
  await f.service.sync({...sync,request_id:'unchanged'})
  const before=stored(f.inbox)
  f.read(async()=>resource==='events'?rows('1','Changed'):rows('2'))
  await assert.rejects(f.service.sync({...sync,request_id:'rejected'}),capacityError(resource))
  assert.deepEqual(stored(f.inbox),before);noLeases(f.inbox)
  assert.equal(f.inbox.receipt('binding','rejected',command),null)
  f.read(async()=>({status:1,data:[]}));await f.service.sync({...sync,request_id:'empty'})
  assert.equal(f.inbox.cards('binding').length,1);assert.deepEqual(f.inbox.capacity.usage(),actual(f.inbox))
 }
})

test('duplicate keys within a page charge every changed observation, not just distinct final cards',async t=>{
 for(const limit of [1,2]){
  const f=fixture(t,{events:limit});await f.service.bind(binding)
  f.read(async()=>({status:1,data:[...rows('1','First').data,...rows('1','Second').data]}))
  if(limit===1){await assert.rejects(f.service.sync(sync),capacityError('events'));assert.equal(f.inbox.cards('binding').length,0)}
  else{const result=await f.service.sync(sync);assert.equal(result.updated,2);assert.equal(f.inbox.cards('binding')[0].title,'Second')}
  assert.deepEqual(f.inbox.capacity.usage(),actual(f.inbox));noLeases(f.inbox)
 }
})

test('UTF-8 quota includes snapshot keys and receipts, accepts the exact boundary and rolls back the next write',async t=>{
 const f=fixture(t);await f.service.bind(binding);const receipt=await f.service.sync(sync)
 const usage=actual(f.inbox);assert.deepEqual(f.inbox.capacity.usage(),usage)
 const path=f.path;f.inbox.close()
 const inbox=new ExternalInbox(path,{capacityLimits:{snapshot_bytes:usage.snapshot_bytes}})
 const service=new ExternalResources({inbox,backendClient:f.backend,connections:f.connections})
 try{
  assert.deepEqual(service.status().cache_capacity.at_limit,['snapshot_bytes'])
  assert.deepEqual(await service.sync(sync),receipt)
  const before=stored(inbox)
  await assert.rejects(service.sync({...sync,request_id:'read-2'}),capacityError('snapshot_bytes'))
  assert.deepEqual(stored(inbox),before);assert.deepEqual(inbox.capacity.usage(),usage);noLeases(inbox)
 }finally{service.close()}
})

test('older over-limit v2 caches remain readable and replayable without schema migration or automatic deletion',async t=>{
 const f=fixture(t);await f.service.bind(binding);const receipt=await f.service.sync(sync)
 await f.service.sync({...sync,request_id:'read-2'})
 const schema=f.inbox.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(),before=stored(f.inbox)
 f.inbox.close()
 const inbox=new ExternalInbox(f.path,{capacityLimits:{receipts:1}}),service=new ExternalResources({inbox,backendClient:f.backend,connections:f.connections})
 try{
  assert.deepEqual(stored(inbox),before);assert.equal(inbox.db.prepare('PRAGMA user_version').get().user_version,CACHE_VERSION)
  assert.deepEqual(inbox.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(),schema)
  assert.equal((await service.cards('binding')).items.length,1);assert.deepEqual(await service.sync(sync),receipt)
  await assert.rejects(service.sync({...sync,request_id:'new'}),capacityError('receipts'));assert.equal(f.reads,2)
  await service.bind({...binding,expected_revision:1,enabled:false})
  assert.equal(inbox.capacity.usage().receipts,0);noLeases(inbox)
 }finally{service.close()}
})

test('cross-handle admission and commit recheck global capacity after another binding consumes the last slot',async t=>{
 const f=fixture(t,{receipts:1});await f.service.bind(binding);await f.service.bind({...binding,id:'other'})
 const other=new ExternalInbox(f.path,{capacityLimits:{receipts:1}})
 try{
  const token=other.begin('other',1),objects=normalizeResponse(source,'story',rows())
  const first=await f.service.sync(sync)
  assert.throws(()=>other.finish('other',1,token,'other-read',objects),capacityError('receipts'))
  other.release('other',token);noLeases(f.inbox)
  assert.equal(other.cards('other').length,0);assert.deepEqual(other.capacity.usage(),actual(f.inbox))
  assert.throws(()=>other.begin('other',1),capacityError('receipts'))
  assert.deepEqual(other.start('binding',1,'read-1',command),{receipt:first})
 }finally{other.close()}
})

test('quota errors never bypass channel, capability or authorization revision checks for replay',async t=>{
 const f=fixture(t,{receipts:1});await f.service.bind(binding);await f.service.sync(sync)
 f.surface.enabled=false;await assert.rejects(f.service.sync(sync),/authorized/)
 f.surface.enabled=true;f.connections.set('tapd',f.provider('v1',[]));await assert.rejects(f.service.sync(sync),/capability/)
 f.connections.set('tapd',f.provider('v2'));await assert.rejects(f.service.sync(sync),/Connection/)
 assert.equal(f.reads,1);noLeases(f.inbox)
})

test('expired and foreign leases remain fenced through rejection, release and handle disposal',async t=>{
 const f=fixture(t);await f.service.bind(binding)
 const old=f.inbox.begin('binding',1);f.advance(60001)
 const other=new ExternalInbox(f.path,{clock:()=>60001})
 try{
  const latest=other.begin('binding',1)
  assert.throws(()=>f.inbox.finish('binding',1,old,'stale',[]),/invalidated/)
  f.inbox.release('binding',old);f.inbox.close()
  assert.equal(other.db.prepare('SELECT token FROM external_polls').get().token,latest)
  other.finish('binding',1,latest,'current',[]);noLeases(other)
 }finally{other.close()}
})

test('unexpected trigger writes are rolled back before any underestimated capacity can commit',async t=>{
 const f=fixture(t,{events:1});await f.service.bind(binding);const before=stored(f.inbox)
 f.inbox.db.exec("CREATE TEMP TRIGGER extra_event AFTER INSERT ON external_receipts BEGIN INSERT INTO external_events(binding,key,body,created) VALUES('binding','extra','{}',0); END")
 await assert.rejects(f.service.sync(sync),/changed unexpectedly/)
 assert.deepEqual(stored(f.inbox),before);assert.deepEqual(f.inbox.capacity.usage(),actual(f.inbox));noLeases(f.inbox)
 f.inbox.db.exec('DROP TRIGGER extra_event')
 await f.service.sync(sync);assert.equal(f.inbox.capacity.usage().events,1)
 assert.deepEqual(f.inbox.capacity.usage(),actual(f.inbox))
})

test('same-handle untracked SQL invalidates usage, while normal sequential writes use exact incremental counters',async t=>{
 const f=fixture(t);await f.service.bind(binding)
 let scans=0;const measure=f.inbox.capacity.measure
 f.inbox.capacity.measure={get(...args){scans++;return measure.get(...args)}}
 for(let i=0;i<30;i++)await f.service.sync({...sync,request_id:'read-'+i})
 assert.equal(scans,0);assert.deepEqual(f.inbox.capacity.usage(),actual(f.inbox))
 f.inbox.db.prepare('UPDATE external_cards SET body=body||?').run('中文')
 assert.deepEqual(f.inbox.capacity.usage(),actual(f.inbox));assert.equal(scans,1)
})

test('trigger replacement with unchanged total_changes cannot hide larger UTF-8 storage',async t=>{
 const f=fixture(t,{snapshot_bytes:2000});await f.service.bind(binding);const before=stored(f.inbox)
 f.inbox.db.exec("CREATE TRIGGER replace_card BEFORE INSERT ON external_cards BEGIN INSERT INTO external_cards VALUES(NEW.binding,NEW.key,json_set(NEW.body,'$.body',printf('%010000d',0)),NEW.seq); SELECT RAISE(IGNORE); END")
 await assert.rejects(f.service.sync(sync),/changed unexpectedly/)
 assert.deepEqual(stored(f.inbox),before);assert.deepEqual(f.inbox.capacity.usage(),actual(f.inbox));noLeases(f.inbox)
 f.inbox.db.exec('DROP TRIGGER replace_card');await f.service.sync(sync)
 assert.deepEqual(f.inbox.capacity.usage(),actual(f.inbox))
})

test('disposal never commits trigger-induced snapshot growth while releasing owned leases',async t=>{
 const f=fixture(t);await f.service.bind(binding);f.inbox.begin('binding',1)
 f.inbox.db.exec("CREATE TEMP TRIGGER poll_extra AFTER DELETE ON external_polls BEGIN INSERT INTO external_events(binding,key,body,created) VALUES('binding','close-extra','{}',0); END")
 assert.throws(()=>f.inbox.close(),/changed unexpectedly/)
 const reopened=new ExternalInbox(f.path)
 try{assert.equal(reopened.capacity.usage().events,0);assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM external_polls').get().n,1)}finally{reopened.close()}
 const other=fixture(t);await other.service.bind(binding)
 other.inbox.db.exec("CREATE TEMP TRIGGER redirect_poll BEFORE INSERT ON external_polls BEGIN INSERT INTO external_polls VALUES(NEW.binding||'-shadow',NEW.token,NEW.expires); SELECT RAISE(IGNORE); END")
 assert.throws(()=>other.inbox.begin('binding',1),/changed unexpectedly/);noLeases(other.inbox)
 other.inbox.db.exec('DROP TRIGGER redirect_poll')
})

test('main and temp triggers with upper/mixed-case table names cannot redirect leases or rewrite snapshots',async t=>{
 for(const temporary of ['', 'TEMP '])for(const uppercase of [true,false]){
  const f=fixture(t);await f.service.bind(binding);const before=stored(f.inbox)
  const poll=uppercase?'EXTERNAL_POLLS':'ExTeRnAl_PoLlS',card=uppercase?'EXTERNAL_CARDS':'ExTeRnAl_CaRdS'
  f.inbox.db.exec(`CREATE ${temporary}TRIGGER redirect_case_poll BEFORE INSERT ON ${poll} BEGIN INSERT INTO external_polls VALUES(NEW.binding||'-shadow',NEW.token,NEW.expires); SELECT RAISE(IGNORE); END`)
  try{
   assert.throws(()=>f.inbox.begin('binding',1),/changed unexpectedly/)
   noLeases(f.inbox);assert.deepEqual(stored(f.inbox),before)
   assert.equal(f.inbox.leases.size,0);assert.deepEqual(f.inbox.capacity.usage(),actual(f.inbox))
  }finally{f.inbox.db.exec('DROP TRIGGER redirect_case_poll')}
  f.inbox.db.exec(`CREATE ${temporary}TRIGGER replace_case_card BEFORE INSERT ON ${card} BEGIN INSERT INTO external_cards VALUES(NEW.binding,NEW.key,json_set(NEW.body,'$.body',printf('%010000d',0)),NEW.seq); SELECT RAISE(IGNORE); END`)
  try{
   await assert.rejects(f.service.sync(sync),/changed unexpectedly/)
   noLeases(f.inbox);assert.deepEqual(stored(f.inbox),before)
   assert.equal(f.inbox.receipt('binding','read-1',command),null)
   assert.deepEqual(f.inbox.capacity.usage(),actual(f.inbox))
  }finally{f.inbox.db.exec('DROP TRIGGER replace_case_card')}
  const receipt=await f.service.sync(sync)
  assert.equal(receipt.updated,1);noLeases(f.inbox)
  assert.deepEqual(f.inbox.capacity.usage(),actual(f.inbox))
 }
})

test('only finite stricter constructor limits are accepted; fixed defaults cannot be widened',t=>{
 const f=fixture(t)
 for(const limits of [{events:0},{receipts:Infinity},{cards:CACHE_LIMITS.cards+1},{snapshot_bytes:1.5},{unknown:1},null]){
  assert.throws(()=>new ExternalInbox(f.path,{capacityLimits:limits}),/Invalid cache capacity/)
 }
 assert.deepEqual(f.inbox.capacity.limits,CACHE_LIMITS)
})

test('owner route reports a specific safe capacity error and does not expose it to unauthenticated sessions',async()=>{
 let handler
 registerExternalResources({webServer:{register:route=>handler=route.handler},connection:{admit:req=>req.principal?{peer:{principal:{kind:req.principal}}}:{rejection:401}}},{service:{sync:async()=>{throw new ExternalCacheCapacityError('receipts')}}})
 for(const [principal,status]of [['owner',409],['session',403],[null,401]]){
  const req=Readable.from([JSON.stringify({op:'sync',...sync})]);Object.assign(req,{method:'POST',url:'/api/kode/external-resources',principal,headers:{'content-type':'application/json'}})
  let code,body;await handler(req,{writeHead:value=>code=value,end:value=>body=JSON.parse(value)})
  assert.equal(code,status)
  if(principal==='owner'){assert.equal(body.code,'external_cache_capacity');assert.equal(body.resource,'receipts');assert.match(body.error,/preserved/)}
  else assert.equal(body.code,undefined)
 }
})

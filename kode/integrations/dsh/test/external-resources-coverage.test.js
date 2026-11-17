import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ExternalInbox, CACHE_VERSION} from '../src/external-integrations/inbox.js'
import {ExternalResources} from '../src/external-integrations/service.js'
import {ReadonlyProvider} from '../src/external-integrations/providers.js'
import {pageObservation} from '../src/external-integrations/coverage.js'

const source={provider:'tapd',instance:'https://tapd.example',resource:'100'}
const scope={home_hub:'home',host_id:'host',workspace_id:'workspace',root_ref:'/fixture/project'}
const binding={id:'tapd',scope,surface_id:'channel',audience_revision:1,connection_id:'tapd',source,enabled:true,expected_revision:0}
const sync={binding_id:'tapd',expected_revision:1,request_id:'read-1',kind:'story'}
const rows=(count,start=1)=>({status:1,data:Array.from({length:count},(_,index)=>({Story:{id:String(start+index),workspace_id:'100',name:'Synthetic story '+(start+index)}}))})
function fixture(t) {
  let now=Date.parse('2026-11-10T00:00:00Z'),read=async()=>rows(1),reads=0
  const root=mkdtempSync(join(tmpdir(),'external-coverage-')),path=join(root,'cache.sqlite')
  const inbox=new ExternalInbox(path,{clock:()=>now})
  const surfaces=[{id:'channel',scope,kind:'channel',audience_revision:1,enabled:true}]
  const backend={call:async()=>({items:surfaces})}
  const provider=(revision='v1',capabilities=['story'])=>new ReadonlyProvider({source,authorizationRevision:revision,capabilities,readJson:async request=>{reads++;return read(request)}})
  const connections=new Map([['tapd',provider()]])
  const service=new ExternalResources({inbox,backendClient:backend,connections})
  t.after(()=>{inbox.close();rmSync(root,{recursive:true,force:true})})
  return {inbox,path,service,surfaces,backend,connections,provider,read:value=>read=value,advance:ms=>now+=ms,get now(){return now},get reads(){return reads}}
}
function expected(f,{page=1,count=1,request='read-1',kind='story',parent=null}={}) {
  return {mode:'single_page_snapshot',observed_page:page,requested_limit:100,observed_count:count,has_more:'unknown',reconciliation:'not_performed',read_at:new Date(f.now).toISOString(),kind,parent,request_id:request}
}

test('full, short and empty source pages record evidence without completeness or deletion inference',async t=>{
  const f=fixture(t);await f.service.bind(binding)
  for(const [page,count]of [[1,100],[2,2],[100,0]]){
    f.advance(1000);f.read(async()=>rows(count,page===2?101:1))
    const request='page-'+page,receipt=await f.service.sync({...sync,page,request_id:request})
    assert.deepEqual(receipt.last_sync,expected(f,{page,count,request}))
    const cards=await f.service.cards('tapd',{limit:100})
    assert.deepEqual(cards.last_sync,receipt.last_sync)
    assert.equal(cards.items.length,100)
  }
  assert.equal(f.inbox.db.prepare('SELECT COUNT(*) n FROM external_cards').get().n,102)
  const before=(await f.service.cards('tapd')).last_sync
  await assert.rejects(f.service.sync({...sync,page:101,request_id:'invalid-page'}),/Invalid page/)
  assert.deepEqual((await f.service.cards('tapd')).last_sync,before)
  assert.equal(f.reads,3)
})

test('new unchanged reads advance read time but exact old receipts never pretend to be fresh',async t=>{
  const f=fixture(t);await f.service.bind(binding)
  const old=await f.service.sync(sync)
  f.advance(1000)
  const latest=await f.service.sync({...sync,request_id:'read-2'})
  assert.equal(latest.updated,0);assert.notEqual(latest.last_sync.read_at,old.last_sync.read_at)
  f.advance(1000)
  assert.deepEqual(await f.service.sync(sync),old)
  assert.equal(f.reads,2);assert.deepEqual((await f.service.cards('tapd')).last_sync,latest.last_sync)
  assert.equal(f.inbox.db.prepare('SELECT COUNT(*) n FROM external_events').get().n,1)
  const reopened=new ExternalInbox(f.path)
  try{
    assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version,CACHE_VERSION)
    assert.deepEqual(reopened.get('tapd').last_sync,latest.last_sync)
    assert.deepEqual(reopened.receipt('tapd','read-1',{binding_id:'tapd',expected_revision:1,kind:'story',page:1,parent:null}),old)
  }finally{reopened.close()}
})

test('repeated and out-of-order source pages only describe the most recent committed read',async t=>{
  const f=fixture(t);await f.service.bind(binding)
  for(const [index,page]of [3,1,2,1].entries()){
    f.advance(1000);f.read(async()=>rows(1,page))
    const receipt=await f.service.sync({...sync,page,request_id:'ordered-'+index})
    assert.equal(receipt.last_sync.observed_page,page)
    assert.deepEqual((await f.service.cards('tapd')).last_sync,receipt.last_sync)
  }
  assert.equal((await f.service.cards('tapd')).items.length,3)
})

test('late expired lease cannot overwrite a newer successful read time or evidence',async t=>{
  const f=fixture(t);await f.service.bind(binding)
  let release;f.read(()=>new Promise(resolve=>release=resolve))
  const late=f.service.sync(sync)
  while(!release)await new Promise(resolve=>setImmediate(resolve))
  f.advance(60001);f.read(async()=>rows(1,2))
  const newer=await f.service.sync({...sync,page:2,request_id:'newer'})
  f.advance(1000);release(rows(1))
  await assert.rejects(late,/lease invalidated/)
  const cards=await f.service.cards('tapd')
  assert.deepEqual(cards.last_sync,newer.last_sync);assert.deepEqual(cards.items.map(card=>card.id),['2'])
  assert.equal(f.inbox.receipt('tapd','read-1',{}),null)
})

test('failed source reads and failed post-read authorization preserve the last successful evidence',async t=>{
  const f=fixture(t);await f.service.bind(binding)
  const before=await f.service.sync(sync);f.advance(1000)
  f.read(async()=>{throw Error('Synthetic source failure')})
  await assert.rejects(f.service.sync({...sync,request_id:'failed'}),/Synthetic/)
  assert.deepEqual((await f.service.cards('tapd')).last_sync,before.last_sync)
  f.read(async()=>{f.surfaces[0].audience_revision=2;return rows(0)})
  await assert.rejects(f.service.sync({...sync,request_id:'revoked'}),/authorized/)
  assert.deepEqual(f.inbox.get('tapd').last_sync,before.last_sync)
  await assert.rejects(f.service.cards('tapd'),/authorized/)
})

test('failed receipt commit rolls back cards, events and latest source observation together',async t=>{
  const f=fixture(t);await f.service.bind(binding);const before=await f.service.sync(sync)
  f.inbox.db.exec("CREATE TEMP TRIGGER fail_receipt BEFORE INSERT ON external_receipts BEGIN SELECT RAISE(ABORT, 'Synthetic receipt failure'); END")
  f.advance(1000);f.read(async()=>rows(1,2))
  await assert.rejects(f.service.sync({...sync,request_id:'cannot-commit'}),/Synthetic receipt failure/)
  const cards=await f.service.cards('tapd')
  assert.deepEqual(cards.last_sync,before.last_sync);assert.deepEqual(cards.items.map(card=>card.id),['1'])
  assert.equal(f.inbox.db.prepare('SELECT COUNT(*) n FROM external_events').get().n,1)
  assert.equal(f.inbox.receipt('tapd','cannot-commit',{}),null)
})

test('cards use the latest committed observation after asynchronous Hub authorization',async t=>{
  const f=fixture(t);await f.service.bind(binding);await f.service.sync(sync)
  let release,first=true
  f.backend.call=async()=>{if(first){first=false;return new Promise(resolve=>release=resolve)}return {items:f.surfaces}}
  const pending=f.service.cards('tapd')
  f.advance(1000);f.read(async()=>rows(1,2))
  const latest=await f.service.sync({...sync,request_id:'newer'})
  release({items:f.surfaces})
  const cards=await pending
  assert.deepEqual(cards.last_sync,latest.last_sync);assert.equal(cards.items.length,2)
})

test('rebind clears read evidence and in-flight old authorization cannot restore it',async t=>{
  const f=fixture(t);await f.service.bind(binding);await f.service.sync(sync)
  let release;f.read(()=>new Promise(resolve=>release=resolve))
  const pending=f.service.sync({...sync,request_id:'in-flight'})
  while(!release)await new Promise(resolve=>setImmediate(resolve))
  await f.service.bind({...binding,expected_revision:1,enabled:false})
  assert.equal(f.inbox.get('tapd').last_sync,undefined)
  release(rows(1));await assert.rejects(pending,/invalidated/)
  await f.service.bind({...binding,expected_revision:2})
  const cleared=await f.service.cards('tapd')
  assert.equal(cleared.last_sync,null);assert.equal(cleared.items.length,0)
})

test('changed connection revisions and removed empty-page capabilities cannot expose old evidence',async t=>{
  const f=fixture(t);await f.service.bind(binding);f.read(async()=>rows(0));await f.service.sync(sync)
  f.connections.set('tapd',f.provider('v1',[]))
  await assert.rejects(f.service.cards('tapd'),/capability/)
  assert.equal(Object.hasOwn((await f.service.list(scope))[0],'last_sync'),false)
  f.connections.set('tapd',f.provider('v2'))
  await assert.rejects(f.service.cards('tapd'),/Connection/)
  assert.deepEqual(await f.service.list(scope),[])
  await f.service.bind({...binding,expected_revision:1})
  assert.equal((await f.service.cards('tapd')).last_sync,null)
})

test('separate scoped bindings never share read evidence for the same external source',async t=>{
  const f=fixture(t);await f.service.bind(binding);await f.service.sync(sync)
  const otherScope={...scope,workspace_id:'other',root_ref:'/fixture/other'}
  f.surfaces.push({...f.surfaces[0],id:'other-channel',scope:otherScope})
  await f.service.bind({...binding,id:'other',scope:otherScope,surface_id:'other-channel'})
  assert.equal((await f.service.cards('other')).last_sync,null)
  f.advance(1000);f.read(async()=>rows(0))
  const other=await f.service.sync({...sync,binding_id:'other',page:2,request_id:'other-read'})
  assert.deepEqual((await f.service.cards('other')).last_sync,other.last_sync)
  assert.equal((await f.service.cards('tapd')).last_sync.observed_page,1)
  assert.deepEqual((await f.service.list(otherScope)).map(b=>b.id),['other'])
})

test('legacy v2 cache and original receipts stay unknown until a new read succeeds',async t=>{
  const f=fixture(t);await f.service.bind(binding);const receipt=await f.service.sync(sync)
  // Model the unchanged JSON payloads produced by schema v2 before read metadata.
  const stored=f.inbox.get('tapd');delete stored.last_sync;delete receipt.last_sync
  f.inbox.db.prepare('UPDATE external_bindings SET body=? WHERE id=?').run(JSON.stringify(stored),'tapd')
  f.inbox.db.prepare('UPDATE external_receipts SET body=? WHERE binding=? AND request=?').run(JSON.stringify(receipt),'tapd','read-1')
  f.inbox.close()
  const inbox=new ExternalInbox(f.path),service=new ExternalResources({inbox,backendClient:f.backend,connections:f.connections})
  try{
    assert.equal((await service.cards('tapd')).last_sync,null)
    assert.deepEqual(await service.sync(sync),receipt)
    assert.equal((await service.cards('tapd')).last_sync,null);assert.equal(f.reads,1)
    await service.sync({...sync,request_id:'new-read'})
    assert.equal((await service.cards('tapd')).last_sync.request_id,'new-read')
  }finally{service.close()}
})

test('observed count includes source records filtered by read capability, not just cached cards',async t=>{
  const f=fixture(t),github={provider:'github',instance:'https://api.github.example',resource:'owner/repo'}
  f.connections.set('github',new ReadonlyProvider({source:github,authorizationRevision:'v1',capabilities:['issue'],readJson:async()=>[{id:9,number:1,title:'Excluded PR',pull_request:{}}]}))
  await f.service.bind({...binding,id:'github',connection_id:'github',source:github})
  const receipt=await f.service.sync({...sync,binding_id:'github',kind:'issue'})
  assert.equal(receipt.observed,0);assert.equal(receipt.last_sync.observed_count,1)
  assert.deepEqual((await f.service.cards('github')).last_sync,receipt.last_sync)
})

test('coverage cannot infer a next page or completeness from page size or invalid metadata',()=>{
  const coverage={mode:'single_page_snapshot',observed_page:1,requested_limit:100,observed_count:0,has_more:'unknown',reconciliation:'not_performed'}
  const command={kind:'story',page:1,parent:null}
  for(const patch of [{observed_page:2},{requested_limit:10},{observed_count:-1},{observed_count:101},{has_more:false},{has_more:true},{reconciliation:'complete'},{mode:'complete_snapshot'}]){
    assert.throws(()=>pageObservation({objects:[],coverage:{...coverage,...patch}},command,'read',0),/observation/)
  }
  assert.throws(()=>pageObservation({objects:[{}],coverage},command,'read',0),/observation/)
  assert.throws(()=>pageObservation({objects:[],coverage},{...command,parent:{kind:'task',id:'999'}},'read',0),/observation/)
  assert.throws(()=>pageObservation({objects:[],coverage},{...command,kind:'comment'},'read',0),/observation/)
})

test('non-comment parent hints cannot invent source coverage or change the latest successful read',async t=>{
  const f=fixture(t);await f.service.bind(binding);const previous=await f.service.sync(sync)
  const before=await f.service.cards('tapd')
  const reads=f.reads;f.advance(1000)
  await assert.rejects(f.service.sync({...sync,request_id:'invalid-parent',parent:{kind:'task',id:'999'}}),/parent/i)
  assert.equal(f.reads,reads)
  const after=await f.service.cards('tapd')
  assert.deepEqual(after,before);assert.deepEqual(after.last_sync,previous.last_sync)
  assert.equal(after.items[0].parent_key,null)
  assert.equal(f.inbox.db.prepare('SELECT COUNT(*) n FROM external_events').get().n,1)
})

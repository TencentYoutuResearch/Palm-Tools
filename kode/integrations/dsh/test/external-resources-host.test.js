import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync, symlinkSync, statSync, linkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Readable} from 'node:stream'
import {DatabaseSync} from 'node:sqlite'
import {mountExternalResources} from '../src/external-integrations/host.js'
import {ExternalInbox, CACHE_VERSION} from '../src/external-integrations/inbox.js'
import {ReadonlyProvider} from '../src/external-integrations/providers.js'
import {privateCachePath} from '../src/external-integrations/cache-storage.js'

function temporary(t) {const root=mkdtempSync(join(tmpdir(),'external-host-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root}
function mount(t, options={}) {
 const root=options.root??temporary(t), handlers=new Map();let removed=0
 const ctx={webServer:{register:route=>{handlers.set(route.path,route.handler);return()=>{handlers.delete(route.path);removed++}}},connection:{admit:req=>req.principal?{peer:{principal:{kind:req.principal}}}:{rejection:401}}}
 const dispose=mountExternalResources(ctx,{backendClient:{url:'http://127.0.0.1:1',call:async()=>{throw Error('Unexpected Hub access')}},homeId:'home',stateFile:join(root,'state.json'),...options})
 t.after(dispose)
 return {root,handlers,dispose,get removed(){return removed},async invoke(query='?op=status',principal='owner',body){
  const handler=handlers.get('/api/kode/external-resources');assert.ok(handler)
  const req=Readable.from(body===undefined?[]:[JSON.stringify(body)])
  Object.assign(req,{url:'/api/kode/external-resources'+query,method:body?'POST':'GET',principal,headers:{'content-type':'application/json'}})
  let status,result
  await handler(req,{writeHead:value=>status=value,end:value=>result=JSON.parse(value)})
  return {status,result}
 }}
}
const source={provider:'tapd',instance:'https://tapd.example',resource:'100'}
const connections=()=>new Map([['tapd',new ReadonlyProvider({source,authorizationRevision:'fixture-v1',capabilities:['story'],readJson:async()=>{throw Error('Unexpected provider access')}})]])
test('Host facade mounts disabled without a registry, with no cache or I/O side effects',async t=>{
 const f=mount(t)
 assert.deepEqual((await f.invoke()).result,{state:'disabled',reason:'authorized_connection_registry_unavailable',authorized_connections:0,provider_health:'not_checked',dispatch:'disabled'})
 assert.equal(existsSync(join(f.root,'external-resources')),false)
 assert.equal((await f.invoke('?op=cards&binding=unknown')).status,503)
 assert.equal((await f.invoke('', 'owner', {op:'sync'})).status,503)
 assert.equal((await f.invoke('?op=status','session')).status,403)
 assert.equal((await f.invoke('?op=status',null)).status,401)
 f.dispose();f.dispose();assert.equal(f.handlers.size,0);assert.equal(f.removed,1)
})
test('empty authorized registry is distinct from missing integration and creates no cache',async t=>{
 const f=mount(t,{connections:new Map()})
 assert.equal((await f.invoke()).result.reason,'no_authorized_connections')
 assert.equal(existsSync(join(f.root,'external-resources')),false)
})
test('approved transport mount owns a private cache and disposal releases it without probing provider',async t=>{
 const f=mount(t,{connections:connections()})
 assert.equal((await f.invoke()).result.state,'ready')
 assert.equal((await f.invoke()).result.provider_health,'not_checked')
 const identity={home_hub:'home',backend_url:'http://127.0.0.1:1'},path=privateCachePath(join(f.root,'state.json'),identity)
 assert.equal(statSync(path).mode&0o777,0o600)
 f.dispose()
 const reopened=new ExternalInbox(path,{cacheIdentity:identity});reopened.close()
})
test('cache errors disable only the external facade and leak no local paths',async t=>{
 const root=temporary(t);writeFileSync(join(root,'external-resources'),'not a directory')
 const f=mount(t,{root,connections:connections()})
 const status=await f.invoke();assert.equal(status.result.state,'disabled');assert.equal(status.result.reason,'cache_unavailable')
 assert.equal(JSON.stringify(status).includes(root),false)
})
test('cache refuses future and unversioned databases without schema changes',t=>{
 const root=temporary(t)
 for(const version of [0,CACHE_VERSION+1]){
  const path=join(root,`unsupported-${version}.sqlite`)
  writeFileSync(path,'',{mode:0o600});const db=new DatabaseSync(path);db.exec(`CREATE TABLE sentinel(value TEXT);INSERT INTO sentinel VALUES('untouched');PRAGMA user_version=${version}`);db.close()
  const before=readFileSync(path)
  assert.throws(()=>new ExternalInbox(path),/version/)
  assert.deepEqual(readFileSync(path),before)
 }
})
test('cache identity cannot be silently rebound to another Host or Hub',t=>{
 const root=temporary(t),path=join(root,'cache.sqlite'),inbox=new ExternalInbox(path,{cacheIdentity:'home-one'})
 inbox.close();const before=readFileSync(path)
 assert.throws(()=>new ExternalInbox(path,{cacheIdentity:'home-two'}),/identity/)
 assert.deepEqual(readFileSync(path),before)
 const reopened=new ExternalInbox(path,{cacheIdentity:'home-one'});reopened.close()
})
test('cache rejects exposed directories, symlink/hardlink files and exposed files',t=>{
 const root=temporary(t),path=join(root,'cache.sqlite'),target=join(root,'target.sqlite')
 writeFileSync(target,'',{mode:0o600});symlinkSync(target,path)
 assert.throws(()=>new ExternalInbox(path),/Private cache file/)
 const hard=join(root,'hard.sqlite');linkSync(target,hard);assert.throws(()=>new ExternalInbox(hard),/Private cache file/)
 const open=join(root,'exposed.sqlite');writeFileSync(open,'',{mode:0o644});chmodSync(open,0o644);assert.throws(()=>new ExternalInbox(open),/Private cache file/)
 chmodSync(root,0o755);assert.throws(()=>new ExternalInbox(join(root,'new.sqlite')),/directory/);chmodSync(root,0o700)
})
test('Host mounting is explicit inside the existing authenticated web lifecycle',()=>{
 const host=readFileSync(new URL('../src/host.js',import.meta.url),'utf8')
 assert.match(host,/ctx\.inject\(\['webServer', 'connection'\], async webCtx =>[\s\S]*mountExternalResources\(webCtx, \{ backendClient: admin, homeId: node\.node_id, stateFile, connections: externalConnections \}\)/)
 assert.match(host,/'kode\.external-resources-api'/)
 assert.doesNotMatch(host,/connections:.*(?:process\.env|runtimeConfig)/)
})

test('previous GitHub identity cache version is rejected without adopting old cards',t=>{
 const root=temporary(t),path=join(root,'legacy-identity.sqlite'),inbox=new ExternalInbox(path)
 inbox.close()
 const legacy=new DatabaseSync(path);legacy.exec(`PRAGMA user_version=${CACHE_VERSION-1}`);legacy.close()
 const before=readFileSync(path)
 assert.throws(()=>new ExternalInbox(path),/version/)
 assert.deepEqual(readFileSync(path),before)
})

test('late trusted registry insertion initializes only for owner; revocation stays fail closed',async t=>{
 const registry=new Map(),f=mount(t,{connections:registry})
 assert.equal((await f.invoke()).result.reason,'no_authorized_connections')
 let reads=0
 registry.set('tapd',new ReadonlyProvider({source,authorizationRevision:'late-v1',capabilities:['story'],readJson:async()=>{reads++;throw Error('Unexpected provider access')}}))
 assert.equal((await f.invoke('?op=status','session')).status,403)
 assert.equal((await f.invoke('?op=status',null)).status,401)
 assert.equal(existsSync(join(f.root,'external-resources')),false)
 assert.equal((await f.invoke()).result.state,'ready')
 assert.equal((await f.invoke()).result.authorized_connections,1)
 assert.equal(reads,0)
 registry.delete('tapd')
 const revoked=(await f.invoke()).result
 assert.equal(revoked.state,'disabled')
 assert.equal(revoked.authorized_connections,0)
 assert.equal(revoked.reason,'no_authorized_connections')
 assert.equal((await f.invoke('', 'owner', {op:'sync',binding_id:'missing',expected_revision:1,request_id:'revoked',kind:'story',page:1})).status,409)
 assert.equal(reads,0)
 f.dispose();f.dispose();assert.equal(f.removed,1)
})

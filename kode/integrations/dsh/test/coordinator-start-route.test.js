import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { registerCoordinatorStart, registerCoordinatorPlannedStart } from '../src/coordinator-start-route.js'

for (const [register,path,method] of [[registerCoordinatorStart,'start','startCoordinator'],[registerCoordinatorPlannedStart,'bootstrap','startPlannedCoordinator']]) test(`Coordinator ${path} owner HTTP route bounds requests and preserves recovery semantics`,async()=>{
  let route,calls=0,available=true,fail=false,last
  const host={[method]:async input=>{calls++;last=input;if(fail)throw new Error('fixture private provider diagnostics');return {state:'created',fingerprint:'fixture'}}}
  register({webServer:{register:r=>{route=r;return()=>{}}},get:()=>available?{officialLoops:host}:undefined,
    connection:{admit:req=>req.headers['x-fixture-principal']?{peer:{principal:{kind:req.headers['x-fixture-principal']}}}:{rejection:401}}})
  assert.equal(route.path,`/api/kode/coordinator/${path}`)
  const server=createServer((req,res)=>route.handler(req,res))
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const url=`http://127.0.0.1:${server.address().port}${route.path}`
  const request=(body,headers={'x-fixture-principal':'owner','content-type':'application/json'},method='POST')=>fetch(url,{method,headers,...(method==='GET'?{}:{body})})
  try{
    assert.equal((await request('{}',{'content-type':'application/json'})).status,401)
    assert.equal((await request('{}',{'x-fixture-principal':'agent','content-type':'application/json'})).status,403)
    assert.equal((await request('{}',{'x-fixture-principal':'owner'})).status,415)
    assert.equal((await request(null,{'x-fixture-principal':'owner'},'GET')).status,405)
    available=false;assert.equal((await request('{}')).status,503);available=true
    assert.equal((await request('x'.repeat(131073))).status,413)
    assert.equal((await request('{')).status,409)
    assert.equal(calls,0)
    const body={command_id:'create',team_id:'candidate',provider:'fixture',start:{request_id:'start'}}
    const ok=await request(JSON.stringify(body));assert.equal(ok.status,200)
    assert.equal(ok.headers.get('cache-control'),'no-store')
    assert.deepEqual(last,body);assert.deepEqual(await ok.json(),{state:'created',fingerprint:'fixture'})
    fail=true;const unknown=await request(JSON.stringify(body));assert.equal(unknown.status,409)
    const result=await unknown.json();assert.equal(result.retry,'same_request')
    assert.doesNotMatch(JSON.stringify(result),/private provider/)
    assert.equal(calls,2,'the route does not perform hidden retries')
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})

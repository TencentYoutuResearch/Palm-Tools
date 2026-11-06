import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { registerBuilderAccounting } from '../src/builder-accounting-route.js'
test('Builder settlement requires explicit owner confirmation and never retries an ambiguous mutation',async()=>{
 let route,calls=0,fail=false,last
 registerBuilderAccounting({webServer:{register:r=>{route=r;return()=>{}}},connection:{admit:req=>({peer:{principal:{kind:req.headers['x-owner']==='yes'?'owner':'agent'}}})}},
  {backendClient:{call:async(path,body)=>{calls++;last={path,body};if(fail)throw Error('private diagnostic');return {label:'团队预算',provider_cost_status:'unconfirmed'}}}})
 const server=createServer((req,res)=>route.handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening')
 const post=(body,owner=true)=>fetch(`http://127.0.0.1:${server.address().port}${route.path}`,{method:'POST',headers:{'content-type':'application/json','x-owner':owner?'yes':'no'},body:JSON.stringify(body)})
 const command={request_id:'final',attempt:1,epoch:1,expected_revision:5,price_id:'price',settlement:'internal_price'},input={operation_id:'creation',command}
 try{
  assert.equal((await post(input,false)).status,403)
  for(const bad of [{...input,extra:true},{...input,command:{...command,settlement:'estimated'}},{...input,command:{...command,expected_revision:0}}])assert.equal((await post(bad)).status,400)
  assert.equal(calls,0)
  const ok=await post(input);assert.equal(ok.status,200);assert.equal(ok.headers.get('cache-control'),'no-store')
  assert.deepEqual(last,{path:'/api/v1/messaging/operations/creation/builder-accounting',body:command})
  fail=true;const ambiguous=await post(input);assert.equal(ambiguous.status,409)
  const body=await ambiguous.json();assert.equal(body.retry,'same_request');assert.doesNotMatch(JSON.stringify(body),/private diagnostic/)
  assert.equal(calls,2)
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})

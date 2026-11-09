import test from 'node:test'
import assert from 'node:assert/strict'
import { registerBuilderInput } from '../src/builder-input-route.js'
test('owner input route rejects spoofed authority and keeps receipt reads free of execution',async()=>{
  let route,kind='agent',status,result,fail=false
  const calls=[]
  registerBuilderInput({webServer:{register:r=>{route=r}},connection:{admit:()=>({peer:{principal:{kind}}})}},{backendClient:{call:async(path,body)=>{
    calls.push({path,body});if(fail)throw new Error('private backend diagnostic')
    if(path.endsWith('/delivery'))return {delivery:{phase:'consumed'}}
    return body?{request:body,receipt:{message_id:'message'}}:{input:{receipt:{message_id:'message'}}}
  }}})
  const res={writeHead:s=>{status=s},end:s=>{result=JSON.parse(s)}}
  const req=(body,method='POST',url='/api/kode/builder/input')=>({method,url,headers:{'content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify(body)}})
  const input={operation_id:'op',draft_id:'draft',request_id:'request',attempt:1,epoch:1,content:'Help create a team'}
  await route.handler(req(input),res);assert.equal(status,403);assert.equal(calls.length,0)
  await route.handler(req(null,'GET','/api/kode/builder/input?operation_id=op&request_id=request'),res);assert.equal(status,403)
  kind='owner'
  for(const extra of [{actor:{kind:'human'}},{source:'owner'},{builder_operation:{id:'other'}},{content:'x'.repeat(16385)},{epoch:0}]){
    await route.handler(req({...input,...extra}),res);assert.equal(status,400)
  }
  assert.equal(calls.length,0)
  await route.handler(req(input),res);assert.equal(status,200)
  assert.equal(calls[0].path,'/api/v1/messaging/operations/op/builder-inputs')
  assert.equal(calls[0].body.operation_id,undefined)
  await route.handler(req(null,'GET','/api/kode/builder/input?operation_id=op&request_id=request'),res)
  assert.equal(status,200);assert.equal(result.delivery.phase,'consumed')
  assert.ok(calls.slice(1).every(c=>c.body===undefined),'receipt lookup performs only reads')
  fail=true;await route.handler(req(input),res);assert.equal(status,409);assert.equal(result.retry,'same_request')
  assert.doesNotMatch(JSON.stringify(result),/private backend/)
})

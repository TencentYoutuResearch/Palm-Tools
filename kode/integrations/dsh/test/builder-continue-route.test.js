import test from 'node:test'
import assert from 'node:assert/strict'
import { registerBuilderContinue } from '../src/builder-continue-route.js'
test('owner confirmation bridge preserves exact command and rejects authority injection',async()=>{
  let route,kind='agent',status,result,fail=false
  const calls=[]
  registerBuilderContinue({webServer:{register:r=>{route=r}},connection:{admit:()=>({peer:{principal:{kind}}})}},
    {backendClient:{call:async(...args)=>{calls.push(args);if(fail)throw Error('private backend details');return {draft:{revision:2},input:{receipt:{message_id:'one'}}}}}})
  const res={writeHead:s=>{status=s},end:b=>{result=JSON.parse(b)}}
  const request=body=>({method:'POST',headers:{'content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify(body)}})
  const command={operation_id:'op',draft_id:'draft',attempt:1,epoch:1,answer:{request_id:'confirm',expected_revision:1,answers:{budget:'50'}}}
  await route.handler(request(command),res);assert.equal(status,403);assert.equal(calls.length,0)
  kind='owner'
  for(const invalid of [{...command,actor:'owner'},{...command,answer:{...command.answer,builder_operation:{id:'spoof'}}}]){
    await route.handler(request(invalid),res);assert.equal(status,400);assert.equal(calls.length,0)
  }
  await route.handler(request(command),res);assert.equal(status,200)
  const {operation_id,...body}=command
  assert.deepEqual(calls,[['/api/v1/messaging/operations/op/builder-continue',body]])
  assert.equal(result.input.receipt.message_id,'one')
  fail=true
  await route.handler(request(command),res);assert.equal(status,409);assert.equal(result.retry,'same_request')
  assert.equal(calls.length,2,'bridge never retries ambiguous confirmation itself')
  assert.doesNotMatch(JSON.stringify(result),/private backend/)
})

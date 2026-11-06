import test from 'node:test'
import assert from 'node:assert/strict'
import { registerWorkRun } from '../src/work-run-route.js'
test('owner work controls preserve exact cancellation intent and reject injected authority',async()=>{
  let route,status,result,principal='owner';const calls=[]
  registerWorkRun({webServer:{register:r=>{route=r}},connection:{admit:()=>({peer:{principal:{kind:principal}}})}},
    {backendClient:{call:async(...args)=>{calls.push(args);return {state:'cancelling',stop_confirmed:false}}}})
  const res={writeHead:s=>{status=s},end:b=>{result=JSON.parse(b)}}
  const post=body=>({method:'POST',headers:{'content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify(body)}})
  const command={run_id:'run',action:'request_cancel',request_id:'decision',expected_revision:4,reason:'Stop this work'}
  for(const action of ['request_cancel','cancel_settled','recheck_execution','takeover','resume']){
    await route.handler(post({...command,action}),res)
    assert.equal(status,200);assert.equal(result.stop_confirmed,false)
    const {run_id,...body}={...command,action}
    assert.deepEqual(calls.at(-1),['/api/v1/messaging/work-runs/run',body])
  }
  for(const change of [{reason:''},{reason:'\0'},{reason:'字'.repeat(700)},{reason:null},{expected_revision:1.5},{action:'finalize_takeover'},{action:'finalize_cancel'},{home_hub:'foreign'},{run_id:'../other'}]){
    await route.handler(post({...command,...change}),res);assert.equal(status,400)
  }
  await route.handler(post({...command,reason:'x'.repeat(17000)}),res);assert.equal(status,413)
  principal='agent';await route.handler(post(command),res);assert.equal(status,403)
  assert.equal(calls.length,5)
})
test('session diagnostics forward exact revision and cursor only after owner authentication', async () => {
  let route, status, principal = 'owner'; const calls = []
  registerWorkRun({ webServer: { register: value => { route = value } }, connection: { admit: () => ({ peer: { principal: { kind: principal } } }) } },
    { backendClient: { call: async (...input) => { calls.push(input); return { read_only: true } } } })
  const response = { writeHead: value => { status = value }, end() {} }
  const request = url => ({ method: 'GET', url })
  await route.handler(request('/api/kode/work-run?run_id=run&view=diagnostics&run_revision=4&after=assignment'), response)
  assert.equal(status, 200)
  assert.deepEqual(calls, [['/api/v1/messaging/work-runs/run/diagnostics?run_revision=4&after=assignment']])
  for (const query of ['run_revision=0', 'run_revision=1.5', 'run_revision=4&run_revision=5', 'run_revision=4&after=../x', 'run_revision=4&home_hub=other']) {
    await route.handler(request('/api/kode/work-run?run_id=run&view=diagnostics&' + query), response); assert.equal(status, 400)
  }
  principal = 'agent'
  await route.handler(request('/api/kode/work-run?run_id=run&view=diagnostics&run_revision=4'), response)
  assert.equal(status, 403); assert.equal(calls.length, 1)
})

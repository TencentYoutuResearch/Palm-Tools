import test from 'node:test'
import assert from 'node:assert/strict'
import { registerWorkRunReceipt } from '../src/work-run-receipt-route.js'
test('command receipt reads preserve atomic Home proof and require owner/exact scope', async () => {
  let route, principal='owner', status, result, calls=0
  let proof={snapshot:'work_run_command_receipt.v1',home_hub:'home',run_id:'run',team_id:'team',request_id:'old-request',run_revision:8,run_state:'cancelled',receipt:null}
  registerWorkRunReceipt({webServer:{register:r=>{route=r}},connection:{admit:()=>({peer:{principal:{kind:principal}}})},get:()=>({officialExecution:{host:'home'}})},
    {backendClient:{call:async(path,body)=>{assert.equal(path,'/api/v1/messaging/work-runs/run/commands/old-request');assert.equal(body,undefined);calls++;return proof}}})
  const response={writeHead:s=>{status=s},end:value=>{result=JSON.parse(value)}}
  const query='/api/kode/work-run/receipt?run_id=run&team_id=team&request_id=old-request'
  await route.handler({method:'GET',url:query},response);assert.equal(status,200);assert.deepEqual(result,proof)
  principal='worker';await route.handler({method:'GET',url:query},response);assert.equal(status,403);assert.equal(calls,1)
  principal='owner';await route.handler({method:'POST',url:query},response);assert.equal(status,405)
  for(const bad of [query+'&extra=1',query+'&run_id=another',query.replace('run_id=run','run_id=../run'),query.replace('&request_id=old-request','')]){await route.handler({method:'GET',url:bad},response);assert.equal(status,400)}
  assert.equal(calls,1)
  for(const change of [{home_hub:'foreign'},{team_id:'other'},{request_id:'other'},{snapshot:'split_reads'},{run_revision:0},{receipt:undefined}]){
    const original=proof;proof={...proof,...change};await route.handler({method:'GET',url:query},response);assert.equal(status,409);proof=original
  }
})

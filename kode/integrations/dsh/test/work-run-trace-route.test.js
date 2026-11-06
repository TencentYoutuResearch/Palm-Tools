import test from 'node:test'
import assert from 'node:assert/strict'
import { registerWorkRunTrace } from '../src/work-run-trace-route.js'
test('trace bridge restricts exact owner scope and read-only query vocabulary',async()=>{
 let route,status,body,principal='owner',calls=0
 const result={schema_version:1,read_only:true,home_hub:'home',team_id:'team',run_id:'run',run_revision:3,view:'work_events'}
 registerWorkRunTrace({webServer:{register:r=>{route=r}},get:()=>({officialExecution:{host:'home'}}),connection:{admit:()=>({peer:{principal:{kind:principal}}})}}, {backendClient:{call:async(path,input)=>{assert.equal(input,undefined);assert.equal(path,'/api/v1/messaging/work-runs/run/trace?view=work_events&run_revision=3');calls++;return result}}})
 const res={writeHead:s=>{status=s},end:r=>{body=JSON.parse(r)}}
 const url='/api/kode/work-run/trace?run_id=run&team_id=team&view=work_events&run_revision=3'
 await route.handler({method:'GET',url},res);assert.equal(status,200);assert.deepEqual(body,result)
 for(const bad of [url+'&run_id=other',url+'&action=execute',url+'&after=-1',url+'&limit=51',url.replace('view=work_events','view=../private'),url.replace('run_id=run','run_id=../run')]){await route.handler({method:'GET',url:bad},res);assert.equal(status,400)}
 await route.handler({method:'POST',url},res);assert.equal(status,405);principal='agent';await route.handler({method:'GET',url},res);assert.equal(status,403);assert.equal(calls,1)
 principal='owner';result.home_hub='foreign';await route.handler({method:'GET',url},res);assert.equal(status,409)
})

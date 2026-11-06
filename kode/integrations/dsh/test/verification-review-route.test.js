import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp,writeFile,chmod,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VerificationRunners } from '../src/verification-runners.js'
import { registerVerificationReview } from '../src/verification-review-route.js'
test('real HTTP owner review rejects Worker before file access, requires exact confirmation and restores lost result',async t=>{
 const root=await mkdtemp(join(tmpdir(),'kode-review-http-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const file=join(root,'check');await writeFile(file,'unrunnable fixture executable');await chmod(file,0o700)
 let runners=new VerificationRunners(join(root,'registry')),runtime={host:'home',verificationRunners:runners,ready:Promise.resolve(),closed:false},route,loss=true
 const ctx={get:()=>({officialExecution:runtime}),webServer:{register:r=>{route=r}},connection:{admit:req=>({peer:{principal:{kind:req.headers['x-fixture-owner']==='yes'?'owner':'agent'}}})}}
 registerVerificationReview(ctx)
 const server=createServer((req,res)=>route.handler(req,req.headers['x-fixture-loss']==='yes'&&loss?{writeHead(){},end(){loss=false;res.writeHead(503,{'content-type':'application/json'});res.end('{}')}}:res))
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()})
 const call=async(body,{owner=true,lost=false,method='POST',query=''}={})=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/kode/verification/review${query}`,{method,headers:{'content-type':'application/json',...(owner?{'x-fixture-owner':'yes'}:{}),...(lost?{'x-fixture-loss':'yes'}:{})},...(method==='POST'?{body:JSON.stringify(body)}:{})});return {status:response.status,value:await response.json()}}
 const definition={runner_id:'local',command_id:'check',revision:'1',executable:file,args:[],timeout_ms:1000,max_output_bytes:1024,scenario_ids:['smoke'],capabilities:['read'],network:false,tool_id:'kode_verify_output'}
 assert.equal((await call({action:'preview',definition:{...definition,executable:'/missing-private-file'}},{owner:false})).status,403)
 assert.equal((await call(null,{method:'GET'})).status,405)
 assert.equal((await call({action:'preview',definition},{query:'?actor=owner'})).status,400)
 assert.equal((await call({action:'preview',definition,actor:'human'})).status,400)
 const reviewed=await call({action:'preview',definition});assert.equal(reviewed.status,200);assert.equal(runners.definitions.size,0)
 const review=reviewed.value
 assert.equal((await call({action:'confirm',review},{owner:false})).status,403)
 assert.equal((await call({action:'confirm',review:{...review,scope_hash:'0'.repeat(64)}})).status,409)
 assert.equal((await call({action:'confirm',review},{lost:true})).status,503)
 assert.equal(runners.definitions.size,1);assert.equal(runners.pending.size,0)
 await runners.close();runners=await new VerificationRunners(join(root,'registry')).open();runtime={...runtime,verificationRunners:runners}
 const recovered=await call({action:'confirm',review});assert.equal(recovered.status,200);assert.equal(recovered.value.execution_performed,false)
 assert.deepEqual(recovered.value.reference,review.reference);await runners.close()
})

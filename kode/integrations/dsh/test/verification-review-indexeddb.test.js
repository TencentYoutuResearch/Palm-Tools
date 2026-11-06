import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp,writeFile,chmod,readFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VerificationRunners } from '../src/verification-runners.js'
import { headlessBrowser } from './support/headless-browser.js'
import { previewVerification } from '../src/verification-review.js'
import { registerVerificationReview } from '../src/verification-review-route.js'
const plugin=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'')
test('real IndexedDB survives page recreation and recovers the exact owner command after committed HTTP response loss',{skip:!process.env.KODE_TEST_BROWSER_BIN},async()=>{
 const root=await mkdtemp(join(tmpdir(),'kode-review-browser-'))
 let browser,server,runners
 try{
 const file=join(root,'check');await writeFile(file,'fixture executable not run');await chmod(file,0o700)
 runners=new VerificationRunners(join(root,'registry'))
 const review=await previewVerification(runners,'home',{runner_id:'local',command_id:'check',revision:'1',executable:file,args:[],timeout_ms:1000,max_output_bytes:1024,scenario_ids:['smoke'],capabilities:['read'],network:false,tool_id:'kode_verify_output'})
 let route,posts=0,lost=false
 registerVerificationReview({get:()=>({officialExecution:{host:'home',verificationRunners:runners}}),webServer:{register:r=>{route=r}},connection:{admit:()=>({peer:{principal:{kind:'owner'}}})}})
 const consent=(await readFile(new URL('../packages/collab/verification-review-command.js',import.meta.url),'utf8')).replace(/from '[^']+builder-accept-command.js'/,"from '/canonical.js'")
 const modules={'/consent.js':consent,'/canonical.js':await readFile(join(plugin,'packages/collab/builder-accept-command.js'),'utf8'),'/storage.js':await readFile(join(plugin,'packages/collab/outbox-storage.js'),'utf8')}
 server=createServer(async(req,res)=>{
  try{
   if(req.url==='/api/kode/verification/review'){
    posts++;let status,headers
    return await route.handler(req,{writeHead(s,h){status=s;headers=h},end(body){const value=JSON.parse(body);if(status===200&&!value.definition&&!lost){lost=true;res.writeHead(503,{'content-type':'application/json'});res.end('{}')}else{res.writeHead(status,headers);res.end(body)}}})
   }
   if(modules[req.url]){res.writeHead(200,{'content-type':'text/javascript'});return res.end(modules[req.url])}
   if(req.url!=='/'){res.writeHead(404);return res.end()}
   res.writeHead(200,{'content-type':'text/html'});res.end(`<script type="module">import {confirmReviewedVerification,verificationReviewKey} from '/consent.js';import {createOutboxStorage} from '/storage.js';window.fixture={confirmReviewedVerification,storage:createOutboxStorage(),review:${JSON.stringify(review)},key:verificationReviewKey('home','local','check','1')};</script>`)
  }catch{if(!res.headersSent)res.writeHead(500);res.end()}
 })
 server.listen(0,'127.0.0.1');await once(server,'listening')
 browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,join(root,'chrome'))
 const url=`http://127.0.0.1:${server.address().port}`
 let page=await browser.page(url)
 const ready=()=>page.evaluate(`(async()=>{const until=Date.now()+5000;while(!window.fixture){if(Date.now()>until)throw Error('module boot failed');await new Promise(r=>setTimeout(r,10))}})()`)
 await ready()
 const identity=`{host:'home',runner:'local',command:'check',revision:'1',storage:fixture.storage}`
 assert.equal(await page.evaluate(`(async()=>{try{await fixture.confirmReviewedVerification({...${identity},review:fixture.review});return 'unexpected'}catch{return (await fixture.storage.read(fixture.key)).state}})()`),'prepared')
 assert.equal(posts,1);assert.equal(runners.definitions.size,1)
 await page.evaluate('fixture.storage.close()');await page.close()
 page=await browser.page(url);await ready()
 const recovered=await page.evaluate(`(async()=>{const saved=await fixture.storage.read(fixture.key);if(saved.review.scope_hash!==fixture.review.scope_hash)throw Error('review changed');const receipt=await fixture.confirmReviewedVerification({...${identity},recover:true});return {receipt,state:(await fixture.storage.read(fixture.key)).state}})()`)
 assert.equal(recovered.state,'accepted');assert.equal(recovered.receipt.execution_performed,false);assert.deepEqual(recovered.receipt.reference,review.reference)
 assert.equal(posts,2);assert.equal(runners.definitions.size,1);assert.equal(runners.pending.size,0)
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await runners?.close();await rm(root,{recursive:true,force:true})}
})

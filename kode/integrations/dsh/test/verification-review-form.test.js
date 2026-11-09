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
import { build } from 'esbuild'
import { collabRenderPage } from './support/collab-render-page.js'
import { registerVerificationReview } from '../src/verification-review-route.js'
const plugin=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'')
test('actual React command review cancels without registration and recovers committed consent after reload',{skip:!process.env.KODE_TEST_BROWSER_BIN},async()=>{
 const root=await mkdtemp(join(tmpdir(),'kode-review-browser-'))
 let browser,server,runners
 try{
 const file=join(root,'check');await writeFile(file,'fixture executable not run');await chmod(file,0o700)
 runners=new VerificationRunners(join(root,'registry'))
 let route,posts=0,lost=false
 registerVerificationReview({get:()=>({officialExecution:{host:'home',verificationRunners:runners}}),webServer:{register:r=>{route=r}},connection:{admit:()=>({peer:{principal:{kind:'owner'}}})}})
 const bundle=await build({entryPoints:[fileURLToPath(new URL('../packages/collab/verification-review-form.js',import.meta.url))],bundle:true,platform:'browser',format:'esm',external:['react'],write:false})
 const form=bundle.outputFiles[0].text.replace(/import React from "react";/,'const React=globalThis.__KODE_TEST_MODULES__.react;')
 const modules={'/form.js':form,'/storage.js':await readFile(join(plugin,'packages/collab/outbox-storage.js'),'utf8')}
 server=createServer(async(req,res)=>{
  try{
   if(req.url==='/api/kode/verification/review'){
    posts++;let status,headers
    return await route.handler(req,{writeHead(s,h){status=s;headers=h},end(body){const value=JSON.parse(body);if(status===200&&!value.definition&&!lost){lost=true;res.writeHead(503,{'content-type':'application/json'});res.end('{}')}else{res.writeHead(status,headers);res.end(body)}}})
   }
   if(modules[req.url]){res.writeHead(200,{'content-type':'text/javascript'});return res.end(modules[req.url])}
   if(await collabRenderPage(req,res))return
   res.writeHead(404);res.end()
  }catch{if(!res.headersSent)res.writeHead(500);res.end()}
 })
 server.listen(0,'127.0.0.1');await once(server,'listening')
 browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,join(root,'chrome'))
 const url=`http://127.0.0.1:${server.address().port}`
 let page=await browser.page(url)
 await page.call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false})
 const ready=()=>page.evaluate(`(async()=>{const until=Date.now()+5000;while(!window.fixture){if(Date.now()>until)throw Error('module boot failed');await new Promise(r=>setTimeout(r,10))}})()`)
 const wait=predicate=>page.evaluate(`(async()=>{const until=Date.now()+5000;while(!(${predicate})){if(Date.now()>until)throw Error('UI wait failed: '+document.body.innerText.slice(0,800));await new Promise(r=>setTimeout(r,10))}})()`)
 const mount=async()=>{await ready();await page.evaluate(`(async()=>{const {VerificationReviewForm}=await import('/form.js');const {createOutboxStorage}=await import('/storage.js');const React=__KODE_TEST_MODULES__.react;fixture.ctx.slots.register({name:'main',key:'conversation',priority:-100},()=>React.createElement(VerificationReviewForm,{host:'home',storage:globalThis.reviewStorage??=(createOutboxStorage())}));})()`);await wait(`document.querySelector('.kode-collab-verification-setup button')&&!document.querySelector('.kode-collab-verification-setup button').disabled`)}
 const click=label=>page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-verification-setup button')).find(b=>b.textContent===${JSON.stringify(label)}&&!b.disabled).click()`)
 await mount()
 for(const [label,text] of [['命令标识','check'],['可执行文件绝对路径',file],['独占资源标识（逗号分隔，可留空）','port:3000,device.camera']]){await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-verification-setup label')).find(l=>l.textContent===${JSON.stringify(label)}).querySelector('input').focus()`);await page.call('Input.insertText',{text})}
 await click('核对验证命令');await wait(`document.body.innerText.includes('确认登记此命令')`)
 assert.equal(runners.definitions.size,0)
 assert.equal(await page.evaluate(`document.body.innerText.includes('device.camera')&&document.body.innerText.includes('port:3000')`),true)
 await click('返回修改');assert.equal(runners.definitions.size,0)
 await click('核对验证命令');await wait(`document.body.innerText.includes('确认登记此命令')`)
 await click('确认登记此命令');await wait(`document.body.innerText.includes('恢复原命令登记')&&document.querySelector('[role=alert]')`)
 assert.equal(runners.definitions.size,1);assert.equal(posts,3)
 await page.evaluate('reviewStorage.close()');await page.close();page=await browser.page(url)
 await page.call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false})
 await mount();await wait(`document.body.innerText.includes('恢复原命令登记')`)
 await click('恢复原命令登记');await wait(`document.body.innerText.includes('验证命令已登记。')`)
 assert.equal(posts,4);assert.equal(runners.definitions.size,1);assert.equal(runners.pending.size,0)
 assert.deepEqual(runners.reference('local','check','1').exclusive_resources,['device.camera','port:3000'])
 assert.equal(await page.evaluate(`document.querySelector('.kode-collab-verification-setup').scrollWidth<=document.querySelector('.kode-collab-verification-setup').clientWidth`),true)
 const screenshot=await page.call('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/superagent-verification-form-501.png',Buffer.from(screenshot.data,'base64'))

 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await runners?.close();await rm(root,{recursive:true,force:true})}
})

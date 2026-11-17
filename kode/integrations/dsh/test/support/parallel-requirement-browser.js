/** Real collaboration UI over the owned Hub; no model simulation in the screenshot. */
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {headlessBrowser} from './headless-browser.js'
import {collabRenderPage} from './collab-render-page.js'
import {registerCollabTeams,registerCollabRuns} from '../../src/collab-api.js'
import {registerCollaboration} from '../../src/collaboration-route.js'
import {registerConversation} from '../../src/conversation-route.js'
import {registerConversationRead} from '../../src/conversation-read-route.js'
import {registerWorkRun} from '../../src/work-run-route.js'
import {registerCollabBudgets} from '../../src/collab-budgets-route.js'
export async function parallelRequirementScreenshots(hub,workspace,tasks,directory){
 if(!process.env.KODE_TEST_BROWSER_BIN||!directory)return
 const profile=await mkdtemp(join(tmpdir(),'kode-parallel-browser-')),routes=new Map(),ctx={connection:{admit:req=>req.headers['x-fixture-owner']==='yes'?{peer:{principal:{kind:'owner'}}}:{rejection:401}},webServer:{register:r=>routes.set(r.path,r)}}
 for(const register of [registerCollaboration,registerCollabTeams,registerCollabRuns,registerConversation,registerConversationRead,registerCollabBudgets,registerWorkRun])register(ctx,{backendClient:{call:(p,b)=>hub.client.call(p,b)}})
 let browser
 const server=createServer(async(req,res)=>{try{const route=routes.get(new URL(req.url,'http://localhost').pathname);if(route)return await route.handler(req,res);if(await collabRenderPage(req,res,{workspaces:[{workspaceId:workspace.id,title:'同一个 Superagent · 两个独立需求',path:workspace.path,sessionIds:[],createdAt:new Date().toISOString()}]}))return;res.writeHead(404);res.end('{}')}catch{if(!res.headersSent)res.writeHead(500);res.end('{}')}})
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile)
  const page=await browser.page(`http://127.0.0.1:${server.address().port}`),wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+15000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,40))}throw Error('UI state unavailable: '+document.body.innerText)})()`)
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:980,deviceScaleFactor:1,mobile:false})
  await wait(`document.querySelector('.kode-collab-mode-switch button')`)
  await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`)
  await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(x=>x.textContent.includes('协作'))`)
  await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(x=>x.textContent.includes('协作')).click()`)
  await wait(`Array.from(document.querySelectorAll('.kode-discussion-row')).some(x=>x.textContent==='Two independent requirements')`)
  await page.evaluate(`Array.from(document.querySelectorAll('.kode-discussion-row')).find(x=>x.textContent==='Two independent requirements').click()`)
  await wait(`document.querySelector('.kode-discussion-timeline')?.innerText.includes('REQ-A')&&document.querySelector('.kode-discussion-timeline')?.innerText.includes('REQ-B')`)
  await mkdir(directory,{recursive:true})
  const shot=async name=>writeFile(join(directory,name+'.png'),Buffer.from((await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'))
  await shot('01-two-requirements-channel')
  for(let i=0;i<2;i++){
   await page.evaluate(`document.querySelector('[data-message-id="${tasks[i].thread_id}"] .kode-discussion-reply').click()`)
   await wait(`document.querySelector('.kode-discussion-detail')?.innerText.includes(${JSON.stringify(i===0?'REQ-A':'REQ-B')})`)
   const text=await page.evaluate(`document.querySelector('.kode-discussion-detail').innerText`)
   assert.ok(!text.includes(i===0?'REQ-B':'REQ-A'))
   if(i===1)assert.ok(!text.includes('progress?'))
   await shot(i===0?'02-requirement-a-question-and-cancel':'03-requirement-b-unaffected')
  }
 }finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(profile,{recursive:true,force:true})}
}

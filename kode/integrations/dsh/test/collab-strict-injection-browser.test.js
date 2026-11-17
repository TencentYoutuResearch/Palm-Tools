import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {collabRenderPage} from './support/collab-render-page.js'
import {headlessBrowser} from './support/headless-browser.js'
test('collaboration mounts through strict Cordis plugin injection, switches title and mounts settings',{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:60000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'kode-strict-collab-'));let browser,server
 try{
 server=createServer(async(req,res)=>{
  if(req.url==='/api/kode/session-interop'){res.setHeader('content-type','application/json');res.end(JSON.stringify({scope:'local_host',summary:null,grants:[],profiles:[]}));return}
  const end=res.end.bind(res)
  if(req.url==='/')res.end=html=>end(html.replace("plugins['@kode/dsh-collab'].apply(ctx);", "ctx.provide('remote.account',{});ctx.provide('conversation',{});await ctx.plugin(plugins['@kode/dsh-collab']);"))
  if(await collabRenderPage(req,res,{settings:true}))return
  res.setHeader('content-type','application/json');if(req.url.startsWith('/api/kode/project-hosts')){res.end(JSON.stringify({current:'local',hosts:[{id:'local',name:'此计算机'}]}));return}if(req.url.startsWith('/api/kode/collab/teams')){res.end(JSON.stringify({home_hub:'strict',items:[],next_cursor:null}));return}res.statusCode=503;res.end(JSON.stringify({error:'fixture service disabled'}))
 });server.listen(0,'127.0.0.1');await once(server,'listening')
 browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);const page=await browser.page(`http://127.0.0.1:${server.address().port}/`)
 const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+12000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,25))}throw Error('Strict collaboration timeout: '+JSON.stringify(window.fixtureErrors))})()`)
 await wait(`document.querySelector('.kode-collab-mode-switch button')`)
 await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`)
 await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('协作'))`)
 await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('协作')).click()`)
 await wait(`document.querySelector('.kode-collab-mode-switch').textContent.includes('Kode Orbit')`)
 await page.evaluate(`document.querySelector('button[aria-label="Kode"]').click()`)
 await wait(`document.querySelector('#kode-settings-tab-collaboration')`)
 await page.evaluate(`document.querySelector('#kode-settings-tab-collaboration').click()`)
 await wait(`document.querySelector('[aria-label="本机会话互通"] fieldset')`)
 assert.equal(await page.evaluate(`document.querySelectorAll('.kode-settings-nav button').length`),7)
 assert.deepEqual(await page.evaluate(`fixtureErrors`),[])
 assert.equal(await page.evaluate(`document.documentElement.hasAttribute('data-kode-collab-init')`),false)
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await rm(profile,{recursive:true,force:true})}
})

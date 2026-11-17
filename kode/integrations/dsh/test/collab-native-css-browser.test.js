/** Cold start against other ui-workspace builds. The CSS-module hash changes per build (the
 * live rc.5 runtime differs from the dev one), so the 协作 tree must take its row classes from
 * the native style tags actually loaded, never from a hardcoded hash; and when the native CSS
 * is missing it must say so and fall back to the native list instead of unstyled rows.
 * Released client Session stack; nothing is injected by the fixture; no writes, no model. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {createRequire} from 'node:module'
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {collabRenderPage} from './support/collab-render-page.js'
import {headlessBrowser} from './support/headless-browser.js'

const require=createRequire(import.meta.url)
const SID='native-css-session',home='home'
const bundle=await build({entryPoints:['packages/collab/client-source.js'],bundle:true,loader:{'.png':'dataurl'},format:'cjs',platform:'browser',external:['react','react-dom','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-primitives','@kode/dsh-composer'],write:false})
const client=`window.__ModuleLoader__.load({id:'@kode/dsh-collab',factory(require){const module={exports:{}},exports=module.exports;${bundle.outputFiles[0].text};return module.exports}})`
const original=await readFile(require.resolve('@deepseek-ai/dsh-client-ui-workspace/client'),'utf8')
const [rowsHash]=/\b([A-Za-z0-9]{6})_sessionRow\b/.exec(original).slice(1),[listHash]=/\b([A-Za-z0-9]{6})_groupSection\b/.exec(original).slice(1)
// Another build: same code, new CSS-module hashes (what the live runtime ships).
const rehashed=original.replaceAll(rowsHash+'_','Kq9zXa_').replaceAll(listHash+'_','Wr3tPb_')
// Native Rows CSS absent: the tag is injected under a name the tree does not know.
const missing=original.replace('"@deepseek-ai/dsh-client-ui-workspace/Rows.module.css"','"@deepseek-ai/dsh-client-ui-workspace/Rows.module.css.disabled"')
const ref={host_id:home,workspace_id:'ws-fixture',root_ref:'/fixture/project'}
const contact={preference:{revision:0,pinned:false,archived:false,archived_through_sequence:0},archived:false,needs_attention:false,latest_sequence:1,unread_count:0,last_activity_at:0,attention:{decisions:0,resources:0,stopping:0,active_runs:0}}
const team={id:'team-a',home_hub:home,revision:2,superagent_id:'super-a',conversation_id:'dm-a',contact,spec:{name:'评审团队',kind:'coordinator',purpose:'评审',workers:[],workspace_refs:[ref],coordinator_targets:['control'],execution_targets:[]}}

async function boot(workspaceBundle,run){
 const profile=await mkdtemp(join(tmpdir(),'kode-native-css-'));let server,browser
 const send=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value))}
 try{
  server=createServer(async(req,res)=>{
   const url=new URL(req.url,'http://localhost'),q=key=>url.searchParams.get(key)
   if(url.pathname==='/fixture-collab.js'){res.setHeader('content-type','text/javascript');res.end(client);return}
   if(await collabRenderPage(req,res,{workspaceBundle,workspaces:[{workspaceId:'ws-fixture',title:'Kode',path:'/fixture/project',sessionIds:[SID],createdAt:'2026-11-10T00:00:00.000Z'}],
    nativeSession:{id:SID,cwd:'/fixture/project',createdAt:Date.now()-3600e3,updatedAt:Date.now()-3600e3}}))return
   if(req.method!=='GET')return send(res,{error:'此隔离测试不接受写入'},503)
   if(url.pathname==='/api/kode/collaboration'&&q('path')==='surfaces'){const scope=Object.fromEntries(['home_hub','host_id','workspace_id','root_ref'].map(key=>[key,q(key)]));return send(res,{scope,items:[{id:'s-review',kind:'channel',enabled:true,title:'需求评审',scope,team_ids:['team-a'],revision:1}]})}
   if(url.pathname==='/api/kode/collab/teams')return send(res,q('team_id')?{projection:'configuration_revision',team}:{home_hub:home,projection:'contact_directory',archived:q('archived')==='true',order:'pinned_attention_unread_recent',items:q('archived')==='true'?[]:[team],next_cursor:null})
   if(url.pathname==='/api/kode/avatars')return send(res,{avatars:[]})
   send(res,{error:'此隔离测试未启用该服务'},503)
  });server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);const page=await browser.page(`http://127.0.0.1:${server.address().port}`)
  await page.call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false})
  const wait=(expr,ms=12000)=>page.evaluate(`(async()=>{const end=Date.now()+${ms};while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,25))}throw Error('native css timeout: '+${JSON.stringify(expr)}+' '+JSON.stringify({errors:window.fixtureErrors,side:document.querySelector('.kode-scoped-workspace-sidebar')?.outerHTML.slice(0,500)}))})()`)
  await wait(`window.fixture&&document.querySelector('.kode-collab-mode-switch button')`)
  if(await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').getAttribute('aria-label').includes('会话')`)){
   await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`)
   await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('协作'))`)
   await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('协作')).click()`)
  }
  await wait(`document.querySelector('.kode-scoped-workspace-sidebar[data-native-css]')`)
  const dir=process.env.KODE_ARTIFACT_DIR??'/tmp/kode-orbit-shots';await mkdir(dir,{recursive:true})
  const shot=async name=>writeFile(join(dir,name),Buffer.from((await page.call('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:300,height:520,scale:2}})).data,'base64'))
  await run({page,wait,shot})
  assert.deepEqual(await page.evaluate(`window.fixtureErrors`),[])
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await rm(profile,{recursive:true,force:true})}
}

test('another ui-workspace build (different CSS hash) still styles the 协作 tree with the native CSS',{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:120000},()=>boot(rehashed,async({page,wait,shot})=>{
 await wait(`document.querySelector('[data-sidebar-row=channel]')`)
 assert.equal(await page.evaluate(`document.querySelector('.kode-scoped-workspace-sidebar').dataset.nativeCss`),'ready')
 assert.equal(await page.evaluate(`!!document.querySelector('style[data-plugin-css$="Rows.module.css"]').textContent.includes('Kq9zXa_sessionRow')`),true,'the page runs the rehashed native CSS')
 const geometry=await page.evaluate(`(()=>{const r=document.querySelector('[data-sidebar-row=channel]'),a=r.querySelector('[data-row-actions]'),s=getComputedStyle(r);return {kq:r.className.includes('Kq9zXa_sessionRow'),old:/\\b[A-Za-z0-9]{6}_/.test(r.className.replace(/Kq9zXa_\\w+/g,'')),height:r.getBoundingClientRect().height,display:s.display,actions:a?getComputedStyle(a).display:'none',project:document.querySelector('[data-row-key^="workspace:"]').getBoundingClientRect().height}})()`)
 assert.deepEqual(geometry,{kq:true,old:false,height:32,display:'flex',actions:'none',project:34},'native row geometry from the loaded build; actions hidden at rest')
 await shot('native-css-rehashed.png')
}))

test('missing native row CSS is reported and falls back to the native session list, never unstyled rows',{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:120000},()=>boot(missing,async({page,wait,shot})=>{
 await wait(`document.querySelector('.kode-scoped-workspace-sidebar[data-native-css=missing] [role=alert]')`)
 assert.equal(await page.evaluate(`!!document.querySelector('[data-sidebar-row]')`),false,'no rows without their CSS')
 assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('[aria-label="原生会话管理"]')).display`),'flex','the native list stays usable')
 await shot('native-css-missing.png')
}))

const live=process.env.KODE_LIVE_UI_WORKSPACE
test('the live runtime ui-workspace build styles the 协作 tree',{skip:!process.env.KODE_TEST_BROWSER_BIN||!live,timeout:120000},async()=>boot(await readFile(live,'utf8'),async({page,wait,shot})=>{
 await wait(`document.querySelector('[data-sidebar-row=channel]')`)
 assert.equal(await page.evaluate(`document.querySelector('.kode-scoped-workspace-sidebar').dataset.nativeCss`),'ready')
 assert.deepEqual(await page.evaluate(`(()=>{const r=document.querySelector('[data-sidebar-row=channel]');return {height:r.getBoundingClientRect().height,display:getComputedStyle(r).display,actions:getComputedStyle(r.querySelector('[data-row-actions]')).display}})()`),{height:32,display:'flex',actions:'none'})
 await shot('native-css-live-build.png')
}))

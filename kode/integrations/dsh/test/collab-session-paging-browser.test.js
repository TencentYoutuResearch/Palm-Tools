/** 协作 sidebar sessions page like the native workspace list (5 at a time, "展开其余 n 个会话" /
 * "收起", raised to keep running/waiting/current rows) and show live state with the native
 * StateDot. Real Chrome over the released client stack; sessions and statuses are fixture
 * snapshots. No model, Hub or microphone runs, and nothing is written. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {collabRenderPage} from './support/collab-render-page.js'
import {headlessBrowser} from './support/headless-browser.js'

const bundle=await build({entryPoints:['packages/collab/client-source.js'],bundle:true,loader:{'.png':'dataurl'},format:'cjs',platform:'browser',external:['react','react-dom','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-primitives','@kode/dsh-composer'],write:false})
const client=`window.__ModuleLoader__.load({id:'@kode/dsh-collab',factory(require){const module={exports:{}},exports=module.exports;${bundle.outputFiles[0].text};return module.exports}})`
const now=Date.now(),ids=Array.from({length:12},(_,i)=>'s-'+(i+1))
const seeds=ids.map((id,i)=>({id,title:'会话 '+(i+1),cwd:'/fixture/project',createdAt:now-(i+1)*3600e3,updatedAt:now-(i+1)*3600e3}))

test('协作 session rows page natively and running rows use the native StateDot spinner',{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:120000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'kode-session-paging-'));let server,browser
 const send=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value))}
 const workspaceBundle=process.env.KODE_LIVE_UI_WORKSPACE?await readFile(process.env.KODE_LIVE_UI_WORKSPACE):null
 try{
  server=createServer(async(req,res)=>{
   const url=new URL(req.url,'http://localhost')
   if(url.pathname==='/fixture-collab.js'){res.setHeader('content-type','text/javascript');res.end(client);return}
   if(await collabRenderPage(req,res,{workspaceBundle,managedSessions:seeds,workspaces:[{workspaceId:'ws-fixture',title:'Kode',path:'/fixture/project',sessionIds:ids,createdAt:'2026-11-10T00:00:00.000Z'}]}))return
   if(req.method!=='GET')return send(res,{error:'此隔离测试不接受写入'},503)
   if(url.pathname==='/api/kode/collab/teams')return send(res,{home_hub:'home',projection:'contact_directory',archived:false,order:'pinned_attention_unread_recent',items:[],next_cursor:null})
   if(url.pathname==='/api/kode/avatars')return send(res,{avatars:[]})
   send(res,{error:'此隔离测试未启用该服务'},503)
  });server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);const page=await browser.page(`http://127.0.0.1:${server.address().port}`)
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
  const wait=(expr,ms=12000)=>page.evaluate(`(async()=>{const end=Date.now()+${ms};while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,25))}throw Error('paging timeout: '+${JSON.stringify(expr)}+' '+JSON.stringify({errors:window.fixtureErrors,side:document.querySelector('.kode-scoped-workspace-sidebar')?.innerText.slice(0,600)}))})()`)
  const dir=process.env.KODE_ARTIFACT_DIR??'/tmp/kode-orbit-shots';await mkdir(dir,{recursive:true})
  const shot=async name=>writeFile(join(dir,name),Buffer.from((await page.call('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:280,height:900,scale:2}})).data,'base64'))
  const menuItem=label=>`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes(${JSON.stringify(label)}))`
  await wait(`window.fixture&&document.querySelector('.kode-collab-mode-switch button')`)
  if(await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').getAttribute('aria-label').includes('会话')`)){
   await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`);await wait(menuItem('协作'));await page.evaluate(`${menuItem('协作')}.click()`)}
  await page.evaluate(`fixture.ctx.get('sessions').refresh()`)
  const L=await page.evaluate(`/\\.([A-Za-z0-9-]+_)groupSection\\b/.exec(document.querySelector('style[data-plugin-css="@deepseek-ai/dsh-client-ui-workspace/WorkspaceBrowser.module.css"]').textContent)[1]`)
  const shown=`Array.from(document.querySelectorAll('[data-adapted-session-id]')).map(r=>r.dataset.adaptedSessionId)`
  const more=`document.querySelector('.kode-scoped-tree [data-sidebar-section=sessions] .${L}sessionOverflowButton')`
  await wait(`document.querySelectorAll('[data-adapted-session-id]').length===5`)
  assert.deepEqual(await page.evaluate(shown),ids.slice(0,5))
  assert.equal(await page.evaluate(`${more}.textContent+'|'+${more}.getAttribute('aria-expanded')`),'展开其余 7 个会话|false')
  assert.equal(await page.evaluate(`document.body.innerText.includes('仅列出前')`),false)
  await shot('session-paging-collapsed.png')
  // Native step: +5, then the last ≤5 at once; 收起 returns to the baseline.
  await page.evaluate(`${more}.click()`);await wait(`document.querySelectorAll('[data-adapted-session-id]').length===10`)
  assert.equal(await page.evaluate(`${more}.textContent`),'展开其余 2 个会话')
  await page.evaluate(`${more}.click()`);await wait(`document.querySelectorAll('[data-adapted-session-id]').length===12`)
  assert.equal(await page.evaluate(`${more}.textContent+'|'+${more}.getAttribute('aria-expanded')`),'收起|true')
  await page.evaluate(`${more}.click()`);await wait(`document.querySelectorAll('[data-adapted-session-id]').length===5`)
  // A running row past the page raises the baseline and shows the native StateDot spinner.
  await page.evaluate(`fixture.workspaceData.status.publish(new Map([['s-8',{running:true}],['s-2',{pendingInteraction:{kind:'approval'}}]]))`)
  await wait(`document.querySelectorAll('[data-adapted-session-id]').length===8`)
  assert.equal(await page.evaluate(`${more}.textContent`),'展开其余 4 个会话')
  const running=`document.querySelector('[data-adapted-session-id="s-8"]')`
  assert.equal(await page.evaluate(`${running}.dataset.sessionState`),'ongoing')
  const dot=await page.evaluate(`(()=>{const slot=${running}.querySelector('[aria-hidden=true]');const animated=Array.from(slot.querySelectorAll('*')).concat(slot).some(e=>e.getAnimations().length>0);return {html:slot.innerHTML.slice(0,200),animated,label:${running}.innerText}})()`)
  assert.equal(dot.animated,true,'native ongoing StateDot animates: '+dot.html)
  assert.match(dot.label,/进行中/,'screen-reader label from the native status chain')
  assert.equal(await page.evaluate(`document.querySelector('[data-adapted-session-id="s-2"]').dataset.sessionState+'|'+document.querySelector('[data-adapted-session-id="s-2"] [data-row-title]').nextElementSibling.textContent`),'warning|待审批')
  assert.deepEqual(await page.evaluate('fixtureErrors'),[])
  await shot('session-paging-running.png')
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}await rm(profile,{recursive:true,force:true})}
})

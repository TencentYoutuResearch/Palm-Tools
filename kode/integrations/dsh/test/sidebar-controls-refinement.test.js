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
const source=await build({entryPoints:['packages/collab/client-source.js'],bundle:true,loader:{'.png':'dataurl'},format:'cjs',platform:'browser',external:['react','react-dom','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-primitives','@kode/dsh-composer'],write:false})
const client=process.env.KODE_TEST_SHIPPED_COLLAB==='1'?await readFile(new URL('../packages/collab/client.js',import.meta.url),'utf8'):`window.__ModuleLoader__.load({id:'@kode/dsh-collab',factory(require){const module={exports:{}},exports=module.exports;${source.outputFiles[0].text};return module.exports}})`
// Controlled scoped channel data, using the current collaboration read contract.
const workspaces=[{workspaceId:'kode',title:'Kode',path:'/fixture/kode',sessionIds:[]},{workspaceId:'palm',title:'palm-device',path:'/fixture/palm',sessionIds:[]}]
const scopes=workspaces.map(w=>({home_hub:'home',host_id:'home',workspace_id:w.workspaceId,root_ref:w.path}))
const surfaces=scopes.map((scope,i)=>({id:'channel-'+scope.workspace_id,scope,kind:'channel',title:workspaces[i].title+' 协作',team_ids:[],revision:1,enabled:true}))
test('compact scoped controls preserve project and native manager semantics', {skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:45000},async()=>{
 let server,browser;const profile=await mkdtemp(join(tmpdir(),'kode-compact-'));const requests=[]
 try{
 server=createServer(async(req,res)=>{try{
 if(req.url==='/fixture-collab.js'){res.setHeader('content-type','text/javascript');return res.end(client)}
 const url=new URL(req.url,'http://localhost');if(url.pathname.startsWith('/api/'))requests.push({method:req.method,url})
 if(url.pathname==='/api/kode/collaboration'){
  res.setHeader('content-type','application/json')
  if(url.searchParams.get('path')==='surfaces'){const scope=Object.fromEntries(['home_hub','host_id','workspace_id','root_ref'].map(key=>[key,url.searchParams.get(key)]));return res.end(JSON.stringify({scope,items:surfaces.filter(s=>Object.keys(scope).every(key=>s.scope[key]===scope[key]))}))}
  const surface=surfaces.find(s=>url.searchParams.get('path')===`surfaces/${s.id}/messages`);if(surface)return res.end(JSON.stringify({surface,items:[],has_more:false,next_cursor:null}))
 }
 if(req.url.startsWith('/api/kode/collab/teams')){res.setHeader('content-type','application/json');return res.end(JSON.stringify({home_hub:'home',projection:'contact_directory',archived:false,order:'pinned_attention_unread_recent',items:[],next_cursor:null}))}
 if(await collabRenderPage(req,res,{workspaces}))return;res.writeHead(404);res.end('{}')
 }catch(error){res.writeHead(500);res.end(String(error))}});server.listen(0,'127.0.0.1');await once(server,'listening')
 browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);const page=await browser.page(`http://127.0.0.1:${server.address().port}`)
 const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expr})return true;await new Promise(r=>setTimeout(r,30))}throw Error(JSON.stringify({expr:${JSON.stringify(expr)},body:document.body.innerText,errors:fixtureErrors}))})()`)
  const enterCollaboration=async()=>{await wait(`document.querySelector('.kode-collab-mode-switch button')`);if(await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').getAttribute('aria-label').includes('会话')`)){await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`);await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('协作'))`);await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('协作')).click()`)}}
 await enterCollaboration()
 const channel=`document.querySelector('[data-current-workspace-scope] [data-sidebar-section=channels] [data-sidebar-row=channel]')`
 const project=t=>`Array.from(document.querySelectorAll('[data-project-scope]')).find(g=>g.querySelector('[data-row-key^="workspace:"]')?.textContent===${JSON.stringify(t)})`
 await wait(`document.querySelector('[data-current-workspace-scope] [data-sidebar-section=channels] button[aria-label="新建频道"]')&&${channel}`)
 await page.call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false})
 const capture=async name=>{if(!process.env.KODE_COMPACT_CAPTURE)return;await mkdir(process.env.KODE_COMPACT_CAPTURE,{recursive:true});const shot=await page.call('Page.captureScreenshot',{format:'png'});await writeFile(join(process.env.KODE_COMPACT_CAPTURE,name+'.png'),Buffer.from(shot.data,'base64'))}
 assert.equal(await page.evaluate(`document.querySelectorAll('[data-current-workspace-scope] input').length`),0)
 assert.equal(await page.evaluate(`document.querySelectorAll('[data-current-workspace-scope] [data-sidebar-section=sessions] summary button').length`),1)
 await capture('after-desktop')
 // Channels are real collaboration surfaces, not a searchable team-contact list.
 assert.equal(await page.evaluate(`document.querySelectorAll('[aria-label="搜索当前项目的频道"]').length`),0)
 const channels=`document.querySelector('[data-current-workspace-scope] [data-sidebar-section=channels]')`
 await page.evaluate(`${channels}.querySelector('summary').click()`)
 await wait(`!${channels}.open`)
 // Creation from a folded group: the native Modal says why it cannot proceed when the project has no team.
 await page.evaluate(`${channels}.querySelector('summary button[aria-label="新建频道"]').click()`)
 await wait(`document.querySelector('.kode-surface-create .kode-surface-create-empty')`)
 assert.match(await page.evaluate(`document.querySelector('.kode-surface-create').innerText`),/还没有可邀请的团队/)
 await capture('after-create-expanded')
 await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
 await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
 await wait(`!document.querySelector('[role=dialog]')`)
 assert.equal(await page.evaluate(`${channels}.open`),false,'cancelled creation preserves the disclosure state')
 await page.evaluate(`${channels}.querySelector('summary').focus()`)
 await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13})
 await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
 await wait(`${channels}.open`)
 await page.evaluate(`${channel}.click()`)
 assert.equal(await wait(`document.querySelector('.kode-discussion-heading h2')?.textContent==='Kode 协作'&&${channel}?.getAttribute('aria-current')==='page'`),true,'the selected channel and main conversation agree after the asynchronous directory refresh')
 // Another project: expand its tree row, then act inside it; it becomes the current project.
 await page.evaluate(`${project('palm-device')}.querySelector('[data-row-key^="workspace:"]').click()`)
 await wait(`${project('palm-device')}.querySelector('[data-sidebar-row=channel]')?.textContent==='palm-device 协作'`)
 await page.evaluate(`${project('palm-device')}.querySelector('[data-sidebar-row=channel]').click()`)
 await wait(`document.querySelector('[data-current-workspace-scope]')?.dataset.currentWorkspaceScope.includes('palm')&&document.querySelector('.kode-discussion-heading h2')?.textContent==='palm-device 协作'`)
 assert.equal(await page.evaluate(`document.querySelectorAll('[data-current-workspace-scope]').length`),1,'exactly one current project')
 assert.equal(await page.evaluate(`document.querySelector('[data-current-workspace-scope]').innerText.includes('Kode 协作')`),false)
 await page.evaluate(`document.querySelector('[data-current-workspace-scope] [data-sidebar-section=sessions] summary').click()`)
 await wait(`!document.querySelector('[data-current-workspace-scope] [data-sidebar-section=sessions]').open`)
 await page.evaluate(`window.keptNative=document.querySelector('.fixture-native-workspaces');window.keptStore=fixture.nativeWorkspaceEntry.store.create();${project('palm-device')}.querySelector('button[aria-label="项目操作：palm-device"]').click()`)
 await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('在会话模式中管理'))`)
 await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('在会话模式中管理')).click()`)
 await wait(`document.querySelector('.fixture-native-workspaces').getBoundingClientRect().height>0`)
 await enterCollaboration()
 await wait(`document.querySelector('[data-current-workspace-scope] [data-sidebar-section=sessions]')`)
 assert.equal(await page.evaluate(`keptNative===document.querySelector('.fixture-native-workspaces')&&keptStore===fixture.nativeWorkspaceEntry.store.create()`),true,'mode changes retain the native workspace instance and store')
 assert.equal(await page.evaluate(`document.querySelector('[data-current-workspace-scope] [data-sidebar-section=sessions]').open`),false,'returning from native management preserves the scoped disclosure')
 for(const scope of scopes)assert.ok(requests.some(({url})=>url.pathname==='/api/kode/collaboration'&&url.searchParams.get('path')==='surfaces'&&Object.keys(scope).every(key=>url.searchParams.get(key)===scope[key])),'channel reads bind the exact Home/Host/workspace/root tuple')
 assert.equal(requests.some(({method})=>method!=='GET'),false,'cancelled creation and navigation issue no writes')
 await page.call('Emulation.setDeviceMetricsOverride',{width:430,height:850,deviceScaleFactor:1,mobile:false});await capture('after-narrow')
 assert.deepEqual(await page.evaluate('fixtureErrors'),[])
 assert.equal(await page.evaluate('fixture.created()'),0,'scope switching and cancelled channel creation never create a Session')
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await rm(profile,{recursive:true,force:true})}
})

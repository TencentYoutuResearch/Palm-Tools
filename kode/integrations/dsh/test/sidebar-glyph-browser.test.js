/** Real isolated Hub + DSH renderer, synthetic workspace only. No model or daily service. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtemp,rm,writeFile,mkdir,readFile,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {isolatedHub} from './support/discussion-hub.js'
import {headlessBrowser} from './support/headless-browser.js'
import {collabRenderPage} from './support/collab-render-page.js'
import {registerCollaboration} from '../src/collaboration-route.js'
import {registerCollabTeams,registerCollabRuns} from '../src/collab-api.js'
import {registerConversationRead} from '../src/conversation-read-route.js'

const ids=['channels','direct','sessions']
const summary=id=>`[data-sidebar-section="${id}"] > summary`
test('sidebar glyph shares one slot across hover, keyboard, whole-row clicks and touch', {
 skip:!process.env.KODE_TEST_BROWSER_BIN||!process.env.KODE_TEST_HUB_BIN,timeout:90000,
},async()=>{
 const hub=await isolatedHub('sidebar-glyph-ui'),profile=await mkdtemp(join(tmpdir(),'kode-sidebar-glyph-'))
 let server,browser
 const writes=[],output=process.env.KODE_TEST_SCREENSHOTS
 try{
  const workspacePath=join(hub.root,'workspace');await mkdir(workspacePath);const root=await realpath(workspacePath)
  await hub.client.call('/api/v1/messaging/workbench/workspaces',{action:'create',path:root,title:'侧栏交互 · 隔离测试'})
  const workspace=(await hub.client.call('/api/v1/messaging/workbench/workspaces')).workspaces.find(w=>w.path===root)
  const scope={home_hub:hub.node,host_id:hub.node,workspace_id:workspace.id,root_ref:root}
  await hub.client.call('/api/v1/messaging/teams',{id:'sidebar-team',request_id:'create',expected_revision:0,spec:{name:'侧栏测试团队',purpose:'仅用于展示侧栏',kind:'coordinator',workspace_refs:[{host_id:scope.host_id,workspace_id:scope.workspace_id,root_ref:root}],execution_targets:[],workers:[],coordinator_targets:[],workflow_pack_refs:[],delivery_bindings:[],grant_id:null,budget_policy_id:null,scheduling_policy_id:null,limits:{max_active_assignments:1,max_active_runs:1},proactive_mode:'off'}})
  for(const [id,kind,title] of [['channel','channel','产品讨论'],['private','dm','设计私信']]){
   await hub.client.call('/api/v1/messaging/collaboration/surfaces/'+id,{request_id:'create-'+id,expected_revision:0,scope,kind,title,team_ids:['sidebar-team'],enabled:true})
  }
  const routes=new Map(),ctx={connection:{admit:req=>req.headers['x-fixture-owner']==='yes'?{peer:{principal:{kind:'owner'}}}:{rejection:401}},webServer:{register:r=>routes.set(r.path,r)}}
  for(const register of [registerCollaboration,registerCollabTeams,registerCollabRuns,registerConversationRead])register(ctx,{backendClient:{call:(p,b)=>{if(b)writes.push({path:p,body:b});return hub.client.call(p,b)}}})
  const compiled=process.env.KODE_TEST_SHIPPED_COLLAB==='1'?await readFile(new URL('../packages/collab/client.js',import.meta.url),'utf8'):(await build({entryPoints:['packages/collab/client-source.js'],bundle:true,loader:{'.png':'dataurl'},format:'cjs',platform:'browser',external:['react','react-dom','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-primitives','@kode/dsh-composer','@deepseek-ai/dsh-client-ui-conversation'],write:false})).outputFiles[0].text
  const client=process.env.KODE_TEST_SHIPPED_COLLAB==='1'?compiled:`window.__ModuleLoader__.load({id:'@kode/dsh-collab',factory(require){const module={exports:{}},exports=module.exports;${compiled};return module.exports}})`
  const workspaces=[{workspaceId:workspace.id,title:workspace.title,path:root,sessionIds:[]}]
  server=createServer(async(req,res)=>{try{
   if(req.url==='/fixture-collab.js'){res.setHeader('content-type','text/javascript');return res.end(client)}
   const route=routes.get(new URL(req.url,'http://localhost').pathname)
   if(route)return await route.handler(req,res)
   if(await collabRenderPage(req,res,{workspaces}))return
   res.writeHead(404);res.end('{}')
  }catch{if(!res.headersSent)res.writeHead(500);res.end('{}')}})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile)
  const page=await browser.page('http://127.0.0.1:'+server.address().port)
  const rawEvaluate=page.evaluate;page.evaluate=async(expression)=>{try{return await rawEvaluate(expression)}catch(error){throw new Error(expression.slice(0,220)+': '+error.message)}}
  const rawCall=page.call;page.call=async(method,params)=>{try{return await rawCall(method,params)}catch(error){throw new Error(method+' '+JSON.stringify(params)+': '+error.message)}}
  const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,25))}throw Error('Sidebar timeout '+JSON.stringify({expr:${JSON.stringify(expr)},errors:fixtureErrors,body:document.body.innerText}))})()`)
  const select=selector=>page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const point=async(selector,fraction=.5)=>page.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width*${fraction},y:r.top+r.height/2}})()`)
  const move=async selector=>page.call('Input.dispatchMouseEvent',{type:'mouseMoved',...(await point(selector))})
  const mouseClick=async(selector,fraction=.5)=>{const p=await point(selector,fraction);await page.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p})}
  const key=async value=>{const keys={Enter:['Enter',13,'\r'],Space:[' ',32,' '],Tab:['Tab',9],Escape:['Escape',27]},[name,code,text]=keys[value];await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:name,code:value,windowsVirtualKeyCode:code,...(text?{text,unmodifiedText:text}:{})});await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:name,code:value,windowsVirtualKeyCode:code})}
  // SidebarSection now uses the native project-row anatomy (sidebar-sections.js:44-48): an icon slot (ROW.folder) then a chevron slot (ROW.chevron),
  // swapped by native hover CSS via display, so only one occupies the shared 16px column at a time; the label is the native ROW.title span.
  const label=id=>`${summary(id)} > span:not([aria-hidden]):not([data-row-actions]) > span`
  const status=id=>page.evaluate(`(()=>{const s=document.querySelector(${JSON.stringify(summary(id))}),[i,c]=s.querySelectorAll(':scope > span[aria-hidden=true]'),shown=e=>getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility==='visible'?'visible':'hidden',rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}},g=shown(i)==='visible'?i:c;return {expanded:s.getAttribute('aria-expanded'),open:s.parentElement.open,icon:shown(i),chevron:shown(c),rotation:getComputedStyle(c.querySelector('svg')).transform,slot:rect(g),iconRect:rect(i),chevronRect:rect(c),iconGlyph:rect(i.querySelector('svg')??i),label:rect(document.querySelector(${JSON.stringify(label(id))})),slots:s.querySelectorAll(':scope > span[aria-hidden=true]').length,directGlyphs:s.querySelectorAll(':scope > svg,:scope > img').length,hidden:[i,c].every(e=>e.getAttribute('aria-hidden')==='true')?'true':'false',labelText:s.getAttribute('aria-label'),controlled:document.getElementById(s.getAttribute('aria-controls'))?.getAttribute('aria-labelledby')===s.id,focus:s.matches(':focus-visible'),outline:getComputedStyle(s).outlineStyle,outlineWidth:getComputedStyle(s).outlineWidth}})()`)
  const shot=async name=>{
   if(!output)return
   await mkdir(output,{recursive:true})
   await page.evaluate(`(()=>{const e=document.createElement('div');e.id='glyph-evidence';e.textContent='真实隔离 Hub · 合成内容 · 未启动模型';e.style='position:fixed;bottom:6px;right:8px;padding:4px 8px;font:11px sans-serif;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);pointer-events:none';document.body.append(e)})()`)
   try{await writeFile(join(output,name+'.png'),Buffer.from((await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'))}finally{await page.evaluate(`document.getElementById('glyph-evidence').remove()`)}
  }
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:940,deviceScaleFactor:1,mobile:false})
  await wait(`document.querySelector('.kode-collab-mode-switch button')`)
  {
   await select('.kode-collab-mode-switch button');await wait(`document.querySelector('[role=menuitem]')`)
   await page.evaluate(`[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.includes('协作')).click()`)
  }
  await wait(`document.querySelector('[data-sidebar-section=direct] :is([data-sidebar-row=channel],[data-sidebar-row=dm]) [data-row-title]')?.textContent.includes('设计私信')`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-discussion-home')?.textContent.includes('说说你想解决的问题、使用场景和预期效果')`),true)
  assert.equal(await page.evaluate(`document.querySelector('.kode-discussion-home')?.textContent.includes('新建会话时优先用我设置的默认模型')`),true)
  assert.equal(await page.evaluate(`document.querySelectorAll('.kode-discussion-home textarea,.kode-discussion-home [contenteditable=true]').length`),0,'guidance is display-only, not a prefilled draft')
  await page.evaluate(`document.activeElement.blur();window.nativeSidebarNode=document.querySelector('.fixture-native-workspaces');window.keptSectionBody=document.querySelector('[data-sidebar-section=sessions] .kode-sidebar-section-body');void 0`)
  await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:1100,y:300})
  const sidebarGeometry=await page.evaluate(`(()=>{const content=document.querySelector('.kode-scoped-content'),container=content.parentElement;return {client:container.clientWidth,scroll:container.scrollWidth,headers:[...content.querySelectorAll('.kode-sidebar-group-row')].map(s=>({width:s.getBoundingClientRect().width,parent:s.parentElement.clientWidth,boxSizing:getComputedStyle(s).boxSizing}))}})()`)
  assert.ok(sidebarGeometry.scroll<=sidebarGeometry.client,JSON.stringify(sidebarGeometry))
  for(const header of sidebarGeometry.headers){assert.equal(header.boxSizing,'border-box');assert.ok(header.width<=header.parent)}
  const idle={}
  for(const id of ids){
   idle[id]=await status(id)
   // Two native slots (icon, chevron) but only one rendered at a time; no glyph sits outside a slot.
   assert.equal(idle[id].slots,2);assert.equal(idle[id].directGlyphs,0)
   assert.equal(idle[id].icon,'visible');assert.equal(idle[id].chevron,'hidden')
   assert.equal(idle[id].hidden,'true');assert.equal(idle[id].controlled,true)
   // Native slot is 16px wide on the 20px row line; the icon glyph itself is 16x16. The hidden chevron slot takes no space.
   assert.equal(idle[id].slot.width,16);assert.equal(idle[id].iconGlyph.width,16);assert.equal(idle[id].iconGlyph.height,16)
   assert.deepEqual(idle[id].slot,idle[id].iconRect);assert.equal(idle[id].chevronRect.width,0)
  }
  await shot('sidebar-icons-idle-light')
  for(const id of ids){
   await move(summary(id));const hovered=await status(id)
   assert.equal(hovered.icon,'hidden');assert.equal(hovered.chevron,'visible')
   assert.deepEqual(hovered.chevronRect,idle[id].iconRect,'chevron takes exactly the icon position')
   // Native hover also reveals the row actions (sidebar-sections.js:31,49), which narrows the title box; its position must not move.
   assert.deepEqual([hovered.label.x,hovered.label.y,hovered.label.height],[idle[id].label.x,idle[id].label.y,idle[id].label.height],'switching glyphs never moves the label')
   if(id==='channels')await shot('sidebar-chevron-hover-light')
  }
  // Hit blank space, not only the tiny glyph. Native summary toggles the section.
  await mouseClick(summary('sessions'),.55);await wait(`document.querySelector('[data-sidebar-section=sessions] summary').getAttribute('aria-expanded')==='false'`)
  // The native arrow animates its transform (0.15s); wait for the collapsed end state rather than sampling mid-transition.
  await wait(`!document.querySelector('[data-sidebar-section=sessions] > summary > span[aria-hidden]:nth-child(2) svg').getAnimations().length`)
  assert.equal((await status('sessions')).rotation,'none')
  await mouseClick(label('sessions'));await wait(`document.querySelector('[data-sidebar-section=sessions]').open`)
  await key('Tab');await page.evaluate(`document.querySelector(${JSON.stringify(summary('sessions'))}).focus()`)
  await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:1100,y:300})
  const focused=await status('sessions');assert.equal(focused.focus,true);assert.equal(focused.icon,'hidden');assert.equal(focused.chevron,'visible');assert.notEqual(focused.outline,'none');assert.ok(parseFloat(focused.outlineWidth)>0) // native row keeps the platform focus ring (outline-style auto, 2px)
  await shot('sidebar-keyboard-focus-light')
  await key('Enter');await wait(`document.querySelector('[data-sidebar-section=sessions] summary').getAttribute('aria-expanded')==='false'`)
  await shot('sidebar-keyboard-collapsed-light')
  await key('Space');await wait(`document.querySelector('[data-sidebar-section=sessions] summary').getAttribute('aria-expanded')==='true'`)
  assert.equal(await page.evaluate(`keptSectionBody===document.querySelector('[data-sidebar-section=sessions] .kode-sidebar-section-body')`),true)
  // Existing sibling actions remain separate and do not toggle the disclosure.
  await select(summary('channels'));await wait(`!document.querySelector('[data-sidebar-section=channels]').open`)
  // The section's create action is the native RowAction labelled 新建频道 (discussion-ui.js:65).
  await select('button[aria-label="新建频道"]');await wait(`document.querySelector('[role=dialog]')`)
  assert.equal((await status('channels')).expanded,'false')
  await key('Escape');await wait(`!document.querySelector('[role=dialog]')`)
  assert.equal((await status('channels')).expanded,'false')
  await select(summary('channels'));await wait(`document.querySelector('[data-sidebar-section=channels]').open`)
  const ax=await page.call('Accessibility.getFullAXTree')
  for(const label of ['频道','私信','会话']){
   const entries=ax.nodes.filter(n=>!n.ignored&&n.role?.value==='DisclosureTriangle'&&n.name?.value===label)
   assert.equal(entries.length,1,'one named accessible disclosure per section: '+label)
   assert.equal(entries[0].properties.find(p=>p.name==='expanded')?.value?.value,true)
  }
  await page.evaluate(`(()=>{document.activeElement.blur();const theme=fixture.ctx.theme.getTheme().themes.find(t=>t.colorScheme==='dark');document.body.setAttribute('data-ds-dark-theme','');document.documentElement.style.colorScheme='dark';for(const [name,value]of Object.entries(theme.tokens))document.documentElement.style.setProperty(name,value)})()`)
  await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:1100,y:300});await shot('sidebar-icons-idle-dark')
  await move(summary('direct'));await shot('sidebar-chevron-hover-dark')
  // Actual Chromium touch emulation exercises CSS media queries and real touch dispatch.
  await page.call('Emulation.setDeviceMetricsOverride',{width:1000,height:900,deviceScaleFactor:1,mobile:false})
  assert.equal(await page.evaluate(`document.querySelector('#fixture-main').scrollWidth<=document.querySelector('#fixture-main').clientWidth`),true)
  await shot('sidebar-intermediate-dark')
  await page.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true})
  await page.call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1})
  await page.evaluate(`document.activeElement.blur()`)
  assert.equal(await page.evaluate(`matchMedia('(hover:none)').matches&&matchMedia('(pointer:coarse)').matches`),true)
  for(const id of ids){const value=await status(id);assert.equal(value.icon,'hidden');assert.equal(value.chevron,'visible');assert.ok(await page.evaluate(`document.querySelector(${JSON.stringify(summary(id))}).getBoundingClientRect().height>=44`))}
  assert.equal(await page.evaluate(`document.querySelector('#fixture-main').scrollWidth<=document.querySelector('#fixture-main').clientWidth`),true,'guidance fits the narrow content pane without horizontal overflow')
  await shot('sidebar-touch-affordance-dark')
  const tap=async()=>{const p=await point(summary('direct'));await page.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[p]});await page.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})}
  await tap();await wait(`document.querySelector('[data-sidebar-section=direct] summary').getAttribute('aria-expanded')==='false'`)
  await tap();await wait(`document.querySelector('[data-sidebar-section=direct] summary').getAttribute('aria-expanded')==='true'`)
  assert.equal(await page.evaluate(`nativeSidebarNode===document.querySelector('.fixture-native-workspaces')`),true)
  assert.equal(await page.evaluate('fixture.created()'),0)
  assert.deepEqual(writes,[],'disclosure and canceled creation do not mutate Hub state')
  assert.deepEqual(await page.evaluate('fixtureErrors'),[])
  if(output)await writeFile(join(output,'result.json'),JSON.stringify({realIsolatedHub:true,shippedBundle:process.env.KODE_TEST_SHIPPED_COLLAB==='1',singleGlyphSlot:true,hoverNoLayoutShift:true,wholeRowAndLabelClick:true,keyboardEnterSpace:true,focusRing:true,ariaExpandedAndControls:true,decorativeGlyphsHidden:true,touchTapTwice:true,themeCoverage:['light','dark'],widths:[1440,1000,390],sidebarNoHorizontalOverflow:true,touchTargetMinHeight:44,nativeSessionCreates:0,hubWrites:writes.length,modelStarted:false},null,2))
 }finally{
  await browser?.close()
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
  await hub.close();await rm(profile,{recursive:true,force:true})
 }
})

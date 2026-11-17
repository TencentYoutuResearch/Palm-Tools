import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtemp,rm,writeFile,mkdir,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {isolatedHub} from './support/discussion-hub.js'
import {versionedProject} from './support/versioned-project.js'
import {conversationTeam} from './support/conversation-team.js'
import {headlessBrowser} from './support/headless-browser.js'
import {collabRenderPage} from './support/collab-render-page.js'
import {registerCollabTeams,registerCollabRuns} from '../src/collab-api.js'
import {registerCollaboration} from '../src/collaboration-route.js'
import {registerConversation} from '../src/conversation-route.js'
import {registerConversationRead} from '../src/conversation-read-route.js'
import {registerWorkRun} from '../src/work-run-route.js'
import {registerBuilderDrafts} from '../src/builder-drafts-route.js'
import {registerCollabBudgets} from '../src/collab-budgets-route.js'

test('brand slot: accessible title switch preserves native shell, session identity and thread draft', {skip:!process.env.KODE_TEST_BROWSER_BIN || !process.env.KODE_TEST_HUB_BIN,timeout:120000},async()=>{
 const hub=await isolatedHub('discussion-ui'),profile=await mkdtemp(join(tmpdir(),'kode-discussion-chrome-'))
 let server,browser
 const call=(p,b)=>hub.client.call('/api/v1/messaging/'+p,b)
 const output=process.env.KODE_TEST_SCREENSHOTS
 try{
  const root=await versionedProject(hub.root)
  await call('workbench/workspaces',{action:'create',path:root,title:'Kode · 隔离测试'})
  const catalog=await call('workbench/workspaces'),w=catalog.workspaces.find(x=>x.path===root)
  const scope={home_hub:hub.node,host_id:hub.node,workspace_id:w.id,root_ref:root}
  const team=await conversationTeam(hub,{workspace:{host_id:hub.node,workspace_id:w.id,root_ref:root}})
  const make=(id,kind,title)=>call('collaboration/surfaces/'+id,{request_id:'create-'+id,expected_revision:0,scope,kind,title,team_ids:[team.id],enabled:true})
  const channel=await make('development','channel','开发协作'),dm=await make('private','dm','Kode 团队私信')
  const post=(id,text,thread)=>call('collaboration/surfaces/'+id+'/messages',{request_id:crypto.randomUUID(),expected_revision:1,content:text,mentions:[],...(thread?{thread_id:thread}:{})})
  const rootMessage=await post(channel.id,'历史会话头像修复：先确认复现步骤，再补测试。')
  await post(channel.id,'这是隔离测试数据。回复会保留在这一条讨论里，不会自动启动执行。',rootMessage.id)
  const privateRoot=await post(dm.id,'私信内先讨论方案，未批准发布前不要同步到频道。')
  await post(dm.id,'PRIVATE-SENTINEL：这段补充只应留在私信。',privateRoot.id)
  const workspaces=catalog.workspaces.map(x=>({workspaceId:x.id,title:x.title,path:x.path,sessionIds:[],createdAt:x.created_at??new Date().toISOString()}))
  const routes=new Map(),ctx={connection:{admit:req=>req.headers['x-fixture-owner']==='yes'?{peer:{principal:{kind:'owner'}}}:{rejection:401}},webServer:{register:r=>routes.set(r.path,r)}}
  for(const register of [registerBuilderDrafts,registerCollaboration,registerCollabTeams,registerCollabRuns,registerConversation,registerConversationRead,registerCollabBudgets,registerWorkRun])register(ctx,{backendClient:{call:(p,b)=>hub.client.call(p,b)}})
  server=createServer(async(req,res)=>{try{const route=routes.get(new URL(req.url,'http://localhost').pathname);if(route)return await route.handler(req,res);if(await collabRenderPage(req,res,{workspaces}))return;res.writeHead(404);res.end('{}')}catch(e){if(!res.headersSent)res.writeHead(500);res.end('{}')}})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile)
  const url=`http://127.0.0.1:${server.address().port}`
  let page=await browser.page(url)
  const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+15000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,40))}throw Error('UI timeout '+JSON.stringify({body:document.body.innerText,errors:fixtureErrors}))})()`)
  const click=label=>page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`)
  const shot=async name=>{if(!output)return;await mkdir(output,{recursive:true});await writeFile(join(output,name+'.png'),Buffer.from((await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'))}
  await page.call('Emulation.setDeviceMetricsOverride',{width:1320,height:900,deviceScaleFactor:1,mobile:false})
  await wait(`document.querySelector('.kode-collab-mode-switch button')`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').getAttribute('aria-label').includes('DeepSeek Harness')`),true)
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('div[aria-label="原生会话管理"]')).display`),'flex')
  await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`)
  await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('协作'))`)
  await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('协作')).click()`)
  await wait(`Array.from(document.querySelectorAll(':is([data-sidebar-row=channel],[data-sidebar-row=dm]) [data-row-title]')).some(b=>b.textContent==='开发协作')`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-brand-switch button').textContent.includes('Kode Orbit')`),true)
  assert.equal(await page.evaluate(`document.querySelectorAll('button button').length`),0)
  assert.equal(await page.evaluate(`!!document.querySelector('button[aria-label="新建会话"]')`),false)
  assert.equal(await page.evaluate(`!!document.querySelector('.kode-collab-brand-switch').closest('[aria-hidden="true"]')`),false)
  assert.equal(await page.evaluate(`document.querySelectorAll('.kode-collab-global-builder').length`),0)
  assert.equal(await page.evaluate(`document.body.innerText.includes('Superagents · 执行会话')`),false)
  assert.equal(await page.evaluate(`!!document.querySelector('[data-sidebar-section=sessions] [data-icon="message-square"]')`),true)
  assert.equal(await page.evaluate(`!!document.querySelector('[data-sidebar-section=channels] [data-icon="hash"]')`),true)
  // The workspace heading only adds workspaces; inviting members belongs to the open channel's heading.
  assert.equal(await page.evaluate(`document.querySelectorAll('.kode-scoped-workspace-heading [aria-label="邀请成员"]').length`),0)
  assert.equal(await page.evaluate(`document.querySelectorAll('.kode-scoped-workspace-heading [aria-label="添加工作区"]').length`),1)
  for(const label of ['插件','Kode','自动化任务','设置']) assert.equal(await page.evaluate(`[...document.querySelectorAll('button')].some(b=>b.getAttribute('aria-label')===${JSON.stringify(label)})`),true)
  assert.equal(await page.evaluate(`document.querySelectorAll('.kode-collab-mode-switch').length`),1)
  assert.equal(await page.evaluate(`!!document.querySelector('.kode-collab-brand-switch').closest('[class*=logoRow]')`),true)
  assert.equal(await page.evaluate(`document.querySelector('.kode-brand-mark')?.complete&&document.querySelector('.kode-brand-mark')?.naturalWidth`),128)
  assert.equal(await page.evaluate(`document.querySelectorAll('.kode-collab-brand-switch svg ellipse').length`),0)
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-brand-switch button').getAttribute('aria-label').includes('DeepSeek Harness')`),false)
  await page.evaluate(`document.fonts.load('500 21px Montserrat')`)
  assert.equal(await page.evaluate(`document.fonts.check('500 21px Montserrat')`),true)
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('.kode-brand-wordmark')).fontFamily.startsWith('Montserrat')`),true)
  await shot('brand-orbit-desktop')
  await click('开发协作')
  await wait(`document.querySelector('.kode-discussion-timeline')?.innerText.includes('历史会话头像修复')`)
  assert.equal(await page.evaluate(`document.querySelectorAll('.kode-discussion-heading [aria-label="邀请成员"]').length`),1)
  assert.equal(await page.evaluate(`document.querySelector('.kode-discussions').innerText.includes('PRIVATE-SENTINEL')`),false)
  await page.evaluate(`document.querySelector('.kode-discussion-reply').click()`)
  await wait(`document.querySelector('.kode-discussion-detail')?.innerText.includes('回复会保留')`)
  await shot('channel-thread-desktop')
  await page.evaluate(`document.querySelector('.kode-discussion-detail [contenteditable=true]').focus()`);await page.call('Input.insertText',{text:'切换保留草稿'})
  await page.evaluate(`window.nativeKept=document.querySelector('.fixture-native-workspaces');document.querySelector('.kode-collab-mode-switch button').click()`)
  await wait(`document.querySelector('[role=menuitem]')`)
  await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('会话')).click()`)
  await wait(`!document.querySelector('.kode-discussions')`)
  assert.equal(await page.evaluate(`window.nativeKept===document.querySelector('.fixture-native-workspaces')`),true)
  assert.equal(await page.evaluate('fixture.created()'),0)
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-brand-switch button').getAttribute('aria-label').includes('DeepSeek Harness')`),true)
  assert.equal(await page.evaluate(`!!document.querySelector('.kode-collab-brand-switch [class*=brandIdentity]')`),true)
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-brand-switch button').textContent.includes('Kode Orbit')`),false)
  await shot('session-mode')
  await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`)
  await wait(`document.querySelector('[role=menuitem]')`)
  await shot('mode-menu')
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await wait(`!document.querySelector('[role=menuitem]')`)
  await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').focus()`)
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13})
  await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  await wait(`document.querySelector('[role=menuitem]')`)
  await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('协作')).click()`)
  await wait(`document.querySelector('.kode-discussion-detail [contenteditable=true]')?.textContent==='切换保留草稿'`)
  assert.deepEqual(await page.evaluate('fixtureErrors'),[])
  await page.call('Emulation.setDeviceMetricsOverride',{width:430,height:850,deviceScaleFactor:1,mobile:true})
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-brand-switch button').textContent.includes('Kode Orbit')`),true)
  await shot('brand-orbit-narrow')
  await page.call('Emulation.setDeviceMetricsOverride',{width:1320,height:900,deviceScaleFactor:1,mobile:false})
  await page.evaluate(`document.querySelector('button[aria-label="收起侧边栏"]').click()`)
  await wait(`document.querySelector('.kode-collab-unified-sidebar')?.dataset.wide==='false'`)
  assert.equal(await page.evaluate(`document.querySelectorAll('.kode-collab-mode-switch').length`),1)
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').getBoundingClientRect().height>0`),true)
  await page.evaluate(`document.querySelector('button[aria-label="打开侧边栏"]').click()`)
  await wait(`document.querySelector('.kode-collab-brand-switch')`)
  assert.equal(await page.evaluate(`document.querySelectorAll('.kode-collab-mode-switch').length`),1)
  await page.evaluate(`document.querySelector('.kode-discussion-heading [aria-label="邀请成员"]').click()`)
  await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='打开 Team Builder')`)
  await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='打开 Team Builder').click()`)
  // Builder start page (no drafts yet): goal first, nothing created by navigating.
  await wait(`document.querySelector('.kode-collab-builder')?.innerText.includes('想让团队完成什么？') && !document.querySelector('.kode-collab-builder')?.innerText.includes('暂时无法读取')`)
  assert.equal(await page.evaluate('fixture.created()'),0)
  await shot('builder-from-project')
  assert.deepEqual(await page.evaluate('fixtureErrors'),[])
 }finally{await browser?.close();if(server?.listening)await new Promise(r=>server.close(r));await hub.close();await rm(profile,{recursive:true,force:true})}
})

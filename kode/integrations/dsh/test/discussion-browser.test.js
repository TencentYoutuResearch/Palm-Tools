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
import {registerCollabBudgets} from '../src/collab-budgets-route.js'

test('real Rust Hub + owner facade + dsh UI: channel and private threads, reload and restart', {skip:!process.env.KODE_TEST_BROWSER_BIN || !process.env.KODE_TEST_HUB_BIN,timeout:120000},async()=>{
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
  for(const register of [registerCollaboration,registerCollabTeams,registerCollabRuns,registerConversation,registerConversationRead,registerCollabBudgets,registerWorkRun])register(ctx,{backendClient:{call:(p,b)=>hub.client.call(p,b)}})
  server=createServer(async(req,res)=>{try{const route=routes.get(new URL(req.url,'http://localhost').pathname);if(route)return await route.handler(req,res);if(await collabRenderPage(req,res,{workspaces}))return;res.writeHead(404);res.end('{}')}catch(e){if(!res.headersSent)res.writeHead(500);res.end('{}')}})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile)
  const url=`http://127.0.0.1:${server.address().port}`
  let page=await browser.page(url)
  const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+15000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,40))}throw Error('UI timeout '+JSON.stringify({body:document.body.innerText,errors:fixtureErrors}))})()`)
  // Sidebar rows also hold avatars and badges, so a row is matched by its [data-row-title] text.
  const click=label=>page.evaluate(`Array.from(document.querySelectorAll('button,[data-sidebar-row] [data-row-title]')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`)
  const shot=async name=>{if(!output)return;await mkdir(output,{recursive:true});await writeFile(join(output,name+'.png'),Buffer.from((await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'))}
  await page.call('Emulation.setDeviceMetricsOverride',{width:1320,height:900,deviceScaleFactor:1,mobile:false})
  await wait(`document.querySelector('.kode-collab-mode-switch button')`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').getAttribute('aria-label').includes('会话')`),true)
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('div[aria-label="原生会话管理"]')).display`),'flex')
  await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`)
  await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('协作'))`)
  await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('协作')).click()`)
  await wait(`Array.from(document.querySelectorAll(':is([data-sidebar-row=channel],[data-sidebar-row=dm]) [data-row-title]')).some(b=>b.textContent==='开发协作')`)
  await click('开发协作')
  await wait(`document.querySelector('.kode-discussion-timeline')?.innerText.includes('历史会话头像修复')`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-discussions').innerText.includes('PRIVATE-SENTINEL')`),false)
  await page.evaluate(`document.querySelector('.kode-discussion-reply').click()`)
  await wait(`document.querySelector('.kode-discussion-detail')?.innerText.includes('回复会保留')`)
  await shot('channel-thread-desktop')
  await page.evaluate(`document.querySelector('.kode-discussion-detail textarea,.kode-discussion-detail [role=textbox]').focus()`);await page.call('Input.insertText',{text:'切换保留草稿'})
  await page.evaluate(`window.nativeKept=document.querySelector('.fixture-native-workspaces');document.querySelector('.kode-collab-mode-switch button').click()`)
  await wait(`document.querySelector('[role=menuitem]')`)
  await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('会话')).click()`)
  await wait(`!document.querySelector('.kode-discussions')`)
  assert.equal(await page.evaluate(`window.nativeKept===document.querySelector('.fixture-native-workspaces')`),true)
  assert.equal(await page.evaluate('fixture.created()'),0)
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
  await wait(`(document.querySelector('.kode-discussion-detail textarea')?.value ?? document.querySelector('.kode-discussion-detail [role=textbox]')?.textContent)==='切换保留草稿'`)
  await page.evaluate(`document.querySelector('.kode-discussion-detail textarea,.kode-discussion-detail [role=textbox]').focus()`)
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:4,commands:['selectAll']})
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8})
  await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8})
  await wait(`!(document.querySelector('.kode-discussion-detail textarea')?.value ?? document.querySelector('.kode-discussion-detail [role=textbox]')?.textContent)?.trim()`)
  await new Promise(r=>setTimeout(r,100))

  await page.evaluate(`document.querySelector('.kode-discussion-detail textarea,.kode-discussion-detail [role=textbox]').focus()`);await page.call('Input.insertText',{text:'增加一个边界测试，结果留在本串。'})
  await wait(`(document.querySelector('.kode-discussion-detail textarea')?.value ?? document.querySelector('.kode-discussion-detail [role=textbox]')?.textContent)==='增加一个边界测试，结果留在本串。'`)
  await wait(`!document.querySelector('.kode-discussion-detail button[type=submit],.kode-discussion-detail button[aria-label=发送]')?.disabled`)
  await page.evaluate(`(()=>{const b=document.querySelector('.kode-discussion-detail button[type=submit],.kode-discussion-detail button[aria-label=发送]');b.click();b.click()})()`)
  await wait(`document.querySelector('.kode-discussion-detail .kode-discussion-messages').innerText.includes('增加一个边界测试')`)
  const actual=await call('collaboration/surfaces/development/messages?thread_id='+rootMessage.id)
  assert.equal(actual.items.filter(x=>x.content==='增加一个边界测试，结果留在本串。').length,1)
  await page.evaluate(`document.querySelector('button[aria-label="关闭消息列"]').click()`)
  await wait(`!document.querySelector('.kode-discussion-detail')`)
  assert.equal(await page.evaluate(`document.querySelector('[data-sidebar-section=threads]')`),null)
  assert.equal(await page.evaluate(`!!document.querySelector('[data-sidebar-section=channels] [data-icon="hash"]')`),true)
  assert.equal(await page.evaluate(`!!document.querySelector('[data-sidebar-section=direct] .kode-discussion-avatar')`),true)
  assert.equal(await page.evaluate(`!!document.querySelector('.kode-discussion-message>.kode-discussion-avatar')`),true)
  await page.evaluate(`document.querySelector('.kode-discussion-reply').click()`)
  await wait(`document.querySelector('.kode-discussion-detail')`)
  await page.evaluate(`document.querySelector('button[aria-label="展开消息列"]').click()`)
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('.kode-discussion-timeline')).display`),'none')
  await shot('thread-expanded')
  await click('Kode 团队私信')
  const privateReplySelector = `.kode-discussion-timeline [data-message-id="${privateRoot.id}"] .kode-discussion-reply`
  await wait(`document.querySelector('.kode-discussions')?.dataset.private==='true' && document.querySelector(${JSON.stringify(privateReplySelector)})`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-discussions').innerText.includes('历史会话头像修复')`),false)
  await page.evaluate(`document.querySelector(${JSON.stringify(privateReplySelector)}).click()`)
  await wait(`document.querySelector('.kode-discussion-detail')?.innerText.includes('PRIVATE-SENTINEL')`)
  await shot('dm-thread-desktop')
  await page.call('Emulation.setDeviceMetricsOverride',{width:430,height:850,deviceScaleFactor:1,mobile:true})
  await page.evaluate(`fixture.ctx.layout.toggleSidebar()`);await new Promise(r=>setTimeout(r,700))
  await shot('dm-thread-narrow')
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('.kode-discussion-timeline')).display`),'none')
  await page.close();await hub.stop();await hub.start()
  page=await browser.page(url)
  await wait(`Array.from(document.querySelectorAll(':is([data-sidebar-row=channel],[data-sidebar-row=dm]) [data-row-title]')).some(b=>b.textContent==='Kode 团队私信')`)
  await click('Kode 团队私信');await wait(`document.querySelector('.kode-discussion-reply')`);await page.evaluate(`document.querySelector('.kode-discussion-reply').click()`)
  await wait(`document.querySelector('.kode-discussion-detail')?.innerText.includes('PRIVATE-SENTINEL')`)
  assert.equal((await call('collaboration/surfaces/development/messages')).items.some(m=>m.content.includes('PRIVATE-SENTINEL')),false)
  const errors=await page.evaluate('fixtureErrors');assert.deepEqual(errors,[])
 }finally{await browser?.close();if(server?.listening)await new Promise(r=>server.close(r));await hub.close();await rm(profile,{recursive:true,force:true})}
})

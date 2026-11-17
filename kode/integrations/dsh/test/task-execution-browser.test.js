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

test('real Hub + browser: explicit task creation preserves context and cannot dispatch before authorization', {skip:!process.env.KODE_TEST_BROWSER_BIN || !process.env.KODE_TEST_HUB_BIN,timeout:120000},async()=>{
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
  const shot=async name=>{if(!output)return;await page.evaluate(`Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))`);await mkdir(output,{recursive:true});await writeFile(join(output,name+'.png'),Buffer.from((await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'))}
  await page.call('Emulation.setDeviceMetricsOverride',{width:1320,height:900,deviceScaleFactor:1,mobile:false})
  await wait(`document.querySelector('.kode-collab-mode-switch button')`)
  // The mode switch is an icon trigger now; its current mode is in the accessible name, not visible text.
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').getAttribute('aria-label').includes('会话')`),true)
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('div[aria-label="原生会话管理"]')).display`),'flex')
  await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`)
  await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('协作'))`)
  await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('协作')).click()`)
  await wait(`Array.from(document.querySelectorAll(':is([data-sidebar-row=channel],[data-sidebar-row=dm]) [data-row-title]')).some(b=>b.textContent==='开发协作')`)
  await click('开发协作')
  await wait(`document.querySelector('.kode-discussion-timeline')?.innerText.includes('历史会话头像修复')`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-discussions').innerText.includes('PRIVATE-SENTINEL')`),false)
  // The old one-button TaskExecution modal was replaced by the thread task tools (discussion-task-ui.js):
  // 整理为任务 → 核对发布摘要 → 批准摘要并创建任务, then 预览执行 → 批准本地执行. Same contract is checked.
  const field=async(label,value)=>{await wait(`document.querySelector('[aria-label=${JSON.stringify(label)}]')`);await page.evaluate(`(()=>{const e=document.querySelector('[aria-label=${JSON.stringify(label)}]');const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`)}
  const waitButton=label=>wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`)
  await page.evaluate(`document.querySelector('.kode-discussion-timeline [data-message-id="${rootMessage.id}"] .kode-discussion-reply').click()`)
  await wait(`document.querySelector('.kode-discussion-detail details.kode-discussion-task-tools > summary')`)
  await page.evaluate(`(()=>{const tools=document.querySelector('.kode-discussion-detail details.kode-discussion-task-tools');if(!tools.open)tools.querySelector('summary').click()})()`)
  await waitButton('整理为任务');await click('整理为任务')
  await field('任务负责团队',team.id);await field('任务归档频道',channel.id);await field('任务摘要',rootMessage.content)
  await waitButton('核对发布摘要');await click('核对发布摘要')
  await waitButton('批准摘要并创建任务')
  await shot('task-review-before-dispatch')
  await click('批准摘要并创建任务')
  await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='预览执行')`)
  const tasks=await call('collaboration/surfaces/development/tasks')
  assert.equal(tasks.items.length,1)
  assert.equal(tasks.items[0].summary,rootMessage.content)
  assert.equal(tasks.items[0].work_run_id,undefined)
  const execution=await call('collaboration/tasks/'+tasks.items[0].id+'/execution')
  assert.equal(execution.work_run,null)
  assert.equal(execution.context.summary,rootMessage.content)
  assert.equal(JSON.stringify(execution.context).includes('PRIVATE-SENTINEL'),false)
  // The team in this fixture is not activated: the preview stops at authority and 批准本地执行 stays disabled.
  await waitButton('预览执行');await click('预览执行')
  await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='批准本地执行')&&document.querySelector('[role=dialog] [role=alert]')`)
  assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='批准本地执行').disabled`),true)
  assert.equal((await call('collaboration/tasks/'+tasks.items[0].id+'/execution')).work_run,null)
  await shot('task-created-awaiting-authority')
  assert.deepEqual(await page.evaluate('fixtureErrors'),[])

 }finally{await browser?.close();if(server?.listening)await new Promise(r=>server.close(r));await hub.close();await rm(profile,{recursive:true,force:true})}
})

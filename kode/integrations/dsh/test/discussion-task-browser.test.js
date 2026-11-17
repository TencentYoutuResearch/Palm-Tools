/** Shipped dsh components + real disposable Rust Hub. No model, Host runner or business service. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises'
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
import {registerTeamActivation} from '../src/team-activation-route.js'
import {registerCollabBudgets} from '../src/collab-budgets-route.js'
import {registerWorkRun} from '../src/work-run-route.js'

test('owner summary → unique task → explicit local execution: real UI, exact retries, two tasks and revocation',{skip:!process.env.KODE_TEST_BROWSER_BIN||!process.env.KODE_TEST_HUB_BIN,timeout:120000},async()=>{
 const hub=await isolatedHub('task-approval-ui'),profile=await mkdtemp(join(tmpdir(),'kode-task-approval-'))
 let server,browser,page
 const call=(p,b)=>hub.client.call('/api/v1/messaging/'+p,b),writes=[]
 let loseCreate=true,loseExecution=true
 try{
  const root=await versionedProject(hub.root)
  await call('workbench/workspaces',{action:'create',path:root,title:'隔离验证 · 任务批准'})
  const catalog=await call('workbench/workspaces'),workspace=catalog.workspaces.find(w=>w.path===root)
  const scope={home_hub:hub.node,host_id:hub.node,workspace_id:workspace.id,root_ref:root}
  const team=await conversationTeam(hub,{workspace:{host_id:hub.node,workspace_id:workspace.id,root_ref:root}})
  for(const [id,kind,title] of [['channel','channel','研发任务'],['dm','dm','方案私信']])await call('collaboration/surfaces/'+id,{request_id:'create-'+id,expected_revision:0,scope,kind,title,team_ids:[team.id],enabled:true})
  const post=(id,content)=>call('collaboration/surfaces/'+id+'/messages',{request_id:crypto.randomUUID(),expected_revision:1,content,mentions:[]})
  const a=await post('dm','需求 A：历史头像修复。PRIVATE_ORIGINAL_A 不应发布。'),b=await post('dm','需求 B：优化侧栏搜索。PRIVATE_ORIGINAL_B 不应发布。'),c=await post('dm','需求 C：团队权限变更测试。')
  const routes=new Map(),ctx={connection:{admit:req=>req.headers['x-fixture-owner']==='yes'?{peer:{principal:{kind:'owner'}}}:{rejection:401}},webServer:{register:r=>routes.set(r.path,r)}}
  const client={call:async(path,body)=>{
   if(body)writes.push({path,body:structuredClone(body)})
   const result=await hub.client.call(path,body)
   if(body&&path.endsWith('/collaboration/tasks')&&loseCreate){loseCreate=false;throw Error('Fixture: create committed, reply lost')}
   if(body&&/\/collaboration\/tasks\/[^/]+\/execution$/.test(path)&&loseExecution){loseExecution=false;throw Error('Fixture: dispatch committed, reply lost')}
   return result
  }}
  for(const register of [registerCollaboration,registerCollabTeams,registerCollabRuns,registerConversation,registerConversationRead,registerTeamActivation,registerCollabBudgets,registerWorkRun])register(ctx,{backendClient:client})
  const workspaces=catalog.workspaces.map(w=>({workspaceId:w.id,title:w.title,path:w.path,sessionIds:[],createdAt:new Date().toISOString()}))
  server=createServer(async(req,res)=>{try{const route=routes.get(new URL(req.url,'http://localhost').pathname);if(route)return await route.handler(req,res);if(await collabRenderPage(req,res,{workspaces}))return;res.writeHead(404);res.end('{}')}catch{if(!res.headersSent)res.writeHead(500);res.end('{}')}})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile)
  const url=`http://127.0.0.1:${server.address().port}`
  page=await browser.page(url)
  const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+15000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,35))}throw Error('Task approval UI timeout: '+document.body.innerText+' '+JSON.stringify(fixtureErrors))})()`)
  // Sidebar rows also hold avatars and badges, so a row is matched by its [data-row-title] text.
  const click=async label=>{await wait(`Array.from(document.querySelectorAll('button,[data-sidebar-row] [data-row-title]')).some(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`);await page.evaluate(`Array.from(document.querySelectorAll('button,[data-sidebar-row] [data-row-title]')).find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled).click()`)}
  const field=async(label,value)=>{await wait(`document.querySelector('[aria-label=${JSON.stringify(label)}]')`);await page.evaluate(`(()=>{const e=document.querySelector('[aria-label=${JSON.stringify(label)}]');const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`)}
  const shot=async name=>{if(!process.env.KODE_TEST_SCREENSHOTS)return;await new Promise(r=>setTimeout(r,350));await mkdir(process.env.KODE_TEST_SCREENSHOTS,{recursive:true});await writeFile(join(process.env.KODE_TEST_SCREENSHOTS,name+'.png'),Buffer.from((await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'))}
  const openDM=async()=>{
   await wait(`document.querySelector('.kode-collab-mode-switch button')`)
   if(await page.evaluate(`!Array.from(document.querySelectorAll(':is([data-sidebar-row=channel],[data-sidebar-row=dm]) [data-row-title]')).some(b=>b.textContent==='方案私信')`)){
    await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`);await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('协作'))`);await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('协作')).click()`)
   }
   await click('方案私信');await wait(`document.querySelector('.kode-discussion-timeline [data-message-id="${a.id}"]')`)
  }
  const expandTaskTools=async()=>{await wait(`document.querySelector('.kode-discussion-detail details.kode-discussion-task-tools > summary')`);await page.evaluate(`(()=>{const tools=document.querySelector('.kode-discussion-detail details.kode-discussion-task-tools');if(!tools.open)tools.querySelector('summary').click()})()`);await wait(`document.querySelector('.kode-discussion-detail details.kode-discussion-task-tools')?.open`)}
  const openThread=async id=>{await page.evaluate(`document.querySelector('.kode-discussion-timeline [data-message-id="${id}"] button').click()`);await wait(`document.querySelector('.kode-discussion-detail [data-message-id="${id}"]')`);await expandTaskTools()}
  const draft=async summary=>{await click('整理为任务');await field('任务负责团队','team');await field('任务归档频道','channel');await field('任务摘要',summary)}
  const taskWrites=()=>writes.filter(w=>w.path.endsWith('/collaboration/tasks')),executionWrites=()=>writes.filter(w=>/\/collaboration\/tasks\/[^/]+\/execution$/.test(w.path))
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:980,deviceScaleFactor:1,mobile:false})
  await openDM();await openThread(a.id);assert.equal(writes.length,0)
  await draft('需求 A：修复历史头像显示，补充读取路径测试，仅本地验证。')
  await click('核对发布摘要');await wait(`document.querySelector('[aria-label="待批准的任务摘要"]')`);assert.equal(taskWrites().length,0)
  await field('任务摘要','需求 A：修复历史头像显示，补充读取路径与回退测试，仅本地验证。')
  assert.equal(await page.evaluate(`!!document.querySelector('[aria-label="待批准的任务摘要"]')`),false,'editing summary revokes earlier approval')
  await click('核对发布摘要');await shot('summary-approval-desktop')
  await page.call('Emulation.setDeviceMetricsOverride',{width:430,height:900,deviceScaleFactor:1,mobile:true});await shot('summary-approval-narrow');await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:980,deviceScaleFactor:1,mobile:false})
  await page.evaluate(`document.querySelector('button[aria-label="关闭任务摘要"]').click()`)
  await openThread(b.id);await draft('需求 B：搜索输入回归测试。');await page.evaluate(`document.querySelector('button[aria-label="关闭任务摘要"]').click()`)
  await openThread(a.id);await click('整理为任务');assert.match(await page.evaluate(`document.querySelector('[aria-label="任务摘要"]').value`),/^需求 A/)
  await click('核对发布摘要');await page.evaluate(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='批准摘要并创建任务');b.click();b.click()})()`)
  await wait(`document.body.innerText.includes('恢复原创建请求')`);assert.equal(taskWrites().length,1)
  const created=(await call('collaboration/surfaces/dm/tasks')).items;assert.equal(created.length,1);const taskA=created[0];assert.equal(taskA.work_run_id,undefined)
  // Pending publication survives dismissal, another thread, and reopening without a new POST.
  await page.evaluate(`document.querySelector('button[aria-label="关闭任务摘要"]').click()`);await wait(`!document.querySelector('[role=dialog]')`)
  await openThread(b.id);await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='整理为任务')`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-discussion-detail').innerText.includes('恢复原任务创建请求')`),false)
  await openThread(a.id);await click('恢复原任务创建请求');await wait(`document.querySelector('[aria-label="任务摘要"]')?.disabled`)
  assert.equal(await page.evaluate(`document.querySelector('[aria-label="任务摘要"]').value`),taskA.summary)
  assert.equal(taskWrites().length,1);assert.equal((await call('collaboration/surfaces/dm/tasks')).items.length,1)
  await page.evaluate(`document.querySelector('button[aria-label="关闭任务摘要"]').click()`)
  await page.call('Page.reload');await openDM();await openThread(a.id);await click('恢复原任务创建请求');await click('恢复原创建请求')
  await wait(`document.querySelector('[data-task-id="${taskA.id}"]')`);assert.equal(taskWrites().length,2);assert.deepEqual(taskWrites()[0],taskWrites()[1]);assert.equal((await call('collaboration/surfaces/dm/tasks')).items.length,1)
  assert.equal(executionWrites().length,0)
  await click('打开任务串');await wait(`document.querySelector('.kode-discussion-heading h2')?.textContent==='研发任务'&&document.querySelector('[data-task-id="${taskA.id}"]')`);await expandTaskTools();assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='整理为任务')`),false);await openDM();await openThread(a.id)
  const channelMessages=await call('collaboration/surfaces/channel/messages');assert.equal(JSON.stringify(channelMessages).includes('PRIVATE_ORIGINAL'),false)
  await click('预览执行');await wait(`document.body.innerText.includes('批准本地执行')`);await shot('execution-approval-desktop');assert.equal(executionWrites().length,0)
  await page.evaluate(`document.querySelector('button[aria-label="关闭执行预览"]').click()`);assert.equal(executionWrites().length,0)
  await click('预览执行');await click('批准本地执行');await wait(`document.body.innerText.includes('恢复原执行请求')`)
  assert.equal(executionWrites().length,1)
  const afterA=await call('collaboration/tasks/'+taskA.id);assert.ok(afterA.work_run_id)
  // Pending execution stays bound to A when its modal closes or the user visits B.
  await page.evaluate(`document.querySelector('button[aria-label="关闭执行预览"]').click()`);await wait(`!document.querySelector('[role=dialog]')`)
  await openThread(b.id);await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='整理为任务')`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-discussion-detail').innerText.includes('恢复原执行请求')`),false)
  await openThread(a.id);await click('恢复原执行请求');await wait(`document.querySelector('[role=dialog]')?.innerText.includes('原批准请求尚未确认')`)
  assert.equal(executionWrites().length,1);assert.equal((await call('collaboration/tasks/'+taskA.id)).work_run_id,afterA.work_run_id)
  await page.evaluate(`document.querySelector('button[aria-label="关闭执行预览"]').click()`)
  await page.call('Page.reload');await openDM();await openThread(a.id);await click('恢复原执行请求');await page.evaluate(`Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent==='恢复原执行请求').click()`)
  await wait(`!document.querySelector('[role=dialog]')`);assert.equal(executionWrites().length,2);assert.deepEqual(executionWrites()[0],executionWrites()[1]);assert.equal((await call('collaboration/tasks/'+taskA.id)).work_run_id,afterA.work_run_id)
  assert.equal(JSON.stringify(await call('work-runs/'+afterA.work_run_id)).includes('PRIVATE_ORIGINAL'),false)
  await openThread(b.id);await click('整理为任务');assert.equal(await page.evaluate(`document.querySelector('[aria-label="任务摘要"]').value`),'需求 B：搜索输入回归测试。');await click('核对发布摘要');await click('批准摘要并创建任务')
  await wait(`document.querySelector('.kode-task-status')?.innerText.includes('需求 B')`);const taskB=(await call('collaboration/surfaces/dm/tasks')).items.find(t=>t.origin_message_id===b.id)
  await click('预览执行');await click('批准本地执行');await wait(`document.querySelector('.kode-task-status')?.dataset.runId`)
  const afterB=await call('collaboration/tasks/'+taskB.id);assert.ok(afterB.work_run_id);assert.notEqual(afterA.work_run_id,afterB.work_run_id)
  await shot('task-b-separate-run-desktop')
  await click('取消任务');await wait(`document.querySelector('[role=dialog]')?.innerText.includes('需求 B')`);await click('继续保留')
  assert.equal(writes.filter(w=>w.path.endsWith('/execution/cancel')).length,0)
  await openThread(a.id);await click('取消任务');await wait(`document.querySelector('[role=dialog]')?.innerText.includes('需求 A')`);await click('确认取消这项任务');await wait(`!document.querySelector('[role=dialog]')`)
  const cancels=writes.filter(w=>w.path.endsWith('/execution/cancel'));assert.equal(cancels.length,1);assert.ok(cancels[0].path.includes(taskA.id));assert.notEqual((await call('work-runs/'+afterB.work_run_id)).state,'cancelled')
  await shot('task-a-cancel-only-desktop')
  await openThread(c.id);await draft('需求 C：检查授权失效时禁止执行。');await click('核对发布摘要');await click('批准摘要并创建任务');await wait(`document.querySelector('.kode-task-status')?.innerText.includes('需求 C')`)
  await click('预览执行');await wait(`document.body.innerText.includes('批准本地执行')`)
  const activation=await call('teams/team/activation');await call('teams/team/activation',{action:'deactivate',request_id:'revoke-after-preview',expected_revision:activation.revision})
  await click('批准本地执行');await wait(`document.querySelector('[role=dialog]')?.innerText.includes('授权可能已变化')`)
  const taskC=(await call('collaboration/surfaces/dm/tasks')).items.find(t=>t.origin_message_id===c.id);assert.equal(taskC.work_run_id,undefined)
  await shot('expired-authorization-desktop')
  assert.deepEqual(await page.evaluate('fixtureErrors'),[])
  await writeFile(join(process.env.KODE_TEST_SCREENSHOTS??hub.root,'result.json'),JSON.stringify({tasks:[taskA.id,taskB.id,taskC.id],runs:[afterA.work_run_id,afterB.work_run_id],createRequests:taskWrites().length,executionRequests:executionWrites().length,exactCreateRetry:true,exactExecutionRetry:true,pendingModalAndThreadRecovery:true,cancelledOnlyTaskA:true,revokedExecutionRejected:true,providerCalls:0},null,2))
 }finally{await browser?.close();if(server?.listening){server.closeAllConnections();await new Promise(r=>server.close(r))}await hub.close();await rm(profile,{recursive:true,force:true})}
})

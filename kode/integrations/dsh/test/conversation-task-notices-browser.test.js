/** Real isolated Hub and shipped renderer. Only controlled task state; no provider/model starts. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtemp,rm,writeFile,mkdir,readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
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

test('controlled real Hub notices return to exact same-name channel, survive restart and fail closed after revocation',{
 skip:!process.env.KODE_TEST_HUB_BIN||!process.env.KODE_TEST_BROWSER_BIN,timeout:120000,
},async()=>{
 const hub=await isolatedHub('notice-home'),profile=await mkdtemp(join(tmpdir(),'kode-task-notice-'))
 let server,browser;const writes=[],reads=[],call=(path,body)=>hub.client.call('/api/v1/messaging/'+path,body)
 try{
  const root=await versionedProject(hub.root)
  await call('workbench/workspaces',{action:'create',path:root,title:'受控提醒验证'})
  const workspace=(await call('workbench/workspaces')).workspaces.find(row=>row.path===root)
  const scope={home_hub:hub.node,host_id:hub.node,workspace_id:workspace.id,root_ref:root}
  const team=await conversationTeam(hub,{workspace:{host_id:hub.node,workspace_id:workspace.id,root_ref:root}})
  const cases=[]
  for(const label of ['A','B']){
   const channel='channel-'+label
   await call('collaboration/surfaces/'+channel,{request_id:'create',expected_revision:0,scope,kind:'channel',title:'同名频道',team_ids:[team.id],enabled:true})
   const message=await call(`collaboration/surfaces/${channel}/messages`,{request_id:'root',expected_revision:1,content:`原始需求 ${label}，不要复制到私信。`,mentions:[]})
   let task=await call('collaboration/tasks',{request_id:'task',origin_surface_id:channel,origin_message_id:message.id,origin_revision:1,archive_surface_id:channel,archive_revision:1,team_id:team.id,team_revision:1,summary:`需求 ${label} · 保持独立身份`})
   const preview=await call(`collaboration/tasks/${task.id}/execution`),activation=await call('teams/team/activation')
   const receipt=await call(`collaboration/tasks/${task.id}/execution`,{request_id:'execute',expected_task_revision:task.revision,binding_id:'local',activation_revision:activation.revision,context_sha256:preview.context_sha256})
   task=await call('collaboration/tasks/'+task.id);cases.push({label,channel,message,task,run:await call('work-runs/'+receipt.work_run_id)})
  }
  const mutate=(id,change)=>{const db=new DatabaseSync(join(hub.root,'ledger.sqlite'));try{const row=JSON.parse(db.prepare('SELECT body FROM work_runs WHERE id=?').get(id).body);change(row);db.prepare('UPDATE work_runs SET state=?,body=? WHERE id=?').run(row.state,JSON.stringify(row),id)}finally{db.close()}}
  mutate(cases[0].run.id,row=>{row.state='running';row.clarifications=[{run_id:row.id,assignment_id:'controlled-assignment',request:{request_id:'controlled-question',questions:[{id:'choice',question:'问题正文不得复制到私信'}]},state:'pending'}]})
  mutate(cases[1].run.id,row=>{row.state='completed';row.completion_authorized=false})
  const before=await Promise.all(cases.map(c=>call('work-runs/'+c.run.id)))
  const notices=()=>call(`conversations/${team.conversation_id}/task-notices`)
  const initial=await notices();assert.equal(initial.items.length,2);assert.ok(!JSON.stringify(initial).includes('不得复制'))
  await hub.stop();await hub.start();assert.deepEqual(await notices(),initial)
  const routes=new Map(),ctx={connection:{admit:req=>req.headers['x-fixture-owner']==='yes'?{peer:{principal:{kind:'owner'}}}:{rejection:401}},webServer:{register:r=>routes.set(r.path,r)}}
  const client={call:async(path,body)=>{(body?writes:reads).push(path);return hub.client.call(path,body)}}
  for(const register of [registerCollaboration,registerCollabTeams,registerCollabRuns,registerConversation,registerConversationRead,registerWorkRun])register(ctx,{backendClient:client})
  const workspaces=[{workspaceId:workspace.id,title:'受控提醒验证',path:root,sessionIds:[],createdAt:new Date().toISOString()}]
  server=createServer(async(req,res)=>{try{const route=routes.get(new URL(req.url,'http://localhost').pathname);if(route)return await route.handler(req,res);if(await collabRenderPage(req,res,{workspaces}))return;res.writeHead(404);res.end('{}')}catch{if(!res.headersSent)res.writeHead(500);res.end('{}')}})
  server.listen(0,'127.0.0.1');await once(server,'listening');browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile)
  const url='http://127.0.0.1:'+server.address().port,page=await browser.page(url)
  const shot=async name=>{if(!process.env.KODE_NOTICE_SCREENSHOT_DIR)return;await mkdir(process.env.KODE_NOTICE_SCREENSHOT_DIR,{recursive:true});const {data}=await page.call('Page.captureScreenshot',{format:'png'});await writeFile(join(process.env.KODE_NOTICE_SCREENSHOT_DIR,name+'.png'),Buffer.from(data,'base64'))}
  const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+12000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,35))}throw Error('Notice UI timeout: '+document.body.innerText+' '+JSON.stringify(fixtureErrors))})()`)
  const openDm=async()=>{await wait(`document.querySelector('.kode-collab-mode-switch button')`);if(await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').getAttribute('aria-label').includes('会话')`)){await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`);await wait(`[...document.querySelectorAll('[role=menuitem]')].some(b=>b.textContent.includes('协作'))`);await page.evaluate(`[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent.includes('协作')).click()`)}
   await wait(`document.querySelector('[data-sidebar-row=team]')`);await page.evaluate(`document.querySelector('[data-sidebar-row=team]').click()`);await wait(`document.querySelector('[aria-label="频道任务提醒"]')?.textContent.includes('需求 A')`)}
  const refresh=()=>page.evaluate(`[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='刷新提醒').click()`)
  await openDm()
  assert.equal(await page.evaluate(`document.querySelector('[aria-label="频道任务提醒"] details').open`),false)
  assert.ok(!(await page.evaluate(`document.querySelector('[aria-label="频道任务提醒"]').textContent`)).includes('问题正文'))
  for(let n=0;n<2;n++){await refresh();await wait(`document.querySelectorAll('[data-task-notice]').length===2`)}
  assert.equal(await page.evaluate(`document.querySelectorAll('[data-task-notice]').length`),2)
  for(const [width,height] of [[1440,1000],[390,844]]){
   await page.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
   if(width===390)await page.evaluate(`fixture.ctx.layout.toggleSidebar()`)
   await wait(`innerWidth===${width}&&innerHeight===${height}&&document.querySelector('[aria-label="发送"]')`)
   const bounds=await page.evaluate(`(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const e=document.querySelector('[aria-label="频道任务提醒"]'),s=getComputedStyle(e),send=document.querySelector('[aria-label="发送"]'),r=send?.getBoundingClientRect();return {width:e.clientWidth,scroll:e.scrollWidth,height:e.getBoundingClientRect().height,innerWidth,innerHeight,maxHeight:s.maxHeight,boxSizing:s.boxSizing,send:r?{top:r.top,bottom:r.bottom,width:r.width,height:r.height}:null,frame:document.querySelector('#fixture-frame').getBoundingClientRect().toJSON()}})()`)
   assert.ok(bounds.scroll<=bounds.width+1,JSON.stringify(bounds));assert.ok(bounds.height<=height*.27,JSON.stringify(bounds))
   assert.ok(bounds.send&&bounds.send.height>0&&bounds.send.bottom<=height+1,`composer remains visible: ${JSON.stringify(bounds)}`)
   if(process.env.KODE_NOTICE_SCREENSHOT_DIR){await mkdir(process.env.KODE_NOTICE_SCREENSHOT_DIR,{recursive:true});const {data}=await page.call('Page.captureScreenshot',{format:'png'});await writeFile(join(process.env.KODE_NOTICE_SCREENSHOT_DIR,`controlled-notices-${width}.png`),Buffer.from(data,'base64'))}
  }
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false})
  await page.evaluate(`fixture.ctx.layout.toggleSidebar()`)
  await page.evaluate(`document.querySelector('[aria-label="频道任务提醒"] details').open=true;document.querySelector('button[aria-label="回频道查看 需求 B · 保持独立身份"]').click()`)
  await wait(`document.querySelector('.kode-discussion-detail')?.textContent.includes('需求 B · 保持独立身份')`)
  assert.ok(!(await page.evaluate(`document.querySelector('.kode-discussion-detail').textContent`)).includes('需求 A · 保持独立身份'))
  await shot('controlled-notices-return-channel-B')
  assert.equal(reads.filter(path=>path===`/api/v1/messaging/collaboration/tasks/${cases[1].task.id}`).length>=2,true)
  await openDm()
  await call('collaboration/surfaces/channel-A',{request_id:'revoke',expected_revision:1,scope,kind:'channel',title:'同名频道',team_ids:[team.id],enabled:false})
  await page.evaluate(`document.querySelector('button[aria-label="回频道查看 需求 A · 保持独立身份"]').click()`)
  await wait(`document.querySelector('[aria-label="频道任务提醒"]')?.textContent.includes('未打开任何频道')`)
  assert.equal(await page.evaluate(`document.querySelectorAll('[data-task-notice]').length`),0)
  await shot('controlled-notices-revoked-click-cleared')
  await refresh();await wait(`document.querySelectorAll('[data-task-notice]').length===1`)
  assert.ok(!(await page.evaluate(`document.querySelector('[aria-label="频道任务提醒"]').textContent`)).includes('需求 A'))
  assert.match(await page.evaluate(`document.querySelector('[aria-label="频道任务提醒"]').textContent`),/访问范围已变化/)
  await shot('controlled-notices-revoked-refresh')
  await page.call('Page.reload');await wait(`document.querySelector('[aria-label="频道任务提醒"]')?.textContent.includes('本页已结束任务')`)
  assert.equal(await page.evaluate(`document.querySelectorAll('[data-task-notice]').length`),1)
  assert.deepEqual(await Promise.all(cases.map(c=>call('work-runs/'+c.run.id))),before)
  assert.deepEqual(writes.filter(path=>!path.endsWith('/read-state')),[]);assert.equal(await page.evaluate('fixture.created()'),0)
  assert.deepEqual(await page.evaluate('fixtureErrors'),[])
  if(process.env.KODE_NOTICE_SCREENSHOT_DIR)await writeFile(join(process.env.KODE_NOTICE_SCREENSHOT_DIR,'controlled-notices-result.json'),JSON.stringify({realIsolatedHub:true,controlledTaskState:true,modelsStarted:0,extraWrites:writes,clientSha256:createHash('sha256').update(await readFile(new URL('../packages/collab/client.js',import.meta.url))).digest('hex'),hubSha256:createHash('sha256').update(await readFile(process.env.KODE_TEST_HUB_BIN)).digest('hex'),exactSameNameChannel:true,restart:true,revocation:true},null,2))
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}await hub.close();await rm(profile,{recursive:true,force:true})}
})

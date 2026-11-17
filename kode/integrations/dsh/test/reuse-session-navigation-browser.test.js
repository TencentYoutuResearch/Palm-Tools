/** Real isolated Hub + shipped UI/navigation. Existing Session controller snapshots are controlled; no Worker/model is launched. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
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
import {registerWorkRun} from '../src/work-run-route.js'
import {registerManagedSessionAccess} from '../src/managed-session-access.js'
import {ownerWorkerDirectory} from '../src/owner-worker-directory.js'

test('discussion and workspace reuse exact existing Worker sessions and ProcessDetail without task/budget/authority writes',{skip:!process.env.KODE_TEST_BROWSER_BIN||!process.env.KODE_TEST_HUB_BIN,timeout:120000},async()=>{
 const hub=await isolatedHub('session-navigation-ui'),profile=await mkdtemp(join(tmpdir(),'kode-session-navigation-'))
 let server,browser,delaySession=null,deniedRun=null,delayRun=null;const delayed=[]
 const call=(path,body)=>hub.client.call('/api/v1/messaging/'+path,body),writes=[],bindings={}
 try{
  const root=await versionedProject(hub.root);await call('workbench/workspaces',{action:'create',path:root,title:'会话复用验证'})
  const workspace=(await call('workbench/workspaces')).workspaces.find(w=>w.path===root),scope={home_hub:hub.node,host_id:hub.node,workspace_id:workspace.id,root_ref:root}
  const secondRoot=await versionedProject(hub.root);await call('workbench/workspaces',{action:'create',path:secondRoot,title:'另一验证工作区'});const secondWorkspace=(await call('workbench/workspaces')).workspaces.find(w=>w.path===secondRoot)
  const configuredHub={...hub,client:{call:(path,body)=>hub.client.call(path,path.endsWith('/capability-profiles')?{...body,assessments:{fit:{evaluation:{kind:'task_fit',tag:'inspection',score:80},source:'user',confidence:1,evidence:[],updated_at:Date.now(),valid_until:Date.now()+180000,pinned:false}}}:body)}}
  const team=await conversationTeam(configuredHub,{workspace:{host_id:scope.host_id,workspace_id:scope.workspace_id,root_ref:scope.root_ref}})
  await call('collaboration/surfaces/channel',{request_id:'create',expected_revision:0,scope,kind:'channel',title:'复用测试频道',team_ids:[team.id],enabled:true})
  const cases=[]
  for(const label of ['A','B']){
   const message=await call('collaboration/surfaces/channel/messages',{request_id:'message-'+label,expected_revision:1,content:'需求 '+label,mentions:[]})
   const summary='需求 '+label+' 的独立任务'
   let task=await call('collaboration/tasks',{request_id:'task-'+label,origin_surface_id:'channel',origin_message_id:message.id,origin_revision:1,archive_surface_id:'channel',archive_revision:1,team_id:team.id,team_revision:1,summary,publication:{destination_id:'channel',destination_revision:1,summary_sha256:createHash('sha256').update(summary).digest('hex')}})
   const preview=await call('collaboration/tasks/'+task.id+'/execution'),activation=await call('teams/team/activation')
   const receipt=await call('collaboration/tasks/'+task.id+'/execution',{request_id:'execute-'+label,expected_task_revision:task.revision,binding_id:'local',activation_revision:activation.revision,context_sha256:preview.context_sha256})
   const run=await call('work-runs/'+receipt.work_run_id)
   const prepared=await call('work-runs/'+run.id+'/stages/inspect/assignments',{request_id:'assignment-'+label,expected_revision:run.revision,target_id:'control',worker_id:null})
   const assignment=prepared.assignment
   bindings[assignment.worker.session_id]={managedAssignment:{id:assignment.id},managedOperation:assignment.dispatch.command.operation}
   task=await call('collaboration/tasks/'+task.id);cases.push({label,message,task,assignment,run:await call('work-runs/'+run.id)})
  }
  const rows=cases.map(c=>({sessionId:c.assignment.worker.session_id,blank:false,cwd:'/isolated/derived-not-origin',projections:{values:{title:'Worker '+c.label}}}))
  const services={kodeAgents:{profiles:{binding:id=>bindings[id]}},sessionController:{list:async()=>({items:rows})}}
  const directory={nodeId:hub.node,workspaces:[{id:workspace.id,title:'会话复用验证',path:root,sessionIds:[]},{id:secondWorkspace.id,title:'另一验证工作区',path:secondRoot,sessionIds:[]}],archivedSessionIds:[]}
  const managed=await ownerWorkerDirectory({get:key=>services[key]},hub.client,directory);assert.equal(managed.length,2)
  const routes=new Map(),ctx={connection:{admit:req=>req.headers['x-fixture-owner']==='yes'?{peer:{principal:{kind:'owner'}}}:{rejection:401}},webServer:{register:r=>routes.set(r.path,r)}}
  const readPaths=[],client={call:async(path,body)=>{if(body)writes.push({path,body});else readPaths.push(path);return hub.client.call(path,body)}}
  for(const register of [registerCollaboration,registerCollabTeams,registerCollabRuns,registerConversation,registerConversationRead,registerWorkRun])register(ctx,{backendClient:client})
  registerManagedSessionAccess(ctx,{profiles:{binding:id=>bindings[id]}},hub.node)
  const workspaces=directory.workspaces.map(row=>({workspaceId:row.id,title:row.title,path:row.path,sessionIds:[],createdAt:new Date().toISOString()}))
  const ownerDirectory={current:'local',hosts:[{id:'local',...directory,sessions:[],ownerManagedSessions:managed,ownerManagedCandidateLimit:100}]}
  server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');if(url.pathname==='/api/kode/work-run'&&url.searchParams.get('run_id')===deniedRun){res.writeHead(403);res.end('{}');return}if((url.pathname==='/api/kode/managed-session'&&url.searchParams.get('session_id')===delaySession)||(url.pathname==='/api/kode/work-run'&&url.searchParams.get('run_id')===delayRun)){await new Promise(resolve=>delayed.push(resolve));if(res.destroyed)return}const route=routes.get(url.pathname);if(route)return await route.handler(req,res);if(await collabRenderPage(req,res,{workspaces,ownerDirectory,managedSessions:managed.map(row=>({id:row.id,title:row.title}))}))return;res.writeHead(404);res.end('{}')}catch(e){res.writeHead(500);res.end('{}')}})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);const page=await browser.page('http://127.0.0.1:'+server.address().port)
  const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+15000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,35))}throw Error('Navigation timeout: '+document.body.innerText+' '+JSON.stringify(fixtureErrors))})()`)
  const shot=async name=>{if(!process.env.KODE_TEST_SCREENSHOTS)return;await page.evaluate(`(()=>{const e=document.createElement('div');e.id='navigation-evidence-label';e.style='position:fixed;right:12px;bottom:12px;z-index:999999;padding:8px 12px;background:#203040;color:white;font:12px sans-serif;border-radius:6px';e.textContent='真实隔离 Hub · 受控 Session 快照 · 未启动模型';document.body.append(e)})()`);await mkdir(process.env.KODE_TEST_SCREENSHOTS,{recursive:true});await writeFile(join(process.env.KODE_TEST_SCREENSHOTS,name+'.png'),Buffer.from((await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));await page.evaluate(`document.getElementById('navigation-evidence-label').remove()`)}
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:980,deviceScaleFactor:1,mobile:false})
  // Sidebar rows also hold avatars and badges, so a row is matched by its [data-row-title] text.
  const click=async text=>{await wait(`Array.from(document.querySelectorAll('button,[data-sidebar-row] [data-row-title]')).some(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`);await page.evaluate(`Array.from(document.querySelectorAll('button,[data-sidebar-row] [data-row-title]')).find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled).click()`)}
  const collab=async()=>{await wait(`document.querySelector('.kode-collab-mode-switch button')`);if(await page.evaluate(`document.querySelector('.kode-collab-mode-switch button')?.getAttribute('aria-label').includes('会话')`)){await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`);await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('协作'))`);await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('协作')).click()`)}}
  const openThread=async c=>{await collab();await click('复用测试频道');await wait(`document.querySelector('.kode-discussion-timeline [data-message-id="${c.message.id}"] button')`);await page.evaluate(`document.querySelector('.kode-discussion-timeline [data-message-id="${c.message.id}"] button').click()`);await wait(`document.querySelector('details.kode-discussion-task-tools')`);await page.evaluate(`(()=>{const tools=document.querySelector('details.kode-discussion-task-tools');if(!tools.open)tools.querySelector('summary').click()})()`);await wait(`document.querySelector('[data-task-id="${c.task.id}"] [data-assignment-id="${c.assignment.id}"]')`)}
  const waitDelayed=async()=>{const end=Date.now()+5000;while(!delayed.length&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(delayed.length,'the slow ownership GET must actually be pending')}
  const releaseDelayed=async()=>{delaySession=null;delayRun=null;for(const resume of delayed.splice(0))resume();await new Promise(r=>setTimeout(r,80))}
  // Projects are switched in the sidebar tree: expand the project row, then any click inside its group makes it current.
  const switchWorkspace=async title=>{const row=`[aria-label=${JSON.stringify('项目：'+title)}]`,group=`[role=group][aria-label=${JSON.stringify(title)}]`
   await wait(`document.querySelector(${JSON.stringify(row)})`)
   if(!await page.evaluate(`!!document.querySelector(${JSON.stringify(group)})`))await page.evaluate(`document.querySelector(${JSON.stringify(row)}).click()`)
   await wait(`document.querySelector(${JSON.stringify(group)})`);await page.evaluate(`document.querySelector(${JSON.stringify(group)}).click()`)
   await wait(`document.querySelector(${JSON.stringify(row)}).getAttribute('aria-current')==='true'`)}
  const baseline={runs:await Promise.all(cases.map(c=>call('work-runs/'+c.run.id))),tasks:await Promise.all(cases.map(c=>call('collaboration/tasks/'+c.task.id))),budget:await call('budgets/budget'),activation:await call('teams/team/activation')}
  await collab();await wait(`document.querySelectorAll('[data-managed-session-id]').length===2`)
  assert.equal(await page.evaluate(`document.querySelector('[data-managed-candidate-limit]')`),null,'no candidate-limit notice; rows page like the native list')
  // Managed rows are now the native treeitem itself (scoped-workspace-sidebar.js ManagedWorkerRow → ItemRow): the row opens, it carries no buttons or row menus.
  assert.deepEqual(await page.evaluate(`Array.from(document.querySelectorAll('[data-managed-session-id]')).map(e=>[e.getAttribute('role'),e.getAttribute('aria-label').startsWith('打开受管会话：'),e.querySelectorAll('button,[data-row-actions]').length])`),[['treeitem',true,0],['treeitem',true,0]],'managed rows have only read-only navigation, no native action menus')
  await shot('owner-workspace-managed-readonly-list')
  await page.evaluate(`document.querySelector('[data-managed-session-id="${cases[0].assignment.worker.session_id}"]').click()`)
  await wait(`document.querySelector('[data-native-session="${cases[0].assignment.worker.session_id}"]')`)
  await wait(`document.querySelector('.kode-managed-session-banner')?.innerText.includes('返回任务工作过程')`)
  assert.match(await page.evaluate(`fixture.ctx.get('conversation').blocks.storeFor('${cases[0].assignment.worker.session_id}').getSnapshot().reason`),/只读/)
  await shot('managed-session-return-button')
  await click('返回任务工作过程')
  await wait(`document.querySelector('.kode-collab-run-detail[data-run-id="${cases[0].run.id}"]')?.innerText.includes('流程阶段')`)
  for(const c of cases){
   await openThread(c)
   if(c===cases[0])await shot('discussion-direct-session-links')
   const other=cases.find(x=>x!==c);assert.equal(await page.evaluate(`!!document.querySelector('.kode-discussion-task-panel [data-assignment-id="${other.assignment.id}"]')`),false)
   await click('打开执行会话（只读）：'+c.assignment.worker.session_id)
   await wait(`document.querySelector('[data-native-session="${c.assignment.worker.session_id}"]')`)
   await click('返回任务工作过程')
   await wait(`document.querySelector('.kode-collab-run-detail[data-run-id="${c.run.id}"]')?.innerText.includes('流程阶段')`)
   assert.equal(await page.evaluate(`document.querySelectorAll('.kode-collab-run-detail').length`),1)
   await click('查看内部会话诊断');await click('打开原生会话（只读）');await click('返回任务工作过程')
   await wait(`document.querySelector('.kode-collab-run-detail[data-run-id="${c.run.id}"]')?.innerText.includes('流程阶段')`)
   // Inspect the existing cancellation confirmation only; never submit it.
   await click('取消任务');await wait(`document.body.innerText.includes('确认请求取消')`);await click('继续任务')
  }
  // A slow ownership response cannot steal a newer B selection across sidebar rows.
  await collab();delaySession=cases[0].assignment.worker.session_id
  await page.evaluate(`document.querySelector('[data-managed-session-id="${cases[0].assignment.worker.session_id}"]').click()`);await waitDelayed()
  await page.evaluate(`document.querySelector('[data-managed-session-id="${cases[1].assignment.worker.session_id}"]').click()`)
  await wait(`document.querySelector('[data-native-session="${cases[1].assignment.worker.session_id}"]')`);await releaseDelayed()
  assert.equal(await page.evaluate(`document.querySelector('[data-native-session]')?.dataset.nativeSession`),cases[1].assignment.worker.session_id)
  await click('返回任务工作过程')
  await wait(`document.querySelector('.kode-collab-run-detail[data-run-id="${cases[1].run.id}"]')?.innerText.includes('流程阶段')`)
  // Native direct selection has no source link, even for a previously visited Worker.
  await page.evaluate(`fixture.ctx.get('uiWorkspace').openSession('${cases[0].assignment.worker.session_id}')`)
  await wait(`document.querySelector('.kode-managed-session-banner')?.innerText.includes('只读排障')`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-managed-session-banner').innerText.includes('返回任务工作过程')`),false)
  // Returning does not reuse a previously loaded ProcessDetail after read access changes.
  await openThread(cases[0]);await click('打开执行会话（只读）：'+cases[0].assignment.worker.session_id)
  await wait(`document.querySelector('.kode-managed-session-banner')?.innerText.includes('返回任务工作过程')`)
  deniedRun=cases[0].run.id;await click('返回任务工作过程')
  await wait(`document.querySelector('.kode-managed-session-banner')?.innerText.includes('无法核对任务读取权限或归属')`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-run-detail')`),null)
  assert.match(await page.evaluate(`fixture.ctx.get('conversation').blocks.storeFor('${cases[0].assignment.worker.session_id}').getSnapshot().reason`),/只读/)
  await shot('managed-session-return-read-denied');deniedRun=null
  // Changing workspace while the fresh return GET is pending cannot reopen an old task.
  await openThread(cases[0]);await click('打开执行会话（只读）：'+cases[0].assignment.worker.session_id)
  await wait(`document.querySelector('.kode-managed-session-banner')?.innerText.includes('返回任务工作过程')`)
  delayRun=cases[0].run.id;await click('返回任务工作过程');await waitDelayed();await switchWorkspace('另一验证工作区');await releaseDelayed()
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-run-detail')`),null)
  await switchWorkspace('会话复用验证')
  // Changing a workspace invalidates a pending sidebar link without opening anything.
  // Focusing a project in the tree keeps the open panel (client-source.js focusWorkspace), so start from the channel, not a leftover Session.
  await collab();await click('复用测试频道');await wait(`fixture.selectedPanel()==='kode-discussions'&&!document.querySelector('[data-native-session]')`)
  delaySession=cases[0].assignment.worker.session_id
  await page.evaluate(`document.querySelector('[data-managed-session-id="${cases[0].assignment.worker.session_id}"]').click()`);await waitDelayed();await switchWorkspace('另一验证工作区');await releaseDelayed()
  assert.equal(await page.evaluate(`document.querySelector('[data-native-session]')`),null)
  assert.equal(await page.evaluate(`document.querySelectorAll('[data-managed-session-id]').length`),0)
  await switchWorkspace('会话复用验证')
  // Closing the discussion thread dismisses its pending link; it must not reopen a Session.
  await openThread(cases[0]);delaySession=cases[0].assignment.worker.session_id
  await click('打开执行会话（只读）：'+cases[0].assignment.worker.session_id);await waitDelayed()
  await page.evaluate(`document.querySelector('button[aria-label="关闭消息列"]').click()`);await releaseDelayed()
  assert.equal(await page.evaluate(`fixture.selectedPanel()`),'kode-discussions')
  assert.equal(await page.evaluate(`document.querySelector('.kode-discussion-detail')`),null)
  // A later discussion selection B wins while A's GET is still pending.
  await openThread(cases[0]);delaySession=cases[0].assignment.worker.session_id
  await click('打开执行会话（只读）：'+cases[0].assignment.worker.session_id);await waitDelayed();await openThread(cases[1])
  await click('打开执行会话（只读）：'+cases[1].assignment.worker.session_id)
  await wait(`document.querySelector('[data-native-session="${cases[1].assignment.worker.session_id}"]')`);await releaseDelayed()
  assert.equal(await page.evaluate(`document.querySelector('[data-native-session]')?.dataset.nativeSession`),cases[1].assignment.worker.session_id)
  // Closing native mainView while a return read is pending invalidates its source.
  await wait(`document.querySelector('.kode-managed-session-banner')?.innerText.includes('返回任务工作过程')`)
  delayRun=cases[1].run.id;await click('返回任务工作过程');await waitDelayed()
  await page.evaluate(`fixture.ctx.get('uiWorkspace').clearMain()`);await releaseDelayed()
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-run-detail')`),null)
  assert.equal(await page.evaluate(`document.querySelector('.kode-managed-session-banner')`),null)
  // A newer verified B source wins over A's late return, not just late opens.
  await openThread(cases[0]);await click('打开执行会话（只读）：'+cases[0].assignment.worker.session_id)
  await wait(`document.querySelector('.kode-managed-session-banner')?.innerText.includes('返回任务工作过程')`)
  delayRun=cases[0].run.id;await click('返回任务工作过程');await waitDelayed()
  await openThread(cases[1]);await click('打开执行会话（只读）：'+cases[1].assignment.worker.session_id)
  await wait(`document.querySelector('[data-native-session="${cases[1].assignment.worker.session_id}"]')`);await releaseDelayed()
  await click('返回任务工作过程')
  await wait(`document.querySelector('.kode-collab-run-detail[data-run-id="${cases[1].run.id}"]')?.innerText.includes('流程阶段')`)
  await shot('returned-existing-process-detail')
  assert.equal(await page.evaluate('fixture.created()'),0)
  assert.deepEqual(writes,[],'all navigation and cancellation review steps are reads only')
  assert.deepEqual(await Promise.all(cases.map(c=>call('work-runs/'+c.run.id))),baseline.runs)
  assert.deepEqual(await Promise.all(cases.map(c=>call('collaboration/tasks/'+c.task.id))),baseline.tasks)
  assert.deepEqual(await call('budgets/budget'),baseline.budget);assert.deepEqual(await call('teams/team/activation'),baseline.activation)
  assert.deepEqual(await page.evaluate('fixtureErrors'),[])
  // A Host change invalidates the transient link even when catalogue scopes are unchanged.
  await openThread(cases[0]);await click('打开执行会话（只读）：'+cases[0].assignment.worker.session_id)
  await wait(`document.querySelector('.kode-managed-session-banner')?.innerText.includes('返回任务工作过程')`)
  await page.evaluate(`(()=>{fixtureOwnerDirectory.current='remote';fixture.ctx.get('kodeWorkspaces').directory.publish({...fixtureOwnerDirectory})})()`)
  await wait(`!document.querySelector('.kode-managed-session-banner')?.innerText.includes('返回任务工作过程')`)
  await page.evaluate(`(()=>{fixtureOwnerDirectory.current='local';fixture.ctx.get('kodeWorkspaces').directory.publish({...fixtureOwnerDirectory})})()`)
  // Revoke the original source/archive audience in the real disposable Hub.
  // The generic Run remains readable, but must not substitute for its Task guard.
  await openThread(cases[0]);await click('打开执行会话（只读）：'+cases[0].assignment.worker.session_id)
  await wait(`document.querySelector('.kode-managed-session-banner')?.innerText.includes('返回任务工作过程')`)
  await call('collaboration/surfaces/channel',{request_id:'revoke-return-audience',expected_revision:1,scope,kind:'channel',title:'复用测试频道',team_ids:[team.id],enabled:false})
  await assert.rejects(call('collaboration/tasks/'+cases[0].task.id))
  assert.equal((await call('work-runs/'+cases[0].run.id)).id,cases[0].run.id)
  const afterRevoke=readPaths.length
  await click('返回任务工作过程')
  await wait(`document.querySelector('.kode-managed-session-banner')?.innerText.includes('无法核对任务读取权限或归属')`)
  assert.ok(readPaths.slice(afterRevoke).some(path=>path.endsWith('/collaboration/tasks/'+cases[0].task.id)))
  assert.equal(readPaths.slice(afterRevoke).some(path=>path.includes('/work-runs/')),false,'failed Task guard must prevent every subsequent Run read')
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-run-detail')`),null)
  assert.match(await page.evaluate(`fixture.ctx.get('conversation').blocks.storeFor('${cases[0].assignment.worker.session_id}').getSnapshot().reason`),/只读/)
  assert.deepEqual(writes,[]);assert.equal(await page.evaluate('fixture.created()'),0)
  await shot('managed-session-return-audience-revoked')
  if(process.env.KODE_TEST_SCREENSHOTS)await writeFile(join(process.env.KODE_TEST_SCREENSHOTS,'audience-guard-result.json'),JSON.stringify({realIsolatedHub:true,originalSourceAndArchiveDisabled:true,genericRunStillReadable:true,taskAudienceGuardReentered:true,subsequentRunReads:0,restoredOldDetails:false,nativeInputRemainsReadOnly:true,hostChangeClearsReturn:true,navigationWrites:writes.length},null,2))
  if(process.env.KODE_TEST_SCREENSHOTS)await writeFile(join(process.env.KODE_TEST_SCREENSHOTS,'result.json'),JSON.stringify({realIsolatedHub:true,controlledExistingSessionSnapshots:true,workerModelsStarted:0,nativeSessionCreates:0,navigationWrites:writes.length,taskRunAssignmentSeparation:true,unchangedTaskRunBudgetActivation:true,existingRunCancelReviewOnly:true,latestSidebarSelectionWins:true,workspaceChangeInvalidatesPendingOpen:true,discussionCloseInvalidatesPendingOpen:true,latestDiscussionSelectionWins:true,returnFromVerifiedSidebarDiscussionProcess:true,directNativeOpenHasNoReturn:true,deniedReadDoesNotRestoreOldDetails:true,workspaceChangeInvalidatesPendingReturn:true,nativeCloseInvalidatesPendingReturn:true,newerBSourceWinsLateAReturn:true},null,2))
 }finally{for(const resume of delayed.splice(0))resume();await browser?.close();if(server?.listening){server.closeAllConnections();await new Promise(r=>server.close(r))}await hub.close();await rm(profile,{recursive:true,force:true})}
})

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

test('real Rust Hub + owner facade + dsh UI: invite scoped team and navigate real builder', {skip:!process.env.KODE_TEST_BROWSER_BIN || !process.env.KODE_TEST_HUB_BIN,timeout:120000},async()=>{
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
  // team-two's members: one in this workspace, one only in another root (never an @ candidate here).
  const here={host_id:hub.node,workspace_id:w.id,root_ref:root},elsewhere={...here,root_ref:root+'-elsewhere'}
  const worker=(id,role,refs)=>({id,role,responsibilities:['Verify changes'],allowed_target_ids:['control'],required_capabilities:[],max_parallel:1,workspace_refs:refs})
  await call('teams',{id:'team-two',request_id:'create-two',expected_revision:0,spec:{...team.spec,name:'测试团队',workspace_refs:[here,elsewhere],workers:[worker('tester','Tester',[here]),worker('outside','Outside',[elsewhere])]}})
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
  const shot=async name=>{if(!output)return;await new Promise(r=>setTimeout(r,500));await mkdir(output,{recursive:true});await writeFile(join(output,name+'.png'),Buffer.from((await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'))}
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
  await page.evaluate(`document.querySelector('.kode-discussion-heading button[aria-label="邀请成员"]').click()`)
  await wait(`document.querySelector('select[aria-label="邀请的团队"]')`)
  assert.match(await page.evaluate(`document.querySelector('.kode-member-invite').innerText`),/邀请的单位是整个 Superagent 团队[\s\S]*全部成员都能看到[\s\S]*不授予执行权限/)
  await shot('invite-agent-modal')
  await page.evaluate(`(()=>{const e=document.querySelector('select[aria-label="邀请的团队"]');e.value='team-two';e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await click('确认添加到频道')
  await wait(`!document.querySelector('select[aria-label="邀请的团队"]')`)
  const changed=(await call('collaboration/surfaces?'+new URLSearchParams(scope))).items.find(x=>x.id==='development')
  assert.deepEqual(changed.team_ids,[team.id,'team-two']);assert.equal(changed.revision,2);assert.equal(changed.audience_revision,channel.audience_revision+1)
  // Invited members become structured @ candidates in the channel composer; @ only records the target.
  await wait(`Array.from(document.querySelector('select[aria-label="@ 成员"]')?.options??[]).some(o=>o.textContent==='@测试团队')`)
  assert.deepEqual(await page.evaluate(`Array.from(document.querySelector('select[aria-label="@ 成员"]').options).map(o=>o.textContent)`),['不 @ 成员，仅保存讨论','@Team','@测试团队','@测试团队 · Tester'])
  assert.match(await page.evaluate(`document.querySelector('.kode-discussion-native-composer small').textContent`),/不会自动回复/)
  // Sending with a member @: the durable mention is team + worker of the current revision; the result is stored, not run.
  await page.evaluate(`(()=>{const e=document.querySelector('select[aria-label="@ 成员"]');e.value=[...e.options].find(o=>o.textContent==='@测试团队 · Tester').value;e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await page.evaluate(`document.querySelector('.kode-discussion-native-composer textarea,.kode-discussion-native-composer [role=textbox]').focus()`);await page.call('Input.insertText',{text:'请 Tester 看一下边界用例。'})
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13})
  await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  await wait(`document.querySelector('.kode-discussion-timeline')?.innerText.includes('请 Tester 看一下边界用例。')`)
  const sent=(await call('collaboration/surfaces/development/threads')).items.map(x=>x.root).find(m=>m.content==='请 Tester 看一下边界用例。')
  assert.deepEqual(sent.mentions,[{team_id:'team-two',team_revision:1,worker_id:'tester'}])
  assert.notEqual(sent.delivery_state,'delivered');assert.doesNotMatch(await page.evaluate(`(()=>{let n=[...document.querySelectorAll('.kode-discussion-timeline *')].find(e=>e.childElementCount===0&&e.textContent==='请 Tester 看一下边界用例。');while(n&&!n.matches('article,[role=article],[data-message-id],li'))n=n.parentElement;return (n??document.querySelector('.kode-discussion-timeline')).innerText})()`),/已送达|执行中|已完成|已回复/)
  await wait(`[...document.querySelectorAll('.kode-discussion-timeline [data-mentions]')].some(e=>e.textContent==='@测试团队 · Tester · 已记录，暂不会自动回复')`)
  await shot('channel-member-mention-stored')
  await page.evaluate(`document.querySelector('.kode-discussion-heading button[aria-label="邀请成员"]').click()`)
  await wait(`document.querySelector('select[aria-label="邀请的团队"]')`)
  assert.equal(await page.evaluate(`document.querySelector('select[aria-label="邀请的团队"]').options.length`),1)
  await shot('invite-existing-member-excluded')
  await click('打开 Team Builder')
  await wait(`document.body.innerText.includes('Team Builder') && !document.querySelector('select[aria-label="邀请的团队"]') && !document.body.innerText.includes('暂时无法读取团队草案')`)
  await shot('builder-navigation')
 }finally{await browser?.close();if(server?.listening)await new Promise(r=>server.close(r));await hub.close();await rm(profile,{recursive:true,force:true})}
})

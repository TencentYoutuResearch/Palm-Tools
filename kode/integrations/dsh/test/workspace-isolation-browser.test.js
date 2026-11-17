/** Real persisted Hub catalog/conversations + current scope adapter and retained native manager.
 * Native session execution/controller transport remains a controlled fixture; no model inference here. */
import test from 'node:test'
import {build} from 'esbuild'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtemp,rm,writeFile,mkdir,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {isolatedHub} from './support/isolated-hub.js'
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
// Test-only in-memory module; never overwrite the running product bundle.
const bundle=await build({entryPoints:['packages/collab/client-source.js'],bundle:true,loader:{'.png':'dataurl'},format:'cjs',platform:'browser',external:['react','react-dom','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-primitives','@kode/dsh-composer'],write:false})
const client=process.env.KODE_TEST_SHIPPED_COLLAB==='1'?await readFile(new URL('../packages/collab/client.js',import.meta.url),'utf8'):`window.__ModuleLoader__.load({id:'@kode/dsh-collab',factory(require){const module={exports:{}},exports=module.exports;${bundle.outputFiles[0].text};return module.exports}})`

test('registered workspace scopes isolate UI, drafts, tasks and resources across Hub/browser restarts',{
 skip:!process.env.KODE_TEST_BROWSER_BIN||!process.env.KODE_TEST_BACKEND_URL,timeout:60000,
},async()=>{
 const hub=await isolatedHub('workspace-isolation'),profile=await mkdtemp(join(tmpdir(),'kode-workspace-scope-'))
 let browser,server
 const call=(p,b)=>hub.client.call('/api/v1/messaging/'+p,b)
 try{
  const roots=await Promise.all([versionedProject(hub.root),versionedProject(hub.root)])
  for(const root of roots)await call('workbench/workspaces',{action:'create',path:root,title:'项目同名'})
  const catalog=await call('workbench/workspaces'),a=catalog.workspaces.find(w=>w.path===roots[0]),b=catalog.workspaces.find(w=>w.path===roots[1])
  assert.ok(a&&b&&a.id!==b.id)
  const scope=w=>({host_id:hub.node,workspace_id:w.id,root_ref:w.path})
  const team=await conversationTeam(hub,{workspace:scope(a)})
  const other=await call('teams',{id:'other',request_id:'create',expected_revision:0,spec:{...team.spec,name:'B 项目团队',workspace_refs:[scope(b)],execution_targets:[],workers:[],coordinator_targets:[],workflow_pack_refs:[],delivery_bindings:[],grant_id:null,budget_policy_id:null,scheduling_policy_id:null}})
  const channels=[]
  for(const [workspace,owner,label] of [[a,team,'A'],[b,other,'B']]){
   const channel=await call('collaboration/surfaces/channel-'+label,{request_id:'create-channel-'+label,expected_revision:0,scope:{home_hub:hub.node,...scope(workspace)},kind:'channel',title:'同名频道',team_ids:[owner.id],enabled:true})
   await call('collaboration/surfaces/'+channel.id+'/messages',{request_id:'channel-message-'+label,expected_revision:channel.revision,content:label+' 频道独有记录',mentions:[]})
   channels.push(channel)
  }
  const workspaces=catalog.workspaces.map(w=>({workspaceId:w.id,title:w.title,path:w.path,sessionIds:[],createdAt:w.created_at??new Date().toISOString()}))
  const routes=new Map(),ctx={webServer:{register:route=>routes.set(route.path,route)},connection:{admit:req=>req.headers['x-fixture-owner']==='yes'?{peer:{principal:{kind:'owner'}}}:{rejection:401}}}
  for(const register of [registerCollaboration,registerCollabTeams,registerCollabRuns,registerConversation,registerConversationRead,registerCollabBudgets,registerWorkRun])register(ctx,{backendClient:{call:(p,b)=>hub.client.call(p,b)}})
  server=createServer(async(req,res)=>{try{if(req.url==='/fixture-collab.js'){res.setHeader('content-type','text/javascript');res.end(client);return}const route=routes.get(new URL(req.url,'http://localhost').pathname);if(route)return await route.handler(req,res);if(await collabRenderPage(req,res,{workspaces}))return;res.writeHead(404);res.end('{}')}catch{if(!res.headersSent)res.writeHead(500);res.end('{}')}})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile)
  let page=await browser.page(`http://127.0.0.1:${server.address().port}`)
  const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+15000;while(Date.now()<end){if(${expr})return true;await new Promise(r=>setTimeout(r,25))}throw Error('Scope UI timeout: '+JSON.stringify({waitingFor:${JSON.stringify(expr)},body:document.body.innerText,scope:document.querySelector('[data-current-workspace-scope]')?.dataset.currentWorkspaceScope,switchDisabled:document.querySelector('.kode-scoped-workspace-switch')?.disabled,errors:fixtureErrors}))})()`)
  const enterCollaboration=async()=>{await wait(`document.querySelector('.kode-collab-mode-switch button')`);if(await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').getAttribute('aria-label').includes('会话')`)){await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`);await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('协作'))`);await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('协作')).click()`)}}
  const group=id=>`.kode-scoped-content[data-current-workspace-scope*='${id}']`
  const chooseWorkspace=async id=>{
   // Fixture mount precedes the async Hub catalog. A real user cannot click the
   // disabled switch, and clicking it programmatically would silently do nothing.
   await wait(`document.querySelector('.kode-scoped-workspace-switch')?.disabled===false&&document.querySelector('[data-current-workspace-scope]')`)
   if(await page.evaluate(`!!document.querySelector(${JSON.stringify(group(id))})`))return
   const workspace=catalog.workspaces.find(w=>w.id===id);assert.ok(workspace)
   await page.evaluate(`document.querySelector('.kode-scoped-workspace-switch').click()`)
   const matching=`Array.from(document.querySelectorAll('[role=menuitem]')).filter(n=>n.textContent.includes(${JSON.stringify(workspace.path)}))`
   await wait(`${matching}.length===1`)
   await page.evaluate(`${matching}[0].click()`)
   await wait(`document.querySelector(${JSON.stringify(group(id))})&&!document.querySelector('[role=menu]')`)
  }
  const clickTeam=async(id,name)=>{await chooseWorkspace(id);await wait(`Array.from(document.querySelectorAll(${JSON.stringify(group(id)+' [data-sidebar-row=team] [data-row-title]')})).some(n=>n.textContent===${JSON.stringify(name)})`);await page.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(group(id)+' [data-sidebar-row=team] [data-row-title]')})).find(n=>n.textContent===${JSON.stringify(name)}).click()`);await wait(`document.querySelector('.kode-collab-header h1')?.textContent===${JSON.stringify(name)}&&document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]')`)
  }
  await wait('globalThis.fixture');await enterCollaboration()
  await clickTeam(a.id,'Team')
  assert.equal(await page.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(group(a.id)+' [data-sidebar-row=team] [data-row-title]')})).some(n=>n.textContent==='B 项目团队')`),false)
  assert.equal(await page.evaluate(`document.querySelectorAll('[data-current-workspace-scope]').length`),1)
  assert.equal(await page.evaluate(`document.querySelectorAll('[data-sidebar-section=apps]').length`),0)
  // Both projects deliberately have the same channel title. Navigation must bind
  // the registered tuple and surface identity, never title-based legacy search.
  const clickChannel=async(id,label)=>{
   await chooseWorkspace(id)
   const row=group(id)+' [data-sidebar-section=channels] :is([data-sidebar-row=channel],[data-sidebar-row=dm]) [data-row-title]'
   await wait(`document.querySelector(${JSON.stringify(row)})?.textContent==='同名频道'`)
   await page.evaluate(`document.querySelector(${JSON.stringify(row)}).click()`)
   await wait(`document.querySelector('.kode-discussion-messages')?.innerText.includes(${JSON.stringify(label+' 频道独有记录')})`)
   assert.equal(await page.evaluate(`document.querySelector('.kode-discussion-messages').innerText.includes(${JSON.stringify((label==='A'?'B':'A')+' 频道独有记录')})`),false)
   assert.equal(await wait(`document.querySelector(${JSON.stringify(row)})?.getAttribute('aria-current')==='page'`),true,'the exact scoped channel is selected after directory refresh')
  }
  await clickChannel(a.id,'A')
  await page.evaluate(`document.querySelector(${JSON.stringify(group(a.id)+' [data-sidebar-section=channels] summary')}).click()`)
  await wait(`!document.querySelector(${JSON.stringify(group(a.id)+' [data-sidebar-section=channels]')}).open`)
  // Full native management is a single retained component. Its route preserves
  // scope, channel selection, disclosure state, and the original native store.
  await page.evaluate(`window.keptNative=document.querySelector('.fixture-native-workspaces');window.keptStore=fixture.nativeWorkspaceEntry.store.create();document.querySelector('button[aria-label="原生会话管理"]').click()`)
  await wait(`keptNative.getBoundingClientRect().height>0`)
  assert.equal(await page.evaluate(`keptNative.innerText.includes('项目同名')`),true)
  assert.equal(await page.evaluate(`document.querySelectorAll('.kode-collab-mode-switch').length`),1,'one native-shell route back to collaboration')
  await enterCollaboration()
  await wait(`document.querySelector(${JSON.stringify(group(a.id))})&&document.querySelector('.kode-discussion-messages')?.innerText.includes('A 频道独有记录')`)
  assert.equal(await page.evaluate(`keptNative===document.querySelector('.fixture-native-workspaces')&&keptStore===fixture.nativeWorkspaceEntry.store.create()`),true)
  assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(group(a.id)+' [data-sidebar-section=channels]')}).open`),false,'native management retains the current scope disclosure')
  await page.evaluate(`document.querySelector(${JSON.stringify(group(a.id)+' [data-sidebar-section=channels] summary')}).click()`)
  await wait(`document.querySelector(${JSON.stringify(group(a.id)+' [data-sidebar-section=channels]')}).open`)
  await clickTeam(a.id,'Team')

  await page.evaluate(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]').focus()`);await page.call('Input.insertText',{text:'帮我检查这个项目的会话恢复，先保留一份可核对的记录。'})
  await page.evaluate(`(()=>{const button=document.querySelector('.kode-collab-composer button[aria-label="发送"]');button.click();button.click()})()`)
  // Accepted sends are concise in the DM view; verify the rendered record and
  // cleared original draft, then check the actual persisted Hub receipt.
  await wait(`document.querySelector('.kode-collab-message')?.innerText.includes('帮我检查这个项目的会话恢复，先保留一份可核对的记录。')&&document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]')?.textContent===''`)
  const messages=await call(`conversations/${team.conversation_id}/messages`)
  assert.equal(messages.items.length,1,'double click sends one persisted human input')
  assert.equal(messages.items[0].state,'accepted')
  assert.equal(messages.items[0].actor.kind,'human')
  assert.equal(messages.items[0].content,'帮我检查这个项目的会话恢复，先保留一份可核对的记录。')
  await call('work-runs',{id:'scope-run',request_id:'scope-run',team_id:team.id,team_revision:team.revision,binding_id:'local',inputs:{request:'A 项目独有任务'},prior_run_id:null})
  await page.evaluate(`document.querySelector('button[aria-label="工作过程"]').click()`)
  await wait(`document.querySelector('.kode-collab-process').innerText.includes('A 项目独有任务')`)
  await page.evaluate(`document.querySelector('.kode-collab-run button[aria-label="查看详情"]').click()`)
  await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='取消任务')`)
  await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='取消任务').click()`)
  await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='确认请求取消').click()`)
  await wait(`document.querySelector('.kode-collab-run-cancel')?.innerText.includes('已请求取消')`)
  assert.equal((await call('work-runs/scope-run')).state,'cancelling')

  // The responsive execution inspector takes over the narrow pane. Close it
  // through its real control before typing into the native editor.
  await page.evaluate(`document.querySelector('button[aria-label="关闭执行详情"]').click()`)
  await wait(`!document.querySelector('.kode-collab-inspector')`)
  await page.evaluate(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]').focus()`);await page.call('Input.insertText',{text:'A 项目的未发草稿'})
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]').textContent`),'A 项目的未发草稿','the native editor actually receives the input before changing workspace')
  await chooseWorkspace(b.id)
  await wait(`!document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]')`)
  assert.equal(await page.evaluate(`document.querySelectorAll('[data-current-workspace-scope]').length`),1)
  assert.equal(await page.evaluate(`!!document.querySelector(${JSON.stringify(group(a.id))})`),false,'the previous workspace groups are unmounted')
  await clickChannel(b.id,'B')
  await clickTeam(b.id,'B 项目团队')
  assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('[data-current-workspace-scope] [data-sidebar-row=team] [data-row-title]')).some(n=>n.textContent==='Team')`),false)
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]').textContent`),'')
  await page.evaluate(`document.querySelector('button[aria-label="工作过程"]').click()`)
  await wait(`document.querySelector('.kode-collab-process')?.innerText.includes('还没有任务')`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-process').innerText.includes('A 项目独有任务')`),false)

  await page.evaluate(`document.querySelector('button[aria-label="关闭执行详情"]').click()`)
  await wait(`!document.querySelector('.kode-collab-inspector')`)
  // No budget entry for now (owner decision): nothing of A's budget can surface in B's DM.
  assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('button')).some(b=>/预算/.test(b.textContent+(b.getAttribute('aria-label')??'')))`),false,'no budget entry in B')
  await page.evaluate(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]').focus()`);await page.call('Input.insertText',{text:'B 项目的未发草稿'})
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]').textContent`),'B 项目的未发草稿','the second workspace editor actually receives the input')
  await clickTeam(a.id,'Team')
  await wait(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]')?.textContent==='A 项目的未发草稿'`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]').textContent`),'A 项目的未发草稿')
  await hub.stop();await hub.start()
  await browser.close();browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);page=await browser.page(`http://127.0.0.1:${server.address().port}`)
  await wait(`globalThis.fixture&&document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]')`)
  await wait(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]')?.textContent==='A 项目的未发草稿'`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]').textContent`),'A 项目的未发草稿')
  assert.equal((await call(`conversations/${team.conversation_id}/messages`)).items.length,1)
  assert.equal((await call(`conversations/${other.conversation_id}/messages`)).items.length,0)
  await clickTeam(b.id,'B 项目团队')
  await wait(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]')?.textContent==='B 项目的未发草稿'`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]').textContent`),'B 项目的未发草稿')
  const durable=await call('workbench/workspaces');assert.equal(durable.workspaces.length,2)
  for(const channel of channels){const restored=await call('collaboration/surfaces?'+new URLSearchParams(channel.scope));assert.deepEqual(restored.items.map(s=>s.id),[channel.id]);assert.equal((await call('collaboration/surfaces/'+channel.id+'/messages')).items.length,1)}
  await clickChannel(a.id,'A');await clickChannel(b.id,'B')
  await clickTeam(b.id,'B 项目团队')
  await wait(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]')?.textContent==='B 项目的未发草稿'`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]').textContent`),'B 项目的未发草稿')
  assert.equal(await page.evaluate('fixture.created()'),0)
  assert.deepEqual(await page.evaluate('fixtureErrors'),[])
  if(process.env.KODE_WORKSPACE_SCREENSHOT_DIR){
   const out=process.env.KODE_WORKSPACE_SCREENSHOT_DIR;await mkdir(out,{recursive:true})
   await clickTeam(a.id,'Team')
   // Snapshot-only Session data exercises the scope adaptation; the original manager remains mounted, and Session lifecycle is deliberately not simulated.
   await page.evaluate(`(()=>{const s=fixture.workspaceData.sessions,at=Date.now()-60000;const rows=${JSON.stringify([{id:'snapshot-a',cwd:a.path,title:'测试会话 A（快照）',workspace:a.id},{id:'snapshot-b',cwd:b.path,title:'测试会话 B（快照）',workspace:b.id}])};s.publish({...s.getSnapshot(),ids:rows.map(v=>v.id),byId:Object.fromEntries(rows.map(v=>[v.id,{...v,displayTitle:v.title,createdAt:new Date(at).toISOString(),updatedAt:at,blank:false,running:false,runningSubagentCount:0,retainedBy:{},projectionValues:{}}]))});const w=fixture.workspaceData.workspaces;w.publish({...w.getSnapshot(),items:w.getSnapshot().items.map(v=>({...v,sessionIds:rows.filter(r=>r.workspace===v.workspaceId).map(r=>r.id)}))})})()`)
   await wait(`document.querySelector('[data-adapted-session-id="snapshot-a"]')`)
   await page.evaluate(`(()=>{const el=document.createElement('div');el.id='scope-caption';el.textContent='临时登记工作区 · 真实 Hub / 原生组件 · 测试外壳';Object.assign(el.style,{position:'fixed',right:'6px',bottom:'2px',background:'#303038',color:'#fff',padding:'3px 6px',fontSize:'10px',borderRadius:'4px',zIndex:99999,pointerEvents:'none'});document.body.append(el)})()`)
   const metrics=[]
   const shot=async(name,width,dark,{sidebar=false,chat=false}={})=>{
    await page.call('Emulation.setDeviceMetricsOverride',{width,height:width<640?844:900,deviceScaleFactor:1,mobile:width<640})
    await page.evaluate(`(()=>{document.body.toggleAttribute('data-ds-dark-theme',${dark});const f=document.getElementById('fixture-frame');f.firstElementChild.style.display=${JSON.stringify(chat?'none':'')};f.style.gridTemplateColumns=${JSON.stringify(chat?'minmax(0,1fr)':'260px minmax(0,1fr)')};document.body.style.colorScheme=${JSON.stringify(dark?'dark':'light')}})()`)
    await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:width-3,y:2})
    await page.evaluate(`new Promise(r=>setTimeout(r,250))`)
    const geometry=await page.evaluate(`({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,groups:document.querySelectorAll('[data-current-workspace-scope]').length,applications:document.querySelectorAll('[data-sidebar-section=apps]').length,errors:fixtureErrors})`)
    assert.equal(geometry.overflow,false);assert.equal(geometry.groups,1);assert.deepEqual(geometry.errors,[])
    const image=await page.call('Page.captureScreenshot',{format:'png',...(sidebar?{clip:{x:0,y:0,width:260,height:844,scale:1}}:{})})
    await writeFile(join(out,name+'.png'),Buffer.from(image.data,'base64'));metrics.push({name,...geometry,sidebar_crop:sidebar})
   }
   await shot('desktop-light',1440,false);await shot('desktop-dark',1440,true)
   await shot('narrow-sidebar-dark',390,true,{sidebar:true});await shot('narrow-chat-light',390,false,{chat:true})
   await page.evaluate(`document.querySelector('button[aria-label="工作过程"]').click()`)
   await wait(`document.querySelector('.kode-collab-run')`)
   await page.evaluate(`document.querySelector('.kode-collab-run button[aria-label="查看详情"]').click()`)
   await wait(`document.querySelector('.kode-collab-run-cancel')`)
   await shot('cancelling-desktop',1440,false)
   await writeFile(join(out,'metrics.json'),JSON.stringify(metrics,null,2))
  }
  if(process.env.KODE_WORKSPACE_SCREENSHOT){const shot=await page.call('Page.captureScreenshot',{format:'png'});await writeFile(process.env.KODE_WORKSPACE_SCREENSHOT,Buffer.from(shot.data,'base64'))}
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await hub.close();await rm(profile,{recursive:true,force:true})}
})

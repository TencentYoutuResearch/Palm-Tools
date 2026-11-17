/** The 协作 sidebar is the native workspace tree: projects → 频道/私信/会话, every row on the
 * ui-workspace row anatomy with hover-only actions. Real Chrome over the released client
 * Session stack with the pinned right Sidebar; only Remote RPC and Kode HTTP routes are
 * fixtures. No model, Hub or microphone runs, and nothing is written. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {collabRenderPage} from './support/collab-render-page.js'
import {headlessBrowser} from './support/headless-browser.js'

const SID='native-tree-session',home='home'
const bundle=await build({entryPoints:['packages/collab/client-source.js'],bundle:true,loader:{'.png':'dataurl'},format:'cjs',platform:'browser',external:['react','react-dom','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-primitives','@kode/dsh-composer'],write:false})
const client=`window.__ModuleLoader__.load({id:'@kode/dsh-collab',factory(require){const module={exports:{}},exports=module.exports;${bundle.outputFiles[0].text};return module.exports}})`
const ref={host_id:home,workspace_id:'ws-fixture',root_ref:'/fixture/project'}
const contact={preference:{revision:0,pinned:false,archived:false,archived_through_sequence:0},archived:false,needs_attention:false,latest_sequence:1,unread_count:0,last_activity_at:0,attention:{decisions:0,resources:0,stopping:0,active_runs:0}}
const teamOf=(id,name,conversation,unread=0)=>({id,home_hub:home,revision:2,superagent_id:'super-'+id,conversation_id:conversation,contact:{...contact,unread_count:unread},
 spec:{name,kind:'coordinator',purpose:name==='评审团队'?'代码评审与回归':'发布与灰度',workers:[],workspace_refs:[ref],coordinator_targets:['control'],execution_targets:[{id:'control',host_id:home,executor_profile_id:'codex',provider_id:'openai',model_id:'gpt-6.1-sol',effort:'high'}]}})
const teams=[teamOf('team-a','评审团队','dm-a'),teamOf('team-b','发布团队','dm-b',3)]

test('协作 sidebar is the native project tree with hover-only row actions, settings entries and native creation',{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:120000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'kode-native-tree-'));let server,browser
 const writes=[]
 const send=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value))}
 try{
  server=createServer(async(req,res)=>{
   const url=new URL(req.url,'http://localhost'),q=key=>url.searchParams.get(key)
   if(url.pathname==='/fixture-collab.js'){res.setHeader('content-type','text/javascript');res.end(client);return}
   if(await collabRenderPage(req,res,{settings:true,workspaces:[{workspaceId:'ws-fixture',title:'Kode',path:'/fixture/project',sessionIds:[SID],createdAt:'2026-11-10T00:00:00.000Z'},
     {workspaceId:'ws-palm',title:'Palm Device',path:'/fixture/palm',sessionIds:[],createdAt:'2026-11-10T00:00:00.000Z'}],
    nativeSession:{id:SID,cwd:'/fixture/project',createdAt:Date.now()-3*3600e3,updatedAt:Date.now()-3*3600e3,realSidebarRight:true,
     modelCatalog:{default:{provider:'tclaude',model:'opus-5.5'},routableProviders:['tclaude'],groups:[{id:'tclaude',name:'tclaude',models:[{id:'opus-5.5',name:'Opus 5.5'}]}],failures:[]},
     projections:{modelSelection:{lastUsed:null,next:{provider:'tclaude',model:'opus-5.5'}}}}}))return
   if(req.method!=='GET'){writes.push(req.method+' '+url.pathname);return send(res,{error:'此隔离测试不接受写入'},503)}
   const team=teams.find(row=>row.id===q('team_id'))
   if(url.pathname==='/api/kode/collaboration'&&q('path')==='surfaces'){const scope=Object.fromEntries(['home_hub','host_id','workspace_id','root_ref'].map(key=>[key,q(key)]))
    return send(res,{scope,items:scope.workspace_id==='ws-fixture'?[{id:'s-review',kind:'channel',enabled:true,title:'需求评审',scope,team_ids:['team-a'],revision:1},{id:'s-release',kind:'channel',enabled:true,title:'发布节奏',scope,team_ids:['team-b'],revision:1}]:[]})}
   if(url.pathname==='/api/kode/collab/teams')return send(res,team?{projection:'configuration_revision',team}
    :{home_hub:home,projection:'contact_directory',archived:q('archived')==='true',order:'pinned_attention_unread_recent',items:q('archived')==='true'?[]:teams,next_cursor:null})
   if(url.pathname==='/api/kode/conversation/messages'){const row=teams.find(t=>t.conversation_id===q('conversation_id'))??team;return send(res,{home_hub:home,team_id:row.id,conversation_id:row.conversation_id,items:[],has_more:false,next_cursor:null})}
   if(url.pathname==='/api/kode/conversation/read-state'){const row=teams.find(t=>t.conversation_id===q('conversation_id'))??team;return send(res,{home_hub:home,team_id:row.id,conversation_id:row.conversation_id,principal_id:'local_owner',through_sequence:0,latest_sequence:row.contact.unread_count,unread_count:row.contact.unread_count})}
   if(url.pathname==='/api/kode/collab/runs')return send(res,{home_hub:home,team_id:q('team_id'),items:[],next_cursor:null})
   if(url.pathname==='/api/kode/avatars')return send(res,{avatars:[]})
   if(url.pathname==='/api/kode/collab/appearance')return send(res,{team_id:q('team_id'),home_hub:home,superagent_id:q('superagent_id'),profile:{id:'im',name:'团队',type:'custom',avatar:{id:null,url:null}}})
   if(url.pathname==='/api/kode/agents')return send(res,{profiles:[{id:'tclaude',name:'tclaude',type:'claude',origin:'builtin'}],selectedProfileId:'tclaude',supportedTypes:['claude'],models:[{id:'opus-5.5',name:'Opus 5.5'}],defaultModelSelection:{model:'opus-5.5'}})
   send(res,{error:'此隔离测试未启用该服务'},503)
  });server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);const page=await browser.page(`http://127.0.0.1:${server.address().port}`)
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
  const wait=(expr,ms=12000)=>page.evaluate(`(async()=>{const end=Date.now()+${ms};while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,25))}throw Error('native tree timeout: '+${JSON.stringify(expr)}+' '+JSON.stringify({errors:window.fixtureErrors,console:window.consoleErrors?.slice(-6),side:document.querySelector('.kode-scoped-workspace-sidebar')?.innerText.slice(0,600)}))})()`)
  const dir=process.env.KODE_ARTIFACT_DIR??'/tmp/kode-orbit-shots';await mkdir(dir,{recursive:true})
  const shot=async(name,clip)=>writeFile(join(dir,name),Buffer.from((await page.call('Page.captureScreenshot',{format:'png',...(clip?{clip:{...clip,scale:2}}:{})})).data,'base64'))
  const sideClip={x:0,y:0,width:300,height:640}
  const hover=async selector=>{const box=await page.evaluate(`(()=>{const r=${selector}.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:box.x,y:box.y})}
  let R,L
  const actionsShown=selector=>page.evaluate(`getComputedStyle(${selector}.querySelector('.${R}rowActions')).display!=='none'`)
  const row=(kind,title)=>`Array.from(document.querySelectorAll('[data-sidebar-row=${kind}]')).find(r=>r.querySelector('[data-row-title]')?.textContent===${JSON.stringify(title)})`
  const menuItem=label=>`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes(${JSON.stringify(label)}))`
  const bar=`document.querySelector('[data-fixture-native-rightbar]')`,surface=`document.querySelector('[data-sidebar-right-session^="host:kode-collab/"]')`

  await wait(`window.fixture&&document.querySelector('.kode-collab-mode-switch button')`)
  // Native class prefixes of the ui-workspace build this page actually loaded (they change per build).
  const prefix=(tag,anchor)=>page.evaluate(`/\\.([A-Za-z0-9-]+_)${anchor}\\b/.exec(document.querySelector('style[data-plugin-css="@deepseek-ai/dsh-client-ui-workspace/${tag}"]').textContent)[1]`)
  R=await prefix('Rows.module.css','sessionRow');L=await prefix('WorkspaceBrowser.module.css','groupSection')
  if(await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').getAttribute('aria-label').includes('会话')`)){
   await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`)
   await wait(menuItem('协作'))
   await page.evaluate(`${menuItem('协作')}.click()`)
  }
  await page.evaluate(`fixture.ctx.get('kodeSettings').open=section=>{window.openedSettings=section}`)
  // Projects: the native workspace header and one native project row per registered workspace.
  await wait(`${row('team','评审团队')}&&${row('channel','需求评审')}&&document.querySelector('[data-sidebar-row=session]')`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-scoped-workspace-sidebar .${L}sectionHeader .${L}sectionLabel').textContent`),'工作区')
  assert.deepEqual(await page.evaluate(`Array.from(document.querySelectorAll('.kode-scoped-tree .${R}projectRow[role=treeitem][data-row-key^="workspace:"]')).map(r=>r.textContent)`),['Kode','Palm Device'])
  assert.deepEqual(await page.evaluate(`Array.from(document.querySelectorAll('[data-project-scope] [data-sidebar-section]')).map(d=>d.dataset.sidebarSection)`),['channels','direct','sessions'],'only the current project is expanded by default')
  // Every leaf is a native session row; actions are hidden until hover.
  assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('[data-sidebar-row]')).every(r=>r.classList.contains('${R}sessionRow'))`),true)
  assert.equal(await actionsShown(row('team','评审团队')),false,'no actions at rest')
  assert.match(await page.evaluate(`${row('team','发布团队')}.querySelector('.${R}time').textContent`),/^3$/,'unread count in the trailing slot')
  assert.match(await page.evaluate(`document.querySelector('[data-sidebar-row=session] .${R}time').textContent`),/3小时/)
  await shot('native-tree-rest.png',sideClip)

  // Hover a Team DM row: SuperAgent 设置, 归档 and 置顶 appear on the row, like a Session row.
  await hover(row('team','评审团队'))
  assert.equal(await actionsShown(row('team','评审团队')),true)
  assert.deepEqual(await page.evaluate(`Array.from(${row('team','评审团队')}.querySelectorAll('.${R}rowActions button')).map(b=>b.getAttribute('aria-label'))`),['评审团队 操作','SuperAgent 设置','归档','置顶'])
  await shot('native-tree-team-hover.png',sideClip)
  // Its settings action opens that team's settings tab in the native right Sidebar.
  await page.evaluate(`${row('team','评审团队')}.querySelector('button[aria-label="SuperAgent 设置"]').click()`)
  await wait(`${surface}?.getAttribute('data-sidebar-right-session')==='host:kode-collab/team/home/team-a'&&${surface}.hasAttribute('data-sidebar-right-open')&&${bar}.querySelector('.kode-superagent-settings-tab')`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-header h1')?.textContent`),'评审团队')
  await shot('native-tree-team-settings-1440.png')

  // Team Builder row: hover gear opens Builder settings, even with no draft.
  await hover(row('builder','Team Builder'))
  assert.deepEqual(await page.evaluate(`Array.from(${row('builder','Team Builder')}.querySelectorAll('.${R}rowActions button')).map(b=>b.getAttribute('aria-label'))`),['Team Builder 设置'])
  await page.evaluate(`${row('builder','Team Builder')}.querySelector('button[aria-label="Team Builder 设置"]').click()`)
  await wait(`${surface}?.getAttribute('data-sidebar-right-session')==='host:kode-collab/builder/home'&&${surface}.hasAttribute('data-sidebar-right-open')&&${bar}.querySelector('[aria-label="规划 Agent 与模型"]')`)

  // Project "…": 协作设置 opens the collaboration settings section, not session mode.
  const project=`document.querySelector('[data-project-scope] [data-row-key^="workspace:"]')`
  await hover(project)
  assert.equal(await actionsShown(project),true)
  await page.evaluate(`${project}.querySelector('button[aria-label^="项目操作"]').click()`)
  await wait(`${menuItem('协作设置')}&&${menuItem('在会话模式中管理')}`)
  await shot('native-tree-project-menu.png',sideClip)
  await page.evaluate(`${menuItem('协作设置')}.click()`)
  await wait(`window.openedSettings==='collaboration'`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-mode-switch button')?.getAttribute('aria-label')?.includes('会话')??false`),false,'still in 协作 mode')

  // Channels: local pin moves the row first with the native pin indicator; archive hides it behind 已归档.
  await hover(row('channel','发布节奏'))
  await page.evaluate(`${row('channel','发布节奏')}.querySelector('button[aria-label="置顶"]').click()`)
  await wait(`document.querySelector('[data-sidebar-row=channel] [data-row-title]').textContent==='发布节奏'&&${row('channel','发布节奏')}.querySelector('.${R}pinIndicator')`)
  await hover(row('channel','需求评审'))
  await page.evaluate(`${row('channel','需求评审')}.querySelector('button[aria-label="归档"]').click()`)
  await wait(`!${row('channel','需求评审')}&&Array.from(document.querySelectorAll('.${L}sessionOverflowButton')).some(b=>b.textContent==='已归档 1')`)
  await shot('native-tree-channel-pinned.png',sideClip)

  // Channel creation: native Modal, name + one team of this project as a choice list.
  await hover(`document.querySelector('[data-sidebar-section=channels]>summary')`)
  await page.evaluate(`document.querySelector('[data-sidebar-section=channels]>summary button[aria-label="新建频道"]').click()`)
  await wait(`document.querySelector('.kode-surface-create [role=radiogroup]')`)
  assert.deepEqual(await page.evaluate(`Array.from(document.querySelectorAll('.kode-surface-create-team strong')).map(n=>n.textContent)`),['评审团队','发布团队'])
  assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='创建').disabled`),true)
  await page.evaluate(`document.querySelectorAll('.kode-surface-create-team input')[0].click()`)
  // Screenshot only after the native Modal's enter animation settles and the panel is fully opaque.
  await wait(`document.getAnimations().every(a=>a.playState!=='running')`)
  assert.deepEqual(await page.evaluate(`(()=>{const d=document.querySelector('.kode-surface-create');const chain=[];for(let n=d;n&&n!==document.body;n=n.parentElement)chain.push(Number(getComputedStyle(n).opacity));const bg=getComputedStyle(d.closest('[role=dialog]')??d).backgroundColor;return {opaque:chain.every(o=>o===1),bg:!/rgba\\(.*,\\s*0\\)$|transparent/.test(bg)}})()`),{opaque:true,bg:true},'the dialog is fully opaque, not mid-animation')
  await shot('native-tree-create-channel-1440.png')
  await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='取消').click()`)
  await wait(`!document.querySelector('.kode-surface-create')`)

  // Another project: expand it and act inside; it becomes the current project.
  const palm=`Array.from(document.querySelectorAll('.kode-scoped-tree .${R}projectRow[data-row-key^="workspace:"]')).find(r=>r.textContent==='Palm Device')`
  await page.evaluate(`${palm}.click()`)
  await wait(`document.querySelectorAll('[data-project-scope] .kode-scoped-content').length===2`)
  await page.evaluate(`document.querySelectorAll('[data-project-scope]')[1].querySelector('[data-sidebar-row=builder]').click()`)
  await wait(`document.querySelectorAll('[data-project-scope]')[1].querySelector('.${R}folderActive')`)
  assert.equal(await page.evaluate(`document.querySelectorAll('[data-project-scope] .kode-scoped-content').length`),2,'the earlier project stays expanded')
  assert.equal(await page.evaluate(`document.querySelectorAll('[data-sidebar-row=builder][aria-selected=true]').length`),1,'Team Builder is highlighted once, in the current project')
  await shot('native-tree-two-projects.png',sideClip)

  assert.deepEqual(writes,[],'no writes')
  assert.deepEqual(await page.evaluate(`nativeWire.prompts`),[])
  assert.deepEqual(await page.evaluate(`window.fixtureErrors`),[])
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await rm(profile,{recursive:true,force:true})}
})

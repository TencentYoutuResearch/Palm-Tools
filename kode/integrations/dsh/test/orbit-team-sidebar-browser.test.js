/** Orbit's right Sidebar is the native ui-sidebar-right tab framework (pinned panel-host
 * patch, built by the production build function), hosted by the kode-collab main panel
 * for a real team scope. Released client Session stack; only Remote RPC and the Kode
 * HTTP routes are fixtures. No model, Hub or microphone runs. */
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

const SID='native-orbit-session',home='home'
const bundle=await build({entryPoints:['packages/collab/client-source.js'],bundle:true,loader:{'.png':'dataurl'},format:'cjs',platform:'browser',external:['react','react-dom','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-primitives','@kode/dsh-composer'],write:false})
const client=`window.__ModuleLoader__.load({id:'@kode/dsh-collab',factory(require){const module={exports:{}},exports=module.exports;${bundle.outputFiles[0].text};return module.exports}})`
const ref={host_id:home,workspace_id:'ws-fixture',root_ref:'/fixture/project'}
const contact={preference:{revision:0,pinned:false,archived:false,archived_through_sequence:0},archived:false,needs_attention:false,latest_sequence:1,unread_count:0,last_activity_at:0,attention:{decisions:0,resources:0,stopping:0,active_runs:0}}
const teamOf=(id,name,conversation)=>({id,home_hub:home,revision:2,superagent_id:'super-'+id,conversation_id:conversation,
 spec:{name,kind:'coordinator',purpose:'Review',workers:[{id:'tester',role:'Tester',responsibilities:['Verify changes'],allowed_target_ids:['control'],max_parallel:1}],
  workspace_refs:[ref],coordinator_targets:['control'],execution_targets:[{id:'control',host_id:home,executor_profile_id:'codex',provider_id:'openai',model_id:'gpt-6.1-sol',effort:'high'}]}})
const teams=[teamOf('team-a','评审团队','dm-a'),teamOf('team-b','发布团队','dm-b')]
const message=(team,text)=>({id:'m-'+team.id,sequence:1,home_hub:home,team_id:team.id,conversation_id:team.conversation_id,actor:{kind:'superagent',id:team.superagent_id},content:text})
const lines={'team-a':'评审团队的第一条私信。','team-b':'发布团队的第一条私信。'}

test('Orbit DM opens messages, settings and session links as native right Sidebar tabs scoped to the exact team',{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:120000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'kode-orbit-sidebar-'));let server,browser
 const writes=[]
 const send=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value))}
 try{
  server=createServer(async(req,res)=>{
   const url=new URL(req.url,'http://localhost'),q=key=>url.searchParams.get(key)
   if(url.pathname==='/fixture-collab.js'){res.setHeader('content-type','text/javascript');res.end(client);return}
   if(await collabRenderPage(req,res,{workspaces:[{workspaceId:'ws-fixture',title:'测试工作区 · ws-fixture',path:'/fixture/project',sessionIds:[SID],createdAt:'2026-11-10T00:00:00.000Z'}],
    nativeSession:{id:SID,cwd:'/fixture/project',createdAt:1700000000000,updatedAt:1700000000000,realSidebarRight:true,
     modelCatalog:{default:{provider:'tclaude',model:'opus-5.5'},routableProviders:['tclaude'],groups:[{id:'tclaude',name:'tclaude',models:[{id:'opus-5.5',name:'Opus 5.5'}]}],failures:[]},
     projections:{modelSelection:{lastUsed:null,next:{provider:'tclaude',model:'opus-5.5'}}}}}))return
   if(req.method!=='GET'){writes.push(req.method+' '+url.pathname);return send(res,{error:'此隔离测试不接受写入'},503)}
   const team=teams.find(row=>row.id===q('team_id'))
   if(url.pathname==='/api/kode/collaboration'&&q('path')==='surfaces'){const scope=Object.fromEntries(['home_hub','host_id','workspace_id','root_ref'].map(key=>[key,q(key)]));return send(res,{scope,items:[]})}
   if(url.pathname==='/api/kode/collab/teams')return send(res,team?{projection:'configuration_revision',team}
    :{home_hub:home,projection:'contact_directory',archived:q('archived')==='true',order:'pinned_attention_unread_recent',items:q('archived')==='true'?[]:teams.map(row=>({...row,contact})),next_cursor:null})
   if(url.pathname==='/api/kode/conversation/messages'){const row=teams.find(t=>t.conversation_id===q('conversation_id'))??team;return send(res,{home_hub:home,team_id:row.id,conversation_id:row.conversation_id,items:Number(q('after')??0)<1&&q('view')===null&&q('request_id')===null?[message(row,lines[row.id])]:[],has_more:false,next_cursor:null})}
   if(url.pathname==='/api/kode/conversation/read-state'){const row=teams.find(t=>t.conversation_id===q('conversation_id'))??team;return send(res,{home_hub:home,team_id:row.id,conversation_id:row.conversation_id,principal_id:'local_owner',through_sequence:1,latest_sequence:1,unread_count:0})}
   if(url.pathname==='/api/kode/collab/runs')return send(res,{home_hub:home,team_id:q('team_id'),items:[],next_cursor:null})
   if(url.pathname==='/api/kode/avatars')return send(res,{avatars:[]})
   if(url.pathname==='/api/kode/collab/appearance')return send(res,{team_id:q('team_id'),home_hub:home,superagent_id:q('superagent_id'),profile:{id:'im',name:'团队',type:'custom',avatar:{id:null,url:null}}})
   if(url.pathname==='/api/kode/agents'){const id=q('profile_id'),teamId=q('team_id')
    return send(res,{profiles:[{id:'tclaude',name:'tclaude',type:'claude',origin:'builtin'},{id:'codex',name:'Codex',type:'codex',origin:'builtin'}],selectedProfileId:'tclaude',supportedTypes:['claude','codex'],
     ...(id==='codex'?{models:[{id:'gpt-6.1-sol',name:'GPT-6.1 Sol'}],defaultModelSelection:{model:'gpt-6.1-sol'}}:{models:[{id:'opus-5.5',name:'Opus 5.5'}],defaultModelSelection:{model:'opus-5.5'}}),
     ...(teamId?{teamRolePreferences:{teamId,assignments:{superagent:{profileId:'codex',model:'gpt-6.1-sol'}},preferenceRevision:1,scope:'local_host',eligibleForExecution:false}}:{})})}
   send(res,{error:'此隔离测试未启用该服务'},503)
  });server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);const page=await browser.page(`http://127.0.0.1:${server.address().port}`)
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
  const wait=(expr,ms=12000)=>page.evaluate(`(async()=>{const end=Date.now()+${ms};while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,25))}throw Error('Orbit sidebar timeout: '+${JSON.stringify(expr)}+' '+JSON.stringify({errors:window.fixtureErrors,console:window.consoleErrors?.slice(-6),rightbar:document.querySelector('[data-fixture-native-rightbar]')?.innerText.slice(0,600),main:document.querySelector('#fixture-main')?.innerText.slice(0,400)}))})()`)
  const dir=process.env.KODE_ARTIFACT_DIR??'/tmp/kode-orbit-shots';await mkdir(dir,{recursive:true})
  const shot=async name=>writeFile(join(dir,name),Buffer.from((await page.call('Page.captureScreenshot',{format:'png'})).data,'base64'))
  const bar=`document.querySelector('[data-fixture-native-rightbar]')`
  const surface=`document.querySelector('[data-sidebar-right-session^="host:kode-collab/"]')`
  const click=(label,scope='document')=>page.evaluate(`(()=>{const b=Array.from(${scope}.querySelectorAll('button')).find(b=>(b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)})&&!b.disabled);if(!b)throw Error('no button '+${JSON.stringify(label)}+': '+Array.from(${scope}.querySelectorAll('button')).map(b=>b.getAttribute('aria-label')||b.textContent.trim()).join('|'));b.click()})()`)
  const teamRow=name=>`Array.from(document.querySelectorAll('[data-sidebar-row=team]')).find(r=>r.querySelector('[data-row-title]')?.textContent===${JSON.stringify(name)})`
  const openTeam=async name=>{
   await page.evaluate(`(()=>{const d=document.querySelector('[data-sidebar-section=direct]');if(d&&!d.open)d.querySelector('summary').click()})()`)
   await wait(teamRow(name))
   await page.evaluate(`${teamRow(name)}.click()`)
   await wait(`document.querySelector('.kode-collab-header h1')?.textContent===${JSON.stringify(name)}`)
  }
  await wait(`window.fixture&&document.querySelector('.kode-collab-mode-switch button')`)
  if(await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').getAttribute('aria-label').includes('会话')`)){
   await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`)
   await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('协作'))`)
   await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('协作')).click()`)
  }
  // Team Builder before any draft: the header gear is always there and opens its own settings in the native Sidebar.
  await page.evaluate(`(()=>{const d=document.querySelector('[data-sidebar-section=direct]');if(d&&!d.open)d.querySelector('summary').click()})()`)
  await wait(`document.querySelector('[aria-label="私信 Team Builder"]')`)
  await page.evaluate(`document.querySelector('[aria-label="私信 Team Builder"]').click()`)
  await wait(`document.querySelector('.kode-builder-header button[aria-label="Team Builder 设置"],button[aria-label="Team Builder 设置"]')`)
  await click('Team Builder 设置')
  await wait(`${surface}?.getAttribute('data-sidebar-right-session')==='host:kode-collab/builder/home'&&${surface}.hasAttribute('data-sidebar-right-open')&&${bar}.querySelector('.kode-superagent-settings-tab [aria-label="规划 Agent 与模型"]')`)
  assert.match(await page.evaluate(`${bar}.querySelector('[aria-label="规划 Agent 与模型"]').innerText`),/新规划使用/)
  assert.equal(await page.evaluate(`${bar}.querySelectorAll('[role=tab]').length`),1,'only the requested settings tab opens')
  await shot('orbit-builder-home-settings-1440.png')
  await openTeam('评审团队')
  const keyA='host:kode-collab/team/home/team-a',keyB='host:kode-collab/team/home/team-b'
  // The native seat mounts the host surface for the real team scope, collapsed: nothing opens by itself.
  await wait(`${surface}?.getAttribute('data-sidebar-right-session')===${JSON.stringify(keyA)}`)
  assert.equal(await page.evaluate(`${surface}.hasAttribute('data-sidebar-right-open')`),false,'the host surface starts collapsed')
  assert.equal(await page.evaluate(`fixture.selectedPanel()`),'kode-collab','Orbit stays the active panel')

  // The gear opens the settings tab in the native Sidebar (no in-place inspector), Agent and model kept apart, no budget.
  await click('SuperAgent 设置','document.querySelector(".kode-collab-header-actions")')
  await wait(`${surface}?.hasAttribute('data-sidebar-right-open')&&${bar}.querySelector('.kode-superagent-settings-tab [data-team-role="superagent"] button[aria-label^="模型："]')`)
  assert.equal(await page.evaluate(`!!document.querySelector('aside.kode-superagent-settings')`),false,'no second in-place settings seat')
  assert.equal(await page.evaluate(`!!document.querySelector('#fixture-main .kode-collab-thread')`),true,'the DM stays in the main column')
  const settings=`${bar}.querySelector('.kode-superagent-settings-tab')`
  assert.ok(await page.evaluate(`!!${settings}.querySelector('[data-team-role="superagent"] button[aria-label^="Agent："]')||/Agent/.test(${settings}.querySelector('[data-team-role="superagent"]').innerText)`),'Agent picker is its own control')
  assert.equal(await page.evaluate(`${settings}.querySelector('[data-authorized-role="superagent"] .kode-config-note').textContent`),'Codex · gpt-6.1-sol · high')
  assert.doesNotMatch(await page.evaluate(`${bar}.innerText`),/预算/)
  assert.ok((await page.evaluate(`${bar}.innerText`)).includes('设置'),'the tab strip names the settings tab')
  await shot('orbit-sidebar-settings-tab-1440.png')

  // Messages tab: the exact team's DM column; the main DM owns the only composer.
  // The DM's linked-design entry opens the messages tab and the Builder for the same team: one scope, one surface.
  await click('查看关联设计消息列','document.querySelector(".kode-collab-header-actions")')
  await wait(`${bar}.querySelector('[data-sidebar-messages]')&&${bar}.innerText.includes(${JSON.stringify(lines['team-a'])})&&!document.querySelector('#fixture-main .kode-collab-header')`)
  assert.equal(await page.evaluate(`${surface}.getAttribute('data-sidebar-right-session')`),keyA,'Builder shows team A: same surface')
  // No main DM writer under the Builder: the tab's composer is the only one for this conversation.
  await wait(`!${bar}.querySelector('.kode-sidebar-writer-yield')&&${bar}.querySelectorAll('[data-sidebar-messages] [contenteditable=true],[data-sidebar-messages] textarea').length===1`)
  await shot('orbit-sidebar-messages-builder-1440.png')
  await openTeam('评审团队')
  await wait(`${bar}.querySelector('[data-sidebar-messages]')`)
  assert.ok(!(await page.evaluate(`${bar}.innerText`)).includes(lines['team-b']),'no other team data in this scope')
  assert.equal(await page.evaluate(`!!${bar}.querySelector('.kode-sidebar-writer-yield')`),true,'the tab yields the composer while the main DM writes')
  assert.equal(await page.evaluate(`${bar}.querySelectorAll('[data-sidebar-messages] [contenteditable=true],[data-sidebar-messages] textarea').length`),0)
  await shot('orbit-sidebar-messages-tab-1440.png')

  // Session link: a real Session in a new native tab, retained while open, released on close.
  await page.evaluate(`fixture.ctx.get('sidebarRight').openResourceIn(${JSON.stringify(keyA)},'dsh-resource://kode-collab-session/session/${SID}',{kind:'kode-collab.session',preferNewPane:false})`)
  await wait(`${bar}.querySelector('[data-kode-sidebar-session="${SID}"] [data-conversation-session="${SID}"]')`)
  assert.deepEqual(await page.evaluate(`nativeRetains.filter(r=>r.source==='kodeOrbitSidebar').map(r=>[r.id,r.released])`),[[SID,false]])
  assert.deepEqual(await page.evaluate(`nativeOpened`),[],'no session mode')
  assert.deepEqual(await page.evaluate(`nativeWire.prompts`),[],'nothing is sent')
  await shot('orbit-sidebar-session-tab-1440.png')
  // Native Conversation Views: 轨迹 follows the user's developer-tools switch (read, never written),
  // and the chosen tab reaches the native conversation.view list through conversation.session.
  const tabsQ=`${bar}.querySelector('[data-kode-sidebar-session] [role=tablist][aria-label="会话视图"]')`
  const tabNames=`[...${tabsQ}.querySelectorAll('[role=tab]')].map(b=>b.textContent)`
  assert.equal(await page.evaluate(`!!${tabsQ}`),false,'one registered view: no tab row')
  // This fixture loads neither the chat nor the trajectory view package: register marker views under the native ids.
  await page.evaluate(`(()=>{const React=globalThis.__KODE_TEST_MODULES__.react,view=(id,order,label,marker)=>fixture.ctx.slots.inject('conversation.view',()=>fixture.ctx.slots.register({name:'conversation.view',id,order,label},()=>React.createElement('div',{[marker]:''},id+' body')))
   if(![...fixture.ctx.slots.entries('conversation.view')].some(e=>e.options?.id==='chat'))view('chat',0,'对话','data-fixture-chat')
   view('trajectory',10,'轨迹','data-fixture-trajectory')})()`)
  await new Promise(r=>setTimeout(r,200))
  assert.equal(await page.evaluate(`!!${tabsQ}`),false,'developer tools off: 轨迹 stays hidden')
  await page.evaluate(`fixtureDevTools.set(true)`)
  await wait(`${tabsQ}&&${tabNames}.length===2&&${tabNames}[1]==='轨迹'`)
  assert.equal(await page.evaluate(`${tabsQ}.querySelector('[aria-selected=true]')===${tabsQ}.querySelector('[role=tab]')`),true,'对话 first and selected')
  assert.equal(await page.evaluate(`!!${bar}.querySelector('[data-fixture-trajectory]')`),false)
  assert.equal(await page.evaluate(`!!${bar}.querySelector('[data-kode-sidebar-session] [data-fixture-chat]')`),true,'对话 renders the chat view')
  await page.evaluate(`[...${tabsQ}.querySelectorAll('[role=tab]')].find(b=>b.textContent==='轨迹').click()`)
  await wait(`${bar}.querySelector('[data-kode-sidebar-session] [data-fixture-trajectory]')&&!${bar}.querySelector('[data-fixture-chat]')&&${tabsQ}.querySelector('[aria-selected=true]').textContent==='轨迹'`)
  await shot('orbit-sidebar-session-trajectory-1440.png')
  await page.evaluate(`${tabsQ}.querySelector('[role=tab]').click()`)
  await wait(`!${bar}.querySelector('[data-fixture-trajectory]')`)
  await page.evaluate(`[...${tabsQ}.querySelectorAll('[role=tab]')].find(b=>b.textContent==='轨迹').click()`)
  await wait(`${bar}.querySelector('[data-fixture-trajectory]')`)
  await page.evaluate(`fixtureDevTools.set(false)`)
  await wait(`!${tabsQ}&&!${bar}.querySelector('[data-fixture-trajectory]')`)
  assert.deepEqual(await page.evaluate(`fixtureDevTools.writes`),[],'the global developer-tools setting is never written')
  assert.deepEqual(await page.evaluate(`nativeOpened`),[],'still no session mode')

  // Tab layout is per scope: the other team's surface has none of team A's tabs.
  await openTeam('发布团队')
  await wait(`${surface}?.getAttribute('data-sidebar-right-session')===${JSON.stringify(keyB)}`)
  assert.ok(!(await page.evaluate(`${bar}.innerText`)).includes(lines['team-a']))
  assert.equal(await page.evaluate(`!!${bar}.querySelector('[data-kode-sidebar-session]')`),false)
  await openTeam('评审团队')
  await wait(`${surface}?.getAttribute('data-sidebar-right-session')===${JSON.stringify(keyA)}&&!!${bar}.querySelector('[data-kode-sidebar-session]')`)
  const stored=await page.evaluate(`Object.keys(localStorage).filter(k=>k.includes('host:kode-collab/'))`)
  assert.ok(stored.some(k=>k.includes(keyA)),'tab layout is a local UI preference per host scope: '+JSON.stringify(stored))

  // Closing the session tab releases the reference through the native close.
  const before=await page.evaluate(`${bar}.querySelectorAll('[role=tab]').length`)
  const closed=await page.evaluate(`(()=>{const tabs=Array.from(${bar}.querySelectorAll('[role=tab]'));const t=tabs.find(t=>t.getAttribute('aria-selected')==='true');if(!t||t.textContent!=='project')return 'tabs:'+tabs.map(t=>t.textContent+':'+t.getAttribute('aria-selected')).join('|');const c=t.closest('[data-tab-id],li,div')?.querySelector('button[aria-label*="关闭"]');if(!c)return 'nobutton:'+t.parentElement.parentElement.outerHTML.slice(0,1500);c.click();return 'ok'})()`)
  assert.equal(closed,'ok')
  await wait(`!${bar}.querySelector('[data-kode-sidebar-session]')&&nativeRetains.filter(r=>r.source==='kodeOrbitSidebar').every(r=>r.released)`)
  assert.equal(await page.evaluate(`${bar}.querySelectorAll('[role=tab]').length`),before-1)

  // Leaving Orbit: the Session view's own right Sidebar is back; no host surface is on screen.
  await page.evaluate(`fixture.ctx.layout.selectPanel(null)`)
  await wait(`!${surface}`)
  assert.deepEqual(writes,[],'no writes')
  assert.deepEqual(await page.evaluate(`nativeWire.prompts`),[])
  assert.deepEqual(await page.evaluate(`window.fixtureErrors`),[])
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await rm(profile,{recursive:true,force:true})}
})

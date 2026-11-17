import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collabRenderPage } from './support/collab-render-page.js'
import { headlessBrowser } from './support/headless-browser.js'
const external=['react','react-dom','react-dom/client','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-primitives']
const source=await build({entryPoints:['packages/collab/scoped-workspace-sidebar.js'],bundle:true,format:'cjs',platform:'browser',external,write:false})
const module={exports:{}}
vm.runInNewContext(source.outputFiles[0].text,{module,exports:module.exports,TextEncoder,require:()=>({})})
const {scopedWorkspaceSessions,scopedManagedWorkerRows,sessionStatuses,sessionWatermark,pageRows}=module.exports
const scopes=[
 {home_hub:'home',host_id:'host-a',workspace_id:'project',root_ref:'/work/a',rowId:'project',title:'同名项目'},
 {home_hub:'home',host_id:'host-b',workspace_id:'project',root_ref:'/work/b',rowId:'kode-host:remote/project',title:'同名项目'},
]
const sessions={phase:'ready',ids:['a','b','wrong-cwd'],byId:{a:{id:'a',title:'A'},b:{id:'b',title:'B'},'wrong-cwd':{id:'wrong-cwd',cwd:'/work/a',title:'not a member'}}}
const workspaces={phase:'ready',items:[{workspaceId:'project',path:'/work/a',sessionIds:['a','a','unknown']},{workspaceId:'kode-host:remote/project',path:'/work/b',sessionIds:['b']}],archivedSessionIds:['b']}
const plain=v=>JSON.parse(JSON.stringify(v))
test('public projection follows registered exact identities and membership without changing complete snapshots',()=>{
 const before=JSON.stringify({scopes,sessions,workspaces})
 assert.deepEqual(plain(scopedWorkspaceSessions(scopes,scopes[0],workspaces,sessions).rows),[{session:sessions.byId.a,archived:false}])
 assert.deepEqual(plain(scopedWorkspaceSessions(scopes,scopes[1],workspaces,sessions).rows),[{session:sessions.byId.b,archived:true}])
 for(const foreign of [{...scopes[0],home_hub:'other'},{...scopes[0],host_id:'host-b'},{...scopes[0],root_ref:'/work/a/child'}])assert.equal(scopedWorkspaceSessions(scopes,foreign,workspaces,sessions).phase,'unselected')
 assert.equal(scopedWorkspaceSessions(scopes,scopes[0],{...workspaces,items:[{...workspaces.items[0],path:'/different'}]},sessions).phase,'missing')
 assert.equal(scopedWorkspaceSessions(scopes,scopes[0],{...workspaces,phase:'pending'},sessions).phase,'loading')
 assert.equal(JSON.stringify({scopes,sessions,workspaces}),before)
})

const proof=await build({stdin:{resolveDir:process.cwd(),contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import {ScopedWorkspaceSidebar} from './packages/collab/scoped-workspace-sidebar.js';
import {MenuItemButton} from '@deepseek-ai/dsh-client-ui-primitives';
const h=React.createElement,scopes=${JSON.stringify(scopes)},sessions=${JSON.stringify(sessions)},workspaces=${JSON.stringify(workspaces)};
const calls=[],slotCalls=[],sourceProps={wide:true,useSessions:selector=>selector(sessions),useWorkspaces:selector=>selector(workspaces),open:id=>calls.push(['open',id]),startSession:id=>calls.push(['new',id]),notifyArchivedNotOpenable:()=>calls.push(['archived'])};
let nativeMounts=0,nativeUnmounts=0,nativePropsStable=true,renderCount=0;
function Native(props){nativePropsStable=nativePropsStable&&props.useSessions===sourceProps.useSessions&&props.useWorkspaces===sourceProps.useWorkspaces;React.useEffect(()=>{nativeMounts++;return()=>nativeUnmounts++},[]);return h('div',{'data-proof-native':true},'完整原生管理测试占位：'+props.useSessions(s=>s.ids).join(','))}
sourceProps.renderSlot=(name,owner,options)=>{slotCalls.push({name,owner,context:options?.hookContext});if(name==='sidebar.workspaces.session.menu.item')return h(MenuItemButton,{onSelect:()=>{calls.push(['menu',owner.sessionId]);options.hookContext[1](false)}},'公开菜单测试动作');if(name==='sidebar.session.row.leading')return h('span',{'data-proof-leading':owner.sessionId},'·');return null};
function App(){const [scope,setScope]=React.useState(scopes[0]);renderCount++;return h('div',{style:{display:'flex',height:'100%',width:'100%',minWidth:0}},h('aside',{style:{width:260,minWidth:0,display:'flex',flexDirection:'column'}},h(ScopedWorkspaceSidebar,{native:Native,nativeProps:sourceProps,scopes,selectedScope:scope,onSelectScope:value=>{calls.push(['scope',value.host_id]);setScope(value)},storage:localStorage,renderChannels:value=>h('p',{'data-proof-channel':value.host_id},'频道 · '+value.host_id),renderDirect:value=>h('p',{'data-proof-direct':value.host_id},'私信 · '+value.host_id)})),h('main',{style:{flex:1,minWidth:0}},h('textarea',{'aria-label':'已有对话草稿',defaultValue:'现有草稿'})))}
const root=document.createElement('div');root.id='scoped-sidebar-proof';root.style='position:fixed;inset:0;z-index:10000;background:var(--dsw-alias-surface-base,white)';document.body.append(root);createRoot(root).render(h(App));
window.scopedProof={calls,slotCalls,nativeMounts:()=>nativeMounts,nativeUnmounts:()=>nativeUnmounts,nativePropsStable:()=>nativePropsStable,renderCount:()=>renderCount};
`},bundle:true,format:'iife',platform:'browser',external,write:false,banner:{js:'const require=name=>window.__KODE_TEST_MODULES__[name];'}})

test('public native primitives drive scoped rows and menu context; scope switching preserves mounted native manager and draft', {skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:40000}, async()=>{
 const profile=await mkdtemp(join(tmpdir(),'kode-scoped-public-'));let server,browser
 try{
  server=createServer(async(req,res)=>{
   if(req.url==='/scoped-proof.js'){res.setHeader('content-type','text/javascript');res.end(proof.outputFiles[0].text);return}
   if(req.url.startsWith('/api/kode/collab/teams')){res.setHeader('content-type','application/json');res.end(JSON.stringify({home_hub:'home',projection:'contact_directory',archived:false,order:'pinned_attention_unread_recent',items:[],next_cursor:null}));return}
   if(await collabRenderPage(req,res))return;res.writeHead(404);res.end('{}')
  });server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);const page=await browser.page(`http://127.0.0.1:${server.address().port}`)
  const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+7000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,20))}throw Error('Scoped draft timeout '+JSON.stringify({body:document.body.innerText,errors:fixtureErrors}))})()`)
  await wait('window.fixture');await page.evaluate(`new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='/scoped-proof.js';s.onload=resolve;s.onerror=reject;document.head.append(s)})`)
  await wait(`document.querySelector('[data-adapted-session-id=a]')&&scopedProof.nativeMounts()===1`)
  // Team Builder is an ordinary DM row supplied by the caller; no separate system section.
  assert.equal(await page.evaluate(`!document.querySelector('#scoped-sidebar-proof [data-sidebar-section="system-direct"]')&&!document.body.innerText.includes('系统私信')`),true)
  assert.equal(await page.evaluate(`document.querySelectorAll('[data-adapted-session-id]').length`),1)
  assert.equal(await page.evaluate(`!!document.querySelector('[data-proof-leading=a]')`),true)
  await page.evaluate(`window.keptDraft=document.querySelector('#scoped-sidebar-proof textarea');keptDraft.focus()`);await page.call('Input.insertText',{text:'，切换保留'})
  const draft=await page.evaluate('keptDraft.value')
  const projects=`document.querySelectorAll('#scoped-sidebar-proof [data-project-scope]')`
  await page.evaluate(`document.querySelector('[aria-label="打开会话：A"]').click();document.querySelector('button[aria-label="会话操作：A"]').click()`)
  await wait(`Array.from(document.querySelectorAll('button[role=menuitem]')).some(b=>b.textContent.includes('公开菜单测试动作'))`)
  assert.equal(await page.evaluate(`scopedProof.slotCalls.filter(c=>c.name==='sidebar.workspaces.session.menu.item').every(c=>c.context.length===2&&typeof c.context[0]==='boolean'&&typeof c.context[1]==='function'&&c.owner.sessionId==='a')`),true)
  await page.evaluate(`Array.from(document.querySelectorAll('button[role=menuitem]')).find(b=>b.textContent.includes('公开菜单测试动作')).click()`)
  await wait(`!Array.from(document.querySelectorAll('button[role=menuitem]')).some(b=>b.textContent.includes('公开菜单测试动作'))`)
  // Same-named projects on two hosts stay two exact tree rows; the second expands on demand.
  assert.equal(await page.evaluate(`${projects}.length`),2)
  await page.evaluate(`${projects}[0].querySelector('[data-sidebar-section=sessions] button[aria-label="在“同名项目”中新建会话"]').click()`)
  await page.evaluate(`${projects}[1].querySelector('[data-row-key^="workspace:"]').click()`)
  await wait(`${projects}[1].querySelector('[data-adapted-session-id=b]')`)
  assert.equal(await page.evaluate(`!!${projects}[1].querySelector('[data-adapted-session-id=a],[data-proof-channel=host-a]')||!!${projects}[0].querySelector('[data-adapted-session-id=b],[data-proof-channel=host-b]')`),false,'each project shows only its exact members')
  // Acting inside the second project makes it current before the row acts.
  await page.evaluate(`${projects}[1].querySelector('[data-sidebar-section=sessions] button[aria-label="在“同名项目”中新建会话"]').click()`)
  await page.evaluate(`${projects}[1].querySelector('[aria-label="打开会话：B"]').click()`)
  assert.deepEqual(await page.evaluate('scopedProof.calls'),[['open','a'],['menu','a'],['new','project'],['scope','host-b'],['new','kode-host:remote/project'],['archived']])
  assert.equal(await page.evaluate(`keptDraft===document.querySelector('#scoped-sidebar-proof textarea')&&keptDraft.value===${JSON.stringify(draft)}`),true)
  // The project menu opens the full native manager; without a mode switch it returns in place.
  await page.evaluate(`document.querySelector('#scoped-sidebar-proof [data-project-scope] button[aria-label="项目操作：同名项目"]').click()`)
  await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('在会话模式中管理'))`)
  await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('在会话模式中管理')).click()`)
  await wait(`document.querySelector('[data-proof-native]')?.getBoundingClientRect().height>0`)
  assert.equal(await page.evaluate(`document.querySelector('[data-proof-native]').getBoundingClientRect().height>0`),true)
  assert.equal(await page.evaluate('scopedProof.nativeMounts()'),1);assert.equal(await page.evaluate('scopedProof.nativeUnmounts()'),0);assert.equal(await page.evaluate('scopedProof.nativePropsStable()'),true)
  await page.evaluate(`document.querySelector('#scoped-sidebar-proof button[aria-label="返回当前工作区"]').click()`)
  await wait(`document.querySelector('#scoped-sidebar-proof [data-sidebar-section=sessions] summary').getBoundingClientRect().height>0`)
  await page.evaluate(`document.querySelector('#scoped-sidebar-proof [data-sidebar-section=sessions] summary').focus()`)
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13});await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  await wait(`!document.querySelector('#scoped-sidebar-proof [data-sidebar-section=sessions]').open`)
  assert.equal(await page.evaluate(`!!document.querySelector('[data-adapted-session-id=b]')`),true)
  assert.deepEqual(await page.evaluate('fixtureErrors'),[])
  // Optional evidence: synthetic adapter data, native Menu/Button/Icon; manager is labelled test placeholder.
  if(process.env.KODE_SCOPED_DRAFT_CAPTURE){await page.evaluate(`document.querySelector('#scoped-sidebar-proof [data-sidebar-section=sessions] summary').click()`);await wait(`document.querySelector('#scoped-sidebar-proof [data-sidebar-section=sessions]').open`);await mkdir(process.env.KODE_SCOPED_DRAFT_CAPTURE,{recursive:true});for(const [name,width]of [['desktop',1280],['narrow',390]]){await page.call('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:false});const shot=await page.call('Page.captureScreenshot',{format:'png'});await writeFile(join(process.env.KODE_SCOPED_DRAFT_CAPTURE,name+'.png'),Buffer.from(shot.data,'base64'))}}
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}await rm(profile,{recursive:true,force:true})}
})

test('owner managed rows reject foreign or forged workspace/session tuples without mutating native snapshots',()=>{
 const scope={home_hub:'home',host_id:'home',workspace_id:'project',root_ref:'/work/a'},entry={id:'worker',title:'Worker',read_only:true,scope,run:{id:'run',team_id:'team',home_hub:'home'},item:{assignment_id:'assignment',operation:{id:'operation'},worker:{node_id:'home',session_id:'worker'}}}
 assert.equal(scopedManagedWorkerRows(scope,[entry]).length,1)
 for(const changed of [{...entry,read_only:false},{...entry,scope:{...scope,root_ref:'/work/a/child'}},{...entry,scope:{...scope,workspace_id:'other'}},{...entry,item:{...entry.item,worker:{...entry.item.worker,session_id:'other'}}},{...entry,run:{...entry.run,home_hub:'other'}}])assert.equal(scopedManagedWorkerRows(scope,[changed]).length,0)
 assert.equal(scopedManagedWorkerRows({...scope,host_id:'remote'},[entry]).length,0)
 assert.equal(scopedManagedWorkerRows(scope,[entry],[{session:{id:'worker'}}]).length,0)
 assert.equal(scopedManagedWorkerRows(scope,[entry,entry]).length,1)
})

test('session status and paging follow the native workspace list',()=>{
 assert.deepEqual(plain(sessionStatuses({running:true})),[{state:'ongoing',label:'进行中'}])
 assert.deepEqual(plain(sessionStatuses({running:true,pendingInteraction:'question',runningSubagentCount:2})).map(s=>s.state+':'+(s.trailingLabel??s.label)),['warning:待回答','ongoing:2 个子智能体运行中'])
 assert.equal(sessionStatuses({completed:true})[0].state,'done');assert.equal(sessionStatuses({})[0].state,'idle')
 const rows=Array.from({length:60},(_,i)=>({session:{id:'s'+i}}))
 assert.equal(sessionWatermark(rows),5)
 assert.equal(sessionWatermark(rows,{currentSessionId:'s7'}),8,'the current row stays visible')
 assert.equal(sessionWatermark(rows,{statuses:new Map([['s30',{running:true}]])}),31)
 assert.equal(sessionWatermark(rows,{statuses:new Map([['s55',{running:true}]])}),5,'only the first 50 rows raise the page')
 const page=pageRows([{session:{id:'blank',blank:true}},...rows],5)
 assert.equal(page.rows.length,6);assert.equal(page.hiddenCount,55,'blank rows never count against the page')
})

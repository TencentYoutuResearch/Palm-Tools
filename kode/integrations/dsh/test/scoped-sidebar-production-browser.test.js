/** Current production source + real dsh shell/workspace/menu components.
 * Team/conversation/controller data are labelled synthetic; no models or live runs. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {collabRenderPage} from './support/collab-render-page.js'
import {headlessBrowser} from './support/headless-browser.js'
const bundle=await build({entryPoints:['packages/collab/client-source.js'],bundle:true,loader:{'.png':'dataurl'},format:'cjs',platform:'browser',external:['react','react-dom','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-primitives','@kode/dsh-composer'],write:false})
const client=process.env.KODE_TEST_SHIPPED_COLLAB==='1'?await readFile(new URL('../packages/collab/client.js',import.meta.url),'utf8'):`window.__ModuleLoader__.load({id:'@kode/dsh-collab',factory(require){const module={exports:{}},exports=module.exports;${bundle.outputFiles[0].text};return module.exports}})`
const workspaces=['a','b'].map(id=>({workspaceId:'project-'+id,title:id==='a'?'Kode 优化':'Palm Device',path:'/fixture/'+id,sessionIds:['session-'+id],createdAt:new Date(1700000000000).toISOString()}))
const teams=['a','b'].map(id=>({id:'team-'+id,superagent_id:'super-'+id,conversation_id:'dm-'+id,home_hub:'home',spec:{kind:'coordinator',name:id==='a'?'会话恢复与界面优化':'设备需求与缺陷迭代',purpose:'截图与交互验证用测试数据',workspace_refs:[{host_id:'home',workspace_id:'project-'+id,root_ref:'/fixture/'+id}]},contact:{preference:{revision:0,pinned:false,archived:false,archived_through_sequence:0},archived:false,needs_attention:false,latest_sequence:2,unread_count:0,last_activity_at:1,attention:{decisions:0,resources:0,stopping:0,active_runs:0}}}))

test('production scoped sidebar keeps native plugins and full manager while isolating teams, sessions and drafts', {skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:45000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'kode-scoped-production-'));let server,browser
 const requests=[]
 try{
  server=createServer(async(req,res)=>{
   const url=new URL(req.url,'http://localhost'),send=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value))}
   if(url.pathname==='/fixture-collab.js'){res.setHeader('content-type','text/javascript');res.end(client);return}
   if(url.pathname.startsWith('/api/'))requests.push([req.method,url.pathname,url.search])
   if(url.pathname==='/api/kode/collab/teams'){
    const items=url.searchParams.has('workspace_id')?teams.filter(t=>t.spec.workspace_refs.some(w=>w.host_id===url.searchParams.get('workspace_host')&&w.workspace_id===url.searchParams.get('workspace_id')&&w.root_ref===url.searchParams.get('workspace_root'))):teams
    return send({home_hub:'home',projection:'contact_directory',archived:false,order:'pinned_attention_unread_recent',items,next_cursor:null})
   }
   const team=teams.find(t=>t.conversation_id===url.searchParams.get('conversation_id'))
   if(url.pathname==='/api/kode/conversation/messages'&&team){
    const items=Number(url.searchParams.get('after'))>=2?[]:[
     {id:team.id+'-human',home_hub:'home',team_id:team.id,conversation_id:team.conversation_id,sequence:1,actor:{kind:'human',id:'local_owner'},content:'请先检查当前实现，把可以复现的问题和下一步安排整理给我。',created_at:1700000000000},
     {id:team.id+'-agent',home_hub:'home',team_id:team.id,conversation_id:team.conversation_id,sequence:2,actor:{kind:'superagent',id:team.superagent_id},content:'收到。我会先核对工作区和已有记录，验证后把结果放在这里，重要的变更会先说明。',created_at:1700000060000}]
    return send({home_hub:'home',team_id:team.id,conversation_id:team.conversation_id,items,has_more:false,next_cursor:null})
   }
   if(url.pathname==='/api/kode/conversation/read-state'&&team)return send({home_hub:'home',team_id:team.id,conversation_id:team.conversation_id,principal_id:'local_owner',through_sequence:2,latest_sequence:2,unread_count:0})
   if(url.pathname==='/api/kode/collab/runs')return send({home_hub:'home',team_id:url.searchParams.get('team_id'),items:[],next_cursor:null})
   const end=res.end.bind(res)
   if(url.pathname==='/')res.end=html=>end(html.replace('register:()=>()=>{}','register:command=>{(window.fixtureNativeCommands??=new Map()).set(command.id,command);return()=>fixtureNativeCommands.delete(command.id)}'))
   if(await collabRenderPage(req,res,{workspaces}))return
   res.writeHead(404);res.end('{}')
  });server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);const page=await browser.page(`http://127.0.0.1:${server.address().port}`)
  const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,25))}throw Error('Production scoped sidebar timeout '+JSON.stringify({body:document.body.innerText,errors:fixtureErrors,geometry:Array.from(document.querySelectorAll('.kode-collab-unified-sidebar,.kode-scoped-workspace-sidebar,.fixture-native-workspaces,[aria-label=\"原生会话管理\"]')).map(n=>({tag:n.tagName,class:n.className,height:n.getBoundingClientRect().height,display:getComputedStyle(n).display,flex:getComputedStyle(n).flex}))}))})()`)
  const enterCollaboration=async()=>{await wait(`document.querySelector('.kode-collab-mode-switch button')`);if(await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').getAttribute('aria-label').includes('会话')`)){await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`);await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('协作'))`);await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('协作')).click()`)}}
  const click=label=>page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}).click()`)
  // Projects are native tree rows; acting inside a project's group makes it the current scope.
  const group=t=>`Array.from(document.querySelectorAll('[data-project-scope]')).find(g=>g.querySelector('[data-row-key^="workspace:"]')?.textContent===${JSON.stringify(t)})`
  const teamIn=t=>`${group(t)}?.querySelector('[data-sidebar-row=team] [data-row-title]')`
  const choose=async text=>{await wait(group(text));if(await page.evaluate(`!${group(text)}.querySelector('.kode-scoped-content')`))await page.evaluate(`${group(text)}.querySelector('[data-row-key^="workspace:"]').click()`);await wait(`${group(text)}.querySelector('.kode-scoped-content')`)}
  await enterCollaboration()
  await wait(`globalThis.fixture&&document.querySelector('[data-current-workspace-scope]')`)
  await page.evaluate(`(()=>{const s=fixture.workspaceData.sessions,byId={};for(const id of ['a','b'])byId['session-'+id]={id:'session-'+id,title:id==='a'?'恢复长会话草稿':'设备日志与回归检查',displayTitle:id==='a'?'恢复长会话草稿':'设备日志与回归检查',cwd:'/fixture/'+id,createdAt:new Date(1700000000000).toISOString(),updatedAt:1700000000000,blank:false,running:id==='b',runningSubagentCount:0,retainedBy:{},projectionValues:{}};s.publish({...s.getSnapshot(),ids:Object.keys(byId),byId})})()`)
  await wait(`document.querySelector('[data-adapted-session-id="session-a"]')&&${teamIn('Kode 优化')}`)
  for(const label of ['插件','Kode','自动化任务','设置'])assert.equal(await page.evaluate(`!!document.querySelector('button[aria-label=${JSON.stringify(label)}]')`),true,label)
  // Team Builder is an ordinary row of the DM list; the separate system section is gone.
  assert.equal(await page.evaluate(`!!document.querySelector('[data-sidebar-section="direct"] [data-sidebar-row="builder"][data-system-contact-kind="builder"]')&&!document.querySelector('[data-sidebar-section="system-direct"]')&&!document.body.innerText.includes('系统私信')`),true)
  assert.equal(await page.evaluate(`document.querySelectorAll('button[aria-label="新建会话"]').length`),0,'collaboration omits the redundant global session action')
  assert.equal(await page.evaluate(`document.querySelectorAll('.fixture-native-workspaces').length`),1)
  await page.evaluate(`window.keptNative=document.querySelector('.fixture-native-workspaces');window.keptStore=fixture.nativeWorkspaceEntry.store.create();${teamIn('Kode 优化')}.click()`)
  await wait(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]')&&document.querySelectorAll('[data-message-id]').length===2`)
  await page.evaluate(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]').focus()`);await page.call('Input.insertText',{text:'A 项目未发出的核对草稿'})
  await choose('Palm Device')
  await wait(`${group('Palm Device')}.querySelector('[data-adapted-session-id="session-b"]')&&${teamIn('Palm Device')}?.textContent==='设备需求与缺陷迭代'`)
  assert.equal(await page.evaluate(`!!${group('Palm Device')}.querySelector('[data-adapted-session-id="session-a"]')||${teamIn('Palm Device')}.textContent==='会话恢复与界面优化'`),false,'each project shows only its own sessions and teams')
  await page.evaluate(`${teamIn('Palm Device')}.click()`);await wait(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]')`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]').textContent`),'')
  await choose('Kode 优化');await wait(`${teamIn('Kode 优化')}?.textContent==='会话恢复与界面优化'`)
  await page.evaluate(`${teamIn('Kode 优化')}.click()`);await wait(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]')?.textContent==='A 项目未发出的核对草稿'`)
  await click('会话操作：恢复长会话草稿')
  await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('重命名'))`)
  assert.ok(await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('归档'))`))
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  const manage=async()=>{await page.evaluate(`${group('Kode 优化')}.querySelector('button[aria-label="项目操作：Kode 优化"]').click()`);await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('在会话模式中管理'))`);await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('在会话模式中管理')).click()`)}
  await manage();await wait(`keptNative.getBoundingClientRect().height>0`)
  assert.ok(await page.evaluate(`keptNative.innerText.includes('Kode 优化')&&keptNative.innerText.includes('Palm Device')`))
  assert.equal(await page.evaluate(`keptStore===fixture.nativeWorkspaceEntry.store.create()&&keptNative===document.querySelector('.fixture-native-workspaces')`),true)
  await enterCollaboration()
  await page.evaluate(`fixtureNativeCommands.get('session.search').resolve({modal:null}).run()`)
  await wait(`document.activeElement?.placeholder==='搜索会话名称'&&keptNative.getBoundingClientRect().height>0`)
  assert.equal(await page.evaluate(`keptNative===document.querySelector('.fixture-native-workspaces')`),true)
  await enterCollaboration()
  assert.equal(await page.evaluate('fixture.created()'),0)
  assert.deepEqual(await page.evaluate('fixtureErrors'),[])
  assert.equal(requests.some(([method,path])=>method!=='GET'&&path!=='/api/kode/conversation/read-state'),false,'no task, model or workspace write commands')
  if(process.env.KODE_SCOPED_PRODUCTION_CAPTURE){
   const dir=process.env.KODE_SCOPED_PRODUCTION_CAPTURE;await mkdir(dir,{recursive:true})
   await page.evaluate(`(()=>{const label=document.createElement('div');label.textContent='测试数据 · 当前生产源码 · 原生 dsh 组件 · 测试几何外壳';label.style='position:fixed;right:8px;bottom:6px;z-index:99999;padding:4px 8px;background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-secondary);font:11px sans-serif';document.body.append(label)})()`)
   await page.evaluate(`(()=>{const style=document.createElement('style');style.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';document.head.append(style)})()`)
   const theme=async dark=>page.evaluate(`(()=>{const definition=fixture.ctx.theme.getTheme().themes.find(t=>t.colorScheme===${JSON.stringify(dark?'dark':'light')});document.body.toggleAttribute('data-ds-dark-theme',definition.colorScheme==='dark');document.documentElement.style.colorScheme=definition.colorScheme;for(const [name,value]of Object.entries(definition.tokens))document.documentElement.style.setProperty(name,value)})()`)
   const capture=async name=>{const shot=await page.call('Page.captureScreenshot',{format:'png'});await writeFile(join(dir,name+'.png'),Buffer.from(shot.data,'base64'))}
   await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:940,deviceScaleFactor:1,mobile:false});await capture('desktop-light')
   await theme(true);await page.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);await capture('desktop-dark')
   await choose('Palm Device');await wait(`${teamIn('Palm Device')}?.textContent==='设备需求与缺陷迭代'`);await page.evaluate(`${teamIn('Palm Device')}.click()`);await wait(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]')`);await capture('workspace-b-dark')
   await manage();await wait(`keptNative.getBoundingClientRect().height>0`);await capture('native-manager-dark');await enterCollaboration()
   await theme(false);await page.call('Emulation.setDeviceMetricsOverride',{width:430,height:844,deviceScaleFactor:1,mobile:false});await capture('narrow-expanded-light');assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('.kode-collab-header h1')).whiteSpace`),'nowrap');await click('收起侧边栏');await wait(`document.querySelector('.kode-collab-unified-sidebar').dataset.wide==='false'`);await capture('narrow-collapsed-light');assert.equal(await page.evaluate(`document.querySelector('.kode-collab-header').scrollWidth<=document.querySelector('.kode-collab-header').clientWidth`),true)
  }
  // Collapsed native chrome must retain a real keyboard route back to the scope switcher.
  await page.call('Emulation.setDeviceMetricsOverride',{width:430,height:844,deviceScaleFactor:1,mobile:false})
  if(await page.evaluate(`document.querySelector('.kode-collab-unified-sidebar').dataset.wide!=='false'`))await click('收起侧边栏')
  await wait(`document.querySelector('.kode-collab-unified-sidebar').dataset.wide==='false'`)
  assert.equal(await page.evaluate(`(()=>{const b=document.querySelector('button[aria-label="打开侧边栏"]'),r=b?.getBoundingClientRect();return !!b&&b.tabIndex>=0&&r.width>0&&r.height>0})()`),true,'native expand control remains keyboard reachable')
  await page.evaluate(`document.querySelector('button[aria-label="打开侧边栏"]').focus()`)
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13});await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  await wait(`document.querySelector('.kode-collab-unified-sidebar').dataset.wide==='true'`)
  const palmRow=`${group('Palm Device')}.querySelector('[data-row-key^="workspace:"]')`
  const palmOpen=await page.evaluate(`${palmRow}.getAttribute('aria-expanded')`)
  await page.evaluate(`${palmRow}.focus()`)
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13});await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  await wait(`${palmRow}.getAttribute('aria-expanded')!==${JSON.stringify(palmOpen)}`)
  assert.deepEqual(await page.evaluate('fixtureErrors'),[])
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}await rm(profile,{recursive:true,force:true})}
})

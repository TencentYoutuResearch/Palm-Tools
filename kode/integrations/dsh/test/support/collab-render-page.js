/** Actual shipped SidebarRoot, React/slot renderer and IM components; root geometry and services remain controlled fixtures. */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { nativeBoot, nativeModules } from './native-session-boot.js'
import { buildConversationClient } from '../../scripts/build-conversation.js'
import { buildSidebarRightClient } from '../../scripts/build-sidebar-right.js'
const require = createRequire(import.meta.url)
const dist = join(dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist')
const renderer = require.resolve('@deepseek-ai/dsh-client-ui-renderer/client')
let patchedConversation, patchedSidebarRight
export async function collabRenderPage(req, res, { hub, workspaces, settings = false, avatarAccount = false, managedSessions = [], ownerDirectory = null, nativeSession = null, workspaceBundle = null } = {}) {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path === '/') {
    // Explicit fixture service: these are controlled native-controller snapshots, not production registration.
    if(hub&&!workspaces){
      const page=await hub.client.call('/api/v1/messaging/teams?limit=50')
      const refs=new Map(page.items.flatMap(team=>team.spec?.workspace_refs??[]).filter(ref=>ref.host_id===hub.node).map(ref=>[ref.workspace_id,ref]))
      workspaces=[...refs.values()].map(ref=>({workspaceId:ref.workspace_id,title:'测试工作区 · '+ref.workspace_id,path:ref.root_ref,sessionIds:[],createdAt:new Date().toISOString()}))
    }
    const seed=JSON.stringify(workspaces??[]).replaceAll('<','\\u003c')
    const index = await readFile(join(dist, 'index.html'), 'utf8')
    const script = index.match(/src="\.\/(assets\/index-[^"]+\.js)"/)[1]
    const styles = [...index.matchAll(/href="\.\/(assets\/[^\"]+\.css)"/g)].map(match => `<link rel="stylesheet" href="/${match[1]}">`).join('')
    res.setHeader('content-type', 'text/html'); res.end(`<!doctype html><html data-platform="${process.env.KODE_TEST_PLATFORM === 'darwin' ? 'darwin' : 'web'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<style>html,body,#root{height:100%;margin:0}#fixture-frame{height:100%;display:grid;grid-template-columns:260px minmax(0,1fr);grid-template-rows:minmax(0,1fr)}#fixture-main{min-width:0;height:100%;overflow:hidden}.fixture-native-sidebar{padding:16px}</style></head><body><div id="root"></div><script>window.fixtureManagedSessions=${JSON.stringify(managedSessions).replaceAll('<','\\u003c')};window.fixtureOwnerDirectory=${JSON.stringify(ownerDirectory).replaceAll('<','\\u003c')};window.fixtureAvatarAccount=${JSON.stringify(avatarAccount)};window.fixtureSettings=${JSON.stringify(settings)};window.fixtureWorkspaceSeed=${seed};window.fixtureNativeSession=${JSON.stringify(nativeSession).replaceAll('<','\\u003c')};window.fixtureErrors=[];addEventListener("error",e=>fixtureErrors.push(e.message));addEventListener("unhandledrejection",e=>fixtureErrors.push(String(e.reason)))</script><script type="module">import '/${script}';${nativeSession ? nativeBoot : boot}</script></body></html>`); return true
  }
  let body, mime = 'text/javascript'
  if (path === '/fixture-renderer.js') body = await readFile(renderer)
  else if (path === '/fixture-brand.js') body = await readFile(require.resolve('@deepseek-ai/dsh-client-ui-brand-official/client'))
  else if (path === '/fixture-theme.js') body = await readFile(require.resolve('@deepseek-ai/dsh-client-ui-theme/client'))
  else if (path === '/fixture-kode-client.js') body = await readFile(new URL('../../src/agent-client.js', import.meta.url))
  else if (path === '/fixture-settings-general.js') body = await readFile(require.resolve('@deepseek-ai/dsh-client-ui-settings-general/client'))
  // workspaceBundle: another real build of ui-workspace (its CSS-module hash differs per build).
  else if (path === '/fixture-workspace.js') body = workspaceBundle ?? await readFile(require.resolve('@deepseek-ai/dsh-client-ui-workspace/client'))
  else if (path === '/fixture-sidebar.js') body = await readFile(process.env.KODE_TEST_SIDEBAR_BUNDLE || new URL('../../packages/sidebar/client.js', import.meta.url))
  // The released override: pinned upstream + reviewed patch through the production build function.
  else if (path === '/fixture-conversation.js') body = process.env.KODE_TEST_CONVERSATION_BUNDLE ? await readFile(process.env.KODE_TEST_CONVERSATION_BUNDLE) : await (patchedConversation ??= buildConversationClient())
  // The pinned panel-host patch of the native right Sidebar, through the production build function.
  else if (path === '/fixture-sidebar-right.js') body = await (patchedSidebarRight ??= buildSidebarRightClient())
  else if (path === '/fixture-composer.js') body = await readFile(new URL('../../packages/composer/client.js', import.meta.url))
  else if (path === '/fixture-collab.js') body = await readFile(new URL('../../packages/collab/client.js', import.meta.url))
  else if (nativeModules[path]) body = await readFile(join(dirname(require.resolve(nativeModules[path][0] + '/package.json')), nativeModules[path][1]))
  else if (path.startsWith('/assets/')) {
    const target = resolve(dist, '.' + path)
    if (!target.startsWith(dist + sep)) return false
    body = await readFile(target)
    if (/\/index-[^/]+\.js$/.test(path)) {
      const source = body.toString()
      // Minifiers rename the desktop boot variable across frontend releases;
      // the assignment to this stable global marks the boundary after which
      // the production desktop bootstrap executes. Keep the old rc2-era `Ms`
      // seam working, but don't guess if the bundle shape becomes ambiguous.
      const seams = [...source.matchAll(/\bconst\s+[A-Za-z_$][\w$]*\s*=\s*globalThis\.dshDesktopBoot\b/g)]
      const factory = source.match(/function ([A-Za-z_$][\w$]*)\(\)\{return\{react:/)?.[1]
      if (seams.length !== 1 || !factory) throw Error(`Pinned dsh static-module boot seam changed (found ${seams.length} boot assignments)`)
      body = source.slice(0, seams[0].index) + `globalThis.__KODE_TEST_MODULES__=${factory}();`
    }
    mime = path.endsWith('.css') ? 'text/css' : path.endsWith('.woff2') ? 'font/woff2' : mime
  } else return false
  res.setHeader('content-type', mime); res.end(body); return true
}
const boot = `
const modules=globalThis.__KODE_TEST_MODULES__, plugins={};
window.__ModuleLoader__={load(def){plugins[def.id]=def.factory(name=>{if(name in plugins)return plugins[name];if(!(name in modules))throw Error('Missing test module '+name);return modules[name]})}};
const load=src=>new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=reject;document.head.append(script)});
await load('/fixture-renderer.js');await load('/fixture-theme.js');await load('/fixture-sidebar.js');await load('/fixture-brand.js');await load('/fixture-settings-general.js');await load('/fixture-workspace.js');await load('/fixture-kode-client.js');await load('/fixture-conversation.js');await load('/fixture-composer.js');await load('/fixture-collab.js');
const originalFetch=window.fetch.bind(window);let finishFixtureCatalogue;const fixtureCatalogueReady=new Promise(resolve=>{finishFixtureCatalogue=resolve});window.fetch=async(path,init={})=>{if(String(path).startsWith('/api/kode/collab/teams'))await fixtureCatalogueReady;return originalFetch(path,{...init,headers:{...init.headers,'x-fixture-owner':'yes'}})};
const React=modules.react,h=React.createElement,{Context}=modules['@deepseek-ai/cordis'],ctx=new Context();
plugins['@deepseek-ai/dsh-client-ui-renderer'].apply(ctx);
ctx.slots.onEntryError((key,_entry,error)=>fixtureErrors.push(key+': '+String(error?.message??error)));
const dictionaries=new Map(),localeSnapshot={revision:0};
const locale={register:(name,values)=>{dictionaries.set(name,values.zh);return()=>dictionaries.delete(name)},subscribe:()=>()=>{},getSnapshot:()=>localeSnapshot,bind:name=>(key,values={})=>{let text=dictionaries.get(name)?.[key]??({'brand.localBuild':'DeepSeek Harness'}[key])??key;for(const [field,value]of Object.entries(values))text=text.split('{'+field+'}').join(String(value));return text}};
ctx.provide('locale',locale);const devTools=(()=>{let on=false;const fns=new Set();return{getSnapshot:()=>on,subscribe:fn=>{fns.add(fn);return()=>fns.delete(fn)},set:next=>{on=next;for(const fn of fns)fn()},writes:[]}})();window.fixtureDevTools=devTools;ctx.provide('configForms',{developerTools:{enabled:{getSnapshot:devTools.getSnapshot,subscribe:devTools.subscribe},setEnabled:async value=>{devTools.writes.push(value)}},get:()=>({getSnapshot:()=>({value:undefined}),subscribe:()=>()=>{}})});plugins['@deepseek-ai/dsh-client-ui-theme'].apply(ctx);
const absent={key:undefined,hooks:{},keyedHooks:{},props:{}};const binding={getSnapshot:()=>absent,subscribe:()=>()=>{}},sessionBindings=new Map();ctx.slots.installScope('session',{current:binding,bindingSource:session=>{const id=session?.sessionId??session;if(!id)return binding;if(!sessionBindings.has(id)){const value={...absent,key:id,ctx:{},...window.fixtureSessionBinding?.(id)};sessionBindings.set(id,{getSnapshot:()=>value,subscribe:()=>()=>{}})}return sessionBindings.get(id)},renderArea:(_,props)=>props.children});
ctx.slots.installLocale({getSnapshot:()=>({revision:0}),subscribe:()=>()=>{},bind:locale.bind});
let panel=null,collapsed=false,changed=new Set(),created=0,panelState={activePanelId:null};
const subscribe=fn=>{changed.add(fn);return()=>changed.delete(fn)};
const panelInfo={getSnapshot:()=>panelState,subscribe};
ctx.provide('layout',{panelInfo,beginNavigation(){return new AbortController().signal},selectPanel(id){panel=id;panelState={activePanelId:id};for(const fn of changed)fn()},toggleSidebar(){collapsed=!collapsed;for(const fn of changed)fn()}});
const observable=initial=>{let value=initial;const listeners=new Set();return{getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},publish:next=>{value=next;for(const fn of listeners)fn()}}};
const emptySessions={phase:'ready',byId:{},ids:[],projectionsBySession:{}};
const sessionList=observable(emptySessions),sessionStatus=observable(new Map());
const workspaceList=observable({phase:'ready',state:'ready',items:[],archivedSessionIds:[],pinnedSessionIds:[]});
const denied=()=>{throw Error('This controlled fixture cannot mutate a real workspace or create a Session')};
const sessions={list:sessionList,searchResultLimit:50,search:async()=>({ok:true,value:{items:[],hasMore:false}}),create:()=>{created++;return denied()},retain:denied,refreshProjections:async()=>{},subagentAddress:()=>undefined,using:denied};
if(window.fixtureManagedSessions.length){
 const seeds=window.fixtureManagedSessions;let refs=new Map();
 const publish=()=>{const byId=Object.fromEntries(seeds.map(row=>[row.id,{...row,blank:false,retainedBy:{mainView:refs.get(row.id)??0},projectionValues:{}}]));sessionList.publish({phase:'ready',byId,ids:Object.keys(byId),projectionsBySession:{}})};
 sessions.refresh=async()=>publish();
 sessions.retain=(id,{source})=>{if(source!=='mainView'||!seeds.some(row=>row.id===id))return denied();refs.set(id,(refs.get(id)??0)+1);publish();return{sessionId:id,release(){refs.set(id,Math.max(0,(refs.get(id)??0)-1));publish()}}};
 const blocks=new Map(),blockStores=new Map();ctx.provide('conversation',{blocks:{set:(id,value)=>{blocks.set(id,value);blockStores.get(id)?.publish(value)},storeFor:id=>{if(!blockStores.has(id))blockStores.set(id,observable(blocks.get(id)));return blockStores.get(id)}}});
}
if(window.fixtureOwnerDirectory)ctx.provide('kodeWorkspaces',{directory:observable(window.fixtureOwnerDirectory),currentHost:()=>window.fixtureOwnerDirectory.current,refresh:async()=>{},setChannelWorkspaces:()=>{}});
const workspaces={list:workspaceList,initializeDefault:async()=>undefined,create:denied,rename:denied,delete:denied,insertBefore:denied};
ctx.provide('sessions',sessions);ctx.provide('workspaces',workspaces);
const access=observable(true);ctx.provide('remoteAccess',{source:()=>access});
const shortcutRows=[];ctx.provide('shortcuts',{register:()=>()=>{},catalog:{getSnapshot:()=>shortcutRows,subscribe:()=>()=>{}}});
ctx.slots.provideRoot({hooks:{panelInfo,sessions:sessionList,sessionStatus},keyedHooks:{sessionRetainInfo:()=>observable({}),sessionAccess:()=>access}});
ctx.provide('connection',{state:{getSnapshot:()=> 'connected',subscribe:()=>()=>{}},reconnect(){}});
ctx.provide('remote',{$host:{isLoopback:false,home:'/fixture',id:'fixture',name:'测试主机'},directoryPicker:{}});
let fixtureAccount;
if(window.fixtureAvatarAccount){
 let profile={id:'fixture-owner',avatarUrl:null},pending=[],wake;
 const push=()=>{pending.push({value:{status:profile?'credential-stored':'signed-out'},accept(){}});wake?.();wake=undefined};push();
 fixtureAccount={setProfile(value){profile=value;push()}};
 ctx.remote.account={getProfile:async()=>({ok:true,value:{status:'ready',value:profile}}),watch(){}};
 ctx.remote.$stream=()=>({async *[Symbol.asyncIterator](){while(true){if(!pending.length)await new Promise(r=>wake=r);while(pending.length)yield pending.shift()}},dispose(){wake?.()}});
}

const usePanel=()=>React.useSyncExternalStore(subscribe,()=>String(panel)+String(collapsed));
function Frame({renderSlot}){usePanel();const active=panel;return h('div',{id:'fixture-frame',style:{gridTemplateColumns:collapsed?'56px minmax(0,1fr)':'260px minmax(0,1fr)'}},renderSlot('sidebar',{collapsed,width:260}),h('main',{id:'fixture-main'},renderSlot('main',{}, {entryKey:active??'conversation'})))}
ctx.slots.register({name:'root',children:{sidebar:{kind:'single',scope:'root'},main:{kind:'keyed',scope:'root'},'shell.leading':{kind:'single',scope:'root'}}},Frame);
(plugins['@kode/dsh-sidebar'] ?? plugins['@deepseek-ai/dsh-client-ui-sidebar']).apply(ctx);
plugins['@deepseek-ai/dsh-client-ui-brand-official'].apply(ctx);
const nativeSidebarComponent=ctx.slots.entries('sidebar')[0].component;
plugins['@deepseek-ai/dsh-client-ui-workspace'].apply(ctx);
const nativeWorkspaceEntry=ctx.slots.entries('sidebar.workspaces').find(entry=>entry.store);
const nativeWorkspaceComponent=nativeWorkspaceEntry.component;
nativeWorkspaceEntry.component=props=>h('section',{className:'fixture-native-workspaces','data-fixture-data':'workspace',style:{display:'flex',flexDirection:'column',minHeight:0,flex:1}},h(nativeWorkspaceComponent,props));
ctx.slots.inject('sidebar.workspaces.directoryFlow',()=>ctx.slots.register({name:'sidebar.workspaces.directoryFlow'},()=>null));
const P=modules['@deepseek-ai/dsh-client-ui-primitives'];
for(const [id,label,Icon]of [['plugins','插件',P.IconCordisPluginOutlineRegular],['kode-settings','Kode',P.IconAgentPresetOutlineRegular],['schedules','自动化任务',P.IconClockOutlineRegular]]){
 ctx.slots.register({name:'sidebar.panellist',id,order:id==='plugins'?0:id==='kode-settings'?6:10,label},({size})=>h(Icon,{size}));
 ctx.slots.register({name:'main',key:id},()=>id==='kode-settings'&&window.fixtureSettings?h('div',{className:'kode-settings-main',style:{padding:24,boxSizing:'border-box',height:'100%',overflow:'auto'}},h(plugins['@kode/dsh/client'].SettingsPage,{sessions,slots:ctx.slots})):h('p',{'data-fixture-panel':id},label+'（测试面板）'));
}
plugins['@deepseek-ai/dsh-client-ui-settings-general'].apply(ctx);
ctx.slots.register({name:'main',key:'conversation',children:{'conversation.input.dock':{kind:'list',scope:'session'}}},({renderSlot,SessionProvider})=>{const value=React.useSyncExternalStore(sessionList.subscribe,sessionList.getSnapshot),id=value.ids.find(id=>value.byId[id].retainedBy.mainView>0);return h('div',null,h('p',{'data-native-session':id??''},'Native Session placeholder',id?' · '+id:''),id&&h(SessionProvider,{session:id},renderSlot('conversation.input.dock',{})))});
const appearance=plugins['@kode/dsh/client'].createAppearanceFacade(ctx);appearance.installStyles();ctx.provide('kodeAppearance',appearance);ctx.provide('kodeAgentControls',plugins['@kode/dsh/client'].createAgentControlsFacade());
if(window.fixtureSettings)ctx.provide('kodeSettings',plugins['@kode/dsh/client'].createSettingsFacade());
plugins['@kode/dsh-collab'].apply(ctx);ctx.uiRenderer.mount(document.getElementById('root'));
await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
workspaceList.publish({...workspaceList.getSnapshot(),items:globalThis.fixtureWorkspaceSeed??[]});
// Open controlled fixture projects so UI tests exercise their real nested region.
for(let attempt=0;attempt<60;attempt++){const rows=[...document.querySelectorAll('[data-row-key^="workspace:"]')];if(rows.length){const state=nativeWorkspaceEntry.store.create();for(const workspace of globalThis.fixtureWorkspaceSeed??[])state.actions.setGroupExpanded(workspace.workspaceId,true);break}await new Promise(r=>setTimeout(r,10))}
finishFixtureCatalogue();
globalThis.fixture={ctx,account:fixtureAccount,created:()=>created,sidebarComponent:nativeSidebarComponent,nativeWorkspaceEntry,nativeWorkspaceComponent,workspaceData:{sessions:sessionList,workspaces:workspaceList,status:sessionStatus},selectedPanel:()=>panel};
`

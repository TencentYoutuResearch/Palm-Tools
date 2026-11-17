/** Browser boot for the released client Session stack: session-controller ClientSessions,
 * ui-session, ui-conversation, attachment/model/commands seats and the real Orbit Main.
 * Only the Remote RPC namespace below ClientSessions is a controlled fixture; every
 * frame it serves follows the session-controller wire types. No model ever runs. */
export const nativeModules = {
  '/fixture-native/gateway.js': ['@deepseek-ai/dsh-api-gateway', 'lib/client.browser.js'],
  '/fixture-native/session-controller.js': ['@deepseek-ai/dsh-api-session-controller', 'lib/client.js'],
  '/fixture-native/ui-session.js': ['@deepseek-ai/dsh-client-ui-session', 'lib/client.js'],
  '/fixture-native/file-upload.js': ['@deepseek-ai/dsh-client-file-upload', 'lib/client.js'],
  '/fixture-native/input-trigger.js': ['@deepseek-ai/dsh-client-ui-input-trigger', 'lib/client.js'],
  '/fixture-native/commands.js': ['@deepseek-ai/dsh-client-ui-commands', 'lib/client.js'],
  '/fixture-native/model-selection.js': ['@deepseek-ai/dsh-client-ui-model-selection', 'lib/client.js'],
  '/fixture-native/attachment.js': ['@deepseek-ai/dsh-client-ui-attachment', 'lib/client.js'],
  '/fixture-native/resources.js': ['@deepseek-ai/dsh-client-resources', 'lib/client.js'],
}

export const nativeBoot = `
const modules=globalThis.__KODE_TEST_MODULES__, plugins={};
window.consoleErrors=[];for(const level of ['error','warn']){const original=console[level].bind(console);console[level]=(...args)=>{consoleErrors.push(level+': '+args.map(a=>a?.stack??String(a)).join(' ').slice(0,400));original(...args)}}
const resolveModule=name=>{if(name in modules)return modules[name];if(name in plugins)return plugins[name];const base=name.split('/').slice(0,name.startsWith('@')?2:1).join('/');if(base in plugins)return plugins[base];throw Error('Missing test module '+name)};
window.__ModuleLoader__={load(def){plugins[def.id]=def.factory(resolveModule)}};
const load=src=>new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=reject;document.head.append(script)});
for(const src of ['/fixture-renderer.js','/fixture-theme.js','/fixture-sidebar.js','/fixture-brand.js','/fixture-settings-general.js','/fixture-workspace.js','/fixture-kode-client.js','/fixture-native/gateway.js','/fixture-native/session-controller.js','/fixture-native/ui-session.js','/fixture-native/file-upload.js','/fixture-conversation.js','/fixture-native/input-trigger.js','/fixture-native/commands.js','/fixture-native/model-selection.js','/fixture-native/attachment.js','/fixture-composer.js',...(window.fixtureNativeSession?.realSidebarRight?['/fixture-native/resources.js','/fixture-sidebar-right.js']:[]),'/fixture-collab.js'])await load(src);
const originalFetch=window.fetch.bind(window);window.fetch=async(path,init={})=>originalFetch(path,{...init,headers:{...init.headers,'x-fixture-owner':'yes'}});
const React=modules.react,h=React.createElement,{Context}=modules['@deepseek-ai/cordis'],ctx=new Context();
plugins['@deepseek-ai/dsh-client-ui-renderer'].apply(ctx);
ctx.slots.onEntryError((key,_entry,error)=>fixtureErrors.push(key+': '+String(error?.message??error)));
const dictionaries=new Map(),localeSnapshot={revision:0};
const locale={register:(name,values)=>{dictionaries.set(name,values.zh);return()=>dictionaries.delete(name)},subscribe:()=>()=>{},getSnapshot:()=>localeSnapshot,bind:name=>(key,values={})=>{let text=dictionaries.get(name)?.[key]??({'brand.localBuild':'DeepSeek Harness'}[key])??key;for(const [field,value]of Object.entries(values))text=text.split('{'+field+'}').join(String(value));return text}};
const observable=initial=>{let value=initial;const listeners=new Set();return{getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},publish:next=>{value=next;for(const fn of listeners)fn()}}};
const configValue=observable({value:undefined});
ctx.provide('locale',locale);const devTools=(()=>{let on=false;const fns=new Set();return{getSnapshot:()=>on,subscribe:fn=>{fns.add(fn);return()=>fns.delete(fn)},set:next=>{on=next;for(const fn of fns)fn()},writes:[]}})();window.fixtureDevTools=devTools;ctx.provide('configForms',{developerTools:{enabled:{getSnapshot:devTools.getSnapshot,subscribe:devTools.subscribe},setEnabled:async value=>{devTools.writes.push(value)}},get:()=>configValue});plugins['@deepseek-ai/dsh-client-ui-theme'].apply(ctx);
ctx.slots.installLocale({getSnapshot:()=>({revision:0}),subscribe:()=>()=>{},bind:locale.bind});

// ── Remote RPC boundary (the only controlled layer) ────────────────────────
const seed=window.fixtureNativeSession, gateway=plugins['@deepseek-ai/dsh-api-gateway'];
const wire=window.nativeWire={calls:[],prompts:[]};
const generation=observable({host:{home:'/fixture',id:'fixture'}});
const connection={interactions:'answer',isLoopback:false,generation,state:{getSnapshot:()=>'connected',subscribe:()=>()=>{}},reconnect(){},rpc:{call:async()=>{throw Error('fixture rpc')}},start:()=>({stop(){}}),openWebSocket(){throw Error('fixture has no socket')}};
const forever=signal=>new Promise((_,reject)=>{if(signal?.aborted)return reject(signal.reason);signal?.addEventListener('abort',()=>reject(signal.reason),{once:true})});
const summary=(id=seed.id)=>({agentAvailable:true,sessionId:id,updatedAt:seed.updatedAt,running:false,blank:false,cwd:seed.cwd});
// Sessions a scenario reports as created on the server side (e.g. a handoff successor); same shape as the seed.
window.fixtureNativeExtra=[];
const unsupported=name=>async()=>{wire.calls.push([name]);return{ok:false,error:Object.assign(Error('fixture: '+name+' is not served'),{code:'gateway/unsupported'})}};
const listeners=new Map();
const sessionRemote={
 control:async function*(signal){wire.calls.push(['control']);yield{type:'baseline',value:{projections:{}}};await forever(signal)},
 list:async()=>{wire.calls.push(['list']);return{ok:true,value:{items:[summary(),...window.fixtureNativeExtra.map(id=>summary(id))]}}},
 projections:async({sessionId})=>{wire.calls.push(['projections',sessionId]);return{ok:true,value:{kind:'sequenced',asOfSeq:0,values:{}}}},
 follow:async function*(request,signal){
  const id=request.address?.sessionId??request.address?.childSessionId??request.address;wire.calls.push(['follow',id]);
  yield{type:'snapshot',header:{version:4,id,createdAt:seed.createdAt,cwd:seed.cwd,isSeeded:false},cursor:-1,records:[],hasMore:false,projections:{asOfSeq:-1,values:seed.projections??{}},assistantStream:{revision:0}};
  await forever(signal)},
 page:async()=>({ok:true,value:{records:[],hasMore:false}}),
 modelCatalog:async()=>{wire.calls.push(['modelCatalog']);return{ok:true,value:seed.modelCatalog}},
 search:async()=>({ok:true,value:{items:[],hasMore:false}}),
 prompt:async request=>{wire.prompts.push(request);return{ok:false,error:Object.assign(Error('fixture never runs a model'),{code:'gateway/unsupported'})}},
};
for(const name of ['create','fork','rename','cancel','attachment','updateQueue','models','setModel'])sessionRemote[name]??=unsupported('session.'+name);
const remote={
 $host:{home:'/fixture',isLoopback:false,id:'fixture',name:'测试主机'},
 $stream:options=>new gateway.RemoteStream(connection,options),
 $on:(event,fn)=>{if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(fn);return()=>listeners.get(event).delete(fn)},
 directoryPicker:{},session:sessionRemote,commands:{list:async()=>({ok:true,value:[]}),execute:unsupported('commands.execute')},subagents:{interruptByParent:unsupported('subagents.interruptByParent')},
};
ctx.provide('connection',connection);ctx.provide('remote',remote);for(const name of ['session','commands','subagents','directoryPicker'])ctx.provide('remote.'+name,remote[name]);
ctx.provide('typert',{contexts:{registerClient:()=>()=>{}},remotes:{register:()=>async()=>{}}});
const access=observable(true);ctx.provide('remoteAccess',{source:()=>access});

// ── Released client Session stack ───────────────────────────────────────────
plugins['@deepseek-ai/dsh-client-file-upload'].apply(ctx);
plugins['@deepseek-ai/dsh-api-session-controller'].apply(ctx);
plugins['@deepseek-ai/dsh-client-ui-session'].apply(ctx);
// The real right Sidebar (pinned panel-host patch) replaces the inert face below when a scenario asks for it.
const realSidebarRight=!!seed.realSidebarRight;if(realSidebarRight)plugins['@deepseek-ai/dsh-client-resources'].apply(ctx);

let panel=null,collapsed=false,changed=new Set(),panelState={activePanelId:null};
const subscribe=fn=>{changed.add(fn);return()=>changed.delete(fn)};
const panelInfo={getSnapshot:()=>panelState,subscribe};
const panelLog=window.nativePanels=[];let rightbarShown=false;const rightbarLog=window.nativeRightbar=[];
ctx.provide('layout',{panelInfo,beginNavigation(){return new AbortController().signal},selectPanel(id){panelLog.push(id);panel=id;panelState={activePanelId:id};for(const fn of changed)fn()},toggleSidebar(){collapsed=!collapsed;for(const fn of changed)fn()},openRightbar(track,fullscreen){rightbarLog.push(['open',track,fullscreen]);rightbarShown=true;for(const fn of changed)fn()},closeRightbar(){rightbarLog.push(['close']);rightbarShown=false;for(const fn of changed)fn()}});
ctx.slots.provideRoot({hooks:{panelInfo},keyedHooks:{}});
const workspaceList=observable({phase:'ready',state:'ready',items:[],archivedSessionIds:[],pinnedSessionIds:[]});
const denied=()=>{throw Error('This controlled fixture cannot mutate a real workspace')};
ctx.provide('workspaces',{list:workspaceList,initializeDefault:async()=>undefined,create:denied,rename:denied,delete:denied,insertBefore:denied});
const shortcutRows=[];ctx.provide('shortcuts',{register:()=>()=>{},catalog:{getSnapshot:()=>shortcutRows,subscribe:()=>()=>{}},closeWindow:async()=>{}});
if(!realSidebarRight)ctx.provide('sidebarRight',{open(){},close(){},toggle(){},register:()=>()=>{}});

const usePanel=()=>React.useSyncExternalStore(subscribe,()=>String(panel)+String(collapsed)+String(rightbarShown));
function Frame({renderSlot}){usePanel();return h('div',{id:'fixture-frame',style:{gridTemplateColumns:(collapsed?'56px minmax(0,1fr)':'260px minmax(0,1fr)')+(realSidebarRight?(rightbarShown?' 420px':' 0px'):'')}},renderSlot('sidebar',{collapsed,width:260}),h('main',{id:'fixture-main'},renderSlot('main',{}, {entryKey:panel??'conversation'})),renderSlot('fixture.rightbar',{}),realSidebarRight?h('aside',{'data-fixture-native-rightbar':'',style:{position:'relative',height:'100%',width:rightbarShown?420:0,overflow:'hidden',display:'flex',flexDirection:'column',background:'var(--dsw-alias-bg-base)',borderLeft:rightbarShown?'1px solid var(--dsw-alias-border-l2)':'none',zIndex:2}},renderSlot('rightbar',{width:420,viewportWidth:window.innerWidth,canShow:true})):null)}
ctx.slots.register({name:'root',children:{sidebar:{kind:'single',scope:'root'},main:{kind:'keyed',scope:'root'},'shell.leading':{kind:'single',scope:'root'},'fixture.rightbar':{kind:'single',scope:'root'},rightbar:{kind:'single',scope:'root'}}},Frame);
// A second writer for the same Session, shaped like the native right Sidebar: its own
// sidebarView reference, SessionProvider and embedded Conversation (the subagent
// ConversationSlotPanel occurrence), kept mounted but hidden while a panel is active.
const sidebarWriter=window.fixtureSidebarWriter=observable(false);
function FixtureRightbar({SessionProvider,renderSlot}){
 const on=React.useSyncExternalStore(sidebarWriter.subscribe,sidebarWriter.getSnapshot);usePanel();
 const [reference,setReference]=React.useState(null);
 React.useEffect(()=>{if(!on)return;const r=ctx.get('sessions').retain(seed.id,{source:'sidebarView'});setReference(r);return()=>{setReference(null);r.release()}},[on]);
 if(!on||!reference)return null;
 return h('aside',{'data-fixture-rightbar':'',hidden:panel!==null,style:{position:'fixed',top:0,right:0,bottom:0,width:420,display:panel!==null?'none':'flex',flexDirection:'column',background:'var(--dsw-alias-bg-base)',borderLeft:'1px solid var(--dsw-alias-border-l2)',zIndex:1}},h(SessionProvider,{session:reference},renderSlot('fixture.sidebar.conversation',{})))}
ctx.slots.register({name:'fixture.rightbar',children:{'fixture.sidebar.conversation':{kind:'single',scope:'session'}}},FixtureRightbar);
ctx.slots.register({name:'fixture.sidebar.conversation'},({renderFactorySlot})=>renderFactorySlot('conversation.content',{variant:'embedded',phase:'active',hero:false},{slots:{views:p=>p.renderSlot('conversation.session',{view:'chat'})}}));
(plugins['@kode/dsh-sidebar'] ?? plugins['@deepseek-ai/dsh-client-ui-sidebar']).apply(ctx);
plugins['@deepseek-ai/dsh-client-ui-brand-official'].apply(ctx);
plugins['@deepseek-ai/dsh-client-ui-workspace'].apply(ctx);
const nativeWorkspaceEntry=ctx.slots.entries('sidebar.workspaces').find(entry=>entry.store);
ctx.slots.inject('sidebar.workspaces.directoryFlow',()=>ctx.slots.register({name:'sidebar.workspaces.directoryFlow'},()=>null));
window.fixtureConversationId=plugins['@kode/dsh-conversation']?'@kode/dsh-conversation':'@deepseek-ai/dsh-client-ui-conversation';plugins[fixtureConversationId].apply(ctx);
plugins['@deepseek-ai/dsh-client-ui-input-trigger'].apply(ctx);
plugins['@deepseek-ai/dsh-client-ui-commands'].apply(ctx);
plugins['@deepseek-ai/dsh-client-ui-model-selection'].apply(ctx);
plugins['@deepseek-ai/dsh-client-ui-attachment'].apply(ctx);
plugins['@deepseek-ai/dsh-client-ui-settings-general'].apply(ctx);
const appearance=plugins['@kode/dsh/client'].createAppearanceFacade(ctx);appearance.installStyles();ctx.provide('kodeAppearance',appearance);ctx.provide('kodeAgentControls',plugins['@kode/dsh/client'].createAgentControlsFacade());
if(window.fixtureSettings)ctx.provide('kodeSettings',plugins['@kode/dsh/client'].createSettingsFacade());
if(plugins['@kode/dsh-composer']?.apply)plugins['@kode/dsh-composer'].apply(ctx);

// Session-mode spy: records only; the real uiWorkspace.openSession still runs.
const uiWorkspace=ctx.get('uiWorkspace'),openSession=uiWorkspace.openSession.bind(uiWorkspace);
window.nativeOpened=[];uiWorkspace.openSession=(...args)=>{nativeOpened.push(args[0]);return openSession(...args)};
const sessions=ctx.get('sessions'),retain=sessions.retain.bind(sessions);
// Fill faults at the native boundaries: 'throw'/'blocked' at the conversation input
// facade (blocked is a real native result), 'unbound' makes offerPlanningText find no
// Session binding (its input_unavailable path). Every request is recorded unchanged.
window.fixtureFill=[];wire.inits=[];wire.faults=[];
ctx.inject(['conversation'],scope=>{const input=scope.get('conversation').input;if(input.fixtureSpied)return;input.fixtureSpied=true;const initialize=input.requestDraftInitialization.bind(input);
 input.requestDraftInitialization=(binding,options)=>{wire.inits.push(options);if(fixtureFill[0]==='throw'||fixtureFill[0]==='blocked'){const fault=fixtureFill.shift();wire.faults.push(fault);if(fault==='throw')throw Error('fixture fill fault');return fault}return initialize(binding,options)}});
const lookup=sessions.binding.bind(sessions);
sessions.binding=id=>{if(fixtureFill[0]==='unbound'&&String(new Error().stack).includes('offerPlanningText')){wire.faults.push(fixtureFill.shift());return undefined}return lookup(id)};
window.nativeRetains=[];sessions.retain=(target,options)=>{const row={id:target,source:options?.source,released:false};nativeRetains.push(row);const reference=retain(target,options);const release=reference.release.bind(reference);reference.release=()=>{row.released=true;return release()};return reference};

if(realSidebarRight)plugins['@kode/dsh-sidebar-right'].apply(ctx);
plugins['@kode/dsh-collab'].apply(ctx);ctx.uiRenderer.mount(document.getElementById('root'));
await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
workspaceList.publish({...workspaceList.getSnapshot(),items:globalThis.fixtureWorkspaceSeed??[]});
globalThis.fixture={ctx,nativeWorkspaceEntry,workspaceData:{sessions:sessions.list,workspaces:workspaceList},selectedPanel:()=>panel};
`

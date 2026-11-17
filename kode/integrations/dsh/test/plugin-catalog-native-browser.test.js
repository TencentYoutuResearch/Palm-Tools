/** Real shipped PluginManagerPage + renderer/slot runtime; only remote data is synthetic. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFile,mkdtemp,rm} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {collabRenderPage} from './support/collab-render-page.js'
import {headlessBrowser} from './support/headless-browser.js'
const require=createRequire(import.meta.url)
const boot=`
const modules=window.__KODE_TEST_MODULES__,plugins={};
window.__ModuleLoader__={load:def=>plugins[def.id]=def.factory(name=>plugins[name]??modules[name])};
const load=src=>new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=reject;document.head.append(s)});
await load('/fixture-renderer.js');await load('/native-plugins.js');
const React=modules.react,h=React.createElement,{Context}=modules['@deepseek-ai/cordis'],ctx=new Context();
plugins['@deepseek-ai/dsh-client-ui-renderer'].apply(ctx);
ctx.slots.onEntryError((key,e,error)=>fixtureErrors.push(key+': '+String(error)));
const dictionaries=new Map(),snapshot={revision:0};
const locale={register:(ns,d)=>{dictionaries.set(ns,d.zh);return()=>{}},getSnapshot:()=>snapshot,subscribe:()=>()=>{},resolveText:t=>typeof t==='string'?t:t?.zh??'',bind:ns=>(key,vars={})=>{let t=dictionaries.get(ns)?.[key]??key;for(const [k,v]of Object.entries(vars))t=t.replaceAll('{'+k+'}',String(v));return t}};
ctx.provide('locale',locale);ctx.slots.installLocale({getSnapshot:()=>snapshot,subscribe:()=>()=>{},bind:locale.bind});
const observable=value=>({getSnapshot:()=>value,subscribe:()=>()=>{}});
const binding=observable({key:undefined,hooks:{},keyedHooks:{},props:{}});ctx.slots.installScope('session',{current:binding,bindingSource:()=>binding,renderArea:(_,props)=>props.children});
ctx.provide('configForms',{describe:()=>observable({view:{namespaces:[]}}),get:()=>observable({})});
ctx.provide('layout',{panelInfo:observable({activePanelId:'plugins'}),selectPanel(){}});
window.reads=0;window.mutations=0;
const inventory={list:async()=>{reads++;return{ok:true,value:{managementAvailable:true,entries:[{entryId:'kode',moduleName:'@kode/dsh',enabled:true,fiberPhase:'active'}]}}}};
ctx.provide('remote',{$on:()=>()=>{},pluginInventory:inventory,pluginManager:{registries:async()=>({ok:false,error:{code:'fixture-unavailable'}}),listBundles:async()=>({ok:true,value:[]}),listPlugins:async()=>({ok:true,value:[]}),install:async()=>{mutations++;throw Error('Unexpected install')}},pluginRegistryProbe:{}});
ctx.provide('remote.pluginInventory',inventory);
ctx.slots.register({name:'root',children:{main:{kind:'keyed',scope:'root'},'sidebar.panellist':{kind:'list',scope:'root'},'shell.overlay':{kind:'list',scope:'root'}}},({renderSlot})=>h('main',null,renderSlot('main',{}, {entryKey:'plugins'}),renderSlot('shell.overlay',{})));
plugins['@deepseek-ai/dsh-client-ui-plugin-manager'].apply(ctx);
ctx.uiRenderer.mount(document.getElementById('root'));window.fixture={ctx};
`
test('Kode is managed as @kode/dsh in the native Plugins list, with no parallel Kode tab',{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:60000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'kode-plugin-native-'));let server,browser
 try{
 const index=await readFile(join(dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')),'dist/index.html'),'utf8')
 const script=index.match(/src="\.\/(assets\/index-[^"]+\.js)"/)[1]
 server=createServer(async(req,res)=>{
  if(req.url==='/'){res.setHeader('content-type','text/html');res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>window.fixtureErrors=[];addEventListener('error',e=>fixtureErrors.push(e.message));addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason)))</script><script type="module">import '/${script}';${boot}</script></body></html>`);return}
  if(req.url==='/native-plugins.js'){res.setHeader('content-type','text/javascript');res.end(await readFile(require.resolve('@deepseek-ai/dsh-client-ui-plugin-manager/client')));return}
  if(req.url.startsWith('/api/kode/')){res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.includes('agent-hub')?{sources:[]}:{state:'disabled',authorized_connections:0,provider_health:'not_checked'}));return}
  if(await collabRenderPage(req,res))return;res.writeHead(404);res.end()
 });server.listen(0,'127.0.0.1');await once(server,'listening')
 browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);const page=await browser.page(`http://127.0.0.1:${server.address().port}/`)
 const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+12000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,25))}throw Error('Native plugin wait: '+document.body.innerText+' errors='+JSON.stringify(fixtureErrors))})()`)
 const click=text=>page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`)
 await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='添加插件'&&!b.disabled)`)
 assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('[role=tab],button')).some(b=>b.textContent.trim()==='Kode')`),false,'no parallel Kode plugins tab')
 await wait(`document.body.innerText.includes('@kode/dsh')||reads>0`)
 await click('添加插件');await wait(`document.body.innerText.includes('输入插件的包名、GitHub 仓库地址或本地目录路径。')`)
 assert.equal(await page.evaluate('mutations'),0)
 assert.deepEqual(await page.evaluate('fixtureErrors'),[])
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await rm(profile,{recursive:true,force:true})}
})

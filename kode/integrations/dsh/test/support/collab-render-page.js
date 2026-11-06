/** Pinned shipped React/slot renderer, with a small test shell instead of dsh boot/session services. */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
const require = createRequire(import.meta.url)
const dist = join(dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist')
const renderer = require.resolve('@deepseek-ai/dsh-client-ui-renderer/client')
export async function collabRenderPage(req, res) {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path === '/') {
    const index = await readFile(join(dist, 'index.html'), 'utf8')
    const script = index.match(/src="\.\/(assets\/index-[^"]+\.js)"/)[1]
    const styles = [...index.matchAll(/href="\.\/(assets\/[^\"]+\.css)"/g)].map(match => `<link rel="stylesheet" href="/${match[1]}">`).join('')
    res.setHeader('content-type', 'text/html'); res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<style>html,body,#root{height:100%;margin:0}#fixture-frame{height:100%;display:grid;grid-template-columns:260px minmax(0,1fr)}#fixture-main{min-width:0;height:100%;overflow:hidden}.fixture-native-sidebar{padding:16px}</style></head><body><div id="root"></div><script>window.fixtureErrors=[];addEventListener("error",e=>fixtureErrors.push(e.message));addEventListener("unhandledrejection",e=>fixtureErrors.push(String(e.reason)))</script><script type="module">import '/${script}';${boot}</script></body></html>`); return true
  }
  let body, mime = 'text/javascript'
  if (path === '/fixture-renderer.js') body = await readFile(renderer)
  else if (path === '/fixture-theme.js') body = await readFile(require.resolve('@deepseek-ai/dsh-client-ui-theme/client'))
  else if (path === '/fixture-collab.js') body = await readFile(new URL('../../packages/collab/client.js', import.meta.url))
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
window.__ModuleLoader__={load(def){plugins[def.id]=def.factory(name=>{if(!(name in modules))throw Error('Missing test module '+name);return modules[name]})}};
const load=src=>new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=reject;document.head.append(script)});
await load('/fixture-renderer.js');await load('/fixture-theme.js');await load('/fixture-collab.js');
const originalFetch=window.fetch.bind(window);window.fetch=(path,init={})=>originalFetch(path,{...init,headers:{...init.headers,'x-fixture-owner':'yes'}});
const React=modules.react,h=React.createElement,{Context}=modules['@deepseek-ai/cordis'],ctx=new Context();
plugins['@deepseek-ai/dsh-client-ui-renderer'].apply(ctx);
ctx.provide('locale',{register:()=>()=>{}});ctx.provide('configForms',{get:()=>({getSnapshot:()=>({value:undefined}),subscribe:()=>()=>{}})});plugins['@deepseek-ai/dsh-client-ui-theme'].apply(ctx);
const absent={key:undefined,hooks:{},keyedHooks:{},props:{}};const binding={getSnapshot:()=>absent,subscribe:()=>()=>{}};ctx.slots.installScope('session',{current:binding,bindingSource:()=>binding,renderArea:(_,props)=>props.children});
ctx.slots.installLocale({getSnapshot:()=>({revision:0}),subscribe:()=>()=>{},bind:()=>key=>key});
let panel=null,changed=new Set(),created=0;
ctx.provide('layout',{selectPanel(id){panel=id;for(const fn of changed)fn()},toggleSidebar(){}});
ctx.provide('uiWorkspace',{startSession(){created++}});
const usePanel=()=>React.useSyncExternalStore(fn=>{changed.add(fn);return()=>changed.delete(fn)},()=>panel);
function Frame({renderSlot}){const active=usePanel();return h('div',{id:'fixture-frame'},renderSlot('sidebar',{collapsed:false,width:260}),h('main',{id:'fixture-main'},renderSlot('main',{}, {entryKey:active??'conversation'})))}
ctx.slots.register({name:'root',children:{sidebar:{kind:'single',scope:'root'},main:{kind:'keyed',scope:'root'},'shell.leading':{kind:'single',scope:'root'}}},Frame);
ctx.slots.register({name:'sidebar',locale:'sidebar',children:{'sidebar.settings':{kind:'single',scope:'root'},'sidebar.footer.action':{kind:'list',scope:'root'}},inject:()=>({toggleSidebar(){}})},({renderSlot})=>h('aside',{className:'fixture-native-sidebar'},h('p',null,'Session fixture'),renderSlot('sidebar.footer.action',{wide:true})));
ctx.slots.register({name:'shell.leading',locale:'sidebar',inject:()=>({toggleSidebar(){}})},()=>null);
ctx.slots.register({name:'main',key:'conversation'},()=>h('p',null,'Native Session placeholder'));
plugins['@kode/dsh-collab'].apply(ctx);ctx.uiRenderer.mount(document.getElementById('root'));
globalThis.fixture={ctx,created:()=>created};
`

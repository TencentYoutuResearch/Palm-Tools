import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { headlessBrowser } from './support/headless-browser.js'
import { collabRenderPage } from './support/collab-render-page.js'
const bundle=(await build({absWorkingDir:fileURLToPath(new URL('..',import.meta.url)),entryPoints:['packages/collab/component-adapter.js'],bundle:true,format:'cjs',platform:'browser',external:['react'],write:false})).outputFiles[0].text
const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),useSyncExternalStore:(_subscribe,get)=>get()}
const module={exports:{}};vm.runInNewContext(bundle,{module,exports:module.exports,require:name=>{assert.equal(name,'react');return React}})
const {adaptSlotComponent}=module.exports
const h=React.createElement,Native=props=>h('p',{'data-native':'yes'},props.value),layer=name=>({native:Original,...props})=>h('section',{'data-plugin':name},h(Original,props))
function markup(node){if(node==null)return '';if(typeof node==='string')return node;if(typeof node.type==='function')return markup(node.type(node.props));return '<'+node.type+Object.entries(node.props).filter(([k])=>k!=='children').map(([k,v])=>' '+k+'="'+v+'"').join('')+'>'+node.props.children.map(markup).join('')+'</'+node.type+'>'}
const render=entry=>markup(h(entry.component,{value:'original props'}))
test('a later ordinary plugin may keep the adapter after deactivation and still forward safely',()=>{
 const entry={component:Native},ours=adaptSlotComponent(entry,layer('collab')),captured=entry.component
 const Later=props=>h('aside',{'data-later':'yes'},h(captured,props));entry.component=Later
 assert.match(render(entry),/collab/);ours.deactivate()
 assert.equal(entry.component,Later);assert.doesNotMatch(render(entry),/collab/);assert.match(render(entry),/original props/)
 entry.component=captured;assert.doesNotMatch(render(entry),/collab/);ours.deactivate();assert.equal(entry.component,captured)
})
test('before/ours/after adapters tolerate all six unload orders without resurrecting disposed components',()=>{
 for(const order of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]){
  const entry={component:Native},adapters=['before','ours','after'].map(name=>adaptSlotComponent(entry,layer(name))),disposed=new Set()
  for(const index of order){adapters[index].deactivate();disposed.add(['before','ours','after'][index]);const html=render(entry);for(const name of disposed)assert.doesNotMatch(html,new RegExp('data-plugin="'+name+'"'));assert.match(html,/original props/)}
  assert.equal(render(entry),markup(h(Native,{value:'original props'})))
 }
})
test('entry replacement owned by another plugin is never overwritten during unload',()=>{
 const entry={component:Native},ours=adaptSlotComponent(entry,layer('collab')),Replacement=()=>h('p',null,'replacement')
 entry.component=Replacement;ours.deactivate();assert.equal(entry.component,Replacement)
 assert.equal(render(entry),'<p>replacement</p>')
})

test('mounted real React subscriber removes the enhanced component while a later plugin retains the wrapper',{
 skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:30000,
},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'adapter-react-'));let browser,server
 try{
  server=createServer(async(req,res)=>{if(req.url==='/adapter-test.js'){res.setHeader('content-type','text/javascript');res.end(bundle);return}if(await collabRenderPage(req,res))return;res.writeHead(404);res.end()})
  server.listen(0,'127.0.0.1');await once(server,'listening');browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile)
  const page=await browser.page('http://127.0.0.1:'+server.address().port)
  const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,20))}throw Error('adapter React condition not reached')})()`)
  await wait('globalThis.fixture')
  await page.evaluate(`(async()=>{const React=globalThis.__KODE_TEST_MODULES__.react,h=React.createElement,code=await(await fetch('/adapter-test.js')).text(),module={exports:{}};new Function('require','module','exports',code)(name=>{if(name!=='react')throw Error('unexpected dependency');return React},module,module.exports);globalThis.adapterProbe={renders:0,mounts:0,unmounts:0,disposed:false};const Native=props=>h('p',{id:'adapter-native'},props.value);function Enhanced({native:Original,...props}){if(adapterProbe.disposed)throw Error('disposed Enhanced rendered');adapterProbe.renders++;React.useEffect(()=>{adapterProbe.mounts++;return()=>{adapterProbe.unmounts++}},[]);return h('div',{id:'adapter-enhanced'},h(Original,props))}const entry={component:Native};const adapter=module.exports.adaptSlotComponent(entry,Enhanced),captured=entry.component;const Later=props=>h('section',{id:'adapter-later'},h(captured,props));entry.component=Later;adapterProbe.entry=entry;adapterProbe.Later=Later;adapterProbe.deactivate=()=>{adapterProbe.disposed=true;adapter.deactivate()};fixture.ctx.slots.register({name:'main',key:'adapter-probe'},()=>h(entry.component,{value:'native props preserved'}));fixture.ctx.layout.selectPanel('adapter-probe')})()`)
  await wait(`document.querySelector('#adapter-enhanced')&&adapterProbe.mounts===1`)
  const renders=await page.evaluate('adapterProbe.renders');await page.evaluate('adapterProbe.deactivate()')
  await wait(`!document.querySelector('#adapter-enhanced')&&document.querySelector('#adapter-native')?.textContent==='native props preserved'&&adapterProbe.unmounts===1`)
  assert.equal(await page.evaluate('adapterProbe.renders'),renders);assert.equal(await page.evaluate('adapterProbe.entry.component===adapterProbe.Later'),true)
  assert.equal(await page.evaluate(`!!document.querySelector('#adapter-later')`),true)
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}await rm(profile,{recursive:true,force:true})}
})

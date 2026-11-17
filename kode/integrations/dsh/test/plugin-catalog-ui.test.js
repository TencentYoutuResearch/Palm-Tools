import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import vm from 'node:vm'
import {readPluginCatalog, requestPluginCatalogJson} from '../packages/collab/plugin-catalog-model.js'
const entry = {entryId:'kode', moduleName:'@kode/dsh', enabled:true, fiberPhase:'active'}
const readers = () => ({inventory:async () => ({entries:[entry]}), request:async path => path.includes('agent-hub') ? {sources:[{id:'fixture',targets:['codex'],skills:['skill'],links:[{}],nativeEvidence:{codex:{basis:'skills_links_only'}}}]} : {state:'disabled', authorized_connections:0, provider_health:'not_checked'}})
test('federates existing read authorities without mutation or invented connectivity', async () => {
 const result = await readPluginCatalog(readers())
 assert.deepEqual(result.unavailable, [])
 assert.equal(result.catalog.kode.present, true)
 assert.equal(result.catalog.external_capabilities[0].connection_state, 'not_connected')
})
test('denied or malformed authorities are isolated and raw error secrets are never displayed', async () => {
 const fixture = readers()
 fixture.inventory = async () => {throw Error('PRIVATE')}
 fixture.request = async path => path.includes('agent-hub') ? {sources:'PRIVATE'} : {state:'disabled', authorized_connections:0}
 const result = await readPluginCatalog(fixture)
 assert.deepEqual(new Set(result.unavailable), new Set(['inventory','agentHub']))
 assert.equal(result.catalog.authorities.runtime, 'unavailable')
 assert.equal(result.catalog.external_capabilities[0].connection_state, 'not_connected')
 assert.ok(!JSON.stringify(result).includes('PRIVATE'))
})
test('HTTP reader only performs authenticated uncached GET and rejects forbidden responses', async () => {
 const original = globalThis.fetch; const calls=[]
 globalThis.fetch = async (...args) => {calls.push(args); return {ok:false, status:403}}
 try {await assert.rejects(requestPluginCatalogJson('/api/kode/agent-hub'))} finally {globalThis.fetch = original}
 assert.equal(calls[0][1].method, 'GET'); assert.equal(calls[0][1].credentials, 'same-origin'); assert.equal(calls[0][1].cache, 'no-store')
})
const bundle = await build({entryPoints:[new URL('../packages/collab/plugin-catalog-ui.js',import.meta.url).pathname], bundle:true, platform:'browser', format:'cjs', write:false, external:['react','@deepseek-ai/dsh-client-ui-primitives']})
let hookState
const React = {createElement:(type,props,...children)=>({type,props,children}), useState:()=>[hookState,()=>{}], useReducer:()=>[0,()=>{}], useEffect:()=>{}}
const module = {exports:{}}
vm.runInNewContext(bundle.outputFiles[0].text, {module,exports:module.exports,require:name=>name==='react'?React:{Button:'NativeButton'}})
test('registers native management and legacy settings tabs through declared deferred service, never replaces native controls', () => {
 let callback; const calls=[]
 module.exports.installPluginCatalog({inject:(dependencies,cb)=>{assert.deepEqual(Array.from(dependencies),['remote.pluginInventory']);callback=cb}})
 assert.equal(calls.length,0)
 const scope={remote:{pluginInventory:{list:async()=>({ok:true,value:{entries:[entry]}})}},slots:{inject:(name,cb)=>{calls.push(name);cb()},register:(options)=>{calls.push(options);return ()=>{}}}}
 callback(scope)
 assert.equal(calls[0],'plugins.tab'); assert.equal(calls[2],'settings.plugins.tab'); assert.equal(calls[1].id,'kode'); assert.equal(calls[1].order,5)
})
test('synthetic rendering shows bundle, sync distinction and disconnected providers, using native button', async () => {
 hookState = await readPluginCatalog(readers())
 // The refresh is an icon button: expand it one level so the rendered native Button is part of the output.
 const expand = node => Array.isArray(node) ? node.map(expand) : node && typeof node === 'object' ? (typeof node.type === 'function' && node.type.name === 'IconButton' ? {iconButton:node.props.label, rendered:expand(node.type(node.props))} : {...node, props:node.props && {...node.props, children:undefined}, children:expand(node.children)}) : node
 const tree = expand(module.exports.PluginCatalog({inventory:readers().inventory}))
 const output = JSON.stringify(tree)
 assert.ok(output.includes('"iconButton":"刷新状态"'), 'refresh is a labelled icon button')
 assert.ok(output.includes('"aria-label":"刷新状态"'), 'refresh keeps an accessible name')
 for (const text of ['插件套件','TAPD','工蜂 Git','未连接','实际加载','NativeButton']) {
   assert.ok(output.includes(text),text)
 }
 assert.equal((output.match(/未连接 · 连通性未验证/g) ?? []).length, 2)
 hookState = null
 assert.ok(JSON.stringify(module.exports.PluginCatalog({inventory:readers().inventory})).includes('正在读取'))
})

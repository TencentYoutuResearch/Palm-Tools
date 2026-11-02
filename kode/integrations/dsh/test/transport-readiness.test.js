import test from 'node:test'
import assert from 'node:assert/strict'
import{waitForSessionService}from'../packages/transport/readiness.js'
import{readFile}from'node:fs/promises'
import vm from'node:vm'
const clientSource=await readFile(new URL('../packages/transport/client-source.js',import.meta.url),'utf8')
test('session subscription waits for the Host read endpoint without replaying any mutation',async()=>{
 const calls=[],statuses=[404,503,200]
 assert.equal(await waitForSessionService(async(path,options)=>{calls.push({path,options});const status=statuses.shift();return{status,ok:status===200}},new AbortController().signal,{timeoutMs:500,retryMs:1}),true)
 assert.equal(calls.length,3);assert.ok(calls.every(call=>call.options.method==='GET'&&call.path==='/api/kode/project-hosts'))
})
test('auth failures remain visible to the carrier and startup cancellation releases its wait',async()=>{
 let calls=0
 assert.equal(await waitForSessionService(async()=>{calls++;return{status:401,ok:false}},new AbortController().signal),false);assert.equal(calls,1)
 const stop=new AbortController(),waiting=waitForSessionService(async()=>({status:503,ok:false}),stop.signal,{timeoutMs:5000,retryMs:2000})
 stop.abort(new Error('unloaded'));await assert.rejects(waiting,/unloaded/)
})
for (const [page, carrier, expected] of [
 ['dsh-app://app/', { streamBaseUrl: 'http://127.0.0.1:49000', ownsHost: true }, 'ws://127.0.0.1:49000'],
 ['https://kode.example/', undefined, 'wss://kode.example'],
 ['http://localhost:49000/', undefined, 'ws://localhost:49000'],
]) test(`transport uses the physical Host carrier for ${page}`, async () => {
 class Socket { constructor(url) { this.url = new URL(url) } }
 let installed
 const ctx = {
  AbortController, URL, waitForSessionService,
  __DSH_TRANSPORT__: carrier,
  window: { location: new URL(page) }, WebSocket: Socket,
  fetch: async () => ({status:200, ok:true}),
  effect() {}, provide() {},
  installConnection(_ctx, options) { installed = options.transport },
 }
 vm.runInNewContext(clientSource.split('\n').filter(line => !line.startsWith('import ')).join('\n').replaceAll('export ', ''), ctx)
 await ctx.apply(ctx)
 assert.equal(installed.streamBaseUrl, carrier?.streamBaseUrl)
 assert.equal(installed.ownsHost, carrier?.ownsHost)
 for (const input of ['/api/remote.mux?probe=1', `${expected}/api/remote.mux?probe=1`]) {
  assert.equal(installed.createWebSocket(input).url.href, `${expected}/api/remote.mux?probe=1`)
 }
})

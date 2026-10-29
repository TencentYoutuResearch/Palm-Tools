import test from 'node:test'
import assert from 'node:assert/strict'
import { SidebarBrowserHost, browserUrl, viewportSize, viewportPixelRatio, screencastOptions, registerBrowserApi } from '../src/browser-host.js'

test('sidebar accepts web URLs without credential leaks and bounds the rendering viewport', () => {
  assert.equal(browserUrl('https://git.woa.com/a'), 'https://git.woa.com/a')
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:secret@example.com']) assert.throws(() => browserUrl(url))
  assert.deepEqual(viewportSize(-2, 80000), { width: 320, height: 2160 })
})
test('browser API denies nonowners before launching or dispatching any browser action', async () => {
  let handler
  const dispose = registerBrowserApi({ webServer: { register(value) { handler = value.handler; return () => {} } }, connection: { admit: () => ({ peer: { principal: { kind: 'agent' } } }) } })
  let status, body
  await handler({ method: 'POST', headers: { 'content-type': 'application/json' } }, { writeHead(value) { status = value }, end(value) { body = JSON.parse(value) } })
  assert.equal(status, 403); assert.equal(body.error, 'Host owner required'); await dispose()
})
test('browser follows blank popup targets using their announced URL and releases closed targets', async () => {
  const host = new SidebarBrowserHost(), events = [], calls = []
  host.rpc = { call: async (...args) => { calls.push(args); return {} }, socket: { close() {} } }
  host.pages.set('parent', { id: 'parent', targetId: 'parent-target', popupUrl: 'https://git.woa.com/mr/1', listeners: new Set([event => events.push(event)]) })
  await host.event({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'popup-target', openerId: 'parent-target', url: 'about:blank' } } })
  assert.deepEqual(events[0], { type: 'open', url: 'https://git.woa.com/mr/1' })
  assert.equal(calls[0][0], 'Target.closeTarget')
  await host.remove('parent'); assert.equal(host.pages.size, 0); assert.equal(events[1].type, 'closed')
  await host.close()
})
test('browser create failures release their target and concurrent retries share the same job', async () => {
  const host = new SidebarBrowserHost(), calls = []
  host.launch = async () => ({ call: async (method, args) => {
    calls.push([method, args]); if (method === 'Target.createTarget') return { targetId: 't' }
    if (method === 'Target.attachToTarget') return { sessionId: 's' }
    if (method === 'Page.navigate') return { errorText: 'net::ERR_NAME_NOT_RESOLVED' }
    return {}
  } })
  const input = { id: '0123456789abcdef', url: 'https://example.invalid' }
  const first = host.create(input), second = host.create(input)
  assert.equal(first, second); await assert.rejects(first, /ERR_NAME_NOT_RESOLVED/)
  assert.equal(host.pages.size, 0); assert.equal(host.creating.size, 0)
  assert.equal(calls.filter(([method]) => method === 'Target.closeTarget').length, 1)
  await host.close()
})

test('an unresponsive browser allocator is recovered once without restarting the Host',async()=>{
 const host=new SidebarBrowserHost(),events=[],calls=[]
 const dead={call:async()=>{throw new Error('浏览器响应超时：Target.createTarget')},socket:{close(){calls.push('close old socket')}}}
 const next={call:async(method)=>{calls.push(method);if(method==='Target.createTarget')return{targetId:'new'};if(method==='Target.attachToTarget')return{sessionId:'new-session'};return{}},socket:{close(){}}}
 host.rpc=dead
 host.pages.set('stale',{id:'stale',listeners:new Set([e=>events.push(e)])})
 let launches=0;host.launch=async()=>{host.rpc=++launches===1?dead:next;return host.rpc}
 try {
  const result=await host.create({id:'recovery-test-1234',url:'https://example.com'})
  assert.equal(result.id,'recovery-test-1234');assert.equal(launches,2)
  assert.equal(host.pages.has('stale'),false);assert.equal(events[0].type,'closed')
  assert.ok(calls.includes('close old socket'))
 }finally{await host.close()}
})

test('missing browser pages have a structured recoverable error and input focuses its own target',async()=>{
 const host=new SidebarBrowserHost(),calls=[]
 host.rpc={call:async(method,params)=>{calls.push([method,params]);return{}},socket:{close(){}}}
 try{
  await assert.rejects(host.action({id:'missing',action:'reload'}),error=>error.code==='BROWSER_TAB_GONE')
  host.pages.set('p',{id:'p',targetId:'target',sessionId:'s',size:{width:800,height:600},listeners:new Set(),state:{url:'https://old.example/'}})
  await host.action({id:'p',action:'text',text:'hello'})
  assert.ok(calls.findIndex(c=>c[0]==='Page.bringToFront')<calls.findIndex(c=>c[0]==='Input.insertText'));assert.ok(calls.some(c=>c[0]==='Emulation.setDeviceMetricsOverride'))
  await host.action({id:'p',action:'navigate',url:'https://new.example/'})
  assert.equal(host.pages.get('p').state.url,'https://new.example/')
 }finally{await host.close()}
})

test('frame coalescing retains the final visual update instead of dropping it',async()=>{
 const host=new SidebarBrowserHost(),frames=[],page={id:'p',targetId:'t',listeners:new Set([frame=>frames.push(frame.data)])};host.pages.set('p',page)
 try{host.queueFrame(page,{type:'frame',data:'one'});host.queueFrame(page,{type:'frame',data:'two'});host.queueFrame(page,{type:'frame',data:'three'});await new Promise(resolve=>setTimeout(resolve,90));assert.deepEqual(frames,['one','three'])}finally{await host.close()}
})

test('disconnecting a view after browser recovery never calls through a cleared RPC owner',async()=>{
 const host=new SidebarBrowserHost(),calls=[],page={id:'lease',sessionId:'old-session',size:{width:800,height:600},listeners:new Set(),state:{url:'https://example.com/'}}
 host.pages.set(page.id,page);host.rpc={call:async(method)=>{calls.push(method);return{data:'frame'}},socket:{close(){}}}
 const release=await host.subscribe(page.id,()=>{})
 host.rpc=undefined;assert.doesNotThrow(()=>release());assert.ok(calls.includes('Page.stopScreencast'))
 await host.close()
})

test('Retina backing frames keep CSS viewport dimensions and lossless detail', async () => {
  const size=viewportSize(576,644),pixelRatio=viewportPixelRatio(2,size)
  assert.equal(pixelRatio,2)
  assert.deepEqual(screencastOptions({size,pixelRatio}),{format:'png',maxWidth:1152,maxHeight:1288,everyNthFrame:1})
  assert.equal(viewportPixelRatio(100,size),2)
  const large=viewportSize(3840,2160),bounded=viewportPixelRatio(2,large)
  assert.ok(large.width*large.height*bounded**2<=8388609)
  const host=new SidebarBrowserHost(),calls=[]
  host.rpc={call:async(method,params)=>{calls.push({method,params});return{}}}
  host.pages.set('density-page',{id:'density-page',size,listeners:new Set([()=>{}]),sessionId:'density-session'})
  try {
    await host.action({action:'resize',id:'density-page',...size,pixelRatio:2})
    const metrics=calls.find(c=>c.method==='Emulation.setDeviceMetricsOverride').params
    assert.equal(metrics.width,576);assert.equal(metrics.height,644);assert.equal(metrics.deviceScaleFactor,2)
    assert.equal(calls.find(c=>c.method==='Page.startScreencast').params.maxWidth,1152)
  }finally{clearInterval(host.sweep)}
})

test('Retina captures coalesce dirty frames without concurrent screenshots and retain the last update', async () => {
  const host=new SidebarBrowserHost(), frames=[],pending=[]
  const page={id:'retina',sessionId:'s',pixelRatio:2,size:{width:576,height:644},listeners:new Set([frame=>frames.push(frame)])}
  host.pages.set(page.id,page)
  host.rpc={call:async(method,params)=>method==='Page.captureScreenshot'?new Promise(resolve=>pending.push({resolve,params})): {},socket:{close(){}}}
  try {
    host.queueCapture(page)
    await new Promise(resolve=>setTimeout(resolve,15))
    host.queueCapture(page);host.queueCapture(page)
    assert.equal(pending.length,1)
    assert.deepEqual(pending[0].params.clip,{x:0,y:0,width:576,height:644,scale:1})
    pending[0].resolve({data:'first'})
    await new Promise(resolve=>setTimeout(resolve,125))
    assert.equal(pending.length,2)
    pending[1].resolve({data:'final'})
    await new Promise(resolve=>setTimeout(resolve,125))
    assert.equal(pending.length,2,'static pages must not poll or self-schedule screenshots')
    assert.deepEqual(frames.map(frame=>frame.data),['first','final'])
    assert.deepEqual(frames[1].viewport,{width:576,height:644,scale:1,offsetTop:0})
    host.queueCapture(page);await host.remove(page.id)
    await new Promise(resolve=>setTimeout(resolve,15))
    assert.equal(pending.length,2,'closing a page cancels scheduled captures')
  } finally {await host.close()}
})

test('input reuses the focused page and restores metrics only when switching targets',async()=>{
 const host=new SidebarBrowserHost(),calls=[]
 host.rpc={call:async(method)=>{calls.push(method);return{}},socket:{close(){}}}
 for(const id of ['a','b'])host.pages.set(id,{id,sessionId:id,size:{width:576,height:644},pixelRatio:2,listeners:new Set()})
 try{
  for(let i=0;i<10;i++)await host.action({id:'a',action:'text',text:'x'})
  assert.equal(calls.filter(m=>m==='Page.bringToFront').length,1)
  assert.equal(calls.filter(m=>m==='Emulation.setDeviceMetricsOverride').length,1)
  await host.action({id:'b',action:'text',text:'y'});await host.action({id:'a',action:'text',text:'z'})
  assert.equal(calls.filter(m=>m==='Page.bringToFront').length,3)
  assert.equal(calls.filter(m=>m==='Input.insertText').length,12)
 }finally{await host.close()}
})

test('browser frames flush immediately through response buffering without waiting for another interaction',async()=>{
 const create=SidebarBrowserHost.prototype.create,subscribe=SidebarBrowserHost.prototype.subscribe
 let handler,close,delivered='',buffered='',headers
 SidebarBrowserHost.prototype.create=async function(input){this.pages.set(input.id,{id:input.id,listeners:new Set()});return{id:input.id}}
 SidebarBrowserHost.prototype.subscribe=async function(_id,send){send({type:'frame',data:'last-frame'});return()=>{}}
 const dispose=registerBrowserApi({connection:{admit:()=>({peer:{principal:{kind:'owner'}}})},webServer:{register(value){handler=value.handler;return()=>{}}}})
 try{
  await handler({method:'POST',headers:{'content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify({action:'create',id:'stream-page'})}},{writeHead(){},end(){}})
  await handler({method:'GET',url:'/api/kode/browser?stream=stream-page'},{writeHead(_status,value){headers=value},on(_event,fn){close=fn},write(value){buffered+=value},flush(){delivered+=buffered;buffered=''},end(){}})
  assert.match(delivered,/last-frame/)
  assert.equal(buffered,'')
  assert.match(headers['cache-control'],/no-transform/)
 }finally{close?.();await dispose();SidebarBrowserHost.prototype.create=create;SidebarBrowserHost.prototype.subscribe=subscribe}
})

test('high-density screenshots follow the scrolled CSS viewport instead of capturing a blank document origin',async()=>{
 const host=new SidebarBrowserHost();let capture
 host.rpc={call:async(method,params)=>{if(method==='Page.getLayoutMetrics')return{cssVisualViewport:{pageX:12,pageY:1400},visualViewport:{pageX:24,pageY:2800}};capture=params;return{data:'scrolled-frame'}},socket:{close(){}}}
 try{
  assert.equal((await host.capture({sessionId:'s',size:{width:576,height:644}})).data,'scrolled-frame')
  assert.deepEqual(capture.clip,{x:12,y:1400,width:576,height:644,scale:1})
  assert.equal(capture.optimizeForSpeed,true)
 }finally{await host.close()}
})

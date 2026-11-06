import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { headlessBrowser } from './support/headless-browser.js'
import { collabRenderPage } from './support/collab-render-page.js'

test('real browser virtualizes variable-height history and retains visible nodes, draft and anchor under a 1000-message burst', { skip: !process.env.KODE_TEST_BROWSER_BIN, timeout: 45000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kode-message-window-'))
  let browser, server
  try {
    const result = await build({ stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {MessageWindow} from './packages/collab/message-window.js';
      import {createCollabData} from './packages/collab/data.js';
      const h=React.createElement; const team={id:'team',superagent_id:'super',conversation_id:'dm',home_hub:'home',spec:{name:'Team'}};
      const store=createCollabData({request:async()=>({home_hub:'home',projection:'configuration_revision',items:[team],next_cursor:null}),schedulePublish:requestAnimationFrame,cancelPublish:cancelAnimationFrame});
      const message=n=>({id:'m'+n,sequence:n,home_hub:'home',team_id:'team',conversation_id:'dm',actor:{kind:'human'},content:('Message '+n+'\\n').repeat(n%7+1)});
      let renders=0,savedScroll=0,toggle; const heightCache=new Map(); function App(){const state=React.useSyncExternalStore(store.subscribe,store.getSnapshot),ref=React.useRef(null),[visible,setVisible]=React.useState(true);toggle=()=>setVisible(v=>!v);React.useLayoutEffect(()=>{if(visible&&ref.current)ref.current.scrollTop=savedScroll},[visible]); renders++;return h('div',{style:{height:600,display:'flex',flexDirection:'column'}},visible?h(MessageWindow,{items:state.conversations.dm?.items??[],team,heightCache,scrollRef:ref,onScroll:e=>savedScroll=e.currentTarget.scrollTop}):h('p',null,'Session'),h('textarea',{'aria-label':'performance draft',defaultValue:'keep me'}))}
      store.loadTeams().then(()=>{const container=document.createElement('div');container.id='performance-window';container.style='position:fixed;inset:0;background:white;z-index:9999';document.body.append(container);createRoot(container).render(h(App));
      window.performanceFixture={append(start,count){for(let n=start;n<start+count;n+=50){const items=Array.from({length:Math.min(50,start+count-n)},(_,i)=>message(n+i));store.acceptMessagePage('dm',{home_hub:'home',team_id:'team',conversation_id:'dm',items,has_more:false,next_cursor:null})}},renders:()=>renders,toggle:()=>toggle()};});
    `, resolveDir: process.cwd(), sourcefile: 'performance-entry.js' }, bundle: true, format: 'iife', platform: 'browser', external: ['react', 'react-dom/client'], write: false, banner: { js: `const require=name=>window.__KODE_TEST_MODULES__[name];` } })
    server = createServer(async (req, res) => {
      if (req.url === '/performance.js') { res.setHeader('content-type', 'text/javascript'); res.end(result.outputFiles[0].text); return }
      // The actual shipped module loader provides the pinned React and renderer.
      if (await collabRenderPage(req, res)) return
      res.writeHead(404); res.end()
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    const page = await browser.page(`http://127.0.0.1:${server.address().port}/`)
    await page.evaluate(`new Promise((resolve,reject)=>{const wait=()=>{if(!window.fixture)return setTimeout(wait,20);const s=document.createElement('script');s.type='module';s.src='/performance.js';s.onload=resolve;s.onerror=reject;document.head.append(s)};wait()})`)
    const initial = await page.evaluate(`(async()=>{performanceFixture.append(1,5000);await new Promise(r=>setTimeout(r,200));const root=document.querySelector('#performance-window .kode-collab-messages');root.scrollTop=180000;root.dispatchEvent(new Event('scroll'));await new Promise(r=>setTimeout(r,250));window.anchorNode=root.querySelector('[data-message-id]');window.anchorTop=anchorNode.getBoundingClientRect().top;window.savedScroll=root.scrollTop;window.oldRenders=performanceFixture.renders();return {count:root.querySelectorAll('article').length,sequence:anchorNode.dataset.messageSequence,scroll:root.scrollTop}})()`)
    assert.ok(initial.count < 100, JSON.stringify(initial)); assert.ok(Number(initial.sequence) > 1000)
    const after = await page.evaluate(`(async()=>{performanceFixture.append(5001,1000);await new Promise(r=>setTimeout(r,200));const root=document.querySelector('#performance-window .kode-collab-messages');return {same:anchorNode===root.querySelector('[data-message-id="'+anchorNode.dataset.messageId+'"]'),delta:Math.abs(anchorNode.getBoundingClientRect().top-anchorTop),scrollDelta:Math.abs(root.scrollTop-savedScroll),count:root.querySelectorAll('article').length,draft:document.querySelector('#performance-window textarea').value,renders:performanceFixture.renders()-oldRenders}})()`)
    assert.equal(after.same, true); assert.ok(after.delta < 2, JSON.stringify(after)); assert.ok(after.scrollDelta < 2, JSON.stringify(after))
    assert.ok(after.count < 100); assert.equal(after.draft, 'keep me'); assert.ok(after.renders <= 2, JSON.stringify(after))
    const restored = await page.evaluate(`(async()=>{const id=anchorNode.dataset.messageId;performanceFixture.toggle();await new Promise(r=>setTimeout(r,50));performanceFixture.toggle();await new Promise(r=>setTimeout(r,250));const root=document.querySelector('#performance-window .kode-collab-messages'),node=root.querySelector('[data-message-id="'+id+'"]');return {present:!!node,delta:node?Math.abs(node.getBoundingClientRect().top-anchorTop):null,scrollDelta:Math.abs(root.scrollTop-savedScroll),draft:document.querySelector('#performance-window textarea').value}})()`)
    assert.equal(restored.present, true); assert.ok(restored.delta < 2, JSON.stringify(restored)); assert.ok(restored.scrollDelta < 2, JSON.stringify(restored)); assert.equal(restored.draft, 'keep me')
  } finally { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } await rm(profile, { recursive: true, force: true }) }
})

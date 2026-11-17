/** Real React + shipped primitives + the real outbox; only the Hub message endpoint is a fixture. No model starts. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { headlessBrowser } from './support/headless-browser.js'
import { collabRenderPage } from './support/collab-render-page.js'

test('unconfirmed message: inline status + one retry icon that looks up first, never resends a received message and keeps the draft', {
  skip: !process.env.KODE_TEST_BROWSER_BIN, timeout: 60000,
}, async () => {
  const bundle = (await build({ stdin: { contents: `export { MessageDeliveryStatus, messageDeliveryStyles } from './packages/collab/message-delivery-status.js'; export { createCollabOutbox } from './packages/collab/outbox.js'`, resolveDir: process.cwd() },
    bundle: true, format: 'cjs', platform: 'browser', external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], write: false })).outputFiles[0].text
  const profile = await mkdtemp(join(tmpdir(), 'message-delivery-')); let browser, server
  const output = process.env.KODE_TEST_SCREENSHOTS
  try {
    server = createServer(async (req, res) => {
      if (req.url === '/delivery-test.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle); return }
      if (await collabRenderPage(req, res)) return
      res.writeHead(404); res.end()
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    const page = await browser.page(`http://127.0.0.1:${server.address().port}`)
    await page.call('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false })
    const wait = expression => page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expression})return;await new Promise(r=>setTimeout(r,20))}throw Error('Delivery UI condition not reached: '+${JSON.stringify(expression)}+' '+document.body.innerText)})()`)
    const shot = async name => { if (!output) return; await new Promise(r => setTimeout(r, 200)); await mkdir(output, { recursive: true }); await writeFile(join(output, name + '.png'), Buffer.from((await page.call('Page.captureScreenshot', { format: 'png' })).data, 'base64')) }
    await wait('globalThis.fixture')
    // The harness mirrors the composer: a second click while busy is ignored, and the draft clears only on an accepted receipt.
    await page.evaluate(`(async()=>{
      const React=__KODE_TEST_MODULES__.react,h=React.createElement,module={exports:{}},code=await(await fetch('/delivery-test.js')).text();
      new Function('require','module','exports',code)(name=>__KODE_TEST_MODULES__[name],module,module.exports);
      const {MessageDeliveryStatus,messageDeliveryStyles,createCollabOutbox}=module.exports;
      const team={home_hub:'home',id:'team',superagent_id:'super',conversation_id:'conversation'};
      const rows=new Map(),hub=new Map(),probe=globalThis.delivery={calls:[],mode:'lose-reply',gate:null,ids:['request-1','request-2','request-3']};
      const storage={async read(k){return rows.get(k)??null},async reserve(k,row){const p=rows.get(k);if(p&&p.state!=='accepted')return p;rows.set(k,structuredClone(row));return row},async save(k,row){rows.set(k,structuredClone(row))}};
      const receipt=body=>({...body,id:'m-'+body.request_id,home_hub:'home',team_id:'team',superagent_id:'super',actor:{kind:'human'},state:'accepted'});
      const request=async(path,{body})=>{
        probe.calls.push(body?{post:body.request_id,content:body.content}:{get:new URL(path,location.href).searchParams.get('request_id')});
        if(!body){if(probe.gate)await probe.gate.promise;if(probe.mode==='offline')throw Error('offline');return {message:hub.get(new URL(path,location.href).searchParams.get('request_id'))??null}}
        if(probe.mode==='offline')throw Error('offline');
        if(probe.mode==='reject')throw Object.assign(Error('clarification_rejected: stale question'),{confirmedRejection:true});
        const row=receipt(body);hub.set(body.request_id,row);
        if(probe.mode==='lose-reply')throw Error('reply lost');return row};
      const box=probe.box=createCollabOutbox({storage,request,uuid:()=>probe.ids.shift()});
      function Probe(){
        const [draft,setDraft]=React.useState('你好？'),[busy,setBusy]=React.useState(false),sending=React.useRef(false);
        const records=React.useSyncExternalStore(box.subscribe,box.getSnapshot),record=records[box.keyOf(team)];
        React.useEffect(()=>{void box.load(team)},[]);
        probe.draft=draft;probe.setDraft=setDraft;
        const run=async retry=>{if(sending.current||busy)return;sending.current=true;setBusy(true);probe.runs=(probe.runs??0)+1;
          try{const result=await(retry?box.retry(team):box.send(team,draft));if(result?.state==='accepted')setDraft('')}finally{sending.current=false;setBusy(false)}};
        probe.send=()=>run(false);
        return h('div',{className:'kode-collab-composer',style:{maxWidth:640,margin:'40px auto',display:'flex',flexDirection:'column',gap:10}},
          h('style',null,messageDeliveryStyles),
          h(MessageDeliveryStatus,{record,busy,onRetry:()=>void run(true)}),
          h('textarea',{'aria-label':'草稿',readOnly:true,value:draft,rows:3}))}
      fixture.ctx.slots.register({name:'main',key:'delivery-probe'},()=>h(Probe));fixture.ctx.layout.selectPanel('delivery-probe');
    })()`)
    await wait(`document.querySelector('textarea[aria-label="草稿"]')`)
    const retry = `document.querySelector('.kode-message-delivery button[aria-label="重试发送"]')`
    const calls = () => page.evaluate('delivery.calls')

    // 1. Receipt lost: the Hub accepted it, the reply did not arrive. Inline status, draft kept, no jargon.
    await page.evaluate('delivery.send()')
    await wait(`document.querySelector('.kode-message-delivery[data-state=unconfirmed]')`)
    const status = await page.evaluate(`(()=>{const e=document.querySelector('.kode-message-delivery'),b=e.querySelector('button'),r=e.getBoundingClientRect();return {text:e.innerText,height:r.height,label:b.getAttribute('aria-label'),title:b.title,icon:!!b.querySelector('svg'),preview:e.querySelector('.kode-message-delivery-preview').textContent}})()`)
    assert.equal(status.preview, '你好？'); assert.equal(status.label, '重试发送'); assert.equal(status.title, '重试发送'); assert.equal(status.icon, true)
    assert.match(status.text, /未确认是否送达。重试会先核对，已送达的不会重复发送。/)
    assert.doesNotMatch(status.text, /Hub|请求|查询|receipt|request/i, 'no reconciliation jargon')
    assert.ok(status.height <= 48, 'one compact line, not a repeated message block: ' + status.height)
    assert.equal(await page.evaluate('delivery.draft'), '你好？', 'unconfirmed keeps the draft')
    assert.equal(await page.evaluate(`document.querySelectorAll('.kode-message-delivery').length`), 1)
    await shot('message-delivery-unconfirmed')
    // Retry looks up the original request id first; it is already received, so nothing is posted again.
    await page.evaluate('delivery.mode="online"'); await page.evaluate(`${retry}.click()`)
    await wait(`!document.querySelector('.kode-message-delivery')`)
    assert.deepEqual(await calls(), [{ post: 'request-1', content: '你好？' }, { get: 'request-1' }], 'received message: GET only, no second POST')
    assert.equal(await page.evaluate('delivery.draft'), '', 'accepted clears the draft')

    // 2. Not received + rapid clicks: busy is explicit, one lookup, then the same request id/content once.
    await page.evaluate(`delivery.calls.length=0;delivery.mode='offline';delivery.setDraft('第二条')`)
    await wait(`delivery.draft==='第二条'`); await page.evaluate('delivery.send()')
    await wait(`document.querySelector('.kode-message-delivery[data-state=unconfirmed]')`)
    await page.evaluate(`(()=>{let release;delivery.gate={promise:new Promise(r=>{release=r}),release};delivery.mode='online'})()`)
    const runsBefore = await page.evaluate('delivery.runs')
    await page.evaluate(`(()=>{const b=${retry};b.click();b.click();b.click()})()`)
    await wait(`document.querySelector('.kode-message-delivery[data-state=checking]')`)
    const busy = await page.evaluate(`(()=>{const e=document.querySelector('.kode-message-delivery'),b=e.querySelector('button');return {text:e.innerText,busy:e.getAttribute('aria-busy'),disabled:b.disabled,label:b.getAttribute('aria-label')}})()`)
    assert.deepEqual({ busy: busy.busy, disabled: busy.disabled, label: busy.label }, { busy: 'true', disabled: true, label: '正在核对' })
    assert.match(busy.text, /正在核对是否已送达…/)
    await shot('message-delivery-checking')
    await page.evaluate(`document.querySelector('.kode-message-delivery button').click()`)
    assert.equal(await page.evaluate('delivery.runs') - runsBefore, 1, 'repeated clicks join one recovery')
    assert.equal(await page.evaluate('delivery.draft'), '第二条')
    await page.evaluate('delivery.gate.release();delivery.gate=null')
    await wait(`!document.querySelector('.kode-message-delivery')`)
    assert.deepEqual(await calls(), [{ post: 'request-2', content: '第二条' }, { get: 'request-2' }, { post: 'request-2', content: '第二条' }], 'one lookup, then the identical request once')
    assert.equal(await page.evaluate('delivery.draft'), '')

    // 3. Network still down on retry: stays unconfirmed with the same request and the draft.
    await page.evaluate(`delivery.calls.length=0;delivery.mode='offline';delivery.setDraft('第三条')`)
    await wait(`delivery.draft==='第三条'`); await page.evaluate('delivery.send()')
    await wait(`document.querySelector('.kode-message-delivery[data-state=unconfirmed]')`)
    await page.evaluate(`${retry}.click()`); await wait(`delivery.calls.length===2&&document.querySelector('.kode-message-delivery[data-state=unconfirmed] button:not(:disabled)')`)
    assert.deepEqual(await calls(), [{ post: 'request-3', content: '第三条' }, { get: 'request-3' }])
    assert.equal(await page.evaluate('delivery.draft'), '第三条')
    assert.equal(await page.evaluate('delivery.ids.length'), 0, 'no new request id was minted for the retry')

    // 4. Only a confirmed rejection reads as not delivered; the Hub's raw reason stays out of the line.
    await page.evaluate(`delivery.mode='reject'`); await page.evaluate(`${retry}.click()`)
    await wait(`document.querySelector('.kode-message-delivery[data-state=rejected]')`)
    const rejected = await page.evaluate(`document.querySelector('.kode-message-delivery').innerText`)
    assert.match(rejected, /未送达：团队没有接收这条消息。可以修改后重新发送。/); assert.doesNotMatch(rejected, /clarification_rejected/)
    assert.equal(await page.evaluate('delivery.draft'), '第三条')
    await shot('message-delivery-rejected')
    assert.deepEqual(await page.evaluate('fixtureErrors'), [])
  } finally { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)) } await rm(profile, { recursive: true, force: true }) }
})

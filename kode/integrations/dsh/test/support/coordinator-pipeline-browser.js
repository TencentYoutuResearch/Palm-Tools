import { registerWorkRunTrace } from '../../src/work-run-trace-route.js'
import { registerWorkRunReceipt } from '../../src/work-run-receipt-route.js'
import { registerWorkRunExecution } from '../../src/work-run-execution-route.js'
/** Shipped IM components connected to the real native pipeline; surrounding shell/auth are fixtures. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headlessBrowser } from './headless-browser.js'
import { collabRenderPage } from './collab-render-page.js'
import { registerCollabTeams, registerCollabRuns, registerCollabEvidence } from '../../src/collab-api.js'
import { registerConversation } from '../../src/conversation-route.js'
import { registerCollabBudgets } from '../../src/collab-budgets-route.js'
import { registerWorkRun } from '../../src/work-run-route.js'
export async function pipelineBrowser(hub, onInput, { agents = () => undefined, recheckResponseLoss = false, contactNames = ['Team'] } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'kode-pipeline-browser-'))
  let browser, server, human, sends = 0, loseRecheckReply = recheckResponseLoss
  const recheckWires = [], receiptReads = []
  const close = async () => { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } await rm(profile, { recursive: true, force: true }) }
  try {
    const routes = new Map()
    const ctx = { get: agents, webServer: { register: route => routes.set(route.path, route) }, connection: { admit: req => req.headers['x-fixture-owner'] === 'yes' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } } }
    const client = { call: async (path, body) => {
      if (!body && path.includes('/commands/')) receiptReads.push(path)
      if (body?.action === 'recheck_execution') recheckWires.push({path,command:structuredClone(body)})
      const result = await hub.client.call(path, body)
      if (body?.action === 'recheck_execution' && loseRecheckReply) { loseRecheckReply = false; throw Error('fixture committed native recheck reply lost') }
      if (body && /\/conversations\/[^/]+\/messages$/.test(path)) { human = result; sends++; onInput(result) }
      return result
    } }
    for (const register of [registerCollabTeams, registerCollabRuns, registerCollabEvidence, registerConversation, registerCollabBudgets, registerWorkRun, registerWorkRunExecution, registerWorkRunReceipt, registerWorkRunTrace]) register(ctx, { backendClient: client })
    server = createServer(async (req, res) => {
      try { const route = routes.get(new URL(req.url, 'http://localhost').pathname); if (route) return await route.handler(req, res); if (await collabRenderPage(req, res)) return; res.writeHead(404); res.end() }
      catch { if (!res.headersSent) res.writeHead(500); res.end() }
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    const page = await browser.page(`http://127.0.0.1:${server.address().port}`)
    const wait = expression => page.evaluate(`(async()=>{const until=Date.now()+15000;while(Date.now()<until){if(${expression})return;await new Promise(r=>setTimeout(r,25))}throw Error('Pipeline browser did not reach expected state')})()`)
    await wait('globalThis.fixture')
    await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]').click()`)
    await wait(`document.querySelector('.kode-collab-contact-name')`)
    await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-contact-name')).find(e=>e.textContent==='Team').click()`)
    await wait(`document.querySelector('.kode-collab-composer textarea')`)
    return {
      async verifyContacts() {
        assert.deepEqual((await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-contact-name')).map(e=>e.textContent)`)).sort(),['Other team','Team'])
        for(const name of ['Other team','Team']){
          await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-contact-name')).find(e=>e.textContent===${JSON.stringify(name)}).click()`)
          await wait(`document.querySelector('.kode-collab-contact[aria-current="page"] .kode-collab-contact-name')?.textContent===${JSON.stringify(name)} && document.querySelector('.kode-collab-composer textarea')`)
          if(name==='Other team')assert.equal(await page.evaluate(`document.querySelectorAll('.kode-collab-message-content').length`),0)
        }
      },
      async send(content) {
        await page.evaluate(`document.querySelector('.kode-collab-composer textarea').focus()`)
        await page.call('Input.insertText', { text: content })
        await page.evaluate(`document.querySelector('.kode-collab-composer button[type="submit"]').click()`)
        await wait(`document.body.innerText.includes('Hub 已接收')`)
        assert.ok(human); assert.equal(sends, 1); return human
      },
      async recheckExecution(runId) {
        const click = async text => { await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`); await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled).click()`) }
        await click('工作过程'); await click('查看详情')
        await wait(`document.querySelector('.kode-collab-execution-status')?.innerText.includes('自动推进已暂停')`)
        await click('重新检查执行条件'); await click('确认重新检查')
        if (recheckResponseLoss) await click('恢复原检查请求')
        await wait(`document.querySelector('.kode-collab-execution-recheck')?.innerText.includes('重新检查请求已记录')`)
        assert.equal(recheckWires.length,1)
        assert.ok(recheckWires.every(row=>row.path==='/api/v1/messaging/work-runs/'+encodeURIComponent(runId)))
        if(recheckResponseLoss)assert.deepEqual(receiptReads,['/api/v1/messaging/work-runs/'+encodeURIComponent(runId)+'/commands/'+encodeURIComponent(recheckWires[0].command.request_id)])
        await click('收起工作过程')
        return recheckWires[0].command
      },
      async verifyTraceUI(runId) {
        const click=async text=>{await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`);await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled).click()`)}
        await page.call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false})
        await click('查看完整追溯')
        await wait(`document.querySelectorAll('.kode-collab-trace-record').length>0`)
        await page.evaluate(`(()=>{const e=document.querySelector('[aria-label="追溯记录类型"]');e.value='operation_events';e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
        await page.evaluate(`document.querySelector('[aria-label="追溯关键词"]').focus()`)
        await page.call('Input.insertText',{text:'kode_write_source'});await click('搜索记录')
        await wait(`document.querySelector('.kode-collab-trace-reader').innerText.includes('关键词：kode_write_source')`)
        for(let i=0;i<8&&!await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-trace-record summary')).some(e=>e.textContent.includes('tool_evidence'))`);i++)await click('继续搜索')
        await wait(`Array.from(document.querySelectorAll('.kode-collab-trace-record summary')).some(e=>e.textContent.includes('tool_evidence'))`)
        await page.evaluate(`document.querySelector('.kode-collab-trace-reader').scrollIntoView({block:'start'})`)
        const desktop=await page.call('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/superagent-trace-ui-575-desktop.png',Buffer.from(desktop.data,'base64'))
        await page.call('Page.bringToFront')
        await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-trace-record summary')).find(e=>e.textContent.includes('tool_evidence')).focus()`)
        assert.equal(await page.evaluate(`document.activeElement?.tagName`),'SUMMARY')
        await page.evaluate(`(()=>{globalThis.traceKeyboard=[];const e=document.activeElement;for(const type of ['keydown','keyup','click','toggle']){(type==='toggle'?e.parentElement:e).addEventListener(type,event=>{queueMicrotask(()=>globalThis.traceKeyboard.push({type,key:event.key,prevented:event.defaultPrevented,open:e.parentElement.open}))})}})()`)
        await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
        try { await wait(`Array.from(document.querySelectorAll('.kode-collab-trace-record details')).some(e=>e.open&&e.innerText.includes('raw_sha256'))`) } catch(error) {
          const diagnostic=await page.evaluate(`({active:document.activeElement?.tagName,keyboard:globalThis.traceKeyboard,records:Array.from(document.querySelectorAll('.kode-collab-trace-record details')).slice(0,5).map(e=>({summary:e.querySelector('summary')?.textContent,open:e.open,pre:e.querySelectorAll('pre').length,hash:e.innerText.includes('raw_sha256')}))})`);throw Error(JSON.stringify(diagnostic),{cause:error})
        }
        const downloads=join(profile,'downloads');await mkdir(downloads)
        await page.call('Page.setDownloadBehavior',{behavior:'allow',downloadPath:downloads})
        await click('导出追溯记录');await wait(`document.querySelector('.kode-collab-trace-export').innerText.includes('本次读取范围的记录已齐全')`)
        let raw;const deadline=Date.now()+10000
        while(Date.now()<deadline){const name=(await readdir(downloads)).find(name=>name.endsWith('.json'));if(name){try{raw=await readFile(join(downloads,name),'utf8');JSON.parse(raw);break}catch{}}await new Promise(resolve=>setTimeout(resolve,25))}
        assert.ok(raw,'actual browser download must finish');const exported=JSON.parse(raw)
        assert.equal(exported.format,'kode.work-run.trace.v1');assert.equal(exported.run_id,runId);assert.equal(exported.complete,true);assert.equal(exported.manifest.archive_payloads_included,false)
        for(const stream of exported.manifest.streams)assert.equal(exported.records[stream.view].length,stream.count,stream.view)
        assert.ok(exported.records.operation_events.some(row=>row.data.evidence?.tool==='kode_write_source'))
        await writeFile('/tmp/superagent-trace-ui-575.json',raw)
        await page.call('Emulation.setDeviceMetricsOverride',{width:800,height:800,deviceScaleFactor:1,mobile:false})
        await page.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]})
        const dimensions=await page.evaluate(`(()=>{const e=document.querySelector('.kode-collab-trace-reader'),c=getComputedStyle(e);e.scrollIntoView({block:'start'});return {scroll:e.scrollWidth,width:e.clientWidth,text:c.color,background:c.backgroundColor}})()`)
        assert.ok(dimensions.scroll<=dimensions.width+1,JSON.stringify(dimensions))
        const narrow=await page.call('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/superagent-trace-ui-575-narrow.png',Buffer.from(narrow.data,'base64'));await writeFile('/tmp/superagent-trace-ui-575-viewport.json',JSON.stringify(dimensions))
        assert.deepEqual(await page.evaluate('globalThis.fixtureErrors'),[])
      },
      async verifyResult({ reload = false } = {}) {
        if (reload) {
          await page.call('Page.reload')
          await wait('globalThis.fixture')
          await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]')?.click()`)
          await wait(`document.querySelector('.kode-collab-contact-name')`)
          await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-contact-name')).find(e=>e.textContent==='Team').click()`)
        }
        await wait(`Array.from(document.querySelectorAll('.kode-collab-message-content')).some(node => node.textContent.includes('Implementation, independent review and verification completed.'))`)
        await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '工作过程').click()`)
        await wait(`document.querySelector('.kode-collab-run')`)
        await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '查看详情').click()`)
        await wait(`document.querySelector('.kode-collab-run-detail')?.innerText.includes('Hub 已确认交付')`)
        assert.equal(await page.evaluate(`document.querySelectorAll('.kode-collab-stage-evidence').length`), 3)
        await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-evidence-detail button')).forEach(button => button.click())`)
        await wait(`document.querySelectorAll('.kode-collab-evidence-detail').length === 3 && Array.from(document.querySelectorAll('.kode-collab-evidence-detail')).every(node => node.innerText.includes('这是已记录的证据'))`)
        const evidence = await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-evidence-detail')).map(node => node.innerText)`)
        assert.ok(evidence.some(text => text.includes('补丁哈希')))
        assert.equal(evidence.filter(text => text.includes('结论：通过')).length, 2)
        assert.ok(evidence.some(text => text.includes('退出码：0')))
        assert.equal(sends, 1)
        assert.deepEqual((await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-contact-name')).map(e=>e.textContent)`)).sort(), [...contactNames].sort(), 'only configured Superagents are IM contacts')
        assert.deepEqual(await page.evaluate('globalThis.fixtureErrors'), [])
      }, close,
    }
  } catch (error) { await close(); throw error }
}

import { registerWorkRunReceipt } from '../src/work-run-receipt-route.js'
/** Real Hub, persisted Host observation and shipped UI; no executor/model is started. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedHub } from './support/isolated-hub.js'
import { conversationTeam } from './support/conversation-team.js'
import { headlessBrowser } from './support/headless-browser.js'
import { collabRenderPage } from './support/collab-render-page.js'
import { WorkRunService } from '../src/work-run-service.js'
import { registerWorkRunExecution } from '../src/work-run-execution-route.js'
import { registerWorkRun } from '../src/work-run-route.js'
import { registerCollabTeams, registerCollabRuns } from '../src/collab-api.js'
import { registerConversation } from '../src/conversation-route.js'
import { registerConversationRead } from '../src/conversation-read-route.js'

for(const recheck of [false,true,'obsolete'])test(`owner execution observation and durable recheck recovery (recheck=${recheck})`, { skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_BROWSER_BIN, timeout: 45000 }, async () => {
  const hub = await isolatedHub('execution-view'), profile = await mkdtemp(join(tmpdir(), 'kode-execution-view-'))
  let browser, server, service
  try {
    const team = await conversationTeam(hub), root = '/api/v1/messaging/'
    const run = await hub.client.call(root + 'work-runs', { id: 'run', request_id: 'request', team_id: team.id, team_revision: 1, binding_id: 'local', inputs: { request: 'Inspect the selected project' }, prior_run_id: null })
    const controller = { runtime: { host: hub.node, profiles: { path: join(hub.root, 'profiles.json') }, client: hub.client }, watches: new Map(), close: async () => {}, watch: () => { throw Error('Read-only observation must not dispatch') } }
    service = await new WorkRunService(controller).open()
    await service.record(run.id, { revision: run.revision, state: 'progression_failed', blocked: true })
    const recheckWires=[],receiptReads=[];let loseRecheckReply=false,preventRecheck=false
    const client={call:async(path,body)=>{if(!body&&path.includes('/commands/'))receiptReads.push(path);if(body?.action==='recheck_execution'){recheckWires.push(structuredClone(body));if(preventRecheck)throw Error('fixture request not transmitted')}const result=await hub.client.call(path,body);if(body?.action==='recheck_execution'&&loseRecheckReply){loseRecheckReply=false;throw Error('fixture committed recheck reply lost')}return result}}
    const routes = new Map(), ctx = { get: () => ({ officialExecution: { host: hub.node }, workRuns: service }), webServer: { register: route => routes.set(route.path, route) }, connection: { admit: req => req.headers['x-fixture-owner'] === 'yes' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } } }
    for (const register of [registerWorkRunReceipt, registerWorkRunExecution, registerWorkRun, registerCollabTeams, registerCollabRuns, registerConversation, registerConversationRead]) register(ctx, { backendClient: client })
    let executionPosts = 0
    server = createServer(async (req, res) => {
      try {
        const path = new URL(req.url, 'http://localhost').pathname, route = routes.get(path)
        if (path.startsWith('/api/kode/work-run') && req.method !== 'GET') executionPosts++
        if (route) return await route.handler(req, res)
        if (await collabRenderPage(req, res)) return
        res.writeHead(404); res.end()
      } catch { if (!res.headersSent) res.writeHead(500); res.end() }
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    const page = await browser.page(`http://127.0.0.1:${server.address().port}`)
    const wait = expression => page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expression})return;await new Promise(r=>setTimeout(r,25))}throw Error('Execution status UI timeout: '+document.body.innerText.slice(0,2000))})()`)
    const click = async text => { await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`); await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled).click()`) }
    const open = async (expected='自动推进已暂停') => { await wait('globalThis.fixture'); await wait(`Array.from(document.querySelectorAll('button')).some(b=>['IM','Session'].includes(b.textContent.trim()))`); await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='IM')?.click()`); await wait(`document.querySelector('.kode-collab-contact-name')`); await page.evaluate(`document.querySelector('.kode-collab-contact-name').click()`); await click('工作过程'); await click('查看详情'); await wait(`document.querySelector('.kode-collab-run-detail')?.innerText.includes(${JSON.stringify(expected)})`) }
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await open()
    if(recheck){
      const budget=await hub.client.call(root+'budgets/budget')
      await click('重新检查执行条件');await wait(`document.querySelector('.kode-collab-execution-recheck')?.innerText.includes('确认重新检查')`)
      assert.equal(executionPosts,0)
      loseRecheckReply=true;preventRecheck=recheck==='obsolete';await click('确认重新检查');await click('刷新执行检查')
      await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='恢复原检查请求'&&!b.disabled)`)
      assert.equal(recheckWires.length,1)
      if(recheck==='obsolete'){
        const cancelled=await hub.client.call(root+'work-runs/run',{action:'cancel',request_id:'competing-cancel',expected_revision:run.revision})
        assert.equal(cancelled.state,'cancelled')
        await service.close();await hub.stop('SIGKILL');await hub.start();service=await new WorkRunService(controller).open()
        await page.call('Page.reload');await open('恢复原检查请求');await click('恢复原检查请求')
        await wait(`document.querySelector('.kode-collab-execution-recheck')?.innerText.includes('原检查请求未提交，任务版本已改变')`)
        assert.equal(recheckWires.length,1);assert.equal(receiptReads.length,1)
        assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='恢复原检查请求'||b.textContent==='重新检查执行条件')`),false)
        await page.call('Page.reload');await open('原检查请求未提交，任务版本已改变')
        assert.equal(receiptReads.length,1,'saved obsolete disposition does not query or dispatch again')
        assert.deepEqual(await hub.client.call(root+'work-runs/run'),cancelled)
        const events=(await hub.client.call(root+'work-runs/run/events')).events
        assert.equal(events.filter(e=>e.data.kind==='execution_recheck_requested').length,0)
        assert.deepEqual(await hub.client.call(root+'budgets/budget'),budget)
        const shot=await page.call('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/superagent-execution-recheck-obsolete-571.png',Buffer.from(shot.data,'base64'))
        return
      }
      const committed=await hub.client.call(root+'work-runs/run')
      assert.equal(committed.revision,run.revision+1)
      for(const key of ['state','context','stages','completion_authorized'])assert.deepEqual(committed[key],run[key])
      await service.close();await hub.stop('SIGKILL');await hub.start();service=await new WorkRunService(controller).open()
      await page.call('Page.reload');await open('恢复原检查请求')
      await click('恢复原检查请求')
      await wait(`document.querySelector('.kode-collab-execution-recheck')?.innerText.includes('重新检查请求已记录')`)
      assert.equal(recheckWires.length,1);assert.deepEqual(receiptReads,[root+'work-runs/run/commands/'+encodeURIComponent(recheckWires[0].request_id)])
      assert.deepEqual(await hub.client.call(root+'work-runs/run'),committed)
      const events=(await hub.client.call(root+'work-runs/run/events')).events
      assert.equal(events.filter(e=>e.data.kind==='execution_recheck_requested').length,1)
      assert.deepEqual(await hub.client.call(root+'budgets/budget'),budget)
      const shot=await page.call('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/superagent-execution-recheck-566.png',Buffer.from(shot.data,'base64'))
      assert.deepEqual(await page.evaluate('fixtureErrors'),[])
      return
    }
    const screenshot = await page.call('Page.captureScreenshot', { format: 'png' }); await writeFile('/tmp/superagent-execution-status-563-desktop.png', Buffer.from(screenshot.data, 'base64'))
    await service.close(); await hub.stop('SIGKILL'); await hub.start(); service = await new WorkRunService(controller).open()
    await page.call('Page.reload'); await open()
    assert.deepEqual(await hub.client.call(root + 'work-runs/run'), run)
    await service.record(run.id, { revision: run.revision + 1, state: 'progression_failed', blocked: true })
    await click('刷新执行检查'); await wait(`document.querySelector('.kode-collab-execution-status')?.innerText.includes('尚未更新到当前任务版本')`)
    service.stop.abort()
    await click('刷新执行检查'); await wait(`document.querySelector('.kode-collab-execution-status')?.innerText.includes('执行端暂时不可用')`)
    await page.call('Emulation.setDeviceMetricsOverride', { width: 800, height: 700, deviceScaleFactor: 1, mobile: false })
    const narrow = await page.call('Page.captureScreenshot', { format: 'png' }); await writeFile('/tmp/superagent-execution-status-563-narrow.png', Buffer.from(narrow.data, 'base64'))
    assert.equal(executionPosts, 0); assert.equal(controller.watches.size, 0)
    assert.deepEqual(await hub.client.call(root + 'work-runs/run'), run)
    assert.deepEqual(await page.evaluate('fixtureErrors'), [])
  } finally { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } await service?.close(); await hub.close(); await rm(profile, { recursive: true, force: true }) }
})

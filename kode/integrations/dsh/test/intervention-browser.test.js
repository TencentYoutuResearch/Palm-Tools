/** Real Home/Chrome/IndexedDB owner controls, with no executor/model started. */
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
import { registerCollabTeams, registerCollabRuns, registerCollabEvidence } from '../src/collab-api.js'
import { registerConversation } from '../src/conversation-route.js'
import { registerConversationRead } from '../src/conversation-read-route.js'
import { registerWorkRun } from '../src/work-run-route.js'
import { registerWorkRunReceipt } from '../src/work-run-receipt-route.js'
import { WorkRunController } from '../src/work-run-controller.js'

test('Chrome and Home restart recover committed takeover and resume without another POST or execution', {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_BROWSER_BIN, timeout: 60000,
}, async () => {
  const hub = await isolatedHub('intervention-browser'), profile = await mkdtemp(join(tmpdir(), 'kode-intervention-browser-'))
  let browser, server, controller
  try {
    await conversationTeam(hub)
    const call = (path, body) => hub.client.call('/api/v1/messaging/' + path, body)
    const initial = await call('work-runs', { id: 'intervention-run', request_id: 'create', team_id: 'team', team_revision: 1,
      binding_id: 'local', inputs: { request: 'Inspect this fixture before executing' }, prior_run_id: null })
    const beforeBudget = await call('budgets/budget'), posts = [], lost = new Set(), reads = []
    const client = { call: async (path, body) => {
      if (body && ['takeover', 'resume'].includes(body.action)) posts.push(structuredClone(body))
      if (!body && path.includes('/commands/')) reads.push(path)
      const result = await hub.client.call(path, body)
      if (body && ['takeover', 'resume'].includes(body.action) && !lost.has(body.action)) {
        lost.add(body.action); throw Error('fixture committed reply lost')
      }
      return result
    } }
    const routes = new Map(), ctx = { webServer: { register: route => routes.set(route.path, route) },
      connection: { admit: req => req.headers['x-fixture-owner'] === 'yes' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } } }
    for (const register of [registerCollabTeams, registerCollabRuns, registerCollabEvidence, registerConversation, registerConversationRead, registerWorkRun, registerWorkRunReceipt]) register(ctx, { backendClient: client, quotaHost: hub.node })
    server = createServer(async (req, res) => {
      try {
        const route = routes.get(new URL(req.url, 'http://localhost').pathname)
        if (route) return await route.handler(req, res)
        if (await collabRenderPage(req, res)) return
        res.writeHead(404); res.end()
      } catch { if (!res.headersSent) res.writeHead(500); res.end() }
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const url = `http://127.0.0.1:${server.address().port}`
    let page
    const wait = expression => page.evaluate(`(async()=>{const until=Date.now()+10000;while(Date.now()<until){if(${expression})return;await new Promise(r=>setTimeout(r,25))}throw Error('Intervention UI timed out')})()`)
    const click = async text => {
      await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`)
      await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled).click()`)
    }
    const open = async () => {
      browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile); page = await browser.page(url)
      await wait('globalThis.fixture')
      await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]')?.click()`)
      await wait(`document.querySelector('.kode-collab-contact-name')`)
      await page.evaluate(`document.querySelector('.kode-collab-contact-name').click()`)
      await click('工作过程'); await click('查看详情')
    }
    await open()
    await click('查看内部会话诊断')
    await wait(`document.querySelector('.kode-collab-session-diagnostics')?.innerText.includes('尚无 Worker 会话分配记录')`)
    assert.deepEqual(await call(`work-runs/${initial.id}`), initial)
    await click('暂停并接管')
    await page.evaluate(`document.querySelector('.kode-collab-intervention textarea').focus()`)
    await page.call('Input.insertText', { text: 'Inspect owned fixture workspace' })
    await click('确认暂停并接管'); await wait(`document.querySelector('.kode-collab-intervention')?.innerText.includes('结果尚未确认')`)
    const takingOver = await call(`work-runs/${initial.id}`)
    assert.equal(takingOver.state, 'taking_over'); assert.equal(takingOver.intervention.stop_confirmed, false)
    controller = new WorkRunController({ host: { stop: new AbortController(), execution: { host: hub.node, client: hub.client } } },
      { prepare() { throw Error('must not dispatch') } })
    assert.equal((await controller.advance(initial.id)).state, 'paused')
    await browser.close(); await hub.stop('SIGKILL'); await hub.start(); await open()
    await click('恢复原操作请求')
    await wait(`document.querySelector('.kode-collab-intervention')?.innerText.includes('恢复自动执行')`)
    assert.equal(posts.length, 1)
    assert.equal((await call(`work-runs/${initial.id}`)).state, 'paused')
    await click('恢复自动执行')
    await page.evaluate(`document.querySelector('.kode-collab-intervention textarea').focus()`)
    await page.call('Input.insertText', { text: 'Revalidate all stages now' })
    await click('确认恢复并重新核验'); await wait(`document.querySelector('.kode-collab-intervention')?.innerText.includes('结果尚未确认')`)
    await browser.close(); await hub.stop('SIGKILL'); await hub.start(); await open()
    await click('恢复原操作请求')
    await wait(`document.querySelector('.kode-collab-intervention')?.innerText.includes('恢复请求已记录')`)
    assert.equal(posts.length, 2); assert.equal(reads.length, 4)
    const resumed = await call(`work-runs/${initial.id}`)
    assert.equal(resumed.state, 'waiting_resource'); assert.equal(resumed.id, initial.id)
    assert.equal(resumed.intervention.resume.evidence_policy, 'all_stages_revalidate')
    assert.ok(resumed.stages.every(stage => stage.state === 'pending' && stage.assignment_id === null))
    assert.deepEqual(await call('budgets/budget'), beforeBudget)
    const events = (await call(`work-runs/${initial.id}/events`)).events
    for (const kind of ['work_run_takeover_requested', 'work_run_paused', 'work_run_resumed']) assert.equal(events.filter(event => event.data.kind === kind).length, 1)
    assert.deepEqual(await page.evaluate('globalThis.fixtureErrors'), [])
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false })
    await page.evaluate(`document.querySelector('.kode-collab-intervention').scrollIntoView({block:'center'})`)
    const screenshot = await page.call('Page.captureScreenshot', { format: 'png' })
    await writeFile('/tmp/superagent-intervention-677.png', Buffer.from(screenshot.data, 'base64'))
  } finally {
    await controller?.close(); await browser?.close()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await rm(profile, { recursive: true, force: true }); await hub.close()
  }
})

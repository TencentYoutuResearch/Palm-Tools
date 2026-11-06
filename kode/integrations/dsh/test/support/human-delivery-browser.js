/** Actual owner routes, shipped UI and Hub; only a committed HTTP response is fault-injected. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headlessBrowser } from './headless-browser.js'
import { collabRenderPage } from './collab-render-page.js'
import { registerCollabTeams, registerCollabRuns } from '../../src/collab-api.js'
import { registerConversation } from '../../src/conversation-route.js'
import { registerConversationRead } from '../../src/conversation-read-route.js'
import { registerWorkRun } from '../../src/work-run-route.js'
import { registerWorkDeliveryDecision } from '../../src/work-delivery-decision-route.js'
export async function acceptDeliveryInBrowser(hub, run, choice = 'accept') {
  const profile = await mkdtemp(join(tmpdir(), 'kode-human-native-browser-'))
  let browser, server, first, writes = 0
  const followups = []; let followupReceipt
  const commands = [], routes = new Map()
  try {
    const ctx = { webServer: { register: route => routes.set(route.path, route) }, connection: { admit: req => req.headers['x-fixture-owner'] === 'yes' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } } }
    const client = { call: async (path, body) => {
      const result = await hub.client.call(path, body)
      if (body?.prior_run_id && path.endsWith('/messages')) {
        followups.push(body); followupReceipt = result
        if (followups.length === 1) throw Error('fixture lost committed follow-up response')
      }
      if (body && path.endsWith('/delivery-decision')) {
        commands.push(body); writes++
        if (writes === 1) { first = result; throw Error('fixture lost committed owner response') }
        assert.deepEqual(result, first)
      }
      return result
    } }
    for (const register of [registerCollabTeams, registerCollabRuns, registerConversation, registerConversationRead, registerWorkRun, registerWorkDeliveryDecision]) register(ctx, { backendClient: client })
    server = createServer(async (req, res) => { try {
      const route = routes.get(new URL(req.url, 'http://localhost').pathname)
      if (route) return await route.handler(req, res)
      if (await collabRenderPage(req, res)) return
      res.writeHead(404); res.end()
    } catch { if (!res.headersSent) res.writeHead(500); res.end() } })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    const page = await browser.page(`http://127.0.0.1:${server.address().port}`)
    const wait = expr => page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expr})return true;await new Promise(r=>setTimeout(r,30))}throw Error('Native acceptance UI timed out: '+document.body.innerText)})()`)
    const click = text => page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){const button=Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)});if(button&&!button.disabled){button.click();return}await new Promise(r=>setTimeout(r,30))}throw Error('Decision action not ready: '+${JSON.stringify(text)}+'; '+document.body.innerText)})()`)
    const open = async () => {
      await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='工作过程')`)
      await click('工作过程'); await wait(`document.querySelector('.kode-collab-run')`)
      await click('查看详情'); await wait(`document.querySelector('.kode-collab-delivery-decision')`)
    }
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    await wait('globalThis.fixture'); await click('IM'); await wait(`document.querySelector('.kode-collab-contact-name')`)
    await page.evaluate(`document.querySelector('.kode-collab-contact-name').click()`); await open()
    const hasWaivers = Object.keys(run.human_acceptance.evidence?.waivers ?? {}).length > 0
    const acceptanceReason = hasWaivers ? '已核对本次产物、验证证据和人工豁免' : '已核对本次产物、独立评审与验证证据'
    if (hasWaivers) {
      const text = await page.evaluate(`document.querySelector('.kode-collab-delivery-decision').innerText`)
      assert.match(text, /本次交付包含人工豁免/)
      for (const [stage, waiver] of Object.entries(run.human_acceptance.evidence.waivers)) {
        assert.ok(text.includes(stage)); assert.ok(text.includes(waiver.reason))
      }
    }
    if (choice === 'reject') await page.evaluate(`const select=document.querySelector('.kode-collab-delivery-decision select');select.value='reject';select.dispatchEvent(new Event('change',{bubbles:true}))`)
    await page.evaluate(`document.querySelector('.kode-collab-delivery-decision textarea').focus()`)
    await page.call('Input.insertText', { text: acceptanceReason })
    await click('核对验收决定')
    assert.equal(writes, 0)
    assert.equal((await hub.client.call(`/api/v1/messaging/work-runs/${run.id}`)).completion_authorized, false)
    if (process.env.KODE_TEST_NATIVE_DECISION_SCREENSHOT_PATH) {
      await page.evaluate(`document.querySelector('.kode-collab-delivery-decision').scrollIntoView({block:'center'})`)
      const shot = await page.call('Page.captureScreenshot', { format: 'png' }); await writeFile(process.env.KODE_TEST_NATIVE_DECISION_SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'))
    }
    await click('确认验收决定'); await wait(`document.body.innerText.includes('验收结果尚未确认')`)
    assert.equal(writes, 1); assert.equal(first.state, choice === 'accept' ? 'queued' : 'waiting_user'); assert.equal(first.completion_authorized, false)
    await page.evaluate('globalThis.fixture = undefined'); await page.call('Page.reload'); await wait('globalThis.fixture'); await open()
    await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='重试原验收决定' && !b.disabled)`)
    assert.equal(await page.evaluate(`document.querySelector('.kode-collab-delivery-decision textarea').value`), acceptanceReason)
    await click('重试原验收决定'); await wait(`document.body.innerText.includes(${JSON.stringify(choice === 'accept' ? '验收决定已保存' : '已记录不接受交付')})`)
    assert.equal(writes, 2); assert.deepEqual(commands[0], commands[1]); assert.equal(commands[0].choice, choice)
    assert.equal(commands[0].expected_revision, run.revision); assert.equal(commands[0].evidence_hash, run.human_acceptance.evidence_hash)
    const events = await hub.client.call(`/api/v1/messaging/work-runs/${run.id}/events`)
    assert.equal(events.events.filter(event => event.data.kind === 'delivery_acceptance_decided').length, 1)
    if (choice === 'reject') {
      const before = await hub.client.call(`/api/v1/messaging/work-runs/${run.id}`)
      assert.equal(before.state, 'waiting_user'); assert.equal(before.waiting_reason, 'human_delivery_rejected')
      await new Promise(resolve => setTimeout(resolve, 1200))
      assert.deepEqual(await hub.client.call(`/api/v1/messaging/work-runs/${run.id}`), before, 'rejection cannot silently start another attempt')
      await click('取消任务'); await click('确认请求取消')
      const until = Date.now() + 10000
      while ((await hub.client.call(`/api/v1/messaging/work-runs/${run.id}`)).state !== 'cancelled') {
        assert.ok(Date.now() < until, 'rejected task cancellation did not settle'); await new Promise(resolve => setTimeout(resolve, 50))
      }
      await click('刷新详情')
      await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='基于此任务提出修改')`)
      await click('基于此任务提出修改')
      await wait(`document.querySelector('.kode-collab-composer').innerText.includes(${JSON.stringify(run.id)})`)
      await page.evaluate(`document.querySelector('.kode-collab-composer textarea').focus()`)
      await page.call('Input.insertText', { text: '请按验收反馈修改，保留原任务的记录。' })
      assert.equal(followups.length, 0)
      if (process.env.KODE_TEST_FOLLOWUP_SCREENSHOT_PATH) {
        const shot = await page.call('Page.captureScreenshot', { format: 'png' }); await writeFile(process.env.KODE_TEST_FOLLOWUP_SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'))
      }
      await click('发送'); await wait(`document.body.innerText.includes('发送结果尚未确认')`)
      assert.equal(followups.length, 1); assert.equal(followups[0].prior_run_id, run.id)
      await page.evaluate('globalThis.fixture = undefined'); await page.call('Page.reload'); await wait('globalThis.fixture')
      await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='查询并重试原消息')`)
      assert.equal(await page.evaluate(`document.querySelector('.kode-collab-composer').innerText.includes(${JSON.stringify(run.id)})`), true)
      await click('查询并重试原消息'); await wait(`document.querySelector('.kode-collab-composer').innerText.includes('Hub 已接收')`)
      assert.equal(followups.length, 1, 'receipt recovery must not POST another request')
      const stored = await hub.client.call(`/api/v1/messaging/conversations/${followupReceipt.conversation_id}/requests/${followupReceipt.request_id}`)
      assert.deepEqual(stored.message, followupReceipt)
      assert.equal(stored.message.prior_run_id, run.id)
    }
    assert.deepEqual(await page.evaluate('fixtureErrors'), [])
    return first
  } finally {
    await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await rm(profile, { recursive: true, force: true })
  }
}

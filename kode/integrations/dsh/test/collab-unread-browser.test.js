/** Real Hub and rendered UI; Coordinator transport consumption is fixture-driven, no model inference. */
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
import { registerCollabTeams } from '../src/collab-api.js'
import { registerConversation } from '../src/conversation-route.js'
import { registerConversationRead } from '../src/conversation-read-route.js'

test('incoming reply stays unread offscreen and clears only after presentation in Chrome', { skip: !process.env.KODE_TEST_BROWSER_BIN || !process.env.KODE_TEST_BACKEND_URL, timeout: 60000 }, async () => {
  const hub = await isolatedHub('unread-browser'), profile = await mkdtemp(join(tmpdir(), 'kode-unread-browser-'))
  let server, browser
  try {
    const team = await conversationTeam(hub), base = '/api/v1/messaging/', call = (path, body) => hub.client.call(base + path, body)
    const registered = await call('sessions', { session_id: 'coordinator', title: 'Coordinator', runtime: 'external' })
    const worker = hub.client.forSession(registered.owner_token)
    const selection = { profile_revision: 'f'.repeat(64), model: 'model', effort: null, scope: 'executor_configuration' }
    const bundle = await call('operation-bundles', { owner_session: 'owner', request_key: 'unread', worker: { node_id: hub.node, session_id: 'coordinator' }, selection_policy: selection,
      funding: { budget_ids: ['budget'], amount: 10, unit: 'credits' }, resource: { host: hub.node, profile: 'profile', account_id: 'account', account_epoch: 1, binding_revision: 1, limit_ids: ['daily'], unknown_quota: 'team_budget' }, grant_id: 'grant',
      grant_scope: { team_id: 'team', revision: 1, target: { host: hub.node, workspace: 'workspace', root: '/fixture' }, capabilities: ['read', 'delegate'], tools: ['kode_artifact_capture', 'kode_coordinator_publish_reply'], network: false, budget_ids: ['budget'] } })
    await call('price-versions', { id: 'price', model: 'model', model_policy: 'requested_model', unit: 'credits', input_per_million: 1, cached_per_million: 1, output_per_million: 1 })
    await call(`budget-reservations/${bundle.reservation.request.id}/pricing`, { price_id: 'price' })
    await call('teams/team/coordinator-control', { request_id: 'control', expected_revision: 0, team_revision: 1, activation_revision: 1, operation_id: bundle.operation.id, operation_revision: bundle.operation.revision, attempt: 1, epoch: 1, target_id: 'control' })
    await worker.call(base + `operations/${bundle.operation.id}`, { expected_revision: bundle.operation.revision, attempt: 1, epoch: 1, selection_ack: selection, action: { kind: 'claim_resource', lease_ms: 60000, resource: { profile: 'profile', account_epoch: 1, binding_revision: 1 } } })
    const human = await call(`conversations/${team.conversation_id}/messages`, { request_id: 'long-request', content: Array.from({ length: 100 }, (_, i) => `需求说明第 ${i + 1} 行`).join('\n') })
    const dispatch = { operation_id: bundle.operation.id, control_revision: 1, attempt: 1, epoch: 1 }
    const queued = await call(`conversations/${team.conversation_id}/messages/${human.id}/coordinator-input`, dispatch)
    await worker.call(base + 'sessions/coordinator/claim', {})
    for (const phase of ['prepared', 'queued', 'consumed']) await worker.call(base + `messages/${queued.receipt.message_id}/delivery`, { session_id: 'coordinator', input_id: 'fixture-input', phase, ...(phase === 'consumed' ? { event_seq: 1 } : {}) })
    const reply = await call(`conversations/${team.conversation_id}/coordinator-replies`, { ...dispatch, request_id: 'answer', source_message_id: human.id, content: '已收到需求，准备开始处理。' })
    const read = () => call(`conversations/${team.conversation_id}/read-state`)
    assert.equal((await read()).unread_count, 1)
    const routes = new Map(), ctx = { webServer: { register: route => routes.set(route.path, route) }, connection: { admit: req => req.headers['x-fixture-owner'] === 'yes' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } } }
    for (const register of [registerCollabTeams, registerConversation, registerConversationRead]) register(ctx, { backendClient: hub.client })
    server = createServer(async (req, res) => { try {
      const route = routes.get(new URL(req.url, 'http://localhost').pathname)
      if (route) return await route.handler(req, res)
      if (await collabRenderPage(req, res)) return
      res.writeHead(404); res.end()
    } catch { if (!res.headersSent) res.writeHead(500); res.end() } })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    const page = await browser.page(`http://127.0.0.1:${server.address().port}`)
    const wait = expression => page.evaluate(`(async()=>{const until=Date.now()+10000;while(Date.now()<until){if(${expression})return true;await new Promise(r=>setTimeout(r,50))}throw Error('Unread predicate timed out')})()`)
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    await wait('globalThis.fixture')
    await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]').click()`)
    await wait(`document.querySelector('[aria-label="1 条未读消息"]')`)
    if (process.env.KODE_TEST_UNREAD_SCREENSHOT_PATH) {
      const screenshot = await page.call('Page.captureScreenshot', { format: 'png' })
      await writeFile(process.env.KODE_TEST_UNREAD_SCREENSHOT_PATH, Buffer.from(screenshot.data, 'base64'))
    }
    await page.evaluate(`document.querySelector('.kode-collab-contact-name').click()`)
    await wait(`document.querySelector('[data-message-sequence="${human.sequence}"]')`)
    // The long first message keeps the reply outside the virtual viewport. Loaded
    // history is not required to have a DOM node before it is presented.
    await new Promise(resolve => setTimeout(resolve, 1600))
    assert.equal((await read()).through_sequence, 0, 'loaded offscreen reply and incomplete long request remain unread')
    assert.equal((await read()).unread_count, 1)
    const other = await browser.page('about:blank')
    await other.call('Page.bringToFront')
    await wait(`document.visibilityState === 'hidden' || !document.hasFocus()`)
    await page.evaluate(`const messages=document.querySelector('.kode-collab-messages');messages.scrollTop=messages.scrollHeight`)
    await new Promise(resolve => setTimeout(resolve, 1600))
    assert.equal((await read()).through_sequence, 0, 'background geometry changes must not acknowledge messages')
    await page.call('Page.bringToFront')
    await wait(`document.visibilityState === 'visible' && document.hasFocus()`)
    await wait(`!document.querySelector('.kode-collab-unread')`)
    assert.equal((await read()).through_sequence, reply.sequence)
    assert.equal((await read()).unread_count, 0)
    assert.deepEqual(await page.evaluate('fixtureErrors'), [])
  } finally {
    await browser?.close()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await hub.close(); await rm(profile, { recursive: true, force: true })
  }
})

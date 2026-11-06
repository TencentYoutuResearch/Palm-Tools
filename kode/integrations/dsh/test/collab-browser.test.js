/** Actual Chromium IndexedDB + production owner route + isolated Hub; no model or full dsh UI. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedHub } from './support/isolated-hub.js'
import { conversationTeam } from './support/conversation-team.js'
import { registerConversation } from '../src/conversation-route.js'
import { headlessBrowser } from './support/headless-browser.js'
const binary = process.env.KODE_TEST_BROWSER_BIN

test('real browser outbox survives process death and recovers a lost HTTP reply without another POST', { skip: !binary || !process.env.KODE_TEST_BACKEND_URL, timeout: 60000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kode-collab-browser-'))
  const hub = await isolatedHub('browser-intake')
  let team
  try { team = await conversationTeam(hub) }
  catch (error) { await hub.close(); await rm(profile, { recursive: true, force: true }); throw error }
  let browser, posts = 0, route
  const requests = []
  registerConversation({ webServer: { register: value => { route = value } }, connection: { admit: req => req.headers['x-fixture-owner'] === 'yes' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } } }, { backendClient: { call: (...args) => hub.client.call(...args) } })
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (['/outbox.js', '/outbox-storage.js'].includes(url.pathname)) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(await readFile(new URL(`../packages/collab${url.pathname}`, import.meta.url))); return }
    if (url.pathname === '/api/kode/conversation/messages') {
      if (req.method === 'POST') {
        let status
        await route.handler(req, { writeHead(value) { status = value }, end(body) {
          if (status === 200) { posts++; requests.push(JSON.parse(body)); res.destroy() }
          else { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body) }
        } }); return
      }
      await route.handler(req, res); return
    }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Isolated collaboration storage test</title>')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const setup = `(async()=>{const {createOutboxStorage}=await import('/outbox-storage.js');const {createCollabOutbox,requestCollabMessage}=await import('/outbox.js');globalThis.storage=createOutboxStorage();globalThis.team=${JSON.stringify(team)};globalThis.box=createCollabOutbox({storage,request:(path,options)=>requestCollabMessage(path,{...options,fetcher:(path,init)=>fetch(path,{...init,headers:{...init.headers,'x-fixture-owner':'yes'}})})});return true})()`
  try {
    browser = await headlessBrowser(binary, profile)
    let page = await browser.page(origin); await page.evaluate(setup)
    const sent = await page.evaluate(`box.send(team,'实现这个需求')`)
    assert.equal(sent.state, 'unconfirmed'); assert.ok(posts >= 1)
    assert.equal(new Set(requests.map(row => row.request_id)).size, 1)
    const postsBeforeRecovery = posts
    assert.equal((await hub.client.call(`/api/v1/messaging/conversations/${team.conversation_id}/messages`)).items.length, 1)
    const requestId = sent.request_id
    await browser.close('SIGKILL'); await hub.stop('SIGKILL'); await hub.start(); browser = await headlessBrowser(binary, profile)
    page = await browser.page(origin); await page.evaluate(setup)
    const loaded = await page.evaluate('box.load(team)'); assert.equal(loaded.request_id, requestId); assert.equal(loaded.content, '实现这个需求')
    const recovered = await page.evaluate('box.retry(team)'); assert.equal(recovered.state, 'accepted'); assert.equal(recovered.request_id, requestId); assert.equal(posts, postsBeforeRecovery)
    assert.equal((await hub.client.call(`/api/v1/messaging/conversations/${team.conversation_id}/messages`)).items.length, 1)
    const peer = await browser.page(origin); await peer.evaluate(setup)
    const reservations = await Promise.all([page, peer].map((target, index) => target.evaluate(`storage.reserve('race',{request_id:'candidate-${index}',state:'prepared'})`)))
    assert.equal(reservations[0].request_id, reservations[1].request_id, 'two tabs atomically keep one pending request')
    assert.equal(await page.evaluate(`storage.save('race',{request_id:'wrong',state:'accepted'}).then(()=>false,()=>true)`), true)
    assert.equal((await peer.evaluate(`storage.read('race')`)).state, 'prepared')
  } finally {
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await hub.close(); await rm(profile, { recursive: true, force: true })
  }
})

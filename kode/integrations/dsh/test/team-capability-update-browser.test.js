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
import { registerTeamActivation } from '../src/team-activation-route.js'
import { registerTeamScheduling } from '../src/team-scheduling-route.js'
import { registerTeamCapabilityUpdate } from '../src/team-capability-update-route.js'

test('capability editor cancels safely and recovers actual Hub update after browser reload', { skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_BROWSER_BIN, timeout: 45000 }, async () => {
 const hub = await isolatedHub('capability-browser'), profile = await mkdtemp(join(tmpdir(), 'kode-capability-browser-'))
 let browser, server, writes = 0, drop = true
 try {
  await conversationTeam(hub)
  const routes = new Map(), ctx = { webServer: { register: r => routes.set(r.path, r) }, connection: { admit: req => req.headers['x-fixture-owner'] === 'yes' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } } }
  for (const register of [registerCollabTeams, registerConversation, registerTeamScheduling, registerTeamCapabilityUpdate, registerTeamActivation]) register(ctx, { backendClient: { async call(path, body) { const value = await hub.client.call(path, body); if (body && path.endsWith('/capability-update')) writes++; return value } } })
  server = createServer(async (req, res) => {
   try {
    const path = new URL(req.url, 'http://localhost').pathname, route = routes.get(path)
    if (route) {
     if (path === '/api/kode/teams/capability-update' && req.method === 'POST' && drop) { drop = false; const end = res.end.bind(res), head = res.writeHead.bind(res); res.writeHead = () => res; res.end = () => { head(503, { 'content-type': 'application/json' }); end(JSON.stringify({ error: 'Committed response unavailable' })); return res } }
     return await route.handler(req, res)
    }
    if (await collabRenderPage(req, res)) return
    res.writeHead(404); res.end()
   } catch { if (!res.headersSent) res.writeHead(500); res.end() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
  const page = await browser.page(`http://127.0.0.1:${server.address().port}`)
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  const wait = expr => page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,25))}throw Error('Capability UI timeout: '+document.body.innerText)})()`)
  const click = text => page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)}&&!b.disabled);if(b){b.click();return}await new Promise(r=>setTimeout(r,25))}throw Error('Action unavailable: '+${JSON.stringify(text)}+' '+document.body.innerText)})()`)
  await wait('globalThis.fixture'); await click('IM'); await wait(`document.querySelector('.kode-collab-contact-name')`)
  await page.evaluate(`document.querySelector('.kode-collab-contact-name').click()`)
  const open = async () => { await click('团队管理'); await click('读取调度资源'); await wait(`document.querySelector('.kode-collab-capability-update')`) }
  await open(); await click('修改已有能力评价'); await click('添加评价'); await click('取消修改'); assert.equal(writes, 0)
  await click('修改已有能力评价'); await click('添加评价')
  await page.evaluate(`document.querySelector('.kode-collab-capability-update input[aria-label$="任务类型"]').focus()`)
  await page.call('Input.insertText', { text: 'inspection' }); await click('核对能力修改'); assert.equal(writes, 0)
  await page.evaluate(`document.querySelector('.kode-collab-capability-update').scrollIntoView({block:'center'})`)
  if (process.env.KODE_TEST_CAPABILITY_SCREENSHOT_PATH) { const shot = await page.call('Page.captureScreenshot', { format: 'png' }); await writeFile(process.env.KODE_TEST_CAPABILITY_SCREENSHOT_PATH, Buffer.from(shot.data, 'base64')) }
  await click('确认保存能力修改'); await wait(`document.body.innerText.includes('修改结果尚未确认')`); assert.equal(writes, 1)
  await page.evaluate('globalThis.fixture=undefined'); await page.call('Page.reload'); await wait('globalThis.fixture'); await open()
  await click('恢复原能力修改'); await wait(`!document.body.innerText.includes('恢复原能力修改')`)
  assert.equal(writes, 1)
  assert.equal((await hub.client.call('/api/v1/messaging/teams/team')).revision, 2)
  assert.equal((await hub.client.call('/api/v1/messaging/teams/team/activation')).team_revision, 1)
  // A fresh edit after an accepted outbox entry must use the new draft revisions.
  await click('读取调度资源'); await click('修改已有能力评价')
  await page.evaluate(`[...document.querySelectorAll('.kode-collab-capability-update label')].find(label=>label.textContent==='固定此评价').querySelector('input').click()`)
  await click('核对能力修改'); await click('确认保存能力修改')
  await wait(`document.body.innerText.includes('能力修改已保存为草稿')`)
  assert.equal(writes, 2)
  let current = await hub.client.call('/api/v1/messaging/teams/team')
  assert.equal(current.revision, 3); assert.equal(current.spec.execution_targets[0].capability_profile_revision, '3')
  await click('读取调度资源'); await click('修改已有能力评价'); await click('删除评价'); await click('核对能力修改')
  await wait(`document.body.innerText.includes('变更固定评价时需明确同意替换')`)
  assert.equal(writes, 2, 'pin refusal happens before mutation')
  await page.evaluate(`[...document.querySelectorAll('.kode-collab-capability-update label')].find(label=>label.textContent==='同意替换本次修改涉及的固定评价').querySelector('input').click()`)
  await click('核对能力修改'); await click('确认保存能力修改')
  await wait(`document.body.innerText.includes('能力修改已保存为草稿')`)
  assert.equal(writes, 3)
  current = await hub.client.call('/api/v1/messaging/teams/team')
  assert.equal(current.revision, 4)
  assert.deepEqual((await hub.client.call('/api/v1/messaging/capability-profiles/capability/4')).assessments, {})
  await click('核对激活条件')
  // This owner-only browser fixture has no execution runtime: it must not offer activation.
  await wait(`document.body.innerText.includes('执行器或流程适配尚未就绪，不能激活。')`)
  assert.equal(await page.evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent==='确认激活此版本团队')`), false)
  assert.equal((await hub.client.call('/api/v1/messaging/teams/team/activation')).team_revision, 1)
  assert.deepEqual(await page.evaluate('fixtureErrors'), [])
 } finally { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } await rm(profile, { recursive: true, force: true }); await hub.close() }
})

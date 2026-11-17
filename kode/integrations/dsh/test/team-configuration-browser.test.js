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
import { registerTeamConfiguration } from '../src/team-configuration-route.js'

test('configuration editor cancels and recovers actual Hub versioned save after lost response', { skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_BROWSER_BIN, timeout: 45000 }, async () => {
 const hub = await isolatedHub('capability-browser'), profile = await mkdtemp(join(tmpdir(), 'kode-capability-browser-'))
 let browser, server, writes = 0, drop = true
 try {
  const initial = await conversationTeam(hub)
  initial.spec.workers = [{id:'tester',role:'Tester',responsibilities:['Verify changes'],allowed_target_ids:['control'],required_capabilities:['read'],workspace_refs:initial.spec.workspace_refs,max_parallel:1}]
  await hub.client.call('/api/v1/messaging/teams',{id:'team',request_id:'add-worker',expected_revision:1,spec:initial.spec})
  const routes = new Map(), ctx = { webServer: { register: r => routes.set(r.path, r) }, connection: { admit: req => req.headers['x-fixture-owner'] === 'yes' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } } }
  for (const register of [registerCollabTeams, registerConversation, registerTeamScheduling, registerTeamConfiguration, registerTeamActivation]) register(ctx, { backendClient: { async call(path, body) { const value = await hub.client.call(path, body); if (body && path === '/api/v1/messaging/teams') writes++; return value } } })
  server = createServer(async (req, res) => {
   try {
    const path = new URL(req.url, 'http://localhost').pathname, route = routes.get(path)
    if (route) {
     if (path === '/api/kode/teams/configuration' && req.method === 'POST' && drop) { drop = false; const end = res.end.bind(res), head = res.writeHead.bind(res); res.writeHead = () => res; res.end = () => { head(503, { 'content-type': 'application/json' }); end(JSON.stringify({ error: 'Committed response unavailable' })); return res } }
     return await route.handler(req, res)
    }
    if (await collabRenderPage(req, res, {hub})) return
    res.writeHead(404); res.end()
   } catch { if (!res.headersSent) res.writeHead(500); res.end() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
  const page = await browser.page(`http://127.0.0.1:${server.address().port}`)
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  const wait = expr => page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,25))}throw Error('Capability UI timeout: '+document.body.innerText)})()`)
  const click = text => page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)}&&!b.disabled);if(b){b.click();return}await new Promise(r=>setTimeout(r,25))}throw Error('Action unavailable: '+${JSON.stringify(text)}+' '+document.body.innerText)})()`)
  await wait('globalThis.fixture'); await page.evaluate(`(()=>{const d=document.querySelector('[data-sidebar-section=channels]');if(d&&!d.open)d.querySelector('summary').click()})()`); await wait(`document.querySelector('[data-sidebar-row=team] [data-row-title]')`)
  await page.evaluate(`document.querySelector('[data-sidebar-row=team] [data-row-title]').click()`)
  await click('SuperAgent 设置'); await click('展开高级设置'); await wait(`document.querySelector('.kode-collab-team-configuration')`)
  await wait(`document.querySelector('.kode-collab-team-configuration input:not(:disabled)')`)
  await page.evaluate(`document.querySelector('.kode-collab-team-configuration input:not(:disabled)').focus()`)
  await page.call('Input.insertText', { text: '验证职责 ' })
  await wait(`document.querySelector('.kode-collab-team-configuration fieldset fieldset:not([data-role-prompt]) legend').textContent.includes('验证职责')`)
  await click('核对配置变更'); assert.equal(writes, 0)
  await click('返回编辑'); assert.equal(writes, 0)
  await click('核对配置变更')
  await page.evaluate(`document.querySelector('.kode-collab-team-configuration').scrollIntoView({block:'start'})`)
  if (process.env.KODE_TEST_CONFIGURATION_SCREENSHOT_PATH) { const shot = await page.call('Page.captureScreenshot', { format: 'png' }); await writeFile(process.env.KODE_TEST_CONFIGURATION_SCREENSHOT_PATH, Buffer.from(shot.data, 'base64')) }
  await click('确认保存草稿'); await wait(`document.body.innerText.includes('保存结果尚未确认')`); assert.equal(writes, 1)
  await click('恢复原保存请求'); await wait(`document.body.innerText.includes('当前配置 v3')`)
  const saved = await hub.client.call('/api/v1/messaging/teams/team')
  assert.equal(saved.revision, 3); assert.equal(saved.status, 'draft'); assert.equal(saved.eligible_for_execution, false)
  assert.match(saved.spec.workers[0].role, /验证职责/)
  assert.equal((await hub.client.call('/api/v1/messaging/teams/team/activation')).team_revision, 1)
  assert.deepEqual(await page.evaluate('fixtureErrors'), [])
 } finally { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } await rm(profile, { recursive: true, force: true }); await hub.close() }
})

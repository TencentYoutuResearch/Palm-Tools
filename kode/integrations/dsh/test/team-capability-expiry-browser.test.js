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

test('retained expired pinned measurement permits editing a different assessment', { skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_BROWSER_BIN, timeout: 45000 }, async () => {
 const hub = await isolatedHub('capability-browser'), profile = await mkdtemp(join(tmpdir(), 'kode-capability-browser-'))
 let browser, server, writes = 0, drop = false
 try {
  await conversationTeam(hub)
  const base = '/api/v1/messaging/', at = Date.now()
  await hub.client.call(base + 'capability-profiles', { id: 'historical', expected_revision: 0, host: hub.node, profile: 'profile', model: 'model', assessments: { historical: { evaluation: { kind: 'weakness', text: 'Historical measured limitation' }, source: 'measured', confidence: 0.8, evidence: ['Recorded fixture measurement'], updated_at: at - 20000, valid_until: at - 10000, pinned: true } } })
  const scheduling = await hub.client.call(base + 'team-policies/schedule')
  scheduling.policy.targets.control.capability_id = 'historical'
  await hub.client.call(base + 'team-policies', { id: 'schedule', team_id: 'team', expected_revision: 1, policy: scheduling.policy })
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
  await wait(`[...document.querySelectorAll('button')].some(b=>b.textContent==='确认保存能力修改')`)
  assert.equal(writes, 0)
  const before = await hub.client.call('/api/v1/messaging/capability-profiles/historical/1')
  await click('确认保存能力修改'); await wait(`document.body.innerText.includes('能力修改已保存为草稿')`)
  assert.equal(writes, 1)
  const after = await hub.client.call('/api/v1/messaging/capability-profiles/historical/2')
  assert.deepEqual(after.assessments.historical, before.assessments.historical)
  assert.equal(Object.keys(after.assessments).length, 2)
  assert.equal((await hub.client.call('/api/v1/messaging/teams/team/activation')).team_revision, 1)
 } finally { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } await rm(profile, { recursive: true, force: true }); await hub.close() }
})

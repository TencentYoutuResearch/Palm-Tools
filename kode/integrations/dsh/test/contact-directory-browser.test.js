/** Actual Home, IndexedDB and shipped React. No model execution. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedHub } from './support/isolated-hub.js'
import { headlessBrowser } from './support/headless-browser.js'
import { collabRenderPage } from './support/collab-render-page.js'
import { registerCollabTeams } from '../src/collab-api.js'
import { registerConversation } from '../src/conversation-route.js'
import { registerConversationRead } from '../src/conversation-read-route.js'

test('owner pins and archives contacts, restarts Chrome and restores separate unsent drafts', {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_BROWSER_BIN,
  timeout: 60000,
}, async () => {
  const hub = await isolatedHub('contact-browser')
  const profile = await mkdtemp(join(tmpdir(), 'kode-contact-browser-'))
  let server, browser
  try {
    const call = (path, body) => hub.client.call(`/api/v1/messaging/${path}`, body)
    const spec = name => ({ name, purpose: 'Project', kind: 'coordinator', workspace_refs: [], execution_targets: [], workers: [], coordinator_targets: [], workflow_pack_refs: [], grant_id: null, budget_policy_id: null, scheduling_policy_id: null, limits: { max_active_assignments: 1, max_active_runs: 1 }, proactive_mode: 'off' })
    const alpha = await call('teams', { id: 'alpha', request_id: 'create', expected_revision: 0, spec: spec('Alpha') })
    const beta = await call('teams', { id: 'beta', request_id: 'create', expected_revision: 0, spec: spec('Beta') })
    const registration = await call('sessions', { session_id: 'untrusted', title: 'Worker', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    await assert.rejects(worker.call('/api/v1/messaging/contact-directory'), /403/)
    await assert.rejects(worker.call('/api/v1/messaging/teams/alpha/contact-preference', { request_id: 'illegal', expected_revision: 0, action: 'archive' }), /403/)

    const routes = new Map()
    let writes = 0, lost = false
    const client = { call: async (path, body) => {
      const result = await hub.client.call(path, body)
      if (body && path.endsWith('/contact-preference')) {
        writes++
        if (!lost) { lost = true; throw Error('fixture committed contact reply lost') }
      }
      return result
    } }
    const ctx = { webServer: { register: route => routes.set(route.path, route) }, connection: { admit: req => req.headers['x-fixture-owner'] === 'yes' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } } }
    for (const register of [registerCollabTeams, registerConversation, registerConversationRead]) register(ctx, { backendClient: client })
    server = createServer(async (req, res) => {
      try {
        const route = routes.get(new URL(req.url, 'http://localhost').pathname)
        if (route) return await route.handler(req, res)
        if (await collabRenderPage(req, res)) return
        res.writeHead(404); res.end()
      } catch { if (!res.headersSent) res.writeHead(500); res.end() }
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    const url = `http://127.0.0.1:${server.address().port}`
    let page = await browser.page(url)
    const wait = expression => page.evaluate(`(async()=>{const until=Date.now()+10000;while(Date.now()<until){if(${expression})return;await new Promise(r=>setTimeout(r,25))}throw Error('Contact UI did not reach expected state')})()`)
    const click = async text => {
      await wait(`Array.from(document.querySelectorAll('button')).some(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.disabled)`)
      await page.evaluate(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.disabled).click()`)
    }
    const select = async name => {
      await wait(`Array.from(document.querySelectorAll('.kode-collab-contact-name')).some(e=>e.textContent===${JSON.stringify(name)})`)
      await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-contact-name')).find(e=>e.textContent===${JSON.stringify(name)}).click()`)
      await wait(`document.querySelector('.kode-collab-conversation h1')?.textContent===${JSON.stringify(name)}`)
    }
    await wait('globalThis.fixture')
    await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]').click()`)
    await select('Alpha')
    await wait(`document.querySelector('.kode-collab-composer textarea')`)
    await page.evaluate(`document.querySelector('.kode-collab-composer textarea').focus()`)
    await page.call('Input.insertText', { text: 'Alpha 未发送草稿' })
    await wait(`document.querySelector('.kode-collab-draft-status')?.textContent==='草稿已保存。'`)
    await select('Beta')
    await wait(`document.querySelector('.kode-collab-composer textarea')?.value===''`)
    await page.evaluate(`document.querySelector('.kode-collab-composer textarea').focus()`)
    await page.call('Input.insertText', { text: 'Beta 的另一份草稿' })
    await wait(`document.querySelector('.kode-collab-draft-status')?.textContent==='草稿已保存。'`)
    await select('Alpha')
    await wait(`document.querySelector('.kode-collab-composer textarea')?.value==='Alpha 未发送草稿'`)
    await click('团队管理')
    await click('置顶联系人')
    await wait(`document.querySelector('.kode-collab-contact-name')?.textContent==='Alpha' && document.querySelector('.kode-collab-contact-preferences')?.innerText.includes('联系人设置已保存')`)
    assert.equal(writes, 1, 'committed lost response is recovered by exact receipt GET')
    await click('归档联系人')
    await wait(`document.querySelectorAll('.kode-collab-contact-name').length===1 && document.querySelector('.kode-collab-contact-name').textContent==='Beta'`)
    await click('已归档联系人')
    await select('Alpha')
    await browser.close()
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    page = await browser.page(url)
    await wait('globalThis.fixture')
    await wait(`document.querySelector('button[aria-label="切换到 Session 模式"]')`)
    await click('已归档联系人')
    await select('Alpha')
    await wait(`document.querySelector('.kode-collab-composer textarea')?.value==='Alpha 未发送草稿'`)
    await click('团队管理')
    await click('移出归档')
    await click('返回联系人')
    await wait(`document.querySelectorAll('.kode-collab-contact-name').length===2`)
    assert.equal(writes, 3)
    assert.deepEqual(await call('teams/alpha'), alpha)
    assert.deepEqual(await call('teams/beta'), beta)
    assert.deepEqual((await call(`conversations/${alpha.conversation_id}/messages`)).items, [])
    assert.equal((await call('teams/alpha/coordinator-control')).control, null)
    await hub.stop('SIGKILL'); await hub.start()
    const preference = await call('teams/alpha/contact-preference')
    assert.equal(preference.preference.revision, 3)
    assert.equal(preference.preference.pinned, true)
    assert.equal(preference.preference.archived, false)
    await select('Beta')
    await wait(`document.querySelector('.kode-collab-composer textarea')?.value==='Beta 的另一份草稿'`)
    await select('Alpha')
    await wait(`document.querySelector('.kode-collab-composer textarea')?.value==='Alpha 未发送草稿'`)
    assert.deepEqual(await page.evaluate('globalThis.fixtureErrors'), [])
    const shot = await page.call('Page.captureScreenshot', { format: 'png' })
    await writeFile('/tmp/superagent-contact-directory-637.png', Buffer.from(shot.data, 'base64'))
  } finally {
    await browser?.close()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await rm(profile, { recursive: true, force: true })
    await hub.close()
  }
})

/** Actual Home and Chrome storage with an injected post-send draft-clear failure. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedHub } from './support/isolated-hub.js'
import { conversationTeam } from './support/conversation-team.js'
import { headlessBrowser } from './support/headless-browser.js'
import { collabRenderPage } from './support/collab-render-page.js'
import { registerCollabTeams } from '../src/collab-api.js'
import { registerConversation } from '../src/conversation-route.js'
import { registerConversationRead } from '../src/conversation-read-route.js'

test('Chrome restart recovers accepted-send draft cleanup without another message or execution', {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_BROWSER_BIN,
  timeout: 60000,
}, async () => {
  const hub = await isolatedHub('draft-recovery')
  const profile = await mkdtemp(join(tmpdir(), 'kode-draft-recovery-'))
  let browser, server
  try {
    const team = await conversationTeam(hub)
    const call = (path, body) => hub.client.call(`/api/v1/messaging/${path}`, body)
    const beforeBudget = await call('budgets/budget')
    let sends = 0
    const client = { call: (path, body) => {
      if (body && path.endsWith(`/conversations/${team.conversation_id}/messages`)) sends++
      return hub.client.call(path, body)
    } }
    const routes = new Map()
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
    const url = `http://127.0.0.1:${server.address().port}`
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    let page = await browser.page(url)
    const wait = expression => page.evaluate(`(async()=>{const until=Date.now()+10000;while(Date.now()<until){if(${expression})return;await new Promise(r=>setTimeout(r,25))}throw Error('Draft recovery UI timed out')})()`)
    const select = async () => {
      await wait('globalThis.fixture')
      await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]')?.click()`)
      await wait(`document.querySelector('.kode-collab-contact-name')`)
      await page.evaluate(`document.querySelector('.kode-collab-contact-name').click()`)
      await wait(`document.querySelector('.kode-collab-composer textarea')`)
    }
    await select()
    await page.evaluate(`document.querySelector('.kode-collab-composer textarea').focus()`)
    await page.call('Input.insertText', { text: '浏览器重启后不能重发此需求' })
    await wait(`document.querySelector('.kode-collab-draft-status')?.textContent==='草稿已保存。'`)
    await page.evaluate(`(()=>{
      const original=IDBObjectStore.prototype.put
      globalThis.fixtureDraftClearFailures=0
      IDBObjectStore.prototype.put=function(row,...args){
        if(row?.value?.format==='kode.conversation.view.v1'&&row.value.value.draft===''){
          globalThis.fixtureDraftClearFailures++
          throw Error('fixture storage unavailable after accepted send')
        }
        return original.call(this,row,...args)
      }
    })()`)
    await page.evaluate(`document.querySelector('.kode-collab-composer button[type="submit"]').click()`)
    await wait(`globalThis.fixtureDraftClearFailures===1 && document.querySelector('.kode-collab-draft-status')?.textContent.includes('未能保存')`)
    assert.equal(sends, 1)
    assert.equal((await call(`conversations/${team.conversation_id}/messages`)).items.length, 1)
    await browser.close()
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    page = await browser.page(url)
    await select()
    await wait(`document.querySelector('.kode-collab-composer textarea').value==='' && document.querySelector('.kode-collab-draft-status')?.textContent==='草稿已保存。'`)
    assert.equal(sends, 1)
    assert.equal((await call(`conversations/${team.conversation_id}/messages`)).items.length, 1)
    assert.deepEqual(await call('budgets/budget'), beforeBudget)
    assert.equal((await call('teams/team/coordinator-control')).control, null)
    assert.deepEqual(await page.evaluate('globalThis.fixtureErrors'), [])
  } finally {
    await browser?.close()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await rm(profile, { recursive: true, force: true })
    await hub.close()
  }
})

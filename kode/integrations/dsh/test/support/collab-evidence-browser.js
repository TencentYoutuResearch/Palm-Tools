/** Render evidence captured by the native workflow fixture, never seed fabricated evidence rows. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headlessBrowser } from './headless-browser.js'
import { collabRenderPage } from './collab-render-page.js'
import { registerCollabTeams, registerCollabRuns, registerCollabEvidence } from '../../src/collab-api.js'
import { registerWorkRun } from '../../src/work-run-route.js'
import { registerConversation } from '../../src/conversation-route.js'
export async function inspectNativeEvidence(hub, expected) {
  const profile = await mkdtemp(join(tmpdir(), 'kode-native-evidence-browser-'))
  let browser, server
  try {
    const routes = new Map()
    const ctx = { webServer: { register: route => routes.set(route.path, route) }, connection: { admit: req => req.headers['x-fixture-owner'] === 'yes' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } } }
    for (const register of [registerCollabTeams, registerCollabRuns, registerCollabEvidence, registerWorkRun, registerConversation]) register(ctx, { backendClient: hub.client })
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
    const page = await browser.page(`http://127.0.0.1:${server.address().port}`)
    const wait = expression => page.evaluate(`(async()=>{const until=Date.now()+10000;while(Date.now()<until){if(${expression})return;await new Promise(r=>setTimeout(r,25))}throw Error('Evidence render timeout: '+document.body.innerText.slice(0,1500))})()`)
    await wait('globalThis.fixture')
    await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]').click()`)
    await wait(`document.querySelector('.kode-collab-contact-name')`)
    await page.evaluate(`document.querySelector('.kode-collab-contact-name').click()`)
    const click = text => page.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent===${JSON.stringify(text)}).click()`)
    await wait(`document.querySelector('.kode-collab-header')`); await click('工作过程')
    await wait(`document.querySelector('.kode-collab-run')`)
    await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-run')).find(row=>row.querySelector('small').textContent==='任务编号：before').querySelector('button').click()`)
    await wait(`document.querySelector('.kode-collab-stage-evidence button')`); await click('查看证据')
    await wait(`document.querySelector('.kode-collab-evidence-detail').innerText.includes('目录树哈希')`)
    const rendered = await page.evaluate(`document.querySelector('.kode-collab-evidence-detail').innerText`)
    assert.ok(rendered.includes(expected.snapshot.tree_hash)); assert.ok(rendered.includes(expected.snapshot.patch_hash))
    assert.ok(rendered.includes(expected.snapshot.repository_id)); assert.ok(rendered.includes('最终交付以 Hub 的任务判定为准'))
    assert.deepEqual(await page.evaluate('fixtureErrors'), [])
  } finally {
    await browser?.close()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await rm(profile, { recursive: true, force: true })
  }
}

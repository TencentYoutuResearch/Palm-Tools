/** Actual shipped UI/IndexedDB with controlled HTTP receipts; not real Hub delivery acceptance. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headlessBrowser } from './support/headless-browser.js'
import { collabRenderPage } from './support/collab-render-page.js'
test('human acceptance form recovers original decision from IndexedDB after lost response and reload', { skip: !process.env.KODE_TEST_BROWSER_BIN, timeout: 40000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kode-decision-browser-'))
  let browser, server, original, writes = 0
  const team = { id: 'team', superagent_id: 'super', conversation_id: 'dm', home_hub: 'home', spec: { name: 'Team', kind: 'coordinator' } }
  let run = { id: 'run', team_id: 'team', home_hub: 'home', revision: 4, state: 'waiting_user', waiting_reason: 'human_delivery_acceptance_required', completion_authorized: false, stages: [], request_preview: '验收交付产物', human_acceptance: { revision: 4, state: 'pending', evidence_hash: 'a'.repeat(64) } }
  try {
    server = createServer(async (req, res) => {
      const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
      try {
        const url = new URL(req.url, 'http://localhost')
        if (url.pathname === '/api/kode/collab/teams') {
          if (url.searchParams.get('view') === 'contacts') {
            const archived = url.searchParams.get('archived') === 'true', pending = run.state === 'waiting_user'
            const contact = { preference: { revision: 0, pinned: false, archived: false, archived_through_sequence: 0 },
              archived: false, needs_attention: pending, latest_sequence: 0, unread_count: 0, last_activity_at: 0,
              attention: { decisions: pending ? 1 : 0, resources: 0, stopping: 0, active_runs: 1 } }
            return send(200, { home_hub: 'home', projection: 'contact_directory', archived, order: 'pinned_attention_unread_recent',
              items: archived ? [] : [{ ...team, contact }], next_cursor: null })
          }
          return send(200, { home_hub: 'home', projection: 'configuration_revision', team })
        }
        if (url.pathname === '/api/kode/conversation/messages') return send(200, { home_hub: 'home', team_id: 'team', conversation_id: 'dm', items: [], has_more: false, next_cursor: null })
        if (url.pathname === '/api/kode/conversation/read-state') return send(200, { home_hub: 'home', team_id: 'team', conversation_id: 'dm', principal_id: 'local_owner', through_sequence: 0, latest_sequence: 0, unread_count: 0 })
        if (url.pathname === '/api/kode/collab/runs') return send(200, { home_hub: 'home', team_id: 'team', items: [run], next_cursor: null })
        if (url.pathname === '/api/kode/work-run') return send(200, url.searchParams.get('view') === 'events' ? { events: [], next_cursor: 0 } : run)
        if (url.pathname === '/api/kode/work-run/decision') {
          let body = ''; for await (const part of req) body += part
          const command = JSON.parse(body); writes++
          if (!original) original = command; else assert.deepEqual(command, original)
          run = { ...run, revision: 5, state: 'queued', waiting_reason: 'delivery_finalization_pending', human_acceptance: { ...run.human_acceptance, state: 'accepted', decision: { ...command, actor: { kind: 'human', id: 'local_owner' } } } }
          return send(writes === 1 ? 503 : 200, writes === 1 ? { error: 'fixture response lost' } : run)
        }
        if (await collabRenderPage(req, res)) return
        send(404, {})
      } catch { if (!res.headersSent) send(500, {}) }
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    const page = await browser.page(`http://127.0.0.1:${server.address().port}`)
    const wait = expr => page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expr})return true;await new Promise(r=>setTimeout(r,30))}throw Error('Decision UI timed out: '+document.body.innerText)})()`)
    const click = text => page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){const button=Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)});if(button&&!button.disabled){button.click();return}await new Promise(r=>setTimeout(r,30))}throw Error('Decision action not ready: '+${JSON.stringify(text)}+'; '+document.body.innerText)})()`)
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    await wait('globalThis.fixture'); await click('IM'); await wait(`document.querySelector('.kode-collab-contact-name')`)
    await page.evaluate(`document.querySelector('.kode-collab-contact-name').click()`)
    const open = async () => { await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='工作过程')`); await click('工作过程'); await wait(`document.querySelector('.kode-collab-run')`); await click('查看详情'); await wait(`document.querySelector('.kode-collab-delivery-decision')`) }
    await open()
    await page.evaluate(`document.querySelector('.kode-collab-delivery-decision textarea').focus()`)
    await page.call('Input.insertText', { text: '已核对产物与验证记录' })
    await click('核对验收决定'); assert.equal(writes, 0)
    if (process.env.KODE_TEST_DECISION_SCREENSHOT_PATH) {
      await page.evaluate(`document.querySelector('.kode-collab-delivery-decision').scrollIntoView({block:'center'})`)
      const shot = await page.call('Page.captureScreenshot', { format: 'png' }); await writeFile(process.env.KODE_TEST_DECISION_SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'))
    }
    await click('确认验收决定'); await wait(`document.body.innerText.includes('验收结果尚未确认')`); assert.equal(writes, 1)
    await page.evaluate('globalThis.fixture = undefined'); await page.call('Page.reload'); await wait('globalThis.fixture'); await open()
    await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='重试原验收决定' && !b.disabled)`)
    assert.equal(await page.evaluate(`document.querySelector('.kode-collab-delivery-decision textarea').value`), '已核对产物与验证记录')
    await click('重试原验收决定'); await wait(`document.body.innerText.includes('验收决定已保存')`)
    assert.equal(writes, 2); assert.equal(run.completion_authorized, false)
    assert.deepEqual(await page.evaluate('fixtureErrors'), [])
  } finally {
    await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await rm(profile, { recursive: true, force: true })
  }
})

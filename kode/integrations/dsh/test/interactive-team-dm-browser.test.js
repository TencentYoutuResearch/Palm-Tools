/** In-memory source bundle and an owned empty Chrome profile; no live Hub or provider. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { collabRenderPage } from './support/collab-render-page.js'
import { headlessBrowser } from './support/headless-browser.js'

test('interactive Team legacy DM explicitly creates or reuses private surface without sending or moving history/draft', { skip: !process.env.KODE_TEST_BROWSER_BIN, timeout: 90000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kode-team-dm-ui-'))
  const bundle = await build({ entryPoints: ['packages/collab/client-source.js'], bundle: true, write: false, format: 'cjs', platform: 'browser', loader: { '.png': 'dataurl' }, external: ['@kode/dsh-composer', 'react', 'react-dom', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-conversation'] })
  const source = `window.__ModuleLoader__.load({id:'@kode/dsh-collab',factory(require){const module={exports:{}};const exports=module.exports;${bundle.outputFiles[0].text}\nreturn module.exports;}});`
  const scope = { home_hub: 'local', host_id: 'local', workspace_id: 'workspace', root_ref: '/example/project' }
  const contact = { preference: { revision: 0, pinned: false, archived: false, archived_through_sequence: 0 }, archived: false, needs_attention: false, latest_sequence: 1, unread_count: 0, last_activity_at: 0, attention: { decisions: 0, resources: 0, stopping: 0, active_runs: 0 } }
  const team = { id: 'team', home_hub: 'local', revision: 2, superagent_id: 'super', conversation_id: 'conversation', contact, spec: { execution_mode: 'interactive_native', name: '交互私信测试团队', kind: 'coordinator', purpose: '隔离验证', workspace_refs: [scope], coordinator_targets: ['codex'], execution_targets: [{ id: 'codex', host_id: 'local', executor_profile_id: 'codex', model_id: 'astra-6' }], workers: [] } }
  const history = { id: 'old-message', home_hub: 'local', team_id: 'team', conversation_id: 'conversation', sequence: 1, actor: { kind: 'human', id: 'local_owner' }, content: '原有私信历史不会迁移', created_at: Date.now() }
  const draftKey = JSON.stringify(['conversation-view-v1', 'local', 'local_owner', 'team', 'conversation'])
  const draft = { format: 'kode.conversation.view.v1', state: 'draft', home_hub: 'local', team_id: 'team', conversation_id: 'conversation', request_id: 'draft-request', draft_token: 'draft-token', revision: 1, value: { draft: '原有未发送草稿', scrollTop: 0, clarificationTarget: null, priorRunId: null } }
  const surfaces = [], creates = [], messageWrites = []
  let browser, loseResponse = true
  const server = createServer(async (req, res) => { try {
    const url = new URL(req.url, 'http://localhost'), json = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)) }
    if (url.pathname === '/fixture-collab.js') { res.setHeader('content-type', 'text/javascript'); res.end(source); return }
    if (await collabRenderPage(req, res, { workspaces: [{ workspaceId: 'workspace', title: '隔离项目', path: scope.root_ref, sessionIds: [], createdAt: new Date().toISOString() }] })) return
    if (url.pathname === '/api/kode/project-hosts') return json({ current: 'local', hosts: [{ id: 'local', name: '此计算机' }] })
    if (url.pathname === '/api/kode/collab/teams') return json({ home_hub: 'local', projection: 'contact_directory', archived: false, order: 'pinned_attention_unread_recent', items: [team], next_cursor: null })
    if (url.pathname === '/api/kode/conversation/messages') return json({ home_hub: 'local', team_id: 'team', conversation_id: 'conversation', items: Number(url.searchParams.get('after')) < 1 ? [history] : [], has_more: false, next_cursor: null })
    if (url.pathname === '/api/kode/conversation/read-state') return json({ home_hub: 'local', team_id: 'team', conversation_id: 'conversation', principal_id: 'local_owner', through_sequence: 1, latest_sequence: 1, unread_count: 0 })
    if (url.pathname === '/api/kode/collaboration') {
      const path = url.searchParams.get('path')
      if (path === 'surfaces') return json({ scope, items: surfaces })
      const [, id, kind] = path.split('/'), surface = surfaces.find(row => row.id === id)
      if (req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk
        const input = JSON.parse(raw)
        if (kind === 'messages') { messageWrites.push(input); return json({}) }
        creates.push({ id, input }); if (!surface) surfaces.push({ id, ...input, revision: 1, audience_revision: 1 })
        if (loseResponse) { loseResponse = false; res.statusCode = 503; return json({ error: 'lost receipt' }) }
        return json(surfaces.find(row => row.id === id))
      }
      if (kind === 'threads' || kind === 'messages') return json({ surface, items: [], has_more: false })
      if (kind === 'tasks') return json({ scope, surface, items: [] })
    }
    if (req.method === 'POST' && url.pathname.includes('message')) messageWrites.push(url.pathname)
    res.statusCode = 503; json({ error: 'isolated unsupported read' })
  } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })) } })
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    const page = await browser.page(`http://127.0.0.1:${server.address().port}`)
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1360, height: 960, deviceScaleFactor: 1, mobile: false })
    const wait = expr => page.evaluate(`(async()=>{for(let i=0;i<250;i++){if(${expr})return;await new Promise(r=>setTimeout(r,40))}throw Error(document.body.innerText+' '+JSON.stringify(fixtureErrors))})()`)
    const click = text => page.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.disabled);if(!b)throw Error('No button: '+${JSON.stringify(text)}+' '+document.body.innerText);b.click()})()`)
    await wait('globalThis.fixture')
    await page.evaluate(`new Promise((resolve,reject)=>{const r=indexedDB.open('kode.collab.outbox.v1',1);r.onsuccess=()=>{const db=r.result,tx=db.transaction('messages','readwrite');tx.objectStore('messages').put({key:${JSON.stringify(draftKey)},value:${JSON.stringify(draft)}});tx.oncomplete=()=>{db.close();resolve()};tx.onerror=reject};r.onerror=reject})`)
    await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`); await wait(`document.querySelector('[role=menuitem]')`)
    await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(e=>e.textContent.includes('协作')).click()`)
    const openTeam = async () => { await wait(`document.querySelector('[data-sidebar-row=team] [data-row-title]')`); await page.evaluate(`document.querySelector('[data-sidebar-row=team] [data-row-title]').click()`); await wait(`document.querySelector('[aria-label="原生团队私信入口"]')`) }
    await openTeam(); await wait(`document.body.innerText.includes('当前工作区没有可用')`)
    assert.match(await page.evaluate('document.body.innerText'), /这里的历史与未发送草稿会保留，不会复制到所选私信/)
    assert.equal(creates.length, 0); assert.equal(messageWrites.length, 0)
    await click('开始原生私信'); await wait(`document.querySelector('[aria-label="私信名称"]')`)
    await click('取消'); assert.equal(creates.length, 0)
    await click('开始原生私信'); await wait(`document.querySelector('[aria-label="私信名称"]')`)
    await click('创建'); await wait(`document.body.innerText.includes('创建未确认')`)
    assert.equal(creates.length, 1); assert.equal(surfaces.length, 1); assert.equal(messageWrites.length, 0)
    await click('重试原创建请求'); await wait(`document.querySelector('.kode-discussions[data-private=true]')`)
    assert.deepEqual(creates[1], creates[0]); assert.equal(surfaces.length, 1); assert.equal(messageWrites.length, 0)
    assert.deepEqual(creates[0].input.team_ids, ['team']); assert.deepEqual(creates[0].input.scope, scope)
    await openTeam(); await wait(`document.querySelector('[aria-label="已有原生私信"]')`)
    assert.equal(await page.evaluate(`document.querySelector('[aria-label="已有原生私信"]').value`), '')
    assert.match(await page.evaluate('document.body.innerText'), /这里的历史与未发送草稿会保留，不会复制到所选私信/)
    await page.evaluate(`(()=>{const e=document.querySelector('[aria-label="已有原生私信"]');e.value=${JSON.stringify(surfaces[0].id)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await click('打开所选原生私信'); await wait(`document.querySelector('.kode-discussions[data-private=true]')`)
    assert.equal(creates.length, 2); assert.equal(messageWrites.length, 0)
    const retained = await page.evaluate(`new Promise((resolve,reject)=>{const r=indexedDB.open('kode.collab.outbox.v1',1);r.onsuccess=()=>{const db=r.result,get=db.transaction('messages').objectStore('messages').get(${JSON.stringify(draftKey)});get.onsuccess=()=>{db.close();resolve(get.result.value)};get.onerror=reject}})`)
    assert.equal(retained.value.draft, draft.value.draft)
    await page.call('Page.reload', { ignoreCache: true })
    await wait('globalThis.fixture')
    await wait(`document.querySelector('.kode-discussions[data-private=true]')`)
    assert.equal(await page.evaluate(`document.body.textContent.includes('本条消息用途')`), false)
    assert.equal(await page.evaluate(`document.body.textContent.includes('普通消息（不回答任何问题）')`), false)
    assert.equal(creates.length, 2); assert.equal(messageWrites.length, 0)
    assert.deepEqual(await page.evaluate('fixtureErrors'), [])
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(profile, { recursive: true, force: true }) }
})

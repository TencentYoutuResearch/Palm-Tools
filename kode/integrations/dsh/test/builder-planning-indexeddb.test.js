/** Actual startPlanning + createOutboxStorage on the browser's real IndexedDB; the planning endpoint is fixture data. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headlessBrowser } from './support/headless-browser.js'

// No Hub, no model and no Session: POST /api/kode/builder/planning is answered here per draft id.
const receipt = draft => ({ version: 1, state: 'ready', mode: 'interactive_planning', home_hub: 'hub', draft_id: draft, context_epoch: 1,
  session_id: 'fixture-session-' + draft, workspace_id: null, cwd: '/fixture/private', disposition: 'fresh', execution_authorized: false })

test('planning start on real IndexedDB: first start posts, only a pre-creation refusal frees the slot, lost response replays exactly, a newer revision never replaces an unconfirmed start, concurrent starts share one, storage failure never posts', { skip: !process.env.KODE_TEST_BROWSER_BIN, timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-planning-idb-')); let browser, server
  const posts = [], behaviour = { refused: 'agent-unavailable', registry: 'registry', identity: 'identity', forbidden: 'forbidden', unknown: 'unknown', lost: 'lose-once', concurrent: 'slow', revised: 'lose-once' }, held = []
  const modules = { '/planning.js': await readFile(new URL('../packages/collab/builder-planning.js', import.meta.url), 'utf8'), '/storage.js': await readFile(new URL('../packages/collab/outbox-storage.js', import.meta.url), 'utf8') }
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  try {
    server = createServer(async (req, res) => {
      if (req.url === '/api/kode/builder/planning' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk; const command = JSON.parse(body); posts.push(command)
        const mode = behaviour[command.draft_id]
        if (mode === 'agent-unavailable') { behaviour[command.draft_id] = 'ok'; return json(res, 409, { code: 'NATIVE_AGENT_UNAVAILABLE' }) }
        // Refusals that do not prove the start created nothing: answered the same way every time.
        if (mode === 'registry') return json(res, 409, { code: 'PLANNING_REGISTRY_CHANGED' })
        if (mode === 'identity') return json(res, 409, { code: 'PLANNING_IDENTITY_CHANGED' })
        if (mode === 'forbidden') return json(res, 403, { error: 'forbidden' })
        if (mode === 'unknown') return json(res, 409, { code: 'PLANNING_SOMETHING_NEW' })
        if (mode === 'lose-once') { behaviour[command.draft_id] = 'ok'; res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"version":'); setTimeout(() => res.socket.destroy(), 20); return }
        if (mode === 'slow') { held.push(() => json(res, 200, receipt(command.draft_id))); return }
        return json(res, 200, receipt(command.draft_id))
      }
      if (modules[req.url]) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(modules[req.url]) }
      if (req.url !== '/') { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<script type="module">import * as planning from '/planning.js';import {createOutboxStorage} from '/storage.js';
        const draft=(id,revision=1)=>({id,home_hub:'hub',revision});
        window.fixture={...planning,createOutboxStorage,draft,storage:createOutboxStorage(),
          start:(id,uuid,choice={profileId:'codex',model:'gpt-6.1-sol'},storage=fixture.storage)=>planning.startPlanning({storage,draft:draft(id),choice,uuid:()=>uuid}),
          row:id=>fixture.storage.read(planning.planningRequestKey(draft(id))),
          startAt:(id,revision,uuid,choice)=>planning.startPlanning({storage:fixture.storage,draft:draft(id,revision),choice,uuid:()=>uuid}),
          verifyAt:(id,revision)=>planning.verifyPlanning({storage:fixture.storage,draft:draft(id,revision)}),
          outcome:async run=>{try{return {ok:(await run()).session_id}}catch(error){return {code:error.code??null,status:error.status??null,reserved:error.reserved,message:planning.planningError(error)}}}};</script>`)
    }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, join(root, 'chrome'))
    const url = `http://127.0.0.1:${server.address().port}/`
    let page = await browser.page(url)
    const ready = () => page.evaluate(`(async()=>{const until=Date.now()+5000;while(!window.fixture){if(Date.now()>until)throw Error('module boot failed');await new Promise(r=>setTimeout(r,10))}})()`)
    await ready()
    const run = expr => page.evaluate(`fixture.outcome(()=>${expr})`)
    const sent = id => posts.filter(row => row.draft_id === id)

    // 1. First start on an empty slot: the real storage accepts the reservation and the command is posted.
    assert.deepEqual(await run(`fixture.start('fresh','id-fresh')`), { ok: 'fixture-session-fresh' })
    assert.deepEqual(sent('fresh'), [{ draft_id: 'fresh', draft_revision: 1, request_id: 'id-fresh', profile_id: 'codex', model: 'gpt-6.1-sol' }])
    assert.equal((await page.evaluate(`fixture.row('fresh')`)).state, 'accepted')

    // 2. A definite refusal marks it failed; only then may a new request (new id, new choice) take the slot.
    assert.equal((await run(`fixture.start('refused','id-a')`)).code, 'NATIVE_AGENT_UNAVAILABLE')
    assert.equal((await page.evaluate(`fixture.row('refused')`)).state, 'failed')
    assert.deepEqual(await run(`fixture.start('refused','id-b',{profileId:'cursor',model:'auto'})`), { ok: 'fixture-session-refused' })
    assert.deepEqual(sent('refused').map(row => [row.request_id, row.profile_id]), [['id-a', 'codex'], ['id-b', 'cursor']])

    // 2b. Registry/identity changes, a bare 403 and an unknown 409 keep the exact original; no new request id is ever posted.
    for (const id of ['registry', 'identity', 'forbidden', 'unknown']) {
      await run(`fixture.start('${id}','${id}-original')`)
      const original = await page.evaluate(`fixture.row('${id}')`); assert.equal(original.state, 'sent', id)
      await run(`fixture.start('${id}','${id}-new',{profileId:'cursor',model:'auto'})`)
      assert.deepEqual(sent(id).map(row => row.request_id), [`${id}-original`, `${id}-original`], id); assert.deepEqual(sent(id)[1], sent(id)[0])
      assert.deepEqual(await page.evaluate(`fixture.row('${id}')`), original, id)
    }

    // 3. Lost response, page recreated, pickers changed: the stored original is replayed byte-for-byte.
    const lost = await run(`fixture.start('lost','id-original')`)
    assert.equal(lost.code, null); assert.match(lost.message, /没有收到服务确认[\s\S]*原请求已保存在本机/)
    assert.equal((await page.evaluate(`fixture.row('lost')`)).state, 'sent')
    await page.evaluate('fixture.storage.close()'); await page.close(); page = await browser.page(url); await ready()
    assert.deepEqual(await run(`fixture.start('lost','id-new',{profileId:'tclaude',model:'opus-5.5'})`), { ok: 'fixture-session-lost' })
    assert.equal(sent('lost').length, 2); assert.deepEqual(sent('lost')[1], sent('lost')[0]); assert.equal(sent('lost')[0].request_id, 'id-original')

    // 3b. Revision 1 response lost, draft moves to revision 2: the unconfirmed original is kept verbatim and blocks a new command.
    assert.equal((await run(`fixture.startAt('revised',1,'rev1-original',{profileId:'codex',model:'gpt-6.1-sol'})`)).code, null)
    const original = await page.evaluate(`fixture.row('revised')`); assert.equal(original.state, 'sent')
    const blocked = await run(`fixture.startAt('revised',2,'rev2-new',{profileId:'cursor',model:'auto'})`)
    assert.deepEqual([blocked.code, blocked.status], ['planning_previous_unconfirmed', null])
    assert.match(blocked.message, /草案第 1 版[\s\S]*没有发送任何请求[\s\S]*先核对原请求/)
    assert.deepEqual(await page.evaluate(`fixture.row('revised')`), original, 'the original record is kept byte-for-byte')
    assert.deepEqual(sent('revised').map(row => row.request_id), ['rev1-original'], 'no new command was posted')
    assert.deepEqual(await page.evaluate(`fixture.pendingPlanning(fixture.storage,fixture.draft('revised',2))`), original)
    // Verifying resends only that original, unchanged; the server's own answer settles it.
    assert.deepEqual(await run(`fixture.verifyAt('revised',2)`), { ok: 'fixture-session-revised' })
    assert.deepEqual(sent('revised'), [sent('revised')[0], sent('revised')[0]]); assert.equal(sent('revised')[0].draft_revision, 1)
    assert.equal((await page.evaluate(`fixture.row('revised')`)).state, 'accepted')

    // 4. Two storages (two tabs) start at once: the atomic reservation gives both the same original command.
    await page.evaluate(`void (window.both=Promise.all([fixture.start('concurrent','tab-1'),fixture.start('concurrent','tab-2',{profileId:'cursor',model:'auto'},fixture.createOutboxStorage())]))`)
    while (held.length < 2) await new Promise(r => setTimeout(r, 20))
    held.splice(0).forEach(reply => reply())
    assert.deepEqual((await page.evaluate('both')).map(row => row.session_id), ['fixture-session-concurrent', 'fixture-session-concurrent'])
    assert.deepEqual(sent('concurrent').map(row => row.request_id), ['tab-1', 'tab-1']); assert.deepEqual(sent('concurrent')[1], sent('concurrent')[0])

    // 5. Storage failures never post, and the text says it is local, not the network.
    const before = posts.length
    const unopened = await run(`fixture.start('broken','id-x',undefined,fixture.createOutboxStorage(null))`)
    assert.deepEqual([unopened.code, unopened.reserved], ['planning_storage_failed', false])
    assert.match(unopened.message, /本机未能保存开始请求[\s\S]*没有发送请求，也没有创建会话/); assert.doesNotMatch(unopened.message, /原请求已保存|网络/)
    const unmarked = await run(`fixture.start('unmarked','id-y',undefined,{...fixture.storage,save:async()=>{throw Error('quota')}})`)
    assert.deepEqual([unmarked.code, unmarked.reserved], ['planning_storage_failed', true])
    assert.match(unmarked.message, /本机已保存开始请求[\s\S]*还没有发送/); assert.doesNotMatch(unmarked.message, /网络/)
    assert.equal(posts.length, before, 'no POST without a stored command')
    const kept = await page.evaluate(`fixture.row('unmarked')`); assert.equal(kept.state, 'prepared'); assert.equal(kept.command.request_id, 'id-y')
    // The stored (never sent) command is the one sent next time, not a rebuilt one.
    await run(`fixture.start('unmarked','id-z',{profileId:'cursor',model:'auto'})`)
    assert.deepEqual(sent('unmarked'), [kept.command])
  } finally { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)) } await rm(root, { recursive: true, force: true }) }
})

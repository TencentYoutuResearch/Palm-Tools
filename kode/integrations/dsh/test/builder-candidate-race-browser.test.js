/** Actual BuilderCandidateReview; the draft revisions, candidate and save responses are fixture data. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headlessBrowser } from './support/headless-browser.js'
import { collabRenderPage } from './support/collab-render-page.js'

// No Hub and no model. The test moves the draft revision itself to reproduce the two save races.
const home = 'fixture-home'
const candidate = { name: '评审团队', purpose: '验证改动', workspace_refs: [], workers: [{ id: 'tester', role: '验证', responsibilities: ['运行测试'], allowed_target_ids: ['control'], max_parallel: 1 }] }

test('candidate review stays bound to the revision it was read at: expiry keeps input, ends confirmation, and late old-scope results never land', { skip: !process.env.KODE_TEST_BROWSER_BIN, timeout: 60000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kode-candidate-race-')); let browser, server
  const state = { revision: 1, fail: false }, posts = []
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  try {
    const result = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {BuilderCandidateReview} from './packages/collab/builder-candidate-review.js';
    const store=new Map(),held=[];window.race={store,held,armed:null,saved:[]};
    // An armed key's read is held until released, so a result can arrive after the revision moved on.
    const storage={read:key=>{const value=store.get(key)??null;if(race.armed&&key===race.armed){race.armed=null;return new Promise(r=>held.push(()=>r(structuredClone(value))))}return Promise.resolve(value&&structuredClone(value))},
      save:async(key,value)=>{store.set(key,structuredClone(value))},reserve:async(key,value,replace)=>{const c=store.get(key);if(!c||replace?.(c))store.set(key,structuredClone(value));return structuredClone(store.get(key))}};
    const node=document.createElement('div');node.id='race';node.style='position:fixed;inset:0;overflow:auto;padding:24px;background:#fff;z-index:1';document.body.append(node);
    const root=createRoot(node);
    race.setRevision=revision=>root.render(React.createElement(BuilderCandidateReview,{key:'draft',draft:{id:'draft',home_hub:'${home}',revision,status:'draft'},storage,onSaved:row=>race.saved.push(row.revision)}));
    race.setRevision(1);`, resolveDir: process.cwd() },
    bundle: true, format: 'iife', platform: 'browser', external: ['react', 'react-dom', 'react-dom/client', '@deepseek-ai/dsh-client-ui-primitives', '@kode/dsh-composer'], write: false, banner: { js: 'const require=name=>window.__KODE_TEST_MODULES__[name];' } })
    server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname === '/race.js') { res.setHeader('content-type', 'text/javascript'); res.end(result.outputFiles[0].text); return }
      if (url.pathname === '/api/kode/builder/proposal' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk; posts.push(JSON.parse(body))
        return json(res, 503, { error: 'not confirmed' })
      }
      if (url.pathname === '/api/kode/builder/proposal') return json(res, 200, { format: 'kode.team-proposal.v1', draft_id: 'draft', draft_revision: state.revision, home_hub: home, prompt_max_bytes: 16000, team_max_bytes: 65536,
        saved_proposal: null, saved_workflow: null, candidate: { proposed_team: candidate }, source: { session_id: 's', message_id: 'm' + state.revision, turn: state.revision, sha256: 'a'.repeat(64) },
        state: 'candidate', owner_review_required: true, eligible_for_execution: false })
      if (await collabRenderPage(req, res)) return
      json(res, 503, {})
    }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile); const page = await browser.page(`http://127.0.0.1:${server.address().port}/`)
    await page.evaluate(`new Promise((resolve,reject)=>{const run=()=>{if(!window.fixture)return setTimeout(run,20);const s=document.createElement('script');s.src='/race.js';s.onload=resolve;s.onerror=reject;document.head.append(s)};run()})`)
    const root = `document.querySelector('#race')`
    const wait = expr => page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,25))}throw Error('Race timeout: '+${JSON.stringify(expr)}+' :: '+${root}.innerText)})()`)
    const has = text => page.evaluate(`Array.from(${root}.querySelectorAll('button')).some(b=>b.textContent===${JSON.stringify(text)})`)
    const click = async text => { await wait(`Array.from(${root}.querySelectorAll('button')).some(b=>b.textContent===${JSON.stringify(text)}&&!b.disabled)`); await page.evaluate(`Array.from(${root}.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)}&&!b.disabled).click()`) }
    const prompt = `${root}.querySelector('[data-role-prompt=tester] .kode-role-prompt textarea')`
    const type = value => page.evaluate(`(()=>{const el=${prompt};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    const moveTo = async revision => { state.revision = revision; await page.evaluate(`race.setRevision(${revision})`) }
    const openAt = async revision => { await wait(`/来自第 ${revision} 轮回复/.test(${root}.innerText)`); await click('审核并编辑'); await wait(prompt) }

    // 1. Same draft, newer revision while editing: the form stays on revision 1, input kept read-only, nothing can be saved.
    await openAt(1); await type('保留的输入')
    await moveTo(2)
    await wait(`${root}.querySelector('[data-candidate-state=expired]')`)
    assert.match(await page.evaluate(`${root}.innerText`), /这份编辑基于草案第 1 版，草案现在是第 2 版[\s\S]*输入仍保留/)
    assert.equal(await page.evaluate(`${root}.querySelector('form').dataset.boundRevision`), '1')
    assert.equal(await page.evaluate(`${prompt}.value`), '保留的输入'); assert.equal(await page.evaluate(`${prompt}.readOnly`), true)
    assert.equal(await has('核对并保存'), false); assert.equal(await has('确认保存方案'), false)
    await click('重新读取并审核')
    await openAt(2)
    assert.equal(await page.evaluate(`${prompt}.value`), '', 're-reading starts a fresh review of the new revision')

    // 2. Revision changes during confirmation: the confirmation is withdrawn, not carried to the new revision.
    await type('确认中的输入'); await click('核对并保存')
    await wait(`${root}.querySelector('[aria-label=保存确认]')`)
    await moveTo(3)
    await wait(`${root}.querySelector('[data-candidate-state=expired]')`)
    assert.equal(await page.evaluate(`!!${root}.querySelector('[aria-label=保存确认]')`), false)
    assert.equal(await page.evaluate(`${prompt}.value`), '确认中的输入')
    assert.equal(posts.length, 0, 'no stale spec was submitted')

    // 3. A → B → late A: revision 3 save fails, its pending-record read returns only after revision 4.
    await click('重新读取并审核'); await openAt(3); await type('第三版的指令')
    await page.evaluate(`race.armed=JSON.stringify(['builder-proposal-candidate','${home}','draft',3])`)
    await click('核对并保存'); await click('确认保存方案')
    await wait(`race.held.length===1`)
    assert.equal(posts.length, 1); assert.equal(posts[0].expected_revision, 3, 'the bound revision was submitted')
    await moveTo(4)
    await wait(`/来自第 4 轮回复/.test(${root}.innerText)||${root}.querySelector('[data-candidate-state=expired]')`)
    await page.evaluate(`race.held.shift()()`); await page.evaluate('new Promise(r=>setTimeout(r,150))')
    assert.equal(await has('恢复原保存请求'), false, 'revision 3 pending record did not land on revision 4')
    assert.doesNotMatch(await page.evaluate(`${root}.innerText`), /没有确认结果|上次保存没有收到确认/, 'no revision 3 notice on revision 4')
    // The original revision 3 command is kept intact for its own scope, never discarded or re-targeted.
    const kept = await page.evaluate(`race.store.get(JSON.stringify(['builder-proposal-candidate','${home}','draft',3]))`)
    assert.equal(kept.state, 'prepared'); assert.deepEqual(kept.command, posts[0])
    assert.equal(await page.evaluate(`race.store.has(JSON.stringify(['builder-proposal-candidate','${home}','draft',4]))`), false)
    assert.equal(posts.length, 1); assert.deepEqual(await page.evaluate('race.saved'), [])
    // After an explicit re-read the new revision is fully usable: the aborted old save left nothing busy.
    await click('重新读取并审核'); await wait(`/来自第 4 轮回复/.test(${root}.innerText)`)
    assert.equal(await page.evaluate(`Array.from(${root}.querySelectorAll('button')).find(b=>b.textContent==='审核并编辑')?.disabled`), false, 'the aborted old save does not leave the new revision busy')
    // Back on revision 3 (e.g. after reload) the same original request is offered for recovery.
    await moveTo(3)
    await wait(`Array.from(${root}.querySelectorAll('button')).some(b=>b.textContent==='恢复原保存请求')`)
  } finally { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } await rm(profile, { recursive: true, force: true }) }
})

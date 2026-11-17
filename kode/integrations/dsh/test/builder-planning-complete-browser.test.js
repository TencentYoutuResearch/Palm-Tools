/** Actual BuilderView + native Modal on the browser's real IndexedDB; the draft, uncertain binding and POST replies are fixture data. */
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

// No Hub, no model and no Session: the session host is a recording stub that never submits.
const home = 'fixture-home', session = 'native-planning-session'
const original = { draft_id: 'draft', draft_revision: 1, request_id: 'original-request', profile_id: 'codex', model: 'gpt-6.1-sol' }
const binding = extra => ({ version: 1, mode: 'interactive_planning', home_hub: home, draft_id: 'draft', context_epoch: 1, session_id: session, workspace_id: null,
  cwd: '/fixture/private-planning/' + session, location: { kind: 'private_planning' }, execution_authorized: false, ...extra })

test('completing the original Session: native confirmation, cancel posts nothing, one exact request per confirmation, failures keep the original, ready opens the same Session without sending', { skip: !process.env.KODE_TEST_BROWSER_BIN, timeout: 90000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kode-planning-complete-')); let browser, server
  const posts = [], replies = ['lost', 'unconfirmed', 'late', 'ready']
  const state = { planning: binding({ state: 'uncertain', disposition: 'recovered', retry_request: original }) }
  const draft = { id: 'draft', home_hub: home, revision: 1, status: 'draft', eligible_for_execution: false, interview: { purpose: '组建一个实现与验证团队', questions: [], answers: {}, workspace_refs: [] } }
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  try {
    const result = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {BuilderView,PlanningHostContext} from './packages/collab/builder-view.js';import {BuilderControlsContext} from './packages/collab/builder-controls.js';import {createOutboxStorage} from './packages/collab/outbox-storage.js';import {planningRequestKey,planningGoalKey} from './packages/collab/builder-planning.js';
    const storage=createOutboxStorage(),key=planningRequestKey({id:'draft',home_hub:'${home}'});
    window.complete={host:[],storage,key,row:()=>storage.read(key),held:[],hold:null};
    // An armed key's read is held until released, so the view can close while the handoff waits on it.
    const view={...storage,read:k=>k===complete.hold?new Promise(r=>complete.held.push(()=>r(storage.read(k)))):storage.read(k)};
    complete.goal=planningGoalKey({id:'draft',home_hub:'${home}'});
    (async()=>{
    // The earlier start whose reply was lost: the exact original command is pending in IndexedDB.
    await storage.reserve(key,{request_id:'${original.request_id}',draft_revision:1,state:'sent',command:${JSON.stringify(original)}});
    complete.seeded=await storage.read(key);
    const request=async(path,{signal}={})=>{const response=await fetch(path,{signal});if(!response.ok)throw Object.assign(Error('fixture read'),{status:response.status});return response.json()};
    const input={requestDraftInitialization:(binding,options)=>{complete.host.push(['init',binding.sessionId,options.whenDraftExists]);return 'applied'},submit:()=>complete.host.push(['submit']),for:()=>({focus:()=>{}})};
    const host={sessions:{refresh:async()=>{},binding:id=>({sessionId:id,ctx:{get:name=>name==='conversation'?{input}:null}})},uiWorkspace:{openSession:async id=>complete.host.push(['open',id])},selectMode:mode=>complete.host.push(['mode',mode])};
    const node=document.createElement('div');node.id='complete-test';node.style='position:fixed;inset:0;background:var(--dsw-alias-bg-base,#fff);z-index:1';document.body.append(node);
    const root=createRoot(node);complete.mount=()=>root.render(React.createElement(BuilderControlsContext.Provider,{value:fixture.ctx.get('kodeAgentControls')},React.createElement(PlanningHostContext.Provider,{value:host},React.createElement(BuilderView,{request,storage:view}))));complete.unmount=()=>root.render(null);complete.mount();})().catch(error=>{complete.error=String(error)});`, resolveDir: process.cwd() },
    bundle: true, format: 'iife', platform: 'browser', external: ['react', 'react-dom', 'react-dom/client', '@deepseek-ai/dsh-client-ui-primitives', '@kode/dsh-composer'], write: false,
    banner: { js: 'const require=name=>window.__KODE_TEST_MODULES__[name];' } })
    server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname === '/complete-test.js') { res.setHeader('content-type', 'text/javascript'); res.end(result.outputFiles[0].text); return }
      if (url.pathname === '/api/kode/agents') return json(res, 200, { profiles: [{ id: 'codex', name: 'Codex', type: 'codex', origin: 'builtin' }], selectedProfileId: 'codex', supportedTypes: ['codex'], models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }], defaultModelSelection: { model: 'gpt-6.1-sol' } })
      if (req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk; posts.push({ path: url.pathname, body: JSON.parse(body) })
        if (url.pathname !== '/api/kode/builder/planning') return json(res, 503, {})
        const reply = replies.shift()
        if (reply === 'lost') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"state":'); setTimeout(() => res.socket.destroy(), 20); return }
        if (reply === 'unconfirmed') return json(res, 409, { code: 'PLANNING_NOT_CONFIRMED', execution_authorized: false })
        // 'late': a ready receipt for a view that is closed before it can act; the status stays uncertain.
        if (reply === 'ready') state.planning = binding({ state: 'ready', disposition: 'recovered' })
        return json(res, 200, binding({ state: 'ready', disposition: 'recovered' }))
      }
      if (url.pathname === '/api/kode/builder/drafts') return url.searchParams.has('draft_id') ? json(res, 200, draft) : json(res, 200, { home_hub: home, items: [{ id: 'draft', revision: 1, purpose: draft.interview.purpose, status: 'draft' }], next_cursor: null })
      if (url.pathname === '/api/kode/builder/planning') return json(res, 200, state.planning)
      if (url.pathname === '/api/kode/builder/proposal') return json(res, 200, { format: 'kode.team-proposal.v1', draft_id: 'draft', draft_revision: 1, home_hub: home, saved_proposal: null, saved_workflow: null, state: 'no_completed_reply', candidate: null, source: null, owner_review_required: true, eligible_for_execution: false })
      if (await collabRenderPage(req, res)) return
      json(res, 503, {})
    }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, join(profile, 'chrome')); const page = await browser.page(`http://127.0.0.1:${server.address().port}/`)
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await page.evaluate(`new Promise((resolve,reject)=>{const run=()=>{if(!window.fixture)return setTimeout(run,20);const s=document.createElement('script');s.src='/complete-test.js';s.onload=resolve;s.onerror=reject;document.head.append(s)};run()})`)
    const root = `document.querySelector('#complete-test')`, dialog = `document.querySelector('[role=dialog]')`
    const wait = expr => page.evaluate(`(async()=>{const end=Date.now()+12000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,25))}throw Error('Complete timeout: '+${JSON.stringify(expr)}+' :: '+(${root}?.innerText??''))})()`)
    const button = (text, scope = 'document') => `Array.from(${scope}.querySelectorAll('button')).find(b=>(b.textContent===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)})&&!b.disabled)`
    const click = async (text, scope) => { await wait(button(text, scope)); await page.evaluate(`${button(text, scope)}.click()`) }
    const settle = () => page.evaluate('new Promise(r=>setTimeout(r,400))')
    const planningPosts = () => posts.filter(row => row.path === '/api/kode/builder/planning')
    const expected = { ...original, complete_partial: true }
    const record = () => page.evaluate('complete.row()')

    await wait('window.complete?.seeded||window.complete?.error')
    assert.equal(await page.evaluate('complete.error??null'), null)
    const openDraft = async () => {
      await click('团队规划记录')
      await wait(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).some(b=>b.textContent.includes('组建一个实现与验证团队'))`)
      await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).find(b=>b.textContent.includes('组建一个实现与验证团队')).click()`)
      await wait(`${root}.querySelector('[data-planning-state="uncertain"]')`)
    }
    await openDraft()
    const seeded = await page.evaluate('complete.seeded')

    // 1. The native confirmation explains the effect; cancel posts nothing.
    await click('完成原会话初始化', root)
    await wait(dialog)
    const explained = await page.evaluate(`${dialog}.innerText`)
    assert.match(explained, new RegExp(`服务保留了原规划会话 ID ${session}[\\s\\S]*服务会核查证据，仅在符合条件时补完[\\s\\S]*只可能补完这个原会话（同一 ID[\\s\\S]*不会向模型发送任何消息，不会新建替代会话`))
    assert.doesNotMatch(explained, /已存在|初始化未完成/, 'an uncertain GET proves only the reserved id')
    await click('取消', dialog); await wait(`!${dialog}`); await settle()
    assert.equal(posts.length, 0, 'cancel sends nothing')

    // 2. Double click on confirm: exactly one request, the server's retry_request plus the flag. Lost reply keeps the original.
    await click('完成原会话初始化', root); await wait(button('确认完成初始化', dialog))
    await page.evaluate(`(()=>{const b=${button('确认完成初始化', dialog)};b.click();b.click()})()`)
    await wait(`/诊断：未收到完整的 HTTP 响应/.test(${root}.innerText)`); await settle()
    assert.equal(planningPosts().length, 1, 'a double click sends once')
    assert.deepEqual(planningPosts()[0].body, expected, 'retry_request verbatim plus complete_partial')
    assert.deepEqual(await record(), seeded, 'the pending original is not rewritten with the flag nor marked failed')
    await wait(`${root}.querySelector('[data-planning-state="uncertain"]')`); await settle()
    assert.equal(planningPosts().length, 1, 'no automatic repeat')

    // 3. An unconfirmed reply keeps everything for another check; nothing is repaired automatically.
    await click('完成原会话初始化', root); await click('确认完成初始化', dialog)
    await wait(`/诊断：HTTP 409 · PLANNING_NOT_CONFIRMED/.test(${root}.innerText)`); await settle()
    assert.equal(planningPosts().length, 2); assert.deepEqual(planningPosts()[1].body, expected)
    assert.deepEqual(await record(), seeded)
    assert.equal(await page.evaluate(`!!${button('完成原会话初始化', root)}`), true, 'the original can be checked again')

    // 3b. Ready receipt, but the view closes while the handoff waits on its local read: nothing is opened or filled.
    await page.evaluate('complete.hold=complete.goal')
    await click('完成原会话初始化', root); await click('确认完成初始化', dialog)
    await wait('complete.held.length===1')
    assert.equal(planningPosts().length, 3); assert.deepEqual(planningPosts()[2].body, expected)
    await page.evaluate('complete.unmount()'); await page.evaluate('complete.hold=null;complete.held.shift()()'); await settle()
    assert.deepEqual(await page.evaluate('complete.host'), [], 'a closed view never opens or fills the Session')
    assert.deepEqual(await record(), seeded)
    await page.evaluate('complete.mount()'); await openDraft()

    // 4. Ready: the same Session id is opened; the goal is only offered to its input, never submitted.
    await click('完成原会话初始化', root); await click('确认完成初始化', dialog)
    await wait(`complete.host.some(row=>row[0]==='open')&&complete.host.some(row=>row[0]==='init')`); await settle()
    assert.equal(planningPosts().length, 4); assert.deepEqual(planningPosts()[3].body, expected)
    assert.deepEqual(await page.evaluate('complete.host.filter(row=>row[0]==="open"||row[0]==="init").map(row=>row.slice(0,2))'), [['open', session], ['init', session]])
    assert.equal(await page.evaluate('complete.host.some(row=>row[0]==="submit")'), false, 'no message is sent to the model')
    assert.ok(posts.every(row => row.path === '/api/kode/builder/planning'), 'no other write')
    assert.deepEqual(await record(), seeded, 'local storage is never touched by completion')
    await click('团队工作区', root)
    await wait(`${root}.querySelector('.kode-collab-workspace-form')`)
    assert.match(await page.evaluate(`${root}.innerText`), /不改变已有规划会话的位置或文件访问权限/)
    await click('返回对话', root)
    await wait(`${root}.querySelector('[data-planning-state="ready"]')`)
    assert.equal(planningPosts().length, 4, 'workspace navigation never starts or rebinds a Session')
  } finally { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)) } await rm(profile, { recursive: true, force: true }) }
})

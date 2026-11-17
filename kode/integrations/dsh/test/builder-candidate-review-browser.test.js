/** Actual BuilderView + proposal view with the Kode Agent facade; the draft, planning binding and candidate are fixture data. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { headlessBrowser } from './support/headless-browser.js'
import { collabRenderPage } from './support/collab-render-page.js'

// No Hub, no model and no Session: GET/POST /api/kode/builder/proposal are answered by this file.
const home = 'fixture-home', ref = { host_id: home, workspace_id: 'project', root_ref: '/fixture/kode' }
const candidate = { name: '评审团队', kind: 'coordinator', purpose: '实现并验证改动', workspace_refs: [ref], execution_targets: [{ id: 'control', host_id: home, provider_id: 'openai', model_id: 'gpt-6.1-sol', executor_profile_id: 'codex', account_binding_id: 'acct' }],
  coordinator_targets: ['control'], workflow_pack_refs: [], grant_id: 'grant', budget_policy_id: '', scheduling_policy_id: '', limits: { max_active_runs: 1, max_active_assignments: 2 }, proactive_mode: 'off',
  coordinator_prompt: '先拆解任务，再分配。',
  workers: [{ id: 'builder', role: '实现', responsibilities: ['修改代码'], allowed_target_ids: ['control'], required_capabilities: ['code'], max_parallel: 1, workspace_refs: [ref], role_prompt: '只改与任务相关的文件。' },
    { id: 'tester', role: '验证', responsibilities: ['运行测试', '汇报结果'], allowed_target_ids: ['control'], required_capabilities: ['code'], max_parallel: 1, workspace_refs: [ref] }] }

test('Builder candidate: explained empty/invalid states, readable per-role edit, explicit save through the original POST, no accept', { skip: !process.env.KODE_TEST_BROWSER_BIN, timeout: 90000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kode-builder-candidate-')); let browser, server
  const posts = [], reads = [], state = { draft: { id: 'draft', home_hub: home, revision: 1, status: 'draft', eligible_for_execution: false, interview: { purpose: '组建一个实现与验证团队', questions: [], answers: {}, workspace_refs: [ref] } },
    proposal: ['no_completed_reply', 'invalid', 'candidate'], posts: 0 }
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const proposal = kind => ({ format: 'kode.team-proposal.v1', draft_id: 'draft', draft_revision: state.draft.revision, home_hub: home, prompt_max_bytes: 16000, team_max_bytes: 65536,
    saved_proposal: state.draft.interview.proposed_team ?? null, saved_workflow: null, owner_review_required: true, eligible_for_execution: false,
    ...(kind === 'candidate' ? { state: 'candidate', candidate: { proposed_team: candidate }, source: { session_id: 'native-planning-session', message_id: 'm-7', turn: 3, sha256: 'f'.repeat(64) } } : { state: kind, candidate: null, source: null }) })
  try {
    const result = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {BuilderView,PlanningHostContext} from './packages/collab/builder-view.js';import {BuilderControlsContext} from './packages/collab/builder-controls.js';
    window.builderCandidate={store:new Map(),requests:[]};
    const storage={read:async key=>builderCandidate.store.get(key)??null,save:async(key,value)=>{builderCandidate.store.set(key,structuredClone(value))},reserve:async(key,value,replace)=>{const current=builderCandidate.store.get(key);if(!current||replace?.(current))builderCandidate.store.set(key,structuredClone(value));return structuredClone(builderCandidate.store.get(key))}};
    const request=async(path,{signal}={})=>{builderCandidate.requests.push(path);const response=await fetch(path,{signal});if(!response.ok)throw Object.assign(Error('fixture read'),{status:response.status});return response.json()};
    const host={sessions:{refresh:async()=>{},binding:()=>null},uiWorkspace:{openSession:async()=>{}},selectMode:()=>{}};
    const node=document.createElement('div');node.id='builder-candidate-test';node.style='position:fixed;inset:0;background:var(--dsw-alias-bg-base,#fff);z-index:1';document.body.append(node);
    createRoot(node).render(React.createElement(BuilderControlsContext.Provider,{value:fixture.ctx.get('kodeAgentControls')},React.createElement(PlanningHostContext.Provider,{value:host},React.createElement(BuilderView,{request,storage}))));`, resolveDir: process.cwd() },
    bundle: true, format: 'iife', platform: 'browser', external: ['react', 'react-dom', 'react-dom/client', '@deepseek-ai/dsh-client-ui-primitives', '@kode/dsh-composer'], write: false, banner: { js: 'const require=name=>window.__KODE_TEST_MODULES__[name];' } })
    server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname === '/builder-candidate-test.js') { res.setHeader('content-type', 'text/javascript'); res.end(result.outputFiles[0].text); return }
      if (url.pathname === '/api/kode/agents' && req.method === 'GET') return json(res, 200, { profiles: [{ id: 'codex', name: 'Codex', type: 'codex', origin: 'builtin' }], selectedProfileId: 'codex', supportedTypes: ['codex'], models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }], defaultModelSelection: { model: 'gpt-6.1-sol' } })
      if (req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk; const command = JSON.parse(body); posts.push({ path: url.pathname, body: command })
        if (url.pathname === '/api/kode/builder/proposal') {
          // 1: the response is lost after the server saved it. 2: the identical retry returns the saved draft.
          if (command.expected_revision === state.draft.revision) state.draft = { ...state.draft, revision: 2, request_id: command.request_id, interview: { ...state.draft.interview, proposed_team: command.proposed_team } }
          if (++state.posts === 1) { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"id":'); setTimeout(() => res.socket.destroy(), 20); return }
          return json(res, 200, state.draft)
        }
        return json(res, 503, {})
      }
      if (url.pathname === '/api/kode/builder/proposal') {
        reads.push(url.search)
        const kind = state.proposal.length > 1 ? state.proposal.shift() : state.proposal[0]
        if (kind === 'invalid') return json(res, 409, { code: 'PROPOSAL_INVALID', eligible_for_execution: false })
        return json(res, 200, proposal(state.draft.interview.proposed_team && kind === 'candidate' ? 'no_candidate' : kind))
      }
      if (url.pathname === '/api/kode/builder/drafts') {
        if (url.searchParams.has('draft_id')) return json(res, 200, state.draft)
        return json(res, 200, { home_hub: home, items: [{ id: 'draft', revision: state.draft.revision, purpose: state.draft.interview.purpose, status: 'draft' }], next_cursor: null })
      }
      if (url.pathname === '/api/kode/builder/planning') return json(res, 200, { version: 1, mode: 'interactive_planning', home_hub: home, draft_id: 'draft', context_epoch: 1, session_id: 'native-planning-session', workspace_id: null, cwd: '/fixture/private', location: { kind: 'private_planning' }, execution_authorized: false, state: 'ready', disposition: 'recovered' })
      if (await collabRenderPage(req, res)) return
      json(res, 503, {})
    }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile); const page = await browser.page(`http://127.0.0.1:${server.address().port}/`)
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await page.evaluate(`new Promise((resolve,reject)=>{const run=()=>{if(!window.fixture)return setTimeout(run,20);const s=document.createElement('script');s.src='/builder-candidate-test.js';s.onload=resolve;s.onerror=reject;document.head.append(s)};run()})`)
    const root = '#builder-candidate-test', section = `document.querySelector('${root} [aria-label="方案候选"]')`
    const wait = expr => page.evaluate(`(async()=>{const end=Date.now()+12000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,25))}throw Error('Candidate timeout: '+${JSON.stringify(expr)}+' :: '+document.querySelector('${root}')?.innerText)})()`)
    const clickText = async (text, scope = `document.querySelector('${root}')`) => { await wait(`Array.from(${scope}.querySelectorAll('button')).some(b=>(b.textContent===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)})&&!b.disabled)`); await page.evaluate(`Array.from(${scope}.querySelectorAll('button')).find(b=>(b.textContent===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)})&&!b.disabled).click()`) }
    const type = (selector, value) => page.evaluate(`(()=>{const el=${section}.querySelector(${JSON.stringify(selector)});const set=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set;set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    const shots = process.env.KODE_ARTIFACT_DIR ?? resolve('../../../artifacts/builder-conversation-redesign-20261110'); await mkdir(shots, { recursive: true })
    const shot = async name => writeFile(join(shots, name), Buffer.from((await page.call('Page.captureScreenshot', { format: 'png' })).data, 'base64'))

    await clickText('团队规划记录')
    await wait(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).some(b=>b.textContent.includes('组建一个实现与验证团队'))`)
    await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).find(b=>b.textContent.includes('组建一个实现与验证团队')).click()`)
    // The conversation offers the review; it opens the proposal tab and only reads.
    await clickText('审核方案候选')
    await wait(`${section}?.querySelector('[data-candidate-state=no_completed_reply]')`)
    assert.match(await page.evaluate(`${section}.innerText`), /还没有已完成的回复[\s\S]*不会被读取/)
    await clickText('重新读取', section)
    await wait(`${section}.querySelector('[data-candidate-state=error]')`)
    assert.match(await page.evaluate(`${section}.innerText`), /格式不正确[\s\S]*没有保存任何内容/)
    await clickText('重新读取', section)
    await wait(`${section}.querySelector('[data-candidate-state=candidate]')`)
    assert.match(await page.evaluate(`${section}.innerText`), /评审团队 · 2 个成员 · 来自第 3 轮回复/)
    assert.deepEqual(posts, [], 'reading a candidate writes nothing')
    await shot('builder-candidate-available-1440.png')

    await clickText('审核并编辑', section)
    await wait(`${section}.querySelector('[data-role-prompt=tester] textarea')`)
    assert.deepEqual(await page.evaluate(`Array.from(${section}.querySelectorAll('fieldset legend')).map(n=>n.textContent)`), ['协调者（SuperAgent）', '实现', '验证'])
    assert.equal(await page.evaluate(`${section}.querySelector('[data-role-prompt=builder] .kode-role-prompt textarea').value`), '只改与任务相关的文件。')
    assert.equal(await page.evaluate(`${section}.querySelector('[data-role-prompt=tester] .kode-role-prompt-count').textContent`), '未设置')
    assert.equal(await page.evaluate(`!!${section}.querySelector('textarea[name*=json],pre')`), false, 'no hand-written JSON')
    await type('[data-role-prompt=tester] .kode-role-prompt textarea', '每次都附上失败用例的复现步骤。')
    await type('[data-role-prompt=builder] .kode-role-prompt textarea', '   ')
    await type('[data-role-prompt=coordinator] .kode-role-prompt textarea', '团'.repeat(5334))
    await wait(`${section}.querySelector('[data-role-prompt=coordinator] .kode-role-prompt-count[data-over]')`)
    assert.match(await page.evaluate(`${section}.querySelector('[data-role-prompt=coordinator] .kode-role-prompt-count').textContent`), /16002 \/ 16000 字节，超出上限/)
    assert.equal(await page.evaluate(`Array.from(${section}.querySelectorAll('button')).find(b=>b.textContent==='核对并保存').disabled`), true, 'over-limit cannot be saved')
    await type('[data-role-prompt=coordinator] .kode-role-prompt textarea', '先拆解任务，再按成员分配。')
    await page.evaluate(`${section}.querySelector('[data-role-prompt=tester]').scrollIntoView({block:'center'})`)
    await shot('builder-candidate-edit-1440.png')
    await page.evaluate("document.body.setAttribute('data-ds-dark-theme','')"); await page.evaluate('new Promise(r=>setTimeout(r,100))')
    await shot('builder-candidate-edit-dark-1440.png'); await page.evaluate("document.body.removeAttribute('data-ds-dark-theme')")
    await page.call('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false })
    assert.deepEqual(await page.evaluate(`(()=>{const edge=${section}.getBoundingClientRect().right;return Array.from(${section}.querySelectorAll('*')).filter(n=>n.getBoundingClientRect().width&&n.getBoundingClientRect().right>edge+1).map(n=>n.className||n.tagName)})()`), [])
    await shot('builder-candidate-edit-760.png')
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

    await clickText('核对并保存', section)
    assert.match(await page.evaluate(`${section}.querySelector('[aria-label=保存确认]').innerText`), /第 1 版保存为第 2 版[\s\S]*不会接受团队/)
    assert.deepEqual(posts, [], 'review is not a write')
    await clickText('确认保存方案', section)
    await wait(`Array.from(${section}.querySelectorAll('button')).some(b=>b.textContent==='恢复原保存请求')`)
    assert.match(await page.evaluate(`${section}.innerText`), /上次保存没有收到确认/)
    await clickText('恢复原保存请求', section)
    await wait(`${section}&&/已保存为草案第 2 版/.test(document.querySelector('${root}').innerText)`)

    assert.equal(posts.length, 2); assert.ok(posts.every(row => row.path === '/api/kode/builder/proposal'))
    assert.equal(posts[0].body.request_id, posts[1].body.request_id, 'recovery resends the original request')
    assert.deepEqual(Object.keys(posts[0].body).sort(), ['draft_id', 'expected_revision', 'proposed_team', 'request_id'])
    const saved = posts[0].body.proposed_team
    assert.equal(saved.coordinator_prompt, '先拆解任务，再按成员分配。')
    assert.equal('role_prompt' in saved.workers.find(row => row.id === 'builder'), false, 'a blank box clears by omission')
    assert.equal(saved.workers.find(row => row.id === 'tester').role_prompt, '每次都附上失败用例的复现步骤。')
    assert.deepEqual({ ...saved, coordinator_prompt: candidate.coordinator_prompt, workers: candidate.workers }, candidate, 'everything not shown is carried through')
    // The saved draft is the new proposal; acceptance stays the existing separate step.
    await wait(`Array.from(document.querySelectorAll('${root} button')).some(b=>b.textContent==='核对团队方案')`)
    assert.match(await page.evaluate(`document.querySelector('${root} .kode-collab-proposal').innerText`), /协调者指令[\s\S]*角色指令/)
    assert.ok(!posts.some(row => row.path.includes('accept')), 'nothing was accepted')
    await shot('builder-candidate-saved-1440.png')
  } finally { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } await rm(profile, { recursive: true, force: true }) }
})

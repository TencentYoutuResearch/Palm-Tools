/** Actual SidebarRoot, collab IM and Kode appearance/Agent facades; team, avatars and preferences are fixture data. */
import test from 'node:test'
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collabRenderPage } from './support/collab-render-page.js'
import { headlessBrowser } from './support/headless-browser.js'

// Fixture data only: no Hub, no real model, no Session and no microphone.
test('SuperAgent gear opens native settings with one Agent, Reasonable/Lite and advanced scope, no budget', {
  skip: !process.env.KODE_TEST_BROWSER_BIN, timeout: 60000,
}, async () => {
  const bundle = await build({ entryPoints: ['packages/collab/client-source.js'], bundle: true, loader: { '.png': 'dataurl' }, format: 'cjs', platform: 'browser', external: ['react', 'react-dom', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-primitives', '@kode/dsh-composer'], write: false })
  const client = `window.__ModuleLoader__.load({id:'@kode/dsh-collab',factory(require){const module={exports:{}},exports=module.exports;${bundle.outputFiles[0].text};return module.exports}})`
  const art = await readFile(new URL('../assets/agents/kode.png', import.meta.url))
  const profile = await mkdtemp(join(tmpdir(), 'kode-superagent-settings-'))
  const writes = [], appearancePosts = [], configurationPosts = []
  let browser, server, avatarId = null
  const contact = { preference: { revision: 0, pinned: false, archived: false, archived_through_sequence: 0 }, archived: false, needs_attention: false, latest_sequence: 0, unread_count: 0, last_activity_at: 0, attention: { decisions: 0, resources: 0, stopping: 0, active_runs: 0 } }
  const team = { id: 'team', home_hub: 'home', revision: 2, superagent_id: 'super', conversation_id: 'dm',
    spec: { name: '评审团队', kind: 'coordinator', purpose: 'Review',
      workers: [{ id: 'tester', role: 'Tester', responsibilities: ['Verify changes'], allowed_target_ids: ['control'], max_parallel: 1 }],
      workspace_refs: [{ host_id: 'home', workspace_id: 'ws-fixture', root_ref: '/fixture/project' }],
      coordinator_targets: ['control'], execution_targets: [{ id: 'control', host_id: 'home', executor_profile_id: 'codex', provider_id: 'openai', model_id: 'gpt-6.1-sol', effort: 'high' }] } }
  const profiles = [{ id: 'tclaude', name: 'tclaude', type: 'claude', origin: 'builtin' }, { id: 'codex', name: 'Codex', type: 'codex', origin: 'builtin' }]
  const avatars = [{ id: 'gallery/owl', name: '猫头鹰', url: '/fixture-art/owl.png', background: '/fixture-art/owl-bg.png' }, { id: 'gallery/fox', name: '狐狸', url: '/fixture-art/fox.png', background: '/fixture-art/fox-bg.png' }]
  try {
    server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const send = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
      if (url.pathname === '/fixture-collab.js') { res.setHeader('content-type', 'text/javascript'); res.end(client); return }
      if (url.pathname.startsWith('/fixture-art/')) { res.setHeader('content-type', 'image/png'); res.end(art); return }
      if (await collabRenderPage(req, res, { workspaces: [{ workspaceId: 'ws-fixture', title: '测试工作区 · ws-fixture', path: '/fixture/project', sessionIds: [], createdAt: '2026-11-10T00:00:00.000Z' }] })) return
      let body = ''; for await (const chunk of req) body += chunk
      if (req.method !== 'GET') writes.push(req.method + ' ' + url.pathname)
      if (url.pathname === '/api/kode/collaboration' && url.searchParams.get('path') === 'surfaces') {
        const scope = Object.fromEntries(['home_hub', 'host_id', 'workspace_id', 'root_ref'].map(key => [key, url.searchParams.get(key)]))
        return send({ scope, items: ['channel', 'dm'].map(kind => ({ id: 'native-' + kind, scope, kind, title: kind === 'channel' ? '项目频道' : '项目私信', team_ids: [], revision: 1, enabled: true })) })
      }
      if (url.pathname === '/api/kode/collab/teams') return send(url.searchParams.get('team_id') === 'team' ? { projection: 'configuration_revision', team }
        : { home_hub: 'home', projection: 'contact_directory', archived: url.searchParams.get('archived') === 'true', order: 'pinned_attention_unread_recent', items: url.searchParams.get('archived') === 'true' ? [] : [{ ...team, contact }], next_cursor: null })
      if (url.pathname === '/api/kode/conversation/messages') return send({ home_hub: 'home', team_id: 'team', conversation_id: 'dm', items: [], has_more: false, next_cursor: null })
      if (url.pathname === '/api/kode/conversation/read-state') return send({ home_hub: 'home', team_id: 'team', conversation_id: 'dm', principal_id: 'local_owner', through_sequence: 0, latest_sequence: 0, unread_count: 0 })
      if (url.pathname === '/api/kode/collab/runs') return send({ home_hub: 'home', team_id: 'team', items: [], next_cursor: null })
      if (url.pathname === '/api/kode/teams/configuration' && req.method === 'POST') {
        const command = JSON.parse(body); configurationPosts.push(command)
        return send({ ...team, revision: command.expected_revision + 1, status: 'draft', eligible_for_execution: false, spec: command.spec })
      }
      if (url.pathname === '/api/kode/avatars' && req.method === 'GET') return send({ avatars })
      if (url.pathname === '/api/kode/collab/appearance') {
        const input = req.method === 'POST' ? JSON.parse(body) : Object.fromEntries(url.searchParams)
        if (req.method === 'POST') { appearancePosts.push(input); avatarId = input.avatar_id }
        const avatar = avatars.find(row => row.id === avatarId)
        return send({ team_id: input.team_id, home_hub: input.home_hub, superagent_id: input.superagent_id, profile: { id: 'im-team', name: '评审团队', type: 'custom', avatar: avatar ?? { id: null, url: null } } })
      }
      if (url.pathname === '/api/kode/agents' && req.method === 'GET') {
        const id = url.searchParams.get('profile_id'), teamId = url.searchParams.get('team_id')
        return send({ profiles, selectedProfileId: 'tclaude', supportedTypes: ['claude', 'codex'],
          ...(id === 'tclaude' ? { models: [{ id: 'opus-5.5', name: 'Opus 5.5' }], defaultModelSelection: { model: 'opus-5.5' } } : id === 'codex' ? { models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }], defaultModelSelection: { model: 'gpt-6.1-sol' } } : { models: [] }),
          ...(teamId ? { teamRolePreferences: { teamId, assignments: { superagent: { profileId: 'codex', model: 'gpt-6.1-sol' } }, preferenceRevision: 1, scope: 'local_host', eligibleForExecution: false } } : {}) })
      }
      send({ error: '此隔离测试未启用该服务' }, 503)
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    const page = await browser.page(`http://127.0.0.1:${server.address().port}`)
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false })
    const wait = expr => page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,30))}throw Error('SuperAgent settings timed out: '+${JSON.stringify(expr)}+' :: '+JSON.stringify({body:document.body.innerText.slice(0,2000),errors:window.fixtureErrors}))})()`)
    const clickText = async (text, scope = 'document') => { await wait(`Array.from(${scope}.querySelectorAll('button')).some(b=>(b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)})&&!b.disabled)`); await page.evaluate(`Array.from(${scope}.querySelectorAll('button')).find(b=>(b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)})&&!b.disabled).click()`) }
    const dir = process.env.KODE_ARTIFACT_DIR ?? '/tmp/kode-orbit-shots'; await mkdir(dir, { recursive: true })
    const shot = async name => writeFile(join(dir, name), Buffer.from((await page.call('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
    const panel = `document.querySelector('aside.kode-superagent-settings')`

    await wait(`document.querySelector('.kode-collab-mode-switch button')`)
    if (await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').getAttribute('aria-label').includes('会话')`)) {
      await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`)
      await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('协作'))`)
      await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('协作')).click()`)
    }
    await wait(`document.querySelector('[data-sidebar-section=channels]')`)
    await page.evaluate(`(()=>{const d=document.querySelector('[data-sidebar-section=channels]');if(!d.open)d.querySelector('summary').click()})()`)
    await wait(`document.querySelector('[data-sidebar-row=team] [data-row-title]')`)
    await page.evaluate(`document.querySelector('[data-sidebar-row=team] [data-row-title]').click()`)
    await wait(`document.querySelector('.kode-collab-header')`)

    // No budget entry in the DM header; one settings gear.
    const headerActions = await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-header-actions button')).map(b=>b.getAttribute('aria-label'))`)
    assert.ok(headerActions.includes('SuperAgent 设置'), JSON.stringify(headerActions))
    assert.ok(!headerActions.some(label => /预算/.test(label ?? '')), 'no budget entry: ' + JSON.stringify(headerActions))

    await clickText('SuperAgent 设置', 'document.querySelector(".kode-collab-header-actions")')
    await wait(`${panel}&&${panel}.querySelector('[data-model-tier="reasonable"] button[aria-label^="模型："]')`)
    assert.equal(await page.evaluate(`${panel}.getAttribute('aria-label')`), '评审团队 设置')
    assert.equal(await page.evaluate(`document.activeElement.textContent`), '设置', 'focus moves into the panel')
    assert.deepEqual(await page.evaluate(`Array.from(${panel}.querySelectorAll('.kode-settings-group > h3')).map(n=>n.textContent)`),
      ['身份与外观', '执行配置', '角色指令', '当前会话', '高级'])
    // Image-4 anatomy: every group's rows live in one card, each row title + note left, control right, thin dividers.
    assert.deepEqual(await page.evaluate(`Array.from(${panel}.querySelectorAll('.kode-settings-group')).map(g=>g.querySelectorAll(':scope > .kode-integration-row').length)`), [0, 0, 0, 0, 0], 'no loose rows outside a card')
    assert.equal(await page.evaluate(`${panel}.querySelectorAll('.kode-settings-card').length`), 4)
    const role = await page.evaluate(`(()=>{const row=${panel}.querySelector('[data-model-tier="reasonable"]').getBoundingClientRect(),p=${panel}.querySelector('[data-model-tier="reasonable"] .kode-team-role-pickers').getBoundingClientRect();return {gap:row.right-p.right}})()`)
    assert.ok(role.gap < 12, 'model pickers are the right-side control: '+JSON.stringify(role))
    assert.match(await page.evaluate(`${panel}.querySelector('[aria-label="执行配置"]').innerText`), /Reasonable 模型[\s\S]*Lite 模型/)
    assert.equal(await page.evaluate(`${panel}.querySelectorAll('[data-model-tier]').length`), 2)
    assert.match(await page.evaluate(`${panel}.querySelector('[aria-label="当前会话"]').innerText`), /没有可读取它实际 Agent 与模型的接口/)
    assert.equal(await page.evaluate(`${panel}.querySelector('button[aria-label="交接 SuperAgent（暂不可用）"]').disabled`), true, 'controlled succession is not offered')
    assert.match(await page.evaluate(`${panel}.querySelector('[aria-label="当前会话"]').innerText`), /继任交接尚未接通/)
    assert.match(await page.evaluate(`${panel}.querySelector('[aria-label="身份与外观"]').innerText`), /本浏览器的全局偏好/)
    assert.equal(await page.evaluate(`!!${panel}.querySelector('.kode-superagent-advanced')`), false, 'advanced settings stay collapsed')
    assert.equal(await page.evaluate(`!!document.querySelector('.kode-collab-thread')`), true, 'the conversation stays beside the panel')
    await shot('dm-superagent-settings-1440.png')
    await page.evaluate("document.body.setAttribute('data-ds-dark-theme','')"); await page.evaluate('new Promise(r=>setTimeout(r,100))')
    await shot('dm-superagent-settings-dark-1440.png')
    await page.evaluate("document.body.removeAttribute('data-ds-dark-theme')")

    // Avatar and background together, through the native Choices dialog and the exact team identity.
    await clickText('头像与背景', panel)
    await wait(`document.querySelector('.kode-avatar-editor .kode-avatar-grid button[title="狐狸"]')`)
    await page.evaluate(`document.querySelector('.kode-avatar-editor .kode-avatar-grid button[title="狐狸"]').click()`)
    await wait(`document.querySelector('.kode-avatar-editor .kode-avatar-preview[data-has-background=true] img')`)
    assert.equal(await page.evaluate(`!!document.querySelector('.kode-avatar-editor .kode-avatar-background-toggle input')`), true)
    await new Promise(resolve => setTimeout(resolve, 400))
    await shot('dm-superagent-appearance-1440.png')
    await clickText('确认应用', `document.querySelector('.kode-avatar-editor')`)
    await wait(`!document.querySelector('.kode-avatar-editor')`)
    assert.deepEqual(appearancePosts, [{ team_id: 'team', home_hub: 'home', superagent_id: 'super', avatar_id: 'gallery/fox' }])

    // Advanced: contact, work scope, responsibilities and activation; still no budget form.
    await clickText('展开高级设置', panel)
    await wait(`${panel}.querySelector('.kode-superagent-advanced .kode-collab-team-configuration')`)
    assert.match(await page.evaluate(`${panel}.querySelector('[aria-label="工作范围"]').innerText`), /ws-fixture[\s\S]*\/fixture\/project/)
    assert.ok(await page.evaluate(`Array.from(${panel}.querySelectorAll('button')).some(b=>b.textContent==='核对激活条件')`))
    assert.equal(await page.evaluate(`!!${panel}.querySelector('.kode-collab-initial-budget,.kode-collab-budget,.kode-collab-budget-form')`), false)
    assert.doesNotMatch(await page.evaluate(`${panel}.innerText`), /团队预算|预留预算|初始团队总额度/)
    await page.evaluate(`${panel}.querySelector('.kode-superagent-advanced').scrollIntoView({block:'start'})`)
    await shot('dm-superagent-settings-advanced-1440.png')

    // Role instructions are read, edited, cancelled and saved in place: no jump to the advanced team form.
    await clickText('收起高级设置', panel)
    const instruction = id => `${panel}.querySelector('[data-role-instruction="${id}"]')`
    await wait(`${instruction('tester')}`)
    assert.deepEqual(await page.evaluate(`Array.from(${panel}.querySelectorAll('[data-role-instruction]')).map(r=>r.dataset.roleInstruction)`), ['superagent', 'tester'])
    assert.match(await page.evaluate(`${panel}.querySelector('[aria-label="角色指令"]').innerText`), /不能放宽[\s\S]*不会改变所用的 Agent 或模型[\s\S]*当前基于团队第 2 版/)
    assert.equal(await page.evaluate(`${instruction('superagent')}.querySelector('.kode-role-instruction-preview').textContent`), '未设置角色指令')
    const typeIn = (selector, value) => page.evaluate(`(()=>{const el=${panel}.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    // Cancel discards the unsaved text and writes nothing.
    await clickText('编辑 评审团队（SuperAgent） 的指令', panel)
    await wait(`${panel}.querySelector('[data-role-instruction="superagent"][data-editing] textarea')`)
    assert.equal(await page.evaluate(`Array.from(${panel}.querySelectorAll('button[aria-label^="编辑 "]')).every(b=>b.disabled)`), true, 'one role is edited at a time')
    await typeIn('[data-role-instruction="superagent"] textarea', '草稿：不应保存')
    await clickText('取消', `${instruction('superagent')}`)
    await wait(`!${panel}.querySelector('[data-editing]')`)
    assert.equal(await page.evaluate(`${instruction('superagent')}.querySelector('.kode-role-instruction-preview').textContent`), '未设置角色指令')
    assert.equal(configurationPosts.length, 0, 'cancel writes nothing')
    // Save: the versioned team-configuration command (expected_revision CAS), a new draft revision only.
    await clickText('编辑 评审团队（SuperAgent） 的指令', panel)
    await wait(`${panel}.querySelector('[data-role-instruction="superagent"][data-editing] textarea')`)
    await typeIn('[data-role-instruction="superagent"] textarea', '先确认范围，再分配给成员。')
    await new Promise(resolve => setTimeout(resolve, 100))
    await page.evaluate(`${panel}.querySelector('[aria-label="角色指令"]').scrollIntoView({block:'start'})`)
    await shot('dm-superagent-role-instructions-1440.png')
    await clickText('保存为新草稿', `${instruction('superagent')}`)
    await wait(`/已保存为第 3 版草稿，尚未生效/.test(${panel}.querySelector('[aria-label="角色指令"]').innerText)`)
    assert.equal(configurationPosts.length, 1)
    assert.equal(configurationPosts[0].expected_revision, 2)
    assert.equal(configurationPosts[0].spec.coordinator_prompt, '先确认范围，再分配给成员。')
    assert.equal(configurationPosts[0].spec.workers[0].role_prompt, undefined, 'other roles are untouched')
    assert.deepEqual(configurationPosts[0].spec.execution_targets, team.spec.execution_targets, 'Agent and model are untouched')
    assert.equal(await page.evaluate(`${instruction('superagent')}.querySelector('.kode-role-instruction-preview').textContent`), '先确认范围，再分配给成员。')
    // The next edit is based on the saved draft revision.
    await clickText('编辑 Tester 的指令', panel)
    await wait(`${panel}.querySelector('[data-role-instruction="tester"][data-editing] textarea')`)
    await typeIn('[data-role-instruction="tester"] textarea', '只报告复现过的问题。')
    await clickText('保存为新草稿', `${instruction('tester')}`)
    await wait(`/已保存为第 4 版草稿/.test(${panel}.querySelector('[aria-label="角色指令"]').innerText)`)
    assert.equal(configurationPosts.length, 2)
    assert.equal(configurationPosts[1].expected_revision, 3)
    assert.equal(configurationPosts[1].spec.coordinator_prompt, '先确认范围，再分配给成员。')
    assert.equal(configurationPosts[1].spec.workers[0].role_prompt, '只报告复现过的问题。')
    assert.equal(await page.evaluate(`!!${panel}.querySelector('.kode-superagent-advanced')`), false, 'stayed in place: advanced settings were not opened')
    assert.equal(await page.evaluate(`${panel}.getAttribute('aria-label')`), '评审团队 设置')
    await shot('dm-superagent-role-instructions-saved-1440.png')

    // Narrow: the panel takes the whole column and nothing overflows it.
    await page.call('Emulation.setDeviceMetricsOverride', { width: 760, height: 940, deviceScaleFactor: 1, mobile: false })
    await page.evaluate(`${panel}.querySelector('.kode-settings-main').scrollTop=0`)
    assert.deepEqual(await page.evaluate(`(()=>{const edge=${panel}.getBoundingClientRect().right;return Array.from(${panel}.querySelectorAll('.kode-settings-group *')).filter(n=>n.getBoundingClientRect().width&&n.getBoundingClientRect().right>edge+1).map(n=>n.className||n.tagName)})()`), [])
    await shot('dm-superagent-settings-760.png')
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false })

    // One inspector seat: opening work details replaces settings; Escape closes and returns focus.
    await clickText('工作过程')
    await wait(`!${panel}&&document.querySelector('aside[aria-label="执行详情"]')`)
    await clickText('收起工作过程')
    await clickText('SuperAgent 设置', 'document.querySelector(".kode-collab-header-actions")')
    await wait(panel)
    await page.evaluate(`${panel}.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    await wait(`!${panel}`)
    await wait(`document.activeElement?.closest?.('.kode-collab-header-actions')`)
    assert.equal(await page.evaluate(`document.querySelector('[data-sidebar-row=team][aria-current=page] [data-row-title]')?.textContent`), '评审团队', 'the DM stays on the same team')
    // Without the native right Sidebar the row's hover gear opens the same in-place inspector.
    await page.evaluate(`document.querySelector('[data-sidebar-row=team] button[aria-label="SuperAgent 设置"]').click()`)
    await wait(panel)
    await page.evaluate(`${panel}.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    await wait(`!${panel}`)

    assert.deepEqual(writes, ['POST /api/kode/collab/appearance', 'POST /api/kode/teams/configuration', 'POST /api/kode/teams/configuration'], 'only the chosen appearance and the two explicit drafts were written')
    assert.equal(await page.evaluate('fixture.created()'), 0)
  } finally { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } await rm(profile, { recursive: true, force: true }) }
})

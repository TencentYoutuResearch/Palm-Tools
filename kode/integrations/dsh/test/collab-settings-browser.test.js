import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collabRenderPage } from './support/collab-render-page.js'
import { headlessBrowser } from './support/headless-browser.js'

test('real Kode settings shell: optional collaboration page and shared preferences', { skip: !process.env.KODE_TEST_BROWSER_BIN, timeout: 60000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kode-settings-'))
  let browser
  const server = createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/api/kode/avatars/media')) { res.setHeader('content-type', 'image/png'); res.end(await readFile(new URL('../assets/agents/kode.png', import.meta.url))); return }
      if (await collabRenderPage(req, res, { settings: true, avatarAccount: true })) return
      res.setHeader('content-type', 'application/json')
      if (req.url.startsWith('/api/kode/project-hosts')) return res.end(JSON.stringify({ current: 'local', hosts: [{ id: 'local', name: '此计算机' }] }))
      if (req.url.startsWith('/api/kode/collab/teams')) return res.end(JSON.stringify({ home_hub: 'settings-fixture', items: [], next_cursor: null }))
      res.statusCode = 503; res.end(JSON.stringify({ error: '此隔离测试未启用该服务' }))
    } catch (e) { res.writeHead(500); res.end('{}') }
  })
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    const page = await browser.page(`http://127.0.0.1:${server.address().port}`)
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    const wait = expr => page.evaluate(`(async()=>{for(let i=0;i<150;i++){if(${expr})return;await new Promise(r=>setTimeout(r,50))}throw Error(document.body.innerText+' '+JSON.stringify(fixtureErrors))})()`)
    await wait('globalThis.fixture')
    await page.evaluate(`fixture.ctx.layout.selectPanel('kode-settings')`)
    await wait(`document.querySelector('#kode-settings-tab-collaboration')`)
    await page.evaluate(`(async()=>{for(let i=0;i<100;i++){const b=document.querySelector('#kode-settings-tab-collaboration');if(b){b.click();return}await new Promise(r=>setTimeout(r,50))}throw Error(document.body.innerText+' '+JSON.stringify(fixtureErrors))})()`)
    await wait(`document.querySelector('.kode-collab-settings')`)
    assert.equal(await page.evaluate(`document.querySelectorAll('.kode-settings-nav button').length`), 7)
    for (const id of ['mobile','ssh','collaboration']) assert.equal(await page.evaluate(`!!document.querySelector('#kode-settings-tab-${id}')`),true,id+' settings survive UI integration')
    await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='选择图片'&&!b.disabled)`)
    await page.evaluate(`(async()=>{const c=document.createElement('canvas');c.width=c.height=40;const g=c.getContext('2d');g.fillStyle='#7357dd';g.fillRect(0,0,40,40);const blob=await new Promise(r=>c.toBlob(r));const dt=new DataTransfer();dt.items.add(new File([blob],'avatar.png',{type:'image/png'}));const input=document.querySelector('[aria-label="上传本地协作头像"]');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='恢复账户头像')`)
    assert.equal(await page.evaluate(`document.querySelector('[aria-label="我的协作头像"] img').src.startsWith('data:image/png;base64,')`),true)
    await page.evaluate(`fixture.account.setProfile({id:'fixture-other',avatarUrl:null})`)
    await wait(`!Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='恢复账户头像')`)
    await page.evaluate(`fixture.account.setProfile({id:'fixture-owner',avatarUrl:null})`)
    await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='恢复账户头像')`)

    // Team configuration lives in each Superagent's settings tab; this page only points there.
    assert.match(await page.evaluate(`document.querySelector('.kode-collab-settings [aria-label="界面"]').innerText`), /团队设置[\s\S]*Superagent 私信右上角的设置/)
    // Native SelectField (kodeAgentControls), not a parallel segmented control.
    await page.evaluate(`document.querySelector('.kode-collab-settings button.kode-field-select[aria-label="侧边栏组织方式"]').click()`)
    await wait(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).some(b=>b.textContent.startsWith('协作'))`)
    await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).find(b=>b.textContent.startsWith('协作')).click()`)
    await wait(`document.querySelector('.kode-collab-settings button.kode-field-select[aria-label="侧边栏组织方式"]').textContent.startsWith('协作')`)
    assert.equal(await page.evaluate(`fixture.selectedPanel()`), 'kode-settings')
    assert.equal(await page.evaluate(`document.querySelectorAll('.kode-collab-settings .kode-agent-editor:not(.kode-collab-interop-group>*)').length`), 0, 'no card stack outside the native groups')
    const switchSelector = `.kode-collab-settings [aria-label="头像与外观"] label.kode-integration-row input[type=checkbox][role=switch]`
    const before = await page.evaluate(`document.querySelector('${switchSelector}').checked`)
    await page.evaluate(`document.querySelector('${switchSelector}').click()`)
    assert.equal(await page.evaluate(`document.querySelector('${switchSelector}').checked`), !before)
    if (process.env.KODE_TEST_SCREENSHOTS) {
      await mkdir(process.env.KODE_TEST_SCREENSHOTS, { recursive: true })
      await writeFile(join(process.env.KODE_TEST_SCREENSHOTS, 'kode-collaboration-settings.png'), Buffer.from((await page.call('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
    }
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='恢复账户头像').click()`)
    await wait(`!document.querySelector('[aria-label="我的协作头像"] img')`)
    assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-settings button')).some(b=>b.textContent==='打开插件与集成')`), false, 'no second link to plugins inside 协作')
    assert.equal(await page.evaluate('fixture.created()'), 0)
  } finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); await rm(profile, { recursive:true,force:true }) }
})

// Fixture models only: the settings page reads local preferences and the team revision; nothing is saved or started.
test('real Kode settings shell: 协作 page is card rows without team configuration, even with a loaded team', { skip: !process.env.KODE_TEST_BROWSER_BIN, timeout: 60000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kode-settings-team-'))
  let browser
  const writes = []
  const team = { id: 'team', home_hub: 'settings-fixture', revision: 2, superagent_id: 'super', conversation_id: 'dm',
    spec: { name: '评审团队', kind: 'coordinator', purpose: 'Review', workers: [{ id: 'tester', role: 'Tester', responsibilities: ['Verify changes'], allowed_target_ids: [] }],
      coordinator_targets: ['control'], execution_targets: [{ id: 'control', host_id: 'settings-fixture', executor_profile_id: 'codex', provider_id: 'openai', model_id: 'gpt-6.1-sol', effort: 'high' }] } }
  const contact = { preference: { revision: 0, pinned: false, archived: false, archived_through_sequence: 0 }, archived: false, needs_attention: false, latest_sequence: 0, unread_count: 0, last_activity_at: 0, attention: { decisions: 0, resources: 0, stopping: 0, active_runs: 0 } }
  const profiles = [{ id: 'tclaude', name: 'tclaude', type: 'claude', origin: 'builtin' }, { id: 'codex', name: 'Codex', type: 'codex', origin: 'builtin' }]
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') writes.push(req.method + ' ' + req.url)
      if (req.url.startsWith('/api/kode/avatars/media')) { res.setHeader('content-type', 'image/png'); res.end(await readFile(new URL('../assets/agents/kode.png', import.meta.url))); return }
      if (await collabRenderPage(req, res, { settings: true })) return
      res.setHeader('content-type', 'application/json')
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname === '/api/kode/project-hosts') return res.end(JSON.stringify({ current: 'local', hosts: [{ id: 'local', name: '此计算机' }] }))
      if (url.pathname === '/api/kode/collab/teams') return res.end(JSON.stringify(url.searchParams.get('team_id') === 'team' ? { home_hub: 'settings-fixture', projection: 'configuration_revision', team }
        : { home_hub: 'settings-fixture', projection: 'contact_directory', archived: url.searchParams.get('archived') === 'true', order: 'pinned_attention_unread_recent', items: url.searchParams.get('archived') === 'true' ? [] : [{ ...team, contact }], next_cursor: null }))
      if (url.pathname === '/api/kode/agents' && req.method === 'GET') {
        const id = url.searchParams.get('profile_id'), teamId = url.searchParams.get('team_id')
        return res.end(JSON.stringify({ profiles, selectedProfileId: 'tclaude', supportedTypes: ['claude', 'codex'], types: { claude: { name: 'Claude Code', executable: 'claude' }, codex: { name: 'Codex', executable: 'codex' } },
          ...(id === 'tclaude' ? { models: [{ id: 'opus-5.5', name: 'Opus 5.5' }], defaultModelSelection: { model: 'opus-5.5' } } : id === 'codex' ? { models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }], defaultModelSelection: { model: 'gpt-6.1-sol' } } : { models: [] }),
          ...(teamId ? { teamRolePreferences: { teamId, assignments: { superagent: { profileId: 'codex', model: 'gpt-6.1-sol' } }, preferenceRevision: 1, scope: 'local_host', eligibleForExecution: false } } : {}) }))
      }
      if (url.pathname === '/api/kode/session-interop') return res.end(JSON.stringify({ scope: 'local_host', summary: null, grants: [], profiles: [] }))
      res.statusCode = 503; res.end(JSON.stringify({ error: '此隔离测试未启用该服务' }))
    } catch { res.writeHead(500); res.end('{}') }
  })
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    const page = await browser.page(`http://127.0.0.1:${server.address().port}`)
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false })
    const wait = expr => page.evaluate(`(async()=>{for(let i=0;i<150;i++){if(${expr})return;await new Promise(r=>setTimeout(r,50))}throw Error(document.querySelector('.kode-settings-section')?.innerText+' '+JSON.stringify(fixtureErrors))})()`)
    await wait('globalThis.fixture')
    await page.evaluate(`fixture.ctx.layout.selectPanel('kode-settings')`)
    await wait(`document.querySelector('#kode-settings-tab-collaboration')`)
    await page.evaluate(`document.querySelector('#kode-settings-tab-collaboration').click()`)
    await wait(`document.querySelector('.kode-collab-settings .kode-collab-interop-group h3')`)
    const groups = await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-settings > .kode-settings-group > h3, .kode-collab-settings > .kode-settings-group > section > h3')).map(n=>n.textContent)`)
    assert.deepEqual(groups, ['界面', '头像与外观', '本机会话互通'])
    // No team appearance, Agent defaults or execution configuration here, and no duplicated 团队 title.
    assert.equal(await page.evaluate(`document.querySelectorAll('.kode-collab-settings :is([data-team-role],[data-authorized-role],[aria-label="团队外观"],.kode-settings-scope)').length`), 0)
    // Image-4 anatomy: each section is one card; rows hold title + note on the left and the control on the right.
    const anatomy = await page.evaluate(`(()=>{const card=document.querySelector('.kode-collab-settings [aria-label="界面"] .kode-settings-card'),c=getComputedStyle(card),row=card.querySelector('.kode-integration-row'),title=row.querySelector('strong').getBoundingClientRect(),control=row.querySelector('.kode-field-select').getBoundingClientRect(),r=row.getBoundingClientRect();
      return {radius:parseFloat(c.borderTopLeftRadius),border:c.borderTopStyle,divider:getComputedStyle(row).borderBottomStyle,controlRight:r.right-control.right,titleLeft:title.left-r.left,sameLine:Math.abs((title.top+title.bottom)/2-(control.top+control.bottom)/2)<24,cards:document.querySelectorAll('.kode-collab-settings .kode-settings-card').length}})()`)
    assert.ok(anatomy.radius >= 8 && anatomy.border === 'solid' && anatomy.divider === 'solid', JSON.stringify(anatomy))
    assert.ok(anatomy.controlRight < 2 && anatomy.titleLeft < 2 && anatomy.sameLine, JSON.stringify(anatomy))
    assert.equal(anatomy.cards, 2)
    assert.ok(await page.evaluate(`document.querySelector('.kode-collab-settings [aria-label="界面"] .kode-field > span:first-child').getBoundingClientRect().width<=1`), 'one visible 侧边栏组织方式 title: the field label is visually hidden')
    await mkdir(process.env.KODE_ARTIFACT_DIR ?? '/tmp/kode-orbit-shots', { recursive: true })
    const shot = async name => writeFile(join(process.env.KODE_ARTIFACT_DIR ?? '/tmp/kode-orbit-shots', name), Buffer.from((await page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'))
    await shot('settings-collaboration-team-1440.png')
    // Signed out: 选择图片 still works with a real file input; the image stays on this device only.
    await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='选择图片'&&!b.disabled)`)
    await page.evaluate(`(async()=>{const c=document.createElement('canvas');c.width=c.height=40;const g=c.getContext('2d');g.fillStyle='#2f9e6e';g.fillRect(0,0,40,40);const blob=await new Promise(r=>c.toBlob(r));const dt=new DataTransfer();dt.items.add(new File([blob],'avatar.png',{type:'image/png'}));const input=document.querySelector('[aria-label="上传本地协作头像"]');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await wait(`document.querySelector('[aria-label="我的协作头像"] img')?.src.startsWith('data:image/png;base64,')&&Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='移除图片')`)
    assert.match(await page.evaluate(`document.querySelector('[aria-label="我的协作头像"]').innerText`), /只保存在当前浏览器/)
    await page.evaluate(`document.querySelector('[aria-label="我的协作头像"]').scrollIntoView({block:'center'})`)
    await shot('settings-avatar-signed-out-1440.png')
    // Agent tab: CLI identities only; models are a per-Agent default read from the catalog; no team responsibilities here.
    await page.evaluate(`document.querySelector('#kode-settings-tab-agents').click()`)
    await wait(`document.querySelector('section.kode-agent-settings .kode-agent-row')`)
    const agentText = await page.evaluate(`document.querySelector('section.kode-agent-settings').innerText`)
    assert.doesNotMatch(agentText, /职责|Tester|评审团队/)
    assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('section.kode-agent-settings button[aria-label$="默认模型"]')).length>0`), true)
    await page.evaluate(`document.querySelector('section.kode-agent-settings button[aria-label$="默认模型"]').click()`)
    await page.evaluate('new Promise(r=>setTimeout(r,300))')
    await shot('settings-agent-identities-1440.png')
    await page.evaluate(`document.querySelector('#kode-settings-tab-collaboration').click()`)
    await wait(`document.querySelector('.kode-collab-settings')`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='移除图片').click()`)
    await wait(`!document.querySelector('[aria-label="我的协作头像"] img')`)
    await page.evaluate("document.body.setAttribute('data-ds-dark-theme','')"); await page.evaluate('new Promise(r=>setTimeout(r,100))')
    await shot('settings-collaboration-team-dark-1440.png')
    await page.evaluate("document.body.removeAttribute('data-ds-dark-theme')")
    await page.call('Emulation.setDeviceMetricsOverride', { width: 660, height: 1400, deviceScaleFactor: 1, mobile: false })
    assert.equal(await page.evaluate(`(()=>{const t=document.querySelector('.kode-collab-settings');return t.scrollWidth<=t.clientWidth+1})()`), true)
    await shot('settings-collaboration-team-660.png')
    assert.deepEqual(writes, [], 'opening settings saves nothing: no preference, team, grant or Session write')
    assert.equal(await page.evaluate('fixture.created()'), 0)
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(profile, { recursive: true, force: true }) }
})

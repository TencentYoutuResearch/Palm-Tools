import { versionedProject } from './support/versioned-project.js'
import { registerBuilderDefaults } from '../src/builder-defaults-route.js'
import { registerTeamResource } from '../src/team-resource-route.js'
import { registerTeamScheduling } from '../src/team-scheduling-route.js'
import { registerTeamAuthority } from '../src/team-authority-route.js'
import { registerBuilderAccount } from '../src/builder-account-route.js'
import { registerBuilderWorkflowSetup } from '../src/builder-workflow-setup.js'
import { activationProposal, workflowProposal } from './support/collab-activation-config.js'
import { registerTeamActivation } from '../src/team-activation-route.js'
import { registerBuilderAccept } from '../src/builder-accept-route.js'
import { registerBuilderFunding } from '../src/builder-funding-route.js'
import { registerBuilderSelection } from '../src/builder-selection-route.js'
/** Real shipped React/slots + collab components + Hub; the surrounding Session shell is a fixture. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedHub } from './support/isolated-hub.js'
import { conversationTeam } from './support/conversation-team.js'
import { headlessBrowser } from './support/headless-browser.js'
import { collabRenderPage } from './support/collab-render-page.js'
import { registerCollabTeams, registerCollabRuns } from '../src/collab-api.js'
import { registerTeamBudget } from '../src/team-budget-route.js'
import { registerCollabBudgets } from '../src/collab-budgets-route.js'
import { registerBuilderModels } from '../src/builder-models-route.js'
import { registerResourceCoverage } from '../src/resource-coverage.js'
import { registerBuilderPatchStatus } from '../src/builder-patch-status-route.js'
import { registerBuilderWorkspaces } from '../src/builder-workspaces-route.js'
import { registerBuilderWorkspaceDirectory } from '../src/builder-workspace-directory.js'
import { registerBuilderCreate } from '../src/builder-create-route.js'
import { registerBuilderAnswers } from '../src/builder-answers-route.js'
import { registerBuilderDrafts } from '../src/builder-drafts-route.js'
import { registerWorkRun } from '../src/work-run-route.js'
import { registerConversation } from '../src/conversation-route.js'
import { registerConversationStream } from '../src/conversation-stream-route.js'
import { registerConversationRead } from '../src/conversation-read-route.js'

test('actual collab React seats render contacts, send once and retain draft across IM/Session switches', { skip: !process.env.KODE_TEST_BROWSER_BIN || !process.env.KODE_TEST_BACKEND_URL, timeout: 45000 }, async () => {
  const hub = await isolatedHub('collab-render'), profile = await mkdtemp(join(tmpdir(), 'kode-collab-render-'))
  let streamsOpened = 0, externalStreamEvents = 0
  let browser, server, acceptanceWrites = 0, activationWrites = 0, accountWrites = 0, authorityWrites = 0, initialBudgetWrites = 0, workflowWrites = 0, workflowReceipt, activationRuntime
  try {
    const team = await conversationTeam(hub), routes = new Map(), projectRoot = await versionedProject(hub.root)
    const ctx = { get: () => ({ officialExecution: activationRuntime }), webServer: { register: route => { routes.set(route.path, route) } }, connection: { admit: req => req.headers['x-fixture-owner'] === 'yes' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } } }
    registerConversationRead(ctx, { backendClient: hub.client }); registerConversationStream(ctx, { backendClient: hub.client, quotaHost: hub.node })
    registerTeamResource(ctx, { backendClient: hub.client })
    registerTeamScheduling(ctx, { backendClient: hub.client })
    registerTeamAuthority(ctx, { backendClient: hub.client })
    registerTeamActivation(ctx, { backendClient: hub.client })
    registerBuilderWorkflowSetup(ctx, { backendClient: hub.client })
    registerBuilderAccept(ctx, { backendClient: hub.client })
    registerBuilderAccount(ctx, { backendClient: hub.client })
    registerBuilderFunding(ctx, { backendClient: hub.client })
    registerBuilderSelection(ctx, { backendClient: hub.client })
    registerTeamBudget(ctx, { backendClient: hub.client })
    registerCollabBudgets(ctx, { backendClient: hub.client })
    const resourceService = { profiles: { list: () => [{ id: 'profile', name: 'Fixture execution resource', type: 'dsh', defaultReasoningEffort: 'deliberate' }], bindings: {} }, hasRuntime: () => true, officialResourceDirectory: () => ({ status: 'registered_only', items: [{ provider_id: 'fixture', name: 'Fixture model provider', registered: true }] }) }
    const modelMetadata = { listProviders: () => [{ id: 'fixture', name: 'Fixture' }], listModels: async () => [{ provider: 'fixture', id: 'model', name: 'Fixture model' }], resolveModelInfo: async () => ({ provider: 'fixture', id: 'model', name: 'Fixture model', reasoning: { efforts: [{ id: 'deliberate', name: 'Deliberate' }], defaultEffort: 'deliberate' } }) }
    registerResourceCoverage(ctx, resourceService, hub.client, hub.node)
    registerBuilderModels(ctx, modelMetadata, hub.node)
    registerBuilderDefaults(ctx, { backendClient: hub.client, service: resourceService, llm: modelMetadata, home: hub.node })
    registerBuilderPatchStatus(ctx, { backendClient: hub.client }); registerBuilderWorkspaces(ctx, { backendClient: hub.client }); registerBuilderWorkspaceDirectory(ctx, { backendClient: hub.client }); registerBuilderCreate(ctx, { backendClient: hub.client }); registerBuilderAnswers(ctx, { backendClient: hub.client }); registerBuilderDrafts(ctx, { backendClient: hub.client }); registerWorkRun(ctx, { backendClient: hub.client }); registerCollabRuns(ctx, { backendClient: hub.client }); registerCollabTeams(ctx, { backendClient: hub.client }); registerConversation(ctx, { backendClient: hub.client })
    server = createServer(async (req, res) => {
      try {
        const route = routes.get(new URL(req.url, 'http://localhost').pathname)
        if (new URL(req.url, 'http://localhost').pathname === '/api/kode/conversation/events') {
          streamsOpened++
          const write = res.write.bind(res)
          res.write = (value, ...args) => { if (String(value).includes('另一入口提交的新消息')) externalStreamEvents++; return write(value, ...args) }
        }
        if (new URL(req.url, 'http://localhost').pathname === '/api/kode/builder/accept-proposal' && req.method === 'POST') {
          acceptanceWrites++
          if (acceptanceWrites === 1) return await route.handler(req, { writeHead() {}, end(value) {
            assert.equal(JSON.parse(value).activation_performed, false)
            res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'fixture committed acceptance reply lost' }))
          } })
        }
        if (new URL(req.url, 'http://localhost').pathname === '/api/kode/teams/activation' && req.method === 'POST') {
          activationWrites++
          if (activationWrites === 1 || activationWrites === 3) return await route.handler(req, { writeHead(status) { assert.equal(status, 200) }, end(value) {
            assert.equal(JSON.parse(value).active, activationWrites === 1)
            res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'fixture committed activation reply lost' }))
          } })
        }
        if (new URL(req.url, 'http://localhost').pathname === '/api/kode/builder/configure-workflow' && req.method === 'POST') {
          workflowWrites++
          return await route.handler(req, { writeHead(status) { assert.equal(status, 200) }, end(value) {
            workflowReceipt = JSON.parse(value)
            assert.equal(workflowReceipt.activation_performed, false)
            res.writeHead(workflowWrites === 1 ? 503 : 200, { 'content-type': 'application/json' })
            res.end(workflowWrites === 1 ? JSON.stringify({ error: 'fixture workflow response lost' }) : value)
          } })
        }
        if (new URL(req.url, 'http://localhost').pathname === '/api/kode/builder/account' && req.method === 'POST') {
          accountWrites++
          if (accountWrites === 1) return await route.handler(req, { writeHead(status) { assert.equal(status, 200) }, end(value) {
            assert.equal(JSON.parse(value).execution_started, false)
            res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'fixture account response lost' }))
          } })
        }
        if (new URL(req.url, 'http://localhost').pathname === '/api/kode/teams/authority' && req.method === 'POST') {
          authorityWrites++
          if (authorityWrites === 1) return await route.handler(req, { writeHead(status) { assert.equal(status, 200) }, end(value) {
            assert.equal(JSON.parse(value).activation_performed, false)
            res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'fixture authority response lost' }))
          } })
        }
        if (new URL(req.url, 'http://localhost').pathname === '/api/kode/teams/budget' && req.method === 'POST') {
          let status, headers
          return await route.handler(req, { writeHead(code, values) { status = code; headers = values }, end(value) {
            if (JSON.parse(value).budget_policy) {
              initialBudgetWrites++
              if (initialBudgetWrites === 1) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'fixture initial budget response lost' })); return }
            }
            res.writeHead(status, headers); res.end(value)
          } })
        }
        if (route) return await route.handler(req, res)
        if (await collabRenderPage(req, res)) return
        res.writeHead(404); res.end()
      } catch { if (!res.headersSent) res.writeHead(500); res.end() }
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    const page = await browser.page(`http://127.0.0.1:${server.address().port}`)
    const wait = expression => page.evaluate(`(async()=>{const deadline=Date.now()+10000;while(Date.now()<deadline){if(${expression})return true;await new Promise(r=>setTimeout(r,25))}throw Error('Render predicate timed out: '+JSON.stringify({selection:document.querySelector('.kode-collab-selection-form')?.innerText,body:document.body.innerText.slice(0,800)})+' '+JSON.stringify(globalThis.fixtureErrors))})()`)
    await wait('globalThis.fixture')
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]').click()`)
    await wait(`document.querySelector('.kode-collab-contact-name')`)
    await page.evaluate(`document.querySelector('.kode-collab-contact-name').click()`)
    await wait(`document.querySelector('.kode-collab-composer textarea')`)
    await page.evaluate(`document.querySelector('textarea').focus()`)
    await page.call('Input.insertText', { text: '请实现这个需求' })
    await page.evaluate(`document.querySelector('.kode-collab-composer button[type="submit"]').click()`)
    await wait(`document.body.innerText.includes('Hub 已接收') && document.querySelector('.kode-collab-message-content')`)
    assert.equal((await hub.client.call(`/api/v1/messaging/conversations/${team.conversation_id}/messages`)).items.length, 1)
    await page.evaluate(`document.querySelector('textarea').focus()`); await page.call('Input.insertText', { text: '尚未发送的下一条需求' })
    await page.evaluate(`document.querySelector('[aria-label="切换到 Session 模式"]').click()`)
    await wait(`document.body.innerText.includes('Session fixture')`)
    await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]').click()`)
    await wait(`document.querySelector('textarea')`)
    assert.equal(await page.evaluate(`document.querySelector('textarea').value`), '尚未发送的下一条需求')
    await page.evaluate(`document.querySelector('.kode-collab-search input').focus()`)
    await page.call('Input.insertText', { text: 'no-matching-team' })
    await page.evaluate(`document.querySelector('.kode-collab-search button[type="submit"]').click()`)
    await wait(`document.body.innerText.includes('没有找到匹配的联系人。')`)
    assert.equal(await page.evaluate(`document.querySelector('textarea').value`), '尚未发送的下一条需求')
    assert.ok(await page.evaluate(`Boolean(document.querySelector('.kode-collab-message-content'))`))
    if (process.env.KODE_TEST_CONTACT_SCREENSHOT_PATH) {
      const shot = await page.call('Page.captureScreenshot', { format: 'png' })
      await writeFile(process.env.KODE_TEST_CONTACT_SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'))
    }
    await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-search button')).find(button => button.textContent === '清除搜索').click()`)
    await wait(`document.querySelector('.kode-collab-contact-name')`)
    await wait(`document.querySelector('[data-message-sequence]')`)
    const visibleSequence = await page.evaluate(`Number(document.querySelector('[data-message-sequence]').dataset.messageSequence)`)
    for (let attempt = 0; attempt < 30; attempt++) {
      const read = await hub.client.call(`/api/v1/messaging/conversations/${team.conversation_id}/read-state`)
      if (read.through_sequence >= visibleSequence) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok((await hub.client.call(`/api/v1/messaging/conversations/${team.conversation_id}/read-state`)).through_sequence >= visibleSequence)
    assert.equal(await page.evaluate('fixture.created()'), 0)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '团队预算').click()`)
    await wait(`document.querySelector('[aria-label="团队预算"]').innerText.includes('总额度')`)
    assert.ok(await page.evaluate(`document.querySelector('[aria-label="团队预算"]').innerText.includes('credits')`))
    assert.ok(await page.evaluate(`document.querySelector('[aria-label="团队预算"]').innerText.includes('不是供应商余额')`))
    await page.evaluate(`const input=document.querySelector('.kode-collab-budget-form input');input.focus();input.select()`)
    await page.call('Input.insertText', { text: '150' })
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='核对预算修改').click()`)
    assert.equal((await hub.client.call('/api/v1/messaging/budgets/budget')).budget.limit, 100)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='确认修改团队预算').click()`)
    await wait(`document.querySelector('.kode-collab-budget-form').innerText.includes('团队预算已保存')`)
    assert.equal((await hub.client.call('/api/v1/messaging/budgets/budget')).budget.limit, 150)

    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '收起预算').click()`)

    await hub.client.call(`/api/v1/messaging/conversations/${team.conversation_id}/messages`, { request_id: 'external-message', content: '另一入口提交的新消息' })
    await wait(`Array.from(document.querySelectorAll('.kode-collab-message-content')).some(node => node.textContent === '另一入口提交的新消息')`)
    assert.equal(await page.evaluate(`document.querySelector('textarea').value`), '尚未发送的下一条需求')
    assert.ok(streamsOpened > 0); assert.equal(externalStreamEvents, 1)

    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '团队管理').click()`)
    await wait(`Array.from(document.querySelectorAll('.kode-collab-team-management button')).some(button => button.textContent === '核对激活条件' && !button.disabled)`)
    await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-team-management button')).find(button => button.textContent === '核对激活条件').click()`)
    await wait(`document.querySelector('.kode-collab-team-management')?.innerText.includes('无需重复激活')`)
    assert.ok(await page.evaluate(`document.querySelector('.kode-collab-team-management .kode-collab-team-deactivation') !== null`), 'Hub activation exposes deactivation without a local activation receipt')
    assert.equal(activationWrites, 0)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '收起团队管理').click()`)

    await hub.client.call('/api/v1/messaging/work-runs', { id: 'render-work', request_id: 'render-work', team_id: 'team', team_revision: 1, binding_id: 'local', inputs: { request: '查看任务过程的需求' }, prior_run_id: null })
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '工作过程').click()`)
    await wait(`document.querySelector('.kode-collab-run')`)
    assert.ok(await page.evaluate(`document.querySelector('.kode-collab-process').innerText.includes('查看任务过程的需求')`))
    assert.ok(await page.evaluate(`document.querySelector('.kode-collab-process').innerText.includes('尚未确认交付')`))
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '查看详情').click()`)
    await wait(`document.querySelector('.kode-collab-run-detail').innerText.includes('接收任务')`)
    assert.ok(await page.evaluate(`document.querySelector('.kode-collab-run-detail').innerText.includes('inspect：待开始')`))
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='取消任务').click()`)
    assert.notEqual((await hub.client.call('/api/v1/messaging/work-runs/render-work')).state, 'cancelling')
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='确认请求取消').click()`)
    await wait(`document.querySelector('.kode-collab-run-cancel').innerText.includes('已请求取消')`)
    const cancelled = await hub.client.call('/api/v1/messaging/work-runs/render-work')
    assert.equal(cancelled.state, 'cancelling'); assert.equal(cancelled.cancellation.stop_confirmed, false)
    await hub.client.call('/api/v1/messaging/work-runs/render-work', { action: 'finalize_cancel', request_id: 'external-stop-confirmation', expected_revision: cancelled.revision })
    await wait(`document.querySelector('.kode-collab-run-cancel')?.innerText.includes('执行停止已确认。')`)
    assert.ok(await page.evaluate(`document.querySelector('.kode-collab-run-detail').innerText.includes('接收任务')`), 'background progress retains prior history')
    assert.ok(await page.evaluate(`document.querySelector('.kode-collab-run-detail').innerText.includes('inspect：已取消')`))
    assert.ok(await page.evaluate(`document.querySelector('.kode-collab-run > p').innerText.includes('已取消')`), 'summary follows the authoritative detail revision')
    const liveRun = await hub.client.call('/api/v1/messaging/work-runs', { id: 'zz-live-work', request_id: 'zz-live-work', team_id: 'team', team_revision: 1, binding_id: 'local', inputs: { request: '自动发现的新任务' }, prior_run_id: null })
    await wait(`Array.from(document.querySelectorAll('.kode-collab-run h3')).some(node => node.textContent === '自动发现的新任务')`)
    await hub.client.call('/api/v1/messaging/work-runs/zz-live-work', { action: 'cancel', request_id: 'external-cancel', expected_revision: liveRun.revision })
    await wait(`Array.from(document.querySelectorAll('.kode-collab-run')).find(node => node.querySelector('h3').textContent === '自动发现的新任务')?.querySelector('p').innerText.includes('已取消')`)
    assert.equal(await page.evaluate(`document.querySelectorAll('.kode-collab-run-detail').length`), 1, 'refresh preserves the selected detail')




    assert.equal(await page.evaluate(`document.querySelector('textarea').value`), '尚未发送的下一条需求')

    assert.ok(await page.evaluate(`getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim()`))
    assert.deepEqual(await page.evaluate('fixtureErrors'), [])
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('.kode-collab-contact[aria-current]')).backgroundColor !== getComputedStyle(document.querySelector('.kode-collab-contacts')).backgroundColor`), true)
    await hub.client.call('/api/v1/messaging/superagents/drafts', { id: 'saved-draft', request_id: 'save-draft', expected_revision: 0, revoked: false, interview: { purpose: '搭建前端开发团队', workspace_refs: [], answers: {}, questions: [{ id: 'delivery', prompt: '这项工作的交付终点是什么？' }], proposed_team: null } })
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '团队搭建助手').click()`)
    await wait(`document.querySelector('.kode-collab-builder')?.innerText.includes('搭建前端开发团队')`)
    await page.evaluate(`document.querySelector('.kode-collab-builder .kode-collab-contact').click()`)
    await wait(`document.querySelector('.kode-collab-builder').innerText.includes('这项工作的交付终点是什么？')`)
    await page.evaluate(`document.querySelector('.kode-collab-builder textarea').focus()`)
    await page.call('Input.insertText', { text: '本地验证通过并提供可评审的改动' })
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '保存回答').click()`)
    await wait(`document.querySelector('.kode-collab-builder').innerText.includes('delivery：本地验证通过并提供可评审的改动')`)
    const answered = await hub.client.call('/api/v1/messaging/superagents/drafts/saved-draft')
    assert.equal(answered.revision, 2); assert.equal(answered.interview.answers.delivery, '本地验证通过并提供可评审的改动')
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '返回草案列表').click()`)
    await wait(`document.querySelector('.kode-collab-builder-create textarea')`)
    await page.evaluate(`document.querySelector('.kode-collab-builder-create textarea').focus()`)
    await page.call('Input.insertText', { text: '维护通用研发工具' })
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '保存目标并继续').click()`)
    await wait(`document.querySelector('.kode-collab-builder h2')?.textContent === '维护通用研发工具'`)
    const createdDrafts = (await hub.client.call('/api/v1/messaging/superagents/drafts')).items
    assert.equal(createdDrafts.length, 2)
    const createdDraft = await hub.client.call('/api/v1/messaging/superagents/drafts/' + createdDrafts.find(row => row.purpose === '维护通用研发工具').id)
    assert.equal(createdDraft.eligible_for_execution, false); assert.equal(createdDraft.interview.questions.length, 3)
    await hub.client.call('/api/v1/messaging/workbench/workspaces', { action: 'create', path: projectRoot, title: 'Browser workspace' })
    await wait(`document.querySelector('.kode-collab-workspace-form select option[value="${hub.node}"]')`)
    await page.evaluate(`const select=document.querySelector('.kode-collab-workspace-form select');select.value=${JSON.stringify(hub.node)};select.dispatchEvent(new Event('change',{bubbles:true}))`)
    await wait(`document.querySelector('.kode-collab-workspace-option input')`)
    await page.evaluate(`document.querySelector('.kode-collab-workspace-option input').click()`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '保存工作区').click()`)
    await wait(`document.querySelector('.kode-collab-workspace-form button[type="submit"]').textContent === '保存工作区'`)
    const workspaceDraft = await hub.client.call('/api/v1/messaging/superagents/drafts/' + createdDraft.id)
    assert.equal(workspaceDraft.revision, 2); assert.equal(workspaceDraft.interview.workspace_refs[0].host_id, hub.node)
    assert.equal(workspaceDraft.interview.workspace_refs[0].root_ref, await realpath(projectRoot))
    await hub.client.call('/api/v1/messaging/superagents/drafts/' + createdDraft.id + '/answers', { request_id: 'other-tab-answer', expected_revision: 2, answers: { task_kind: '需求交付' } })
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '保存工作区').click()`)
    await wait(`document.querySelector('.kode-collab-workspace-form').innerText.includes('检查提交结果')`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '检查提交结果').click()`)
    await wait(`document.body.innerText.includes('保留输入并重新编辑')`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '保留输入并重新编辑').click()`)
    await wait(`document.querySelector('.kode-collab-builder').innerText.includes('task_kind：需求交付')`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '保存工作区').click()`)
    await wait(`document.querySelector('.kode-collab-workspace-form button[type="submit"]').textContent === '保存工作区'`)
    assert.equal((await hub.client.call('/api/v1/messaging/superagents/drafts/' + createdDraft.id)).revision, 4)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '查看执行资源与额度').click()`)
    await wait(`document.querySelector('.kode-collab-resources')?.innerText.includes('Fixture execution resource')`)
    assert.ok(await page.evaluate(`document.querySelector('.kode-collab-resources').innerText.includes('此资源尚不支持额度采集')`))
    assert.ok(await page.evaluate(`document.querySelector('.kode-collab-resources').innerText.includes('此资源目录不提供团队预算')`))
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '查看可用模型').click()`)
    await wait(`document.querySelector('.kode-collab-resources select')?.options.length === 2`)
    await page.evaluate(`(() => { const select = document.querySelector('.kode-collab-resources select'); select.value = 'model'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`)
    await wait(`document.querySelector('.kode-collab-resources').innerText.includes('推理强度：Deliberate')`)
    await wait(`document.querySelector('.kode-collab-selection-form')?.innerText.includes('已填入默认或唯一可用资源')`)
    assert.equal(await page.evaluate(`document.querySelector('.kode-collab-selection-form details').open`), false)
    assert.equal((await hub.client.call('/api/v1/messaging/superagents/drafts/' + createdDraft.id + '/selection')).record, null, 'default suggestion alone does not save selection')
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '保存助手资源').click()`)
    await wait(`document.querySelector('.kode-collab-selection-form').innerText.includes('助手资源选择已保存')`)
    const selectedResource = await hub.client.call('/api/v1/messaging/superagents/drafts/' + createdDraft.id + '/selection')
    assert.equal(selectedResource.record.selection.model, 'model')
    assert.equal(selectedResource.record.selection.effort, 'deliberate')
    assert.equal(selectedResource.record.draft_revision, 4)
    assert.equal(selectedResource.record.eligible_for_execution, false)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '返回草案列表').click()`)
    await wait(`Array.from(document.querySelectorAll('.kode-collab-builder button')).some(button => !button.disabled && button.textContent.includes('维护通用研发工具'))`)
    await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-builder button')).find(button => button.textContent.includes('维护通用研发工具')).click()`)
    await wait(`document.querySelector('[aria-label="助手模型"]')?.value === 'model' && document.querySelector('[aria-label="推理强度（可选）"]')?.value === 'deliberate'`)
    assert.equal((await hub.client.call('/api/v1/messaging/superagents/drafts/' + createdDraft.id + '/selection')).record.revision, 1)
    const fundingPath = '/api/v1/messaging/superagents/drafts/' + createdDraft.id + '/funding'
    await wait(`!document.querySelector('[aria-label="预算单位"]').disabled`)
    for (const [label, value] of [['预算单位', 'credits'], ['创建预算总额', '100'], ['每百万输入 token 内部计价', '10'], ['每百万缓存输入 token 内部计价', '2'], ['每百万输出 token 内部计价', '20']]) {
      await page.evaluate(`document.querySelector('[aria-label="${label}"]').focus()`)
      await page.call('Input.insertText', { text: value })
    }
    await page.evaluate(`(() => { const input = document.querySelector('[aria-label="预算到期时间"]'); const date = new Date(Date.now() + 86400000); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); const value = date.toISOString().slice(0,16); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '核对预算与权限').click()`)
    await wait(`document.querySelector('.kode-collab-funding-form').innerText.includes('确认创建预算与草案权限')`)
    assert.equal((await hub.client.call(fundingPath)).record, null, 'review cannot create budget or grant')
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '确认创建预算与草案权限').click()`)
    await wait(`document.querySelector('.kode-collab-funding-form').innerText.includes('创建预算与草案权限已配置')`)
    const fundingRecord = (await hub.client.call(fundingPath)).record
    assert.equal(fundingRecord.budget.limit, 100); assert.equal(fundingRecord.budget.reserved, 0)
    assert.equal(fundingRecord.execution_started, false)
    assert.deepEqual(fundingRecord.grant.policy.capabilities, ['read', 'builder_draft_write'])
    await page.evaluate(`document.querySelector('[aria-label="本次预留预算"]').focus()`)
    await page.call('Input.insertText', { text: '20' })
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '核对启动配置').click()`)
    await wait(`document.querySelector('.kode-collab-start-form').innerText.includes('无法准备启动')`)
    assert.equal((await hub.client.call('/api/v1/messaging/budgets/' + fundingRecord.budget.id)).budget.reserved, 0, 'missing account must not start or reserve')
    await page.evaluate(`document.querySelector('[aria-label="账户归属标识"]').focus()`)
    await page.call('Input.insertText', { text: 'browser-owner-account' })
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '核对账户绑定').click()`)
    await wait(`document.querySelector('.kode-collab-account-form')?.innerText.includes('确认账户绑定')`)
    await assert.rejects(hub.client.call('/api/v1/messaging/resource-accounts/browser-owner-account'), /404|missing/)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '确认账户绑定').click()`)
    await wait(`document.querySelector('.kode-collab-account-form')?.innerText.includes('恢复原账户确认')`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '恢复原账户确认').click()`)
    await wait(`document.querySelector('.kode-collab-account-form')?.innerText.includes('账户绑定已确认')`)
    assert.equal(accountWrites, 2)
    const binding = await hub.client.call('/api/v1/messaging/resource-binding?host=' + hub.node + '&profile=profile')
    assert.equal(binding.account_id, 'browser-owner-account'); assert.equal(binding.revision, 2)
    let currentDraft = await hub.client.call('/api/v1/messaging/superagents/drafts/' + createdDraft.id)
    const escalationProposal = workflowProposal(currentDraft.interview.workspace_refs[0])
    const reviewedEscalation = [{ after_reworks: 1, task_tag: 'specialist', minimum_quality: 90 }]
    escalationProposal.workflow.stages[0].execution.escalation = reviewedEscalation
    await hub.client.call('/api/v1/messaging/superagents/drafts', { id: currentDraft.id, request_id: 'browser-workflow-proposal', expected_revision: currentDraft.revision, revoked: false, interview: { ...currentDraft.interview, proposed_workflow: escalationProposal } })
    await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-builder button')).find(button => button.textContent === '刷新').click()`)
    await wait(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === '核对工作流方案' && !button.disabled)`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '核对工作流方案').click()`)
    assert.equal(workflowWrites, 0)
    const escalationText = await page.evaluate(`document.querySelector('.kode-collab-workflow-proposal').innerText`)
    assert.match(escalationText, /累计返工 1 次后.*specialist.*最低质量 90/)
    assert.match(escalationText, /仍受原预算、权限和返工上限约束/)
    if (process.env.KODE_TEST_ESCALATION_SCREENSHOT_PATH) {
      await page.evaluate(`document.querySelector('.kode-collab-workflow-proposal').scrollIntoView()`)
      const shot = await page.call('Page.captureScreenshot', { format: 'png' })
      await writeFile(process.env.KODE_TEST_ESCALATION_SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'))
    }
    assert.equal((await hub.client.call('/api/v1/messaging/workflows/browser-flow/events')).events.length, 0)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '确认登记流程配置').click()`)
    await wait(`document.querySelector('.kode-collab-workflow-proposal')?.innerText.includes('恢复原流程登记')`)
    currentDraft = await hub.client.call('/api/v1/messaging/superagents/drafts/' + createdDraft.id)
    await hub.client.call('/api/v1/messaging/superagents/drafts', { id: currentDraft.id, request_id: 'update-during-workflow-recovery', expected_revision: currentDraft.revision, revoked: false, interview: { ...currentDraft.interview, purpose: currentDraft.interview.purpose + ' Updated context.' } })
    await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-builder button')).find(button => button.textContent === '刷新').click()`)
    await wait(`document.querySelector('.kode-collab-workflow-proposal')?.innerText.includes('草案已有更新')`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '恢复原流程登记').click()`)
    await wait(`document.querySelector('.kode-collab-workflow-proposal')?.innerText.includes('流程配置已登记')`)
    assert.equal(workflowWrites, 2)
    assert.deepEqual((await hub.client.call('/api/v1/messaging/workflows/browser-flow/versions/1')).pack.stages[0].execution.escalation, reviewedEscalation)
    for (const path of ['workflows/browser-flow', 'project-configs/browser-project', 'project-configs/browser-delivery']) assert.equal((await hub.client.call('/api/v1/messaging/' + path + '/events')).events.length, 1)
    currentDraft = await hub.client.call('/api/v1/messaging/superagents/drafts/' + createdDraft.id)
    const updatedWorkflow = structuredClone(currentDraft.interview.proposed_workflow)
    for (const part of Object.values(updatedWorkflow)) part.version = '2'
    await hub.client.call('/api/v1/messaging/superagents/drafts', { id: currentDraft.id, request_id: 'new-workflow-version', expected_revision: currentDraft.revision, revoked: false, interview: { ...currentDraft.interview, proposed_workflow: updatedWorkflow } })
    await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-builder button')).find(button => button.textContent === '刷新').click()`)
    await wait(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === '核对更新后的工作流方案' && !button.disabled)`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '核对更新后的工作流方案').click()`)
    assert.equal(workflowWrites, 2, 'new proposal review alone does not register')
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '确认登记流程配置').click()`)
    await wait(`document.querySelector('.kode-collab-workflow-proposal')?.innerText.includes('流程配置已登记')`)
    assert.equal(workflowWrites, 3); assert.equal(workflowReceipt.workflow.version, '2')
    for (const path of ['workflows/browser-flow', 'project-configs/browser-project', 'project-configs/browser-delivery']) assert.equal((await hub.client.call('/api/v1/messaging/' + path + '/events')).events.length, 2)
    currentDraft = await hub.client.call('/api/v1/messaging/superagents/drafts/' + createdDraft.id)
    const sampleTeam = await hub.client.call('/api/v1/messaging/teams/team')
    const proposedTeam = activationProposal({ ...sampleTeam.spec, execution_targets: sampleTeam.spec.execution_targets.map(target => ({ ...target, account_binding_id: 'browser-owner-account' })) }, currentDraft.interview.workspace_refs[0], workflowReceipt)
    await hub.client.call('/api/v1/messaging/superagents/drafts', { id: currentDraft.id, request_id: 'browser-proposal', expected_revision: currentDraft.revision, revoked: false, interview: { ...currentDraft.interview, proposed_team: proposedTeam } })
    await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-builder button')).find(button => button.textContent === '刷新').click()`)
    await wait(`document.querySelector('.kode-collab-proposal')?.innerText.includes('Reviewed team')`)
    const teamCount = (await hub.client.call('/api/v1/messaging/teams')).items.length
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '核对团队方案').click()`)
    assert.equal((await hub.client.call('/api/v1/messaging/teams')).items.length, teamCount)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '确认保存团队草案').click()`)
    await wait(`document.querySelector('.kode-collab-proposal')?.innerText.includes('恢复原方案确认')`)
    assert.equal((await hub.client.call('/api/v1/messaging/teams')).items.length, teamCount + 1)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '恢复原方案确认').click()`)
    await wait(`document.querySelector('.kode-collab-proposal')?.innerText.includes('已接受为团队草案')`)
    assert.equal(acceptanceWrites, 2)
    assert.equal((await hub.client.call('/api/v1/messaging/teams')).items.length, teamCount + 1)
    const acceptedTeam = (await hub.client.call('/api/v1/messaging/teams')).items.find(row => row.spec.name === 'Reviewed team')
    assert.ok(acceptedTeam); assert.equal(acceptedTeam.status, 'draft')
    await wait(`Array.from(document.querySelectorAll('.kode-collab-team-activation button')).some(button => button.textContent === '核对激活条件' && !button.disabled)`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '核对激活条件').click()`)
    await wait(`document.querySelector('.kode-collab-team-activation')?.innerText.includes('权限未配置、已撤销或已过期')`)
    assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === '确认激活此版本团队')`), false)
    assert.equal((await hub.client.call('/api/v1/messaging/teams/' + acceptedTeam.id + '/activation-review', { team_revision: acceptedTeam.revision, request_id: 'verify-inactive' })).activation, null)
    for (const [label, value] of [['团队预算单位', 'credits'], ['初始团队总额度', '100'], ['单次工作预留上限', '10']]) {
      await page.evaluate(`document.querySelector('[aria-label="${label}"]').focus()`)
      await page.call('Input.insertText', { text: value })
    }
    await page.evaluate(`(() => { const input = document.querySelector('[aria-label="团队预算到期时间"]'); const date = new Date(Date.now() + 3600000); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, date.toISOString().slice(0,16)); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '核对初始团队预算').click()`)
    await wait(`document.querySelector('.kode-collab-initial-budget')?.innerText.includes('确认创建团队预算')`)
    await assert.rejects(hub.client.call('/api/v1/messaging/team-policies/browser-budget-policy'), /404/)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '确认创建团队预算').click()`)
    await wait(`document.querySelector('.kode-collab-initial-budget')?.innerText.includes('恢复原初始预算')`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '恢复原初始预算').click()`)
    await wait(`document.querySelector('.kode-collab-initial-budget')?.innerText.includes('初始团队预算与策略已保存')`)
    assert.equal(initialBudgetWrites, 2)
    const initialPolicy = await hub.client.call('/api/v1/messaging/team-policies/browser-budget-policy')
    assert.equal(initialPolicy.revision, 1); assert.equal(initialPolicy.policy.max_assignment_charge, 10)
    const initialBudget = (await hub.client.call('/api/v1/messaging/budgets/' + initialPolicy.policy.budget_ids[0])).budget
    assert.equal(initialBudget.limit, 100); assert.equal(initialBudget.reserved, 0); assert.equal(initialBudget.revision, 1)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '读取调度资源').click()`)
    await wait(`document.querySelector('[aria-label="control 的能力评价"]')`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '新增用户能力评价').click()`)
    for (const [label, value] of [['control 任务类型', 'inspection'], ['control 能力评分', '80'], ['control 评价可信度', '0.7'], ['control 评价依据', 'Owner observation in fixture']]) {
      await page.evaluate(`document.querySelector('[aria-label="${label}"]').focus()`)
      await page.call('Input.insertText', { text: value })
    }
    await page.evaluate(`(() => { const input = document.querySelector('[aria-label="control 评价到期时间"]'); const date = new Date(Date.now() + 3600000); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, date.toISOString().slice(0,16)); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '核对用户能力评价').click()`)
    await wait(`document.querySelector('.kode-collab-capability-form')?.innerText.includes('确认保存用户评价')`)
    assert.equal((await hub.client.call('/api/v1/messaging/teams/' + acceptedTeam.id + '/scheduling-options/1')).options[0].capabilities.length, 1)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '确认保存用户评价').click()`)
    await wait(`document.querySelector('[aria-label="control 的能力评价"]')?.options.length === 3`)
    const evaluated = (await hub.client.call('/api/v1/messaging/teams/' + acceptedTeam.id + '/scheduling-options/1')).options[0]
    assert.equal(evaluated.binding.revision, 2, 'assessment alone must preserve the current account binding')
    const newCapability = evaluated.capabilities.find(value => value.id !== 'capability')
    assert.equal(newCapability.assessments.fit.source, 'user'); assert.equal(newCapability.assessments.fit.evaluation.score, 80)
    await page.evaluate(`(() => { const select = document.querySelector('[aria-label="control 的能力评价"]'); select.value = ${JSON.stringify(newCapability.id)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`)

    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '核对调度偏好').click()`)
    await wait(`document.querySelector('.kode-collab-scheduling-form')?.innerText.includes('缺失或不匹配的资源不能确认')`)
    await page.evaluate(`document.querySelector('.kode-collab-scheduling-form input[type="checkbox"]').click()`)
    await page.evaluate(`document.querySelector('[aria-label="browser-owner-account 配置工作并发"]').click()`)
    await page.evaluate(`document.querySelector('[aria-label="browser-owner-account 工作并发上限"]').focus()`)
    await page.call('Input.insertText', { text: '1' })

    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '核对调度偏好').click()`)
    await wait(`document.querySelector('.kode-collab-scheduling-form')?.innerText.includes('确认保存调度策略')`)
    await assert.rejects(hub.client.call('/api/v1/messaging/team-policies/browser-schedule'), /404/)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '确认保存调度策略').click()`)
    await wait(`document.querySelector('.kode-collab-scheduling-form')?.innerText.includes('调度策略已保存')`)
    const scheduled = await hub.client.call('/api/v1/messaging/team-policies/browser-schedule')
    assert.equal(scheduled.revision, 1); assert.equal(scheduled.policy.targets.control.resource.account_id, 'browser-owner-account')
    assert.equal(scheduled.policy.targets.control.resource.binding_revision, 2)
    assert.deepEqual(scheduled.policy.targets.control.resource.limit_ids, [])

    activationRuntime = { host: hub.node } // Controlled adapter registry; this test starts no executor.
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '核对激活条件').click()`)
    await wait(`document.querySelector('.kode-collab-team-activation')?.innerText.includes('团队预算单位：')`)
    await page.evaluate(`(() => { const input = document.querySelector('[aria-label="团队权限到期时间"]'); const date = new Date(Date.now() + 3600000); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, date.toISOString().slice(0,16)); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '核对流程所需权限').click()`)
    await wait(`document.querySelector('.kode-collab-authority-form')?.innerText.includes('确认保存流程权限')`)
    await assert.rejects(hub.client.call('/api/v1/messaging/team-grants/browser-grant'), /404|missing/)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '确认保存流程权限').click()`)
    await wait(`document.querySelector('.kode-collab-authority-form')?.innerText.includes('恢复原权限确认')`)
    assert.equal((await hub.client.call('/api/v1/messaging/team-grants/browser-grant')).revision, 1)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '恢复原权限确认').click()`)
    await wait(`document.querySelector('.kode-collab-authority-form')?.innerText.includes('权限配置已保存')`)
    assert.equal(authorityWrites, 2)
    const confirmedGrant = await hub.client.call('/api/v1/messaging/team-grants/browser-grant')
    assert.deepEqual(confirmedGrant.policy.capabilities, ['delegate', 'read'])
    assert.equal(confirmedGrant.policy.network, false)

    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '核对激活条件').click()`)
    await wait(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === '确认激活此版本团队')`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '确认激活此版本团队').click()`)
    await wait(`document.querySelector('.kode-collab-team-activation')?.innerText.includes('恢复原激活请求')`)
    const activation = await hub.client.call('/api/v1/messaging/teams/' + acceptedTeam.id + '/activation')
    assert.equal(activation.active, true); assert.equal(activation.revision, 1)
    activationRuntime = undefined // Historical recovery must survive unavailable runtime metadata.
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '恢复原激活请求').click()`)
    await wait(`document.querySelector('.kode-collab-team-activation')?.innerText.includes('已有激活确认记录')`)
    assert.equal(activationWrites, 2)
    assert.deepEqual(await hub.client.call('/api/v1/messaging/teams/' + acceptedTeam.id + '/activation'), activation)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '返回草案列表').click()`)
    await wait(`Array.from(document.querySelectorAll('.kode-collab-builder button')).some(button => !button.disabled && button.textContent.includes('维护通用研发工具'))`)
    await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-builder button')).find(button => button.textContent.includes('维护通用研发工具')).click()`)
    await wait(`document.querySelector('.kode-collab-team-activation')?.innerText.includes('已有激活确认记录')`)
    assert.equal(activationWrites, 2, 'restoring IndexedDB confirmation must not activate again')
    await wait(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === '核对当前启用状态' && !button.disabled)`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '核对当前启用状态').click()`)
    await wait(`document.querySelector('.kode-collab-team-deactivation')?.innerText.includes('确认停用当前授权')`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '确认停用当前授权').click()`)
    await wait(`document.querySelector('.kode-collab-team-deactivation')?.innerText.includes('恢复原停用请求')`)
    const deactivated = await hub.client.call('/api/v1/messaging/teams/' + acceptedTeam.id + '/activation')
    assert.equal(deactivated.active, false); assert.equal(deactivated.revision, 2)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '恢复原停用请求').click()`)
    await wait(`document.querySelector('.kode-collab-team-deactivation')?.innerText.includes('停用已确认')`)
    assert.equal(activationWrites, 4)
    assert.deepEqual(await hub.client.call('/api/v1/messaging/teams/' + acceptedTeam.id + '/activation'), deactivated)
    activationRuntime = { host: hub.node }
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '重新核对激活条件').click()`)
    await wait(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === '确认激活此版本团队')`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '确认激活此版本团队').click()`)
    await wait(`document.querySelector('.kode-collab-team-activation')?.innerText.includes('已有激活确认记录') && !Array.from(document.querySelectorAll('button')).some(button => button.textContent === '确认激活此版本团队')`)
    const reactivated = await hub.client.call('/api/v1/messaging/teams/' + acceptedTeam.id + '/activation')
    assert.equal(reactivated.active, true); assert.equal(reactivated.revision, 3)
    assert.equal(activationWrites, 5)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '重新核对激活条件').click()`)
    await wait(`document.querySelector('.kode-collab-team-activation')?.innerText.includes('无需重复激活')`)
    assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === '确认激活此版本团队')`), false)
    await page.evaluate(`(() => { const input = document.querySelector('[aria-label="团队权限到期时间"]'); const date = new Date(Date.now() + 7200000); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, date.toISOString().slice(0,16)); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '核对流程所需权限').click()`)
    await wait(`document.querySelector('.kode-collab-authority-form')?.innerText.includes('确认保存流程权限')`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '确认保存流程权限').click()`)
    await wait(`document.querySelector('.kode-collab-authority-form')?.innerText.includes('权限配置已保存')`)
    assert.equal(authorityWrites, 3)
    assert.equal((await hub.client.call('/api/v1/messaging/team-grants/browser-grant')).revision, 2)
    assert.equal((await hub.client.call('/api/v1/messaging/teams/' + acceptedTeam.id + '/activation')).revision, 3, 'authority update alone cannot activate')
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '重新核对激活条件').click()`)
    await wait(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === '确认激活此版本团队')`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '确认激活此版本团队').click()`)
    await wait(`!Array.from(document.querySelectorAll('button')).some(button => button.textContent === '确认激活此版本团队')`)
    const renewed = await hub.client.call('/api/v1/messaging/teams/' + acceptedTeam.id + '/activation')
    assert.equal(renewed.revision, 4); assert.equal(renewed.snapshot.grant.revision, 2)
    assert.equal(activationWrites, 6)
















    assert.equal(await page.evaluate('fixture.created()'), 0)
    assert.deepEqual(await page.evaluate('fixtureErrors'), [])
    if (process.env.KODE_TEST_SCREENSHOT_PATH) {
      const shot = await page.call('Page.captureScreenshot', { format: 'png' })
      await writeFile(process.env.KODE_TEST_SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'))
    }
  } finally {
    await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await hub.close(); await rm(profile, { recursive: true, force: true })
  }
})

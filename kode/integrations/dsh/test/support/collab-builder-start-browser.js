import { CoordinatorUpdates } from '../../src/coordinator-updates.js'
import { AssignmentDispatchHost } from '../../src/assignment-dispatch-host.js'
import { WorkRunController } from '../../src/work-run-controller.js'
import { prepareWorkRunAssignment } from '../../src/work-run-preparation.js'
import { registerTeamResource } from '../../src/team-resource-route.js'
import { registerTeamScheduling } from '../../src/team-scheduling-route.js'
import { registerTeamAuthority } from '../../src/team-authority-route.js'
import { builderPolicyIdentities } from '../../src/builder-policy-identities.js'
import { registerTeamActivation } from '../../src/team-activation-route.js'
import { registerTeamBudget } from '../../src/team-budget-route.js'
import { registerBuilderAccept } from '../../src/builder-accept-route.js'
import { profileRevision } from '../../src/agent-profiles.js'
import { registerBuilderWorkflowSetup } from '../../src/builder-workflow-setup.js'
import { registerBuilderAnswers } from '../../src/builder-answers-route.js'
import { registerBuilderCreate } from '../../src/builder-create-route.js'
import { registerBuilderWorkspaces } from '../../src/builder-workspaces-route.js'
import { registerBuilderDefaults } from '../../src/builder-defaults-route.js'
import { registerBuilderAccount } from '../../src/builder-account-route.js'
import { registerBuilderInput } from '../../src/builder-input-route.js'
import { registerBuilderConversation } from '../../src/builder-conversation.js'
/** Actual browser + native Host startup. Metadata and model responses are controlled; no paid provider is used. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headlessBrowser } from './headless-browser.js'
import { collabRenderPage } from './collab-render-page.js'
import { registerCollabTeams } from '../../src/collab-api.js'
import { registerBuilderDrafts } from '../../src/builder-drafts-route.js'
import { registerBuilderSelection } from '../../src/builder-selection-route.js'
import { registerBuilderFunding } from '../../src/builder-funding-route.js'
import { registerBuilderWorkspaceDirectory } from '../../src/builder-workspace-directory.js'
import { registerBuilderModels } from '../../src/builder-models-route.js'
import { registerResourceCoverage } from '../../src/resource-coverage.js'
import { registerBuilderStartPlan } from '../../src/builder-start-plan-route.js'
import { registerBuilderStart } from '../../src/builder-start-route.js'
export const browserInterviewAnswers = Object.freeze({
  task_kind: '需求交付', delivery: '本地修改、独立评审与验证通过，由我验收；不推送。',
  example: '输入一个工具缺陷，输出可评审的补丁与验证记录。', workflow: '实现、独立评审、验证，最终由我确认。',
  resources: '使用已登记的本地工作区，优先成本适中的资源。', budget: '团队预算 100 credits，不足时暂停并反馈。',
  permissions: '只允许本地修改，不提交、不推送、不部署、不对外发消息。', verification: '运行项目已有检查并保留结果，需要人工设备时询问我。',
  failure: '最多返工两次，仍失败时向我报告证据。', concurrency: '同一工作区的写任务串行。',
})
export async function inspectBuilderStartup({ hub, host, profiles, root, onConfigured, onWorkflowRegistered, onCoordinatorInput, onRunCompleted, onCoordinatorFinalized, onSuccessorInput, onPendingCoordinatorClose }) {
  const call = (path, body) => hub.client.call(`/api/v1/messaging/${path}`, body)
  const registeredWorkspace = await call('workbench/workspaces', { action: 'create', path: root, title: 'Native Builder project' })
  const workspace = { host_id: hub.node, workspace_id: registeredWorkspace.workspace_id, root_ref: root }
  const registry = host.ctx.get('workspaceRegistry'), previousList = registry.list
  // Keep registered resources available until the enclosing native Host is disposed.
  registry.list = () => [...previousList(), { id: workspace.workspace_id, path: root }]
  const beforeDrafts = (await call('superagents/drafts')).items.length
  let draftPath
  let funding
  const browserProfile = await mkdtemp(join(tmpdir(), 'kode-native-builder-browser-'))
  let browser, server, starts = 0, inputs = 0, accounts = 0, answerWrites = 0, schedulingWrites = 0, created, planned, acceptedTeam
  try {
    const routes = new Map()
    const ctx = { webServer: { register: route => routes.set(route.path, route) }, get: name => name === 'kodeAgents' ? { officialLoops: host, officialExecution: host.execution, profiles } : host.ctx.get(name),
      connection: { admit: req => req.headers['x-fixture-owner'] === 'yes' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } } }
    for (const register of [registerTeamResource, registerTeamScheduling, registerTeamAuthority, registerTeamActivation, registerTeamBudget, registerBuilderAccept, registerBuilderWorkflowSetup, registerBuilderCreate, registerBuilderWorkspaces, registerBuilderAnswers, registerBuilderAccount, registerCollabTeams, registerBuilderDrafts, registerBuilderSelection, registerBuilderFunding, registerBuilderWorkspaceDirectory, registerBuilderInput, registerBuilderConversation]) register(ctx, { backendClient: hub.client })
    registerBuilderStartPlan(ctx); registerBuilderStart(ctx)
    const metadata = { listProviders: () => [{ id: 'fixture', name: 'Fixture' }], listModels: async () => [{ provider: 'fixture', id: 'model', name: 'Model' }], resolveModelInfo: async () => ({ provider: 'fixture', id: 'model', name: 'Model' }) }
    const resources = { profiles, hasRuntime: () => true, officialResourceDirectory: () => ({ status: 'registered_only', items: [{ provider_id: 'fixture', name: 'Fixture', registered: true }] }) }
    registerBuilderModels(ctx, metadata, hub.node)
    registerResourceCoverage(ctx, resources, hub.client, hub.node)
    registerBuilderDefaults(ctx, { backendClient: hub.client, service: resources, llm: metadata, home: hub.node })
    server = createServer(async (req, res) => {
      try {
        const path = new URL(req.url, 'http://localhost').pathname, route = routes.get(path)
        if (path === '/api/kode/builder/answers' && req.method === 'POST') {
          answerWrites++
          if (answerWrites === 1) return await route.handler(req, { writeHead(status) { assert.equal(status, 200) }, end(value) {
            assert.equal(JSON.parse(value).revision, 2)
            res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'fixture committed answer response lost' }))
          } })
        }
        if (path === '/api/kode/builder/accept-proposal' && req.method === 'POST') return await route.handler(req, { writeHead(status, headers) { res.writeHead(status, headers) }, end(value) { acceptedTeam = JSON.parse(value); res.end(value) } })
        if (path === '/api/kode/teams/scheduling' && req.method === 'POST') {
          schedulingWrites++
          if (schedulingWrites === 1) return await route.handler(req, { writeHead(status) { assert.equal(status, 200) }, end(value) {
            assert.equal(JSON.parse(value).internal_prices.provider_invoice, false)
            res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'fixture committed pricing response lost' }))
          } })
        }
        if (path === '/api/kode/builder/account' && req.method === 'POST') accounts++
        if (path === '/api/kode/builder/start-plan') return await route.handler(req, { writeHead(status, headers) { res.writeHead(status, headers) }, end(value) { planned = JSON.parse(value); res.end(value) } })
        if (path === '/api/kode/builder/start') {
          starts++
          if (starts === 1) return await route.handler(req, { writeHead() {}, end(value) {
            created = JSON.parse(value)
            res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'fixture committed response lost' }))
          } })
        }
        if (path === '/api/kode/builder/input' && req.method === 'POST') {
          inputs++
          if (inputs === 1) return await route.handler(req, { writeHead() {}, end(value) {
            assert.equal(JSON.parse(value).receipt.state, 'queued')
            res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'fixture queued input response lost' }))
          } })
        }
        if (route) return await route.handler(req, res)
        if (await collabRenderPage(req, res)) return
        res.writeHead(404); res.end()
      } catch { if (!res.headersSent) res.writeHead(500); res.end() }
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, browserProfile)
    const page = await browser.page(`http://127.0.0.1:${server.address().port}`)
    const wait = expression => page.evaluate(`(async()=>{const until=Date.now()+10000;while(Date.now()<until){if(${expression})return;await new Promise(r=>setTimeout(r,25))}throw Error('Builder startup render timeout: '+document.body.innerText.slice(-1800))})()`)
    const click = text => page.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent===${JSON.stringify(text)}).click()`)
    await wait('globalThis.fixture'); await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]').click()`)
    await wait(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='团队搭建助手')`); await click('团队搭建助手')
    await wait(`document.querySelector('.kode-collab-builder-create textarea')`)
    await page.evaluate(`document.querySelector('.kode-collab-builder-create textarea').focus()`)
    await page.call('Input.insertText', { text: 'Browser startup test' })
    await wait(`document.querySelector('.kode-collab-builder-create button[type="submit"]')?.disabled === false`)
    await click('保存目标并继续')
    await wait(`document.querySelector('.kode-collab-builder h2')?.textContent === 'Browser startup test'`)
    const drafts = (await call('superagents/drafts')).items
    assert.equal(drafts.length, beforeDrafts + 1)
    draftPath = 'superagents/drafts/' + drafts.find(row => row.purpose === 'Browser startup test').id
    assert.equal((await call(draftPath)).interview.workspace_refs.length, 0)
    let interview = await call(draftPath)
    for (let round = 0; interview.interview.questions.length; round++) {
      assert.ok(round < 4, 'interview advances in bounded rounds')
      assert.ok(interview.interview.questions.length <= 3)
      for (const question of interview.interview.questions) {
        assert.ok(browserInterviewAnswers[question.id], 'unexpected questionnaire branch')
        const selector = `Array.from(document.querySelectorAll('.kode-collab-input-label')).find(label => label.textContent === ${JSON.stringify(question.prompt)})?.querySelector('textarea')`
        await wait(selector)
        await page.evaluate(`(${selector}).focus()`)
        await page.call('Input.insertText', { text: browserInterviewAnswers[question.id] })
      }
      await wait(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === '保存回答' && !button.disabled)`)
      await click('保存回答')
      if (round === 0) {
        await wait(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === '重试原回答' && !button.disabled)`)
        assert.equal((await call(draftPath)).revision, interview.revision + 1)
        await click('重试原回答')
      }
      const marker = interview.interview.questions[0].id + '：' + browserInterviewAnswers[interview.interview.questions[0].id]
      await wait(`document.querySelector('.kode-collab-builder')?.innerText.includes(${JSON.stringify(marker)})`)
      const answered = await call(draftPath)
      assert.equal(answered.revision, interview.revision + 1, 'retry cannot advance the draft twice')
      interview = answered
    }
    assert.equal(answerWrites, 5, 'four answer batches plus one exact retry')
    assert.deepEqual(interview.interview.answers, browserInterviewAnswers)
    assert.equal(interview.eligible_for_execution, false)

    await wait(`document.querySelector('.kode-collab-workspace-form select option[value="${hub.node}"]')`)
    await page.evaluate(`(() => { const select = document.querySelector('.kode-collab-workspace-form select'); select.value = ${JSON.stringify(hub.node)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`)
    await wait(`document.querySelector('.kode-collab-workspace-option input')`)
    await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-workspace-option')).find(row => row.textContent.includes('Native Builder project')).querySelector('input').click()`)
    await click('保存工作区')
    await wait(`document.querySelector('.kode-collab-workspace-form button[type="submit"]').textContent === '保存工作区'`)
    const scopedDraft = await call(draftPath)
    assert.equal(scopedDraft.revision, interview.revision + 1)
    assert.deepEqual(scopedDraft.interview.workspace_refs, [workspace])

    await wait(`document.querySelector('.kode-collab-selection-form')?.innerText.includes('已填入默认或唯一可用资源')`)
    assert.equal((await call(`${draftPath}/selection`)).record, null)
    assert.equal(starts, 0, 'resource proposal cannot start a runtime')
    await click('保存助手资源')
    await wait(`document.querySelector('.kode-collab-selection-form')?.innerText.includes('助手资源选择已保存')`)
    const selected = (await call(`${draftPath}/selection`)).record
    assert.deepEqual(selected.selection, { profile_id: 'builder', provider: 'fixture', model: 'model', effort: null, workspace })
    assert.equal(selected.eligible_for_execution, false)
    await wait(`document.querySelector('[aria-label="本次预留预算"]') && !document.querySelector('[aria-label="本次预留预算"]').disabled`)
    await page.evaluate(`document.querySelector('[aria-label="账户归属标识"]').focus()`)
    await page.call('Input.insertText', { text: 'browser-account' })
    await click('核对账户绑定')
    await wait(`document.querySelector('.kode-collab-account-form')?.innerText.includes('确认账户绑定')`)
    assert.equal(accounts, 0)
    await click('确认账户绑定')
    await wait(`document.querySelector('.kode-collab-account-form')?.innerText.includes('账户绑定已确认')`)
    assert.equal(accounts, 1)
    const binding = await call('resource-binding?host=' + hub.node + '&profile=builder')
    assert.equal(binding.account_id, 'browser-account'); assert.equal(binding.revision, 2)
    await wait(`document.querySelector('[aria-label="预算单位"]') && !document.querySelector('[aria-label="预算单位"]').disabled`)
    for (const [label, value] of [['预算单位', 'credits'], ['创建预算总额', '100'], ['每百万输入 token 内部计价', '1'], ['每百万缓存输入 token 内部计价', '1'], ['每百万输出 token 内部计价', '1']]) {
      await page.evaluate(`document.querySelector('[aria-label="${label}"]').focus()`)
      await page.call('Input.insertText', { text: value })
    }
    await page.evaluate(`(() => { const input = document.querySelector('[aria-label="预算到期时间"]'); const date = new Date(Date.now() + 3600000); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, date.toISOString().slice(0,16)); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await click('核对预算与权限')
    await wait(`document.querySelector('.kode-collab-funding-form')?.innerText.includes('确认创建预算与草案权限')`)
    assert.equal((await call(`${draftPath}/funding`)).record, null)
    await click('确认创建预算与草案权限')
    await wait(`document.querySelector('.kode-collab-funding-form')?.innerText.includes('创建预算与草案权限已配置')`)
    funding = (await call(`${draftPath}/funding`)).record
    assert.equal(funding.budget.limit, 100); assert.equal(funding.budget.reserved, 0)
    await page.evaluate(`document.querySelector('[aria-label="本次预留预算"]').focus()`); await page.call('Input.insertText', { text: '20' })
    await page.evaluate(`document.querySelector('.kode-collab-start-form input[type="checkbox"]').click()`)
    await click('核对启动配置'); await wait(`document.querySelector('.kode-collab-start-form')?.innerText.includes('确认启动创建助手')`)
    assert.equal(planned.command.start.operation.resource.account_id, 'browser-account')
    assert.equal(planned.command.start.operation.resource.binding_revision, 2)
    assert.equal(starts, 0); assert.equal((await call(`budgets/${funding.budget.id}`)).budget.reserved, 0)
    await click('确认启动创建助手'); await wait(`document.querySelector('.kode-collab-start-form')?.innerText.includes('恢复原启动请求')`)
    assert.equal(created.state, 'created', 'response was lost after genuine native creation')
    assert.ok(host.handles.has(created.request.session_id))
    assert.equal((await call(`budgets/${funding.budget.id}`)).budget.reserved, 20)
    await click('恢复原启动请求'); await wait(`document.querySelector('.kode-collab-start-form')?.innerText.includes('助手创建已确认')`)
    assert.equal(starts, 2)
    await click('返回草案列表')
    await wait(`Array.from(document.querySelectorAll('button')).some(button=>!button.disabled && button.textContent==='Browser startup test · 草案')`)
    await click('Browser startup test · 草案')
    await wait(`document.querySelector('.kode-collab-start-form')?.innerText.includes('助手创建已确认')`)
    assert.equal(starts, 2, 'IndexedDB restoration does not issue another startup')
    await page.call('Page.reload')
    await wait('globalThis.fixture')
    await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]')?.click()`)
    await wait(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='团队搭建助手')`)
    await click('团队搭建助手')
    await wait(`Array.from(document.querySelectorAll('button')).some(button=>!button.disabled && button.textContent==='Browser startup test · 草案')`)
    await click('Browser startup test · 草案')
    await wait(`document.querySelector('.kode-collab-start-form')?.innerText.includes('助手创建已确认')`)
    assert.equal(starts, 2, 'full page reload recovers IndexedDB without another POST')
    await wait(`document.querySelector('[aria-label="给创建助手的消息"]') && !document.querySelector('[aria-label="给创建助手的消息"]').disabled`)
    await page.evaluate(`document.querySelector('[aria-label="给创建助手的消息"]').focus()`)
    await onConfigured(await call(draftPath))
    await page.call('Input.insertText', { text: 'Browser conversation check' })
    await click('发送给创建助手')
    await wait(`document.querySelector('.kode-collab-builder-conversation')?.innerText.includes('重试原助手消息')`)
    await click('重试原助手消息')
    await wait(`!document.querySelector('[aria-label="给创建助手的消息"]').disabled`)
    await page.evaluate(`document.querySelector('[aria-label="给创建助手的消息"]').focus()`)
    await page.call('Input.insertText', { text: 'Unsent follow-up' })
    await wait(`document.querySelector('.kode-collab-builder-conversation')?.innerText.includes('Browser reply received')`)
    const events = host.ctx.get('agents').get(created.request.session_id).session.snapshotEvents(0)
    assert.equal(events.filter(event => event.type === 'user/message').length, 1)
    assert.equal(inputs, 2, 'ambiguous submission retries once with the original request')
    const proposed = await call(draftPath)
    assert.equal(proposed.actor.kind, 'builder')
    assert.deepEqual(proposed.interview.answers, browserInterviewAnswers)
    assert.deepEqual(proposed.interview.proposed_workflow.workflow.stages.map(stage => stage.id), ['implement', 'review', 'verify'])
    assert.equal((await call('workflows/native-browser-flow/events')).events.length, 0, 'assistant proposal is not owner registration')
    await wait(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === '核对工作流方案' && !button.disabled)`)
    assert.equal(await page.evaluate(`document.querySelector('[aria-label="给创建助手的消息"]').value`), 'Unsent follow-up')
    await click('核对工作流方案')
    assert.equal((await call('workflows/native-browser-flow/events')).events.length, 0)
    await click('确认登记流程配置')
    await wait(`document.querySelector('.kode-collab-workflow-proposal')?.innerText.includes('流程配置已登记')`)
    for (const path of ['workflows/native-browser-flow', 'project-configs/native-browser-project', 'project-configs/native-browser-delivery']) assert.equal((await call(path + '/events')).events.length, 1)
    const version = value => ({ id: value.id, version: value.version, hash: value.hash })
    const flow = version(await call('workflows/native-browser-flow/versions/1'))
    const project = version(await call('project-configs/native-browser-project/versions/1'))
    const delivery = version(await call('project-configs/native-browser-delivery/versions/1'))
    const capability = await call('capability-profiles', { id: 'browser-capability', expected_revision: 0, host: hub.node, profile: 'builder', model: 'model', assessments: {} })
    const teamProposal = { name: 'Browser authored team', purpose: 'Deliver local changes with independent review and verification', kind: 'coordinator', workspace_refs: [workspace],
      execution_targets: [{ id: 'local-model', host_id: hub.node, executor_profile_id: 'builder', executor_profile_revision: profileRevision(profiles.get('builder')), provider_id: 'fixture', model_id: 'model', effort: null, account_binding_id: 'browser-account', capability_profile_revision: String(capability.revision) }],
      workers: ['author', 'reviewer', 'verifier'].map(role => ({ id: role, role, responsibilities: [role], allowed_target_ids: ['local-model'], required_capabilities: role === 'author' ? ['read', 'workspace_write'] : ['read'], workspace_refs: [workspace], max_parallel: 1 })),
      coordinator_targets: ['local-model'], coordinator_startup: { workspace_id: workspace.workspace_id, task_tag: 'development' }, workflow_pack_refs: [flow],
      delivery_bindings: [{ id: 'local', workflow: flow, project, delivery_policy: delivery }], ...builderPolicyIdentities(hub.node, planned.command.team_id).proposed_policy_ids,
      limits: { max_active_assignments: 1, max_active_runs: 1 }, proactive_mode: 'off' }
    await onWorkflowRegistered(await call(draftPath), teamProposal)
    const teamCount = (await call('teams')).items.length
    const sessionsBefore = (await call('sessions')).sessions.length
    await page.evaluate(`(() => { const input = document.querySelector('[aria-label="给创建助手的消息"]'); input.focus(); input.select(); })()`)
    await page.call('Input.insertText', { text: 'Use the registered workflow to propose my team' })
    await click('发送给创建助手')
    await wait(`document.querySelector('.kode-collab-proposal')?.innerText.includes('Browser authored team')`)
    assert.equal((await call('teams')).items.length, teamCount)
    assert.deepEqual((await call(draftPath)).interview.proposed_team, teamProposal)
    await wait(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === '核对团队方案' && !button.disabled)`)
    await click('核对团队方案')
    assert.equal((await call('teams')).items.length, teamCount)
    await click('确认保存团队草案')
    await wait(`document.querySelector('.kode-collab-proposal')?.innerText.includes('已接受为团队草案')`)
    assert.equal(acceptedTeam.activation_performed, false); assert.equal(acceptedTeam.actor.kind, 'human')
    const saved = await call('teams/' + acceptedTeam.team.id)
    assert.equal(saved.status, 'draft'); assert.deepEqual(saved.spec, teamProposal)
    assert.equal((await call('teams')).items.length, teamCount + 1)
    assert.equal((await call('sessions')).sessions.length, sessionsBefore, 'accepting the team cannot start Workers')
    await wait(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === '核对激活条件' && !button.disabled)`)
    await click('核对激活条件')
    await wait(`document.querySelector('[aria-label="团队预算单位"]')`)
    assert.ok(await page.evaluate(`document.querySelector('.kode-collab-account-capacity')?.innerText.includes('尚未配置账号工作并发上限')`))
    for (const [label, value] of [['团队预算单位', 'credits'], ['初始团队总额度', '100'], ['单次工作预留上限', '10']]) {
      await page.evaluate(`document.querySelector('[aria-label="${label}"]').focus()`)
      await page.call('Input.insertText', { text: value })
    }
    await page.evaluate(`(() => { const input = document.querySelector('[aria-label="团队预算到期时间"]'); const date = new Date(Date.now() + 3600000); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, date.toISOString().slice(0,16)); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await page.evaluate(`document.querySelector('[aria-label="启用内部计价结算"]').click()`)
    await click('核对初始团队预算')
    await wait(`document.querySelector('.kode-collab-initial-budget')?.innerText.includes('确认创建团队预算')`)
    await assert.rejects(call('team-policies/' + saved.spec.budget_policy_id), /404/)
    await click('确认创建团队预算')
    await wait(`document.querySelector('.kode-collab-initial-budget')?.innerText.includes('初始团队预算与策略已保存')`)
    const policy = await call('team-policies/' + saved.spec.budget_policy_id)
    assert.equal(policy.team_id, saved.id); assert.equal(policy.revision, 1); assert.equal(policy.policy.settlement, 'internal_price')
    const budget = (await call('budgets/' + policy.policy.budget_ids[0])).budget
    assert.equal(budget.limit, 100); assert.equal(budget.reserved, 0); assert.equal(budget.spent, 0)
    assert.equal((await call('teams/' + saved.id + '/activation-review', { team_revision: saved.revision, request_id: 'verify-no-activation' })).activation, null)
    await click('读取调度资源')
    await wait(`document.querySelector('[aria-label="local-model 的能力评价"]')`)
    assert.ok(await page.evaluate(`document.querySelector('.kode-collab-scheduling-form').innerText.includes('尚无能力评价条目')`))
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '新增用户能力评价').click()`)
    for (const [label, value] of [['local-model 任务类型', 'development'], ['local-model 能力评分', '80'], ['local-model 评价可信度', '0.7'], ['local-model 评价依据', 'Owner observation in fixture']]) {
      await page.evaluate(`document.querySelector('[aria-label="${label}"]').focus()`)
      await page.call('Input.insertText', { text: value })
    }
    await page.evaluate(`(() => { const input = document.querySelector('[aria-label="local-model 评价到期时间"]'); const date = new Date(Date.now() + 3600000); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, date.toISOString().slice(0,16)); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '核对用户能力评价').click()`)
    await wait(`document.querySelector('.kode-collab-capability-form')?.innerText.includes('确认保存用户评价')`)
    assert.equal((await call('teams/' + saved.id + '/scheduling-options/1')).options[0].capabilities.length, 1)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '确认保存用户评价').click()`)
    await wait(`document.querySelector('[aria-label="local-model 的能力评价"]')?.options.length === 3`)
    const evaluated = (await call('teams/' + saved.id + '/scheduling-options/1')).options[0]
    assert.equal(evaluated.binding.revision, 2, 'assessment alone must preserve the current account binding')
    const userCapability = evaluated.capabilities.find(value => value.id !== 'browser-capability')
    assert.equal(userCapability.assessments.fit.source, 'user'); assert.equal(userCapability.assessments.fit.evaluation.score, 80)
    await page.evaluate(`(() => { const select = document.querySelector('[aria-label="local-model 的能力评价"]'); select.value = ${JSON.stringify(userCapability.id)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`)
    await click('核对调度偏好')
    await wait(`document.querySelector('.kode-collab-scheduling-form')?.innerText.includes('缺失或不匹配的资源不能确认')`)
    await page.evaluate(`document.querySelector('.kode-collab-scheduling-form input[type="checkbox"]').click()`)
    await page.evaluate(`document.querySelector('[aria-label="browser-account 配置工作并发"]').click()`)
    await page.evaluate(`document.querySelector('[aria-label="browser-account 工作并发上限"]').focus()`)
    await page.call('Input.insertText', { text: '1' })
    await page.evaluate(`document.querySelector('[aria-label="local-model 配置内部计价"]').click()`)
    for (const [label, value] of [['内部计价单位', 'credits'], ['每百万输入 token 单价', '2'], ['每百万缓存输入 token 单价', '1'], ['每百万输出 token 单价', '3']]) {
      await page.evaluate(`document.querySelector('[aria-label="local-model ${label}"]').focus()`)
      await page.call('Input.insertText', { text: value })
    }

    await click('核对调度偏好')
    await wait(`document.querySelector('.kode-collab-scheduling-form')?.innerText.includes('确认保存调度策略')`)
    await assert.rejects(call('team-policies/' + saved.spec.scheduling_policy_id), /404/)
    await click('确认保存调度策略')
    await wait(`document.querySelector('.kode-collab-scheduling-form')?.innerText.includes('恢复原调度确认')`)
    await click('恢复原调度确认')
    await wait(`document.querySelector('.kode-collab-scheduling-form')?.innerText.includes('调度策略已保存')`)
    const scheduling = await call('team-policies/' + saved.spec.scheduling_policy_id)
    const selectedTarget = scheduling.policy.targets['local-model']
    assert.equal(schedulingWrites, 2)
    const price = await call('price-versions/' + selectedTarget.internal_price_id)
    assert.equal(price.unit, 'credits'); assert.equal(price.model, 'model'); assert.equal(price.model_policy, 'requested_model')
    assert.equal(price.input_per_million, 2); assert.equal(price.cached_per_million, 1); assert.equal(price.output_per_million, 3)
    assert.equal(scheduling.team_id, saved.id); assert.equal(scheduling.revision, 1)
    assert.equal(selectedTarget.resource.account_id, 'browser-account'); assert.equal(selectedTarget.resource.binding_revision, 2)
    assert.deepEqual(selectedTarget.resource.limit_ids, []); assert.equal(selectedTarget.resource.unknown_quota, 'team_budget')
    assert.deepEqual((await call('capability-profiles/browser-capability/1')).assessments, {})
    await click('核对激活条件')
    await wait(`document.querySelector('.kode-collab-team-activation')?.innerText.includes('团队预算单位：')`)
    await page.evaluate(`(() => { const input = document.querySelector('[aria-label="团队权限到期时间"]'); const date = new Date(Date.now() + 3600000); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, date.toISOString().slice(0,16)); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    const answerCheckbox = '.kode-collab-authority-form input[type="checkbox"]'
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(answerCheckbox)})?.checked`), true)
    await page.evaluate(`document.querySelector(${JSON.stringify(answerCheckbox)}).click()`)
    await click('核对流程所需权限')
    await wait(`document.querySelector('.kode-collab-authority-form')?.innerText.includes('确认保存流程权限')`)
    assert.equal(await page.evaluate(`document.querySelector('.kode-collab-authority-form').innerText.includes('kode_coordinator_answer_clarification')`), false)
    await assert.rejects(call('team-grants/' + saved.spec.grant_id), /404|missing/)
    await click('返回修改权限期限')
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(answerCheckbox)})?.checked`), false)
    await page.evaluate(`document.querySelector(${JSON.stringify(answerCheckbox)}).click()`)
    await click('核对流程所需权限')
    await wait(`document.querySelector('.kode-collab-authority-form')?.innerText.includes('确认保存流程权限')`)
    assert.equal(await page.evaluate(`document.querySelector('.kode-collab-authority-form').innerText.includes('kode_coordinator_answer_clarification')`), true)
    assert.equal(await page.evaluate(`document.querySelector('.kode-collab-authority-form').innerText.includes('原样转发')`), true)
    await assert.rejects(call('team-grants/' + saved.spec.grant_id), /404|missing/)
    await click('确认保存流程权限')
    await wait(`document.querySelector('.kode-collab-authority-form')?.innerText.includes('权限配置已保存')`)
    const grant = await call('team-grants/' + saved.spec.grant_id)
    assert.deepEqual(grant.policy.capabilities, ['delegate', 'read', 'workspace_write'])
    assert.ok(grant.policy.tools.includes('kode_coordinator_answer_clarification'))
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(answerCheckbox)})?.checked`), true)
    assert.equal(grant.policy.network, false); assert.deepEqual(grant.policy.budget_ids, policy.policy.budget_ids)
    assert.deepEqual(grant.policy.targets, [{ host: hub.node, workspace: workspace.workspace_id, root }])
    assert.equal((await call('teams/' + saved.id + '/activation-review', { team_revision: saved.revision, request_id: 'verify-authority-not-activation' })).activation, null)
    await click('核对激活条件')
    await wait(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === '确认激活此版本团队' && !button.disabled)`)
    await click('确认激活此版本团队')
    await wait(`document.querySelector('.kode-collab-team-activation')?.innerText.includes('已有激活确认记录')`)
    assert.equal((await call('teams/' + saved.id + '/activation')).active, true)
    assert.equal((await call('sessions')).sessions.length, sessionsBefore, 'activation alone does not dispatch work')
    const coordinatorPlan = await host.planCoordinatorStart({ team_id: saved.id, command_id: 'browser-coordinator-create', request_id: 'browser-coordinator-start', owner_session: 'browser-owner', session_id: 'browser-coordinator', workspace_id: workspace.workspace_id, task_tag: 'development' })
    assert.equal(coordinatorPlan.state, 'planned'); assert.equal(coordinatorPlan.dispatch_authorized, false)
    assert.equal(coordinatorPlan.command.start.target_id, 'local-model')
    assert.equal(coordinatorPlan.command.start.price_id, selectedTarget.internal_price_id)
    assert.equal(coordinatorPlan.ranking.candidates[0].capability_id, userCapability.id)
    assert.deepEqual((await call('budgets/' + budget.id + '/reservations')).reservations, [])
    assert.equal((await call('sessions')).sessions.length, sessionsBefore, 'planning cannot create sessions')
    const coordinatorCreations = await Promise.all([host.startCoordinator(coordinatorPlan.command), host.startCoordinator(coordinatorPlan.command)])
    assert.deepEqual(coordinatorCreations[0], coordinatorCreations[1])
    const coordinatorCreation = coordinatorCreations[0]
    assert.equal(coordinatorCreation.state, 'created')
    assert.deepEqual(await host.startCoordinator(coordinatorPlan.command), coordinatorCreation)
    assert.equal((await call('budgets/' + budget.id + '/reservations')).reservations.length, 1)
    assert.equal((await call('budgets/' + budget.id)).budget.reserved, 10)
    assert.equal((await call('sessions')).sessions.find(session => session.address.session_id === 'browser-coordinator').runtime, 'dsh')
    assert.equal((await call('operations/' + coordinatorCreation.request.operation.id)).state, 'active')
    const coordinatorHandle = host.handles.get('browser-coordinator')
    assert.ok(coordinatorHandle)
    const human = await call('conversations/' + saved.conversation_id + '/messages', { request_id: 'browser-team-requirement', content: 'Implement this requirement using the configured workflow.' })
    await onCoordinatorInput(human)
    const replyPath = 'conversations/' + saved.conversation_id + '/coordinator-replies/browser-coordinator-reply'
    const deadline = Date.now() + 10000
    let reply
    while (Date.now() < deadline) {
      reply = (await call(replyPath)).message
      if (reply) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(reply, 'native Coordinator must publish its receipt-backed reply')
    await coordinatorHandle.agent.whenIdle()
    assert.equal(reply.actor.kind, 'superagent'); assert.equal(reply.in_reply_to, human.id)
    const startedRun = (await call('conversations/' + saved.conversation_id + '/work-runs/requests/browser-work-run')).run
    assert.ok(startedRun); assert.equal(startedRun.owner.kind, 'superagent')
    assert.equal(startedRun.coordinator.source_message_id, human.id)
    assert.equal(startedRun.context.binding.id, 'local')
    assert.equal(startedRun.state, 'waiting_resource')
    for (const key of ['browser-coordinator-tool-1', 'browser-coordinator-tool-2']) assert.equal(profiles.binding('browser-coordinator').officialTools[key].home_reconciled, true)
    const coordinatorBudget = await call('budgets/' + budget.id)
    assert.equal(coordinatorBudget.label, '团队预算')
    assert.equal(coordinatorBudget.budget.spent, 1, 'cumulative usage is rounded once against configured internal prices')
    assert.equal(coordinatorBudget.budget.reserved, 9)
    const accounting = await call('operations/' + coordinatorCreation.request.operation.id + '/budget?attempt=1')
    assert.equal(accounting.reservation.charged, 1); assert.equal(accounting.reservation.finalized, false)
    const closeOperation = await call('operations/' + coordinatorCreation.request.operation.id)
    const closeInput = { operation_id: closeOperation.id, command: { request_id: 'browser-coordinator-finalize', attempt: closeOperation.attempt, epoch: closeOperation.epoch, price_id: selectedTarget.internal_price_id, settlement: 'internal_price' } }
    await assert.rejects(call('operations/' + closeOperation.id + '/coordinator-accounting', { ...closeInput.command, expected_revision: closeOperation.revision }), /exact reported operation/)
    await assert.rejects(host.closeCoordinator({ ...closeInput, command: { ...closeInput.command, price_id: 'foreign-price' } }), /price mismatch/)
    assert.equal((await call('operations/' + closeOperation.id + '/coordinator-close')).idle_close_ready, false)
    await assert.rejects(host.closeCoordinator({ ...closeInput, command: { ...closeInput.command, idle_only: true } }), /not ready for idle close/)
    assert.equal((await call('operations/' + closeOperation.id + '/coordinator-close')).intent, null)
    const closing = await host.closeCoordinator(closeInput)
    assert.equal(closing.state, 'closing'); assert.equal(closing.reason, 'pending_runs')
    assert.equal((await call('budgets/' + budget.id)).budget.reserved, 9)
    const nextHuman = await call('conversations/' + saved.conversation_id + '/messages', { request_id: 'request-during-close', content: 'Next requirement after this work.' })
    await assert.rejects(call('conversations/' + saved.conversation_id + '/messages/' + nextHuman.id + '/coordinator-input', { operation_id: closeOperation.id, control_revision: 1, attempt: closeOperation.attempt, epoch: closeOperation.epoch }), /Coordinator is closing/)
    assert.equal((await call('conversations/' + saved.conversation_id + '/messages/' + nextHuman.id + '/coordinator-input')).input, null)
    const controller = new WorkRunController(new AssignmentDispatchHost(host), { prepare: (assignment, options) => prepareWorkRunAssignment(host.execution, assignment, options) })
    assert.equal((await controller.advance(startedRun.id)).state, 'scheduled')
    const afterCapacity = await call('teams/' + saved.id + '/activation-review', { team_revision: saved.revision, request_id: 'capacity-after' })
    assert.equal(afterCapacity.resources.assignment_capacity_checks_complete, true)
    assert.deepEqual(afterCapacity.resources.assignment_capacity_issues, [])
    assert.deepEqual(afterCapacity.resources.targets[0].assignment_capacity.snapshot, { account_id: 'browser-account', revision: 1, max_active_assignments: 1, held: 0 })
    assert.equal(afterCapacity.resources.targets[0].assignment_capacity.eligible_for_execution, false)
    await click('重新核对激活条件')
    await wait(`document.querySelector('.kode-collab-account-capacity')?.innerText.includes('账号工作并发 0 / 1')`)


    const workerDeadline = Date.now() + 30000
    let progressed
    try {
      do {
        progressed = await controller.advance(startedRun.id)
        assert.ok(!['waiting_adapter', 'recovery_required', 'waiting_user', 'failed'].includes(progressed.state), JSON.stringify(progressed))
        if (progressed.state === 'completed') break
        assert.ok(Date.now() < workerDeadline, JSON.stringify(progressed))
        await new Promise(resolve => setTimeout(resolve, 25))
      } while (true)
      const completed = await call('work-runs/' + startedRun.id)
      assert.equal(completed.completion_authorized, true)
      await onRunCompleted(completed)
      assert.deepEqual(completed.stages.map(stage => stage.state), ['passed', 'passed', 'passed'])
      const implementation = await call('work-assignments/' + completed.stages[0].assignment_id)
      const taskWorkspace = implementation.execution_workspace.receipt
      assert.equal(taskWorkspace.repository, root)
      assert.notEqual(taskWorkspace.root, root)
      assert.equal(implementation.dispatch.command.cwd, taskWorkspace.root)
      assert.equal(taskWorkspace.scope.target.root, taskWorkspace.root)
      assert.equal(await readFile(join(taskWorkspace.root, 'implemented.txt'), 'utf8'), 'implemented')
      await assert.rejects(readFile(join(root, 'implemented.txt')), { code: 'ENOENT' })
      assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '# Selected fixture project\n')
      assert.equal(completed.delivery.integration_state, 'unintegrated')
      assert.equal(completed.delivery.original_workspace_modified, false)
      assert.equal((await call('assignment-capacities/browser-account')).held, 0)
      const finalBudget = (await call('budgets/' + budget.id)).budget
      assert.equal(finalBudget.spent, 4); assert.equal(finalBudget.reserved, 9)
      const reservations = (await call('budgets/' + budget.id + '/reservations')).reservations
      assert.equal(reservations.length, 4)
      assert.equal(reservations.filter(row => row.finalized && row.held === 0 && row.charged === 1).length, 3)

    } finally { await controller.close() }
    const updates = new CoordinatorUpdates(host.execution)
    try {
      const queued = await updates.scan()
      assert.equal(queued.length, 1); assert.equal(queued[0].state, 'queued')
      const deadline = Date.now() + 10000
      let finalReply
      while (Date.now() < deadline) {
        finalReply = (await call('conversations/' + saved.conversation_id + '/coordinator-replies/browser-final-result')).message
        if (finalReply) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.ok(finalReply, 'completed workflow must produce a receipt-backed Coordinator reply')
      await coordinatorHandle.agent.whenIdle()
      assert.equal(finalReply.actor.kind, 'superagent'); assert.equal(finalReply.in_reply_to, human.id)
      for (const key of ['browser-final-status', 'browser-final-publish']) assert.equal(profiles.binding('browser-coordinator').officialTools[key].home_reconciled, true)
      assert.deepEqual(await updates.scan(), [], 'consumed completion notice must not be resent')
      const messages = (await call('conversations/' + saved.conversation_id + '/messages')).items
      assert.deepEqual(messages.map(message => message.actor.kind), ['human', 'superagent', 'human', 'superagent'])
    } finally { await updates.close() }
    const coordinatorOperationPath = 'operations/' + coordinatorCreation.request.operation.id
    await onPendingCoordinatorClose?.()
    const recoveryDeadline = Date.now() + 10000
    while ((await call('budgets/' + budget.id)).budget.reserved !== 0) {
      assert.ok(Date.now() < recoveryDeadline, 'mounted Host must recover pending close without another caller request')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.deepEqual((await call('coordinator-closes/pending')).items, [])
    const liveCoordinator = await call(coordinatorOperationPath)
    const finalization = { request_id: 'browser-coordinator-finalize', attempt: liveCoordinator.attempt, epoch: liveCoordinator.epoch, expected_revision: liveCoordinator.revision, price_id: selectedTarget.internal_price_id, settlement: 'internal_price' }
    const closed = await Promise.all([host.closeCoordinator(closeInput), host.closeCoordinator(closeInput)])
    assert.deepEqual(closed[0], closed[1]); assert.equal(closed[0].state, 'closed')
    assert.equal(closed[0].execution_resumed, false)
    const reportedCoordinator = await call(coordinatorOperationPath)
    finalization.expected_revision = reportedCoordinator.revision
    const finalized = closed.map(value => value.accounting)
    assert.deepEqual(finalized[0], finalized[1])
    assert.equal(finalized[0].team_id, saved.id)
    assert.equal(finalized[0].reservation.finalized, true)
    assert.equal(finalized[0].reservation.held, 0)
    assert.equal(finalized[0].reservation.charged, 1)
    assert.equal(finalized[0].calls.length, 6)
    assert.equal(finalized[0].provider_cost_status, 'unconfirmed')
    assert.equal(finalized[0].completion_authorized, false)
    assert.equal((await call('budgets/' + budget.id)).budget.reserved, 0)
    assert.equal((await call('budgets/' + budget.id)).budget.spent, 4)
    assert.deepEqual(await call(coordinatorOperationPath + '/coordinator-accounting', finalization), finalized[0])
    await assert.rejects(call(coordinatorOperationPath + '/coordinator-accounting', { ...finalization, request_id: 'different-finalize' }), /identity conflict/)
    await onCoordinatorFinalized({ path: coordinatorOperationPath + '/coordinator-accounting', command: finalization, receipt: finalized[0], closeInput, closed: closed[0] })

    assert.equal(host.ctx.agents.get('browser-coordinator'), undefined)
    const storedFinal = (await call('conversations/' + saved.conversation_id + '/coordinator-replies/browser-final-result')).message
    assert.ok(storedFinal)
    assert.equal(storedFinal.actor.kind, 'superagent')
    await onSuccessorInput(nextHuman)
    host.coordinatorBootstrap.start()
    const successorDeadline = Date.now() + 15000
    let successorReply
    while (Date.now() < successorDeadline) {
      successorReply = (await call('conversations/' + saved.conversation_id + '/coordinator-replies/successor-reply')).message
      if (successorReply) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(successorReply, JSON.stringify(host.coordinatorBootstrap.results))
    const successor = host.handles.get('browser-coordinator')
    assert.ok(successor); await successor.agent.whenIdle()
    assert.equal(successorReply.in_reply_to, nextHuman.id)
    assert.equal(successorReply.control_revision, 2)
    const control = (await call('teams/' + saved.id + '/coordinator-control')).control
    assert.equal(control.revision, 2)
    assert.equal(control.worker.session_id, 'browser-coordinator', 'long-lived history is restored in the same native session')
    assert.notEqual(control.request.operation_id, closeOperation.id)
    assert.equal(profiles.binding('browser-coordinator').officialTools['successor-reply'].home_reconciled, true)
    const retainedInput = (await call('conversations/' + saved.conversation_id + '/messages/' + nextHuman.id + '/coordinator-input')).input
    assert.equal(retainedInput.request.operation_id, control.request.operation_id)
    assert.deepEqual(await host.coordinatorBootstrap.scan(), [], 'live successor must not be started twice')
    const idleCloseDeadline = Date.now() + 10000
    while ((await call('budgets/' + budget.id)).budget.reserved && Date.now() < idleCloseDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const idleState = await call('operations/' + control.request.operation_id + '/coordinator-close')
    assert.equal(idleState.intent.request.idle_only, true, 'mounted service initiates successor close without an owner command')
    assert.equal(idleState.operation.state, 'reported')
    assert.equal((await call('budgets/' + budget.id)).budget.reserved, 0)
    assert.equal((await call('budgets/' + budget.id)).budget.spent, 5)










    assert.equal((await call(`budgets/${funding.budget.id}/reservations`)).reservations.length, 1)
    assert.deepEqual(await page.evaluate('fixtureErrors'), [])
    return created.request.session_id
  } finally {
    await browser?.close()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await rm(browserProfile, { recursive: true, force: true })
  }
}

import { planBuilderStart } from '../src/builder-start-plan.js'
import { initializeBuilderInterview } from '../src/builder-initialize.js'
import { confirmFunding } from '../packages/collab/builder-funding.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { isolatedHub } from './support/isolated-hub.js'
test('Builder funding confirmation atomically creates minimal grant and internal team budget', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('builder-funding')
  try {
    const workspace = { host_id: hub.node, workspace_id: 'project', root_ref: '/fixture/project' }
    const draft = { id: 'draft', request_id: 'create', expected_revision: 0, revoked: false, interview: { purpose: 'Create team', workspace_refs: [workspace], answers: {}, questions: [], proposed_team: null } }
    const base = '/api/v1/messaging/'
    await hub.client.call(base + 'superagents/drafts', draft)
    await hub.client.call(base + 'superagents/drafts/draft/selection', { request_id: 'choose', expected_revision: 0, draft_revision: 1, selection: { profile_id: 'runtime', provider: 'provider', model: 'model', effort: null, workspace } })
    const path = base + 'superagents/drafts/draft/funding'
    assert.equal((await hub.client.call(path)).record, null)
    const at = Date.now()
    const command = { request_id: 'confirm', draft_revision: 1, selection_revision: 1, unit: 'credits', limit: 100, starts_at: at - 1000, ends_at: at + 60000, input_per_million: 10, cached_per_million: 2, output_per_million: 20 }
    const digest = createHash('sha256').update(JSON.stringify([hub.node, 'draft', command.request_id])).digest('hex').slice(0, 32)
    const budgetPath = base + `budgets/builder-${digest}-budget`
    await assert.rejects(hub.client.call(path, { ...command, output_per_million: 4000000000000001 }), /invalid internal price/)
    assert.equal((await hub.client.call(path)).record, null)
    await assert.rejects(hub.client.call(budgetPath), /404|unknown|no rows/, 'price failure rolls back the preceding budget write')
    await assert.rejects(hub.client.call(path, { ...command, selection_revision: 2 }), /revision conflict/)
    await assert.rejects(hub.client.call(path, { ...command, capabilities: ['workspace_write'] }), /400|422/)
    const worker = await hub.client.call(base + 'sessions', { session_id: 'worker', title: 'worker', runtime: 'external' })
    const agent = hub.client.forSession(worker.owner_token)
    await assert.rejects(agent.call(path), /403/); await assert.rejects(agent.call(path, command), /403/)
    let local, loseReply = true
    const sent = []
    const storage = { async reserve(_, value) { return local ??= value }, async save(_, value) { local = value } }
    const selection = (await hub.client.call(base + 'superagents/drafts/draft/selection')).record
    const request = async input => {
      const { draft_id, ...body } = input; assert.equal(draft_id, 'draft'); sent.push(body)
      const receipt = await hub.client.call(path, body)
      if (loseReply) throw Error('committed reply lost')
      return receipt
    }
    const currentDraft = { id: 'draft', home_hub: hub.node, revision: 1 }
    await assert.rejects(confirmFunding({ storage, draft: currentDraft, command, selection, request, uuid: () => 'confirm' }), /reply lost/)
    loseReply = false
    const result = await confirmFunding({ storage, draft: currentDraft, command: { ...command, limit: 999 }, selection, request, uuid: () => 'replacement' })
    assert.deepEqual(sent[0], sent[1]); assert.equal(local.state, 'accepted')
    assert.equal(result.label, '团队预算'); assert.equal(result.execution_started, false); assert.equal(result.activation_performed, false)
    assert.equal(result.budget.limit, 100); assert.equal(result.budget.spent, 0); assert.equal(result.budget.reserved, 0)
    assert.equal(result.price.model, 'model'); assert.equal(result.price.model_policy, 'requested_model')
    assert.deepEqual(result.grant.policy.capabilities, ['read', 'builder_draft_write'])
    assert.equal(result.grant.policy.network, false); assert.equal(result.grant.policy.tools.length, 7)
    assert.deepEqual(result.grant.policy.budget_ids, [result.budget.id])
    assert.deepEqual(result.grant.policy.targets, [{ host: hub.node, workspace: 'project', root: '/fixture/project' }])
    assert.deepEqual(await hub.client.call(path, command), result)
    await assert.rejects(hub.client.call(path, { ...command, request_id: 'second' }), /already configured/)
    await assert.rejects(hub.client.call(path, { ...command, limit: 200 }), /already configured/)
    const profile = { id: 'runtime', name: 'Runtime', type: 'dsh' }
    const runtime = { host: hub.node, client: hub.client, profiles: { get: () => profile }, ctx: { get: () => ({ list: () => [{ id: 'project', path: '/fixture/project' }] }), llm: { resolveCallConfig: async config => config } } }
    const intent = { draft_id: 'draft', command_id: 'start', request_id: 'start', owner_session: 'owner', session_id: 'builder', team_id: 'candidate', amount: 20, limit_ids: [], unknown_quota: 'team_budget' }
    await assert.rejects(planBuilderStart(runtime, intent), /account binding unavailable/)
    await hub.client.call(base + 'resource-accounts', { id: 'account', expected_epoch: 0, enabled: true })
    await hub.client.call(base + 'resource-bindings', { host: hub.node, profile: 'runtime', account_id: 'account', account_epoch: 1, expected_revision: 0 })
    await assert.rejects(planBuilderStart(runtime, { ...intent, amount: 101 }), /budget unavailable/)
    const plan = await planBuilderStart(runtime, intent)
    assert.equal(plan.dispatch_authorized, false); assert.equal(plan.command.selection_revision, 1)
    assert.equal((await hub.client.call(budgetPath)).budget.reserved, 0, 'planning cannot reserve funds')
    const initialized = await initializeBuilderInterview(hub.client, plan.command.start)
    const prepared = await hub.client.call(base + 'superagents/builder-starts', { ...plan.command.start, draft_revision: initialized.revision, selection_ref: { revision: plan.command.selection_revision, draft_revision: plan.command.start.draft_revision, provider: plan.command.provider } })
    assert.equal(prepared.bundle.operation.state, 'prepared')
    assert.equal((await hub.client.call(budgetPath)).budget.reserved, 20, 'confirmed funding can feed existing atomic start')
    await hub.client.call(base + 'superagents/drafts', { ...draft, request_id: 'edit', expected_revision: 2, revoked: true })
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(path, command), result)
    assert.deepEqual((await hub.client.call(path)).record, result)
    assert.deepEqual((await hub.client.call(base + 'teams')).items, [])
  } finally { await hub.close() }
})

test('funding owner bridge rejects authority injection and ambiguous numeric amounts', async () => {
  const { registerBuilderFunding } = await import('../src/builder-funding-route.js')
  const { Readable } = await import('node:stream')
  let route, status, body, calls = [], kind = 'worker'
  registerBuilderFunding({ webServer: { register: value => { route = value } }, connection: { admit: () => ({ peer: { principal: { kind } } }) } }, { backendClient: { async call(...args) { calls.push(args); return { recorded: true } } } })
  const send = async command => {
    const req = Readable.from([JSON.stringify(command)]); Object.assign(req, { method: 'POST', headers: { 'content-type': 'application/json' }, url: '/api/kode/builder/funding' })
    await route.handler(req, { writeHead(code) { status = code }, end(value) { body = JSON.parse(value) } })
  }
  const command = { draft_id: 'draft', request_id: 'confirm', draft_revision: 1, selection_revision: 1, unit: 'credits', limit: 100, starts_at: 1, ends_at: 10, input_per_million: 1, cached_per_million: 1, output_per_million: 1 }
  await send(command); assert.equal(status, 403); kind = 'owner'
  for (const patch of [{ capabilities: ['workspace_write'] }, { limit: 0.5 }, { output_per_million: '1' }, { selection_revision: 0 }, { draft_id: '../draft' }]) { await send({ ...command, ...patch }); assert.equal(status, 400) }
  assert.equal(calls.length, 0)
  await send(command); assert.equal(status, 200); assert.deepEqual(body, { recorded: true })
  assert.equal(calls[0][0], '/api/v1/messaging/superagents/drafts/draft/funding'); assert.equal(calls[0][1].draft_id, undefined)
})

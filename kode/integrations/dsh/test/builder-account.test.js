import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
test('Builder account grouping is atomic, owner-only and recoverable after selection changes and restart', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('builder-account')
  try {
    const base = '/api/v1/messaging/', path = base + 'superagents/drafts/draft/account'
    const workspace = { host_id: hub.node, workspace_id: 'project', root_ref: '/fixture/project' }
    const draft = { id: 'draft', request_id: 'create', expected_revision: 0, revoked: false, interview: { purpose: 'Create team', workspace_refs: [workspace], answers: {}, questions: [], proposed_team: null } }
    await hub.client.call(base + 'superagents/drafts', draft)
    const selection = { request_id: 'select', expected_revision: 0, draft_revision: 1, selection: { profile_id: 'runtime', provider: 'provider', model: 'model', effort: null, workspace } }
    await hub.client.call(base + 'superagents/drafts/draft/selection', selection)
    const command = { request_id: 'confirm', draft_revision: 1, selection_revision: 1, account_id: 'account', account_epoch: 1, create_account: true, expected_binding_revision: 0 }
    await assert.rejects(hub.client.call(path, { ...command, expected_binding_revision: 9 }), /revision conflict/)
    await assert.rejects(hub.client.call(base + 'resource-accounts/account'), /404|missing/)
    assert.equal((await hub.client.call(path + '-requests/confirm')).receipt, null)
    await assert.rejects(hub.client.call(path, { ...command, selection_revision: 2 }), /revision conflict/)
    const worker = await hub.client.call(base + 'sessions', { session_id: 'worker', title: 'worker', runtime: 'external' })
    const agent = hub.client.forSession(worker.owner_token)
    await assert.rejects(agent.call(path, command), /403/)
    const [first, second] = await Promise.all([hub.client.call(path, command), hub.client.call(path, command)])
    assert.deepEqual(first, second); assert.equal(first.binding.revision, 1); assert.equal(first.quota_status, 'not_checked'); assert.equal(first.execution_started, false)
    await assert.rejects(hub.client.call(path, { ...command, account_id: 'different' }), /identity conflict/)
    await hub.client.call(base + 'superagents/drafts/draft/selection', { ...selection, expected_revision: 1, request_id: 'changed', selection: { ...selection.selection, profile_id: 'other' } })
    await hub.client.call(base + 'superagents/drafts', { ...draft, request_id: 'revoke', expected_revision: 1, revoked: true })
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(path, command), first)
    assert.deepEqual((await hub.client.call(path + '-requests/confirm')).receipt, first)
    assert.deepEqual((await hub.client.call(base + 'teams')).items, [])
  } finally { await hub.close() }
})

test('Builder account bridge bounds owner input and preserves exact confirmation', async () => {
  const { registerBuilderAccount } = await import('../src/builder-account-route.js')
  const { Readable } = await import('node:stream')
  let route, kind = 'agent', status, result, calls = []
  registerBuilderAccount({ webServer: { register(value) { route = value } }, connection: { admit: () => ({ peer: { principal: { kind } } }) } }, { backendClient: { async call(...args) { calls.push(args); return { receipt: null } } } })
  const send = async (body, method = 'POST', url = '/api/kode/builder/account') => {
    const req = Readable.from(body === null ? [] : [JSON.stringify(body)]); Object.assign(req, { method, url, headers: { 'content-type': 'application/json' } })
    await route.handler(req, { writeHead(value) { status = value }, end(value) { result = JSON.parse(value) } })
  }
  const command = { draft_id: 'draft', request_id: 'confirm', draft_revision: 1, selection_revision: 1, account_id: 'account', account_epoch: 1, create_account: true, expected_binding_revision: 0 }
  await send(command); assert.equal(status, 403); kind = 'owner'
  for (const patch of [{ expected_binding_revision: -1 }, { account_epoch: 1.5 }, { selection_revision: 0 }, { create_account: 'yes' }, { host: 'foreign' }]) { await send({ ...command, ...patch }); assert.equal(status, 400) }
  assert.equal(calls.length, 0)
  await send(command); assert.equal(status, 200)
  const { draft_id, ...body } = command
  assert.deepEqual(calls[0], ['/api/v1/messaging/superagents/drafts/draft/account', body])
  await send(null, 'GET', '/api/kode/builder/account?draft_id=draft&request_id=confirm'); assert.equal(status, 200); assert.deepEqual(result, { receipt: null })
  assert.equal(calls[1][0], '/api/v1/messaging/superagents/drafts/draft/account-requests/confirm')
  await send(null, 'GET', '/api/kode/builder/account?draft_id=draft&request_id=confirm&extra=1'); assert.equal(status, 400)
})

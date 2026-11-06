/** Real isolated Hub + real fixture process; no provider/model invocation. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BackendClient } from '../src/backend-client.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { AgentRuntimeAdapter, profileRoute } from '../src/agent-runtime.js'
import { acquireOperationLease } from '../src/operation-lease.js'
const url = process.env.KODE_TEST_BACKEND_URL, tokenFile = process.env.KODE_TEST_TOKEN_FILE

test('Hub cancellation fences an actual native fixture turn through the bound lease', { skip: !url || !tokenFile }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-operation-runtime-'))
  const admin = new BackendClient(url, (await readFile(tokenFile, 'utf8')).trim())
  const node = await admin.call('/api/v1/messaging/node')
  const id = `operation-worker-${randomUUID()}`
  const registration = await admin.call('/api/v1/messaging/sessions', { session_id: id, title: 'Operation fixture', runtime: 'external' })
  const worker = admin.forSession(registration.owner_token)
  const operation = await admin.call('/api/v1/messaging/operations', { owner_session: 'fixture-owner', request_key: randomUUID(), worker: { node_id: node.node_id, session_id: id } })
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'fixture', name: 'Fixture', type: 'codex', executable: process.execPath, args: [fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))] }])
  await profiles.bind(id, 'fixture')
  await profiles.patchBinding(id, { managedOperation: { id: operation.id, attempt: operation.attempt, epoch: operation.epoch }, operationClosed: false })
  const events = []
  const agent = { id, session: { header: { cwd: root }, append() {} }, ctx: { parallel: async () => {}, get: name => name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'read-only', workspaceRoot: root }) } : undefined, tools: { execute: async () => { throw new Error('unexpected tool') } } } }
  const ctx = { agents: { get: () => agent }, sessionProjections: { stateOf: () => ({ lastTurn: 1, lastStepBoundary: { kind: 'start', step: 1 } }) }, get: name => name === 'kodeOperationLeases' ? { acquire: (_agent, binding, signal) => acquireOperationLease(worker, binding, { node_id: node.node_id, session_id: id }, { signal, leaseMs: 3000 }) } : undefined }
  const adapter = new AgentRuntimeAdapter(ctx, profiles, { recordNative: (_, event) => events.push(event) })
  let cancel
  try {
    await assert.rejects(async () => {
      for await (const _chunk of adapter.stream({ sessionId: id, provider: profileRoute('fixture'), model: 'fixture', signal: AbortSignal.timeout(8000), messages: [{ id: 'leased-input', role: 'user', content: [{ type: 'text', text: 'WAIT' }] }], onNativeTurnReady: () => {
        cancel ??= (async () => {
          const current = await admin.call(`/api/v1/messaging/operations/${operation.id}`)
          return admin.call(`/api/v1/messaging/operations/${operation.id}`, { attempt: current.attempt, epoch: current.epoch, expected_revision: current.revision, action: { kind: 'cancel' } })
        })()
        cancel.catch(() => {})
      } })) { /* drain until cancellation */ }
    }, /Operation lease identity or state changed/)
    await cancel
    assert.equal(profiles.binding(id).operationClosed, true)
    assert.equal(profiles.binding(id).lastOutcome, 'uncertain')
    assert.ok(events.some(row => row.event.method === 'kode/process_stop' && row.event.params.leader_exited))
    assert.equal((await admin.call(`/api/v1/messaging/operations/${operation.id}`)).state, 'cancelling', 'process exit alone cannot attest stopped')
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }) }
})

test('budgeted operation lease refuses unfunded work and aborts admission after settlement', { skip: !url || !tokenFile }, async () => {
  const admin = new BackendClient(url, (await readFile(tokenFile, 'utf8')).trim())
  const { node_id } = await admin.call('/api/v1/messaging/node')
  const session_id = `budget-worker-${randomUUID()}`
  const registration = await admin.call('/api/v1/messaging/sessions', { session_id, title: 'Budget fixture', runtime: 'external' })
  const worker = admin.forSession(registration.owner_token)
  const operation = await admin.call('/api/v1/messaging/operations', { owner_session: 'fixture-owner', request_key: randomUUID(), worker: { node_id, session_id }, budget_required: true })
  const binding = { id: operation.id, attempt: operation.attempt, epoch: operation.epoch }
  await assert.rejects(acquireOperationLease(worker, binding, { node_id, session_id }, { leaseMs: 3000 }))
  const id = `budget-${randomUUID()}`, hold = `hold-${randomUUID()}`, now = Date.now()
  await admin.call('/api/v1/messaging/budgets', { id, scope: 'team', scope_id: 'fixture-team', unit: 'credits', limit: 100, starts_at: now - 1000, ends_at: now + 60000, expected_revision: 0 })
  await admin.call('/api/v1/messaging/budget-reservations', { id: hold, budget_ids: [id], amount: 50, unit: 'credits', operation_id: operation.id })
  const attachment = { attempt: operation.attempt, expected_revision: operation.revision, reservation_id: hold }
  await assert.rejects(worker.call(`/api/v1/messaging/operations/${operation.id}/budget`, attachment))
  await admin.call(`/api/v1/messaging/operations/${operation.id}/budget`, attachment)
  const lease = await acquireOperationLease(worker, binding, { node_id, session_id }, { leaseMs: 3000 })
  try {
    await lease.assertActive()
    await admin.call(`/api/v1/messaging/budget-reservations/${hold}/settle`, { event_id: 'final', expected_revision: 1, total_charge: 30, finalized: true, basis: 'reported' })
    await assert.rejects(lease.assertActive(), /budget is not available/)
    assert.equal(lease.signal.aborted, true)
    const budget = await admin.call(`/api/v1/messaging/budgets/${id}`)
    assert.equal(budget.available, 70)
  } finally { lease.dispose() }
})

test('budgeted native fixture usage survives lost Hub response and Host restart without double charge', { skip: !url || !tokenFile }, async () => {
  const { UsageOutbox } = await import('../src/usage-outbox.js')
  const root = await mkdtemp(join(tmpdir(), 'kode-metered-runtime-'))
  const admin = new BackendClient(url, (await readFile(tokenFile, 'utf8')).trim())
  const { node_id } = await admin.call('/api/v1/messaging/node')
  const id = `meter-worker-${randomUUID()}`, budget = `budget-${randomUUID()}`, hold = `hold-${randomUUID()}`, price = `price-${randomUUID()}`
  const registration = await admin.call('/api/v1/messaging/sessions', { session_id: id, title: 'Meter fixture', runtime: 'external' })
  const worker = admin.forSession(registration.owner_token)
  const op = await admin.call('/api/v1/messaging/operations', { owner_session: 'fixture-owner', request_key: randomUUID(), worker: { node_id, session_id: id }, budget_required: true })
  const now = Date.now()
  await admin.call('/api/v1/messaging/budgets', { id: budget, scope: 'team', scope_id: 'fixture-team', unit: 'credits', limit: 100, starts_at: now - 1000, ends_at: now + 60000, expected_revision: 0 })
  await admin.call('/api/v1/messaging/budget-reservations', { id: hold, budget_ids: [budget], amount: 50, unit: 'credits', operation_id: op.id })
  await admin.call('/api/v1/messaging/price-versions', { id: price, model: 'fixture', unit: 'credits', model_policy: 'requested_model', input_per_million: 1000000, cached_per_million: 1000000, output_per_million: 1000000 })
  await admin.call(`/api/v1/messaging/budget-reservations/${hold}/pricing`, { price_id: price })
  await admin.call(`/api/v1/messaging/operations/${op.id}/budget`, { attempt: op.attempt, expected_revision: op.revision, reservation_id: hold })
  await assert.rejects(worker.call(`/api/v1/messaging/operations/${op.id}/budget?attempt=${op.attempt}`))
  const path = join(root, 'profiles.json')
  const profiles = await new AgentProfiles(path).open([{ id: 'fixture', name: 'Fixture', type: 'codex', executable: process.execPath, args: [fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))], env: { KODE_FIXTURE_USAGE: '1' } }])
  await profiles.bind(id, 'fixture')
  await profiles.patchBinding(id, { managedOperation: { id: op.id, attempt: op.attempt, epoch: op.epoch, budget_required: true }, operationClosed: false })
  let posts = 0, offline = false
  const lossy = { call: async (path, body, signal) => {
    if (offline) throw new Error('fixture disconnected')
    const result = await admin.call(path, body, signal)
    if (path === '/api/v1/messaging/metered-usage' && body) { posts++; offline = true; throw new Error('fixture response lost after commit') }
    return result
  } }
  let outbox = new UsageOutbox(lossy, profiles)
  const agent = { id, session: { header: { cwd: root }, append() {} }, ctx: { parallel: async () => {}, get: name => name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'read-only', workspaceRoot: root }) } : undefined, tools: { execute: async () => { throw new Error('unexpected tool') } } } }
  const ctx = { agents: { get: () => agent }, sessionProjections: { stateOf: () => ({ lastTurn: 1, lastStepBoundary: { kind: 'start', step: 1 } }) }, get: name => name === 'kodeOperationLeases' ? { acquire: (_agent, binding, signal) => acquireOperationLease(worker, binding, { node_id, session_id: id }, { signal, leaseMs: 10000 }) } : undefined }
  const adapter = new AgentRuntimeAdapter(ctx, profiles, { recordNative() {}, usageOutbox: outbox })
  try {
    for await (const _ of adapter.stream({ sessionId: id, provider: profileRoute('fixture'), model: 'fixture', signal: AbortSignal.timeout(10000), messages: [{ id: 'meter-input', role: 'user', content: [{ type: 'text', text: 'fixture task' }] }] })) {}
    await outbox.tick(); await outbox.close()
    assert.equal(posts, 1)
    const before = await admin.call(`/api/v1/messaging/budgets/${budget}`)
    assert.equal(before.budget.spent, 13)
    const reopened = await new AgentProfiles(path).open()
    outbox = new UsageOutbox(admin, reopened)
    await outbox.tick()
    const row = reopened.binding(id).usageOutbox[`${op.id}:${op.attempt}`]
    assert.equal(row.done, true)
    assert.equal(row.receipt.estimated, true)
    assert.equal(row.receipt.attribution.kind, 'requested_model')
    assert.equal(row.receipt.reservation.finalized, false)
    assert.equal((await admin.call(`/api/v1/messaging/budgets/${budget}`)).budget.spent, 13)
  } finally { await adapter.close(); await outbox.close(); await rm(root, { recursive: true, force: true }) }
})

test('Hub resource policy denies foreign edits and revokes admission when provider exhausts', { skip: !url || !tokenFile }, async () => {
  const admin = new BackendClient(url, (await readFile(tokenFile, 'utf8')).trim())
  const { node_id } = await admin.call('/api/v1/messaging/node')
  const id = `resource-worker-${randomUUID()}`, profile = `profile-${randomUUID()}`, account = `account-${randomUUID()}`
  const registered = await admin.call('/api/v1/messaging/sessions', { session_id: id, title: 'Resource fixture', runtime: 'external' })
  const worker = admin.forSession(registered.owner_token)
  const op = await admin.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: randomUUID(), worker: { node_id, session_id: id }, resource_required: true })
  await admin.call('/api/v1/messaging/resource-accounts', { id: account, expected_epoch: 0, enabled: true })
  await admin.call('/api/v1/messaging/resource-bindings', { host: node_id, profile, account_id: account, account_epoch: 1, expected_revision: 0 })
  const policy = { host: node_id, profile, account_id: account, account_epoch: 1, binding_revision: 1, limit_ids: ['tokens'], unknown_quota: 'require_fresh' }
  await assert.rejects(worker.call('/api/v1/messaging/resource-admission', policy), /403/)
  assert.equal((await admin.call('/api/v1/messaging/resource-admission', policy)).allowed, false)
  const now = Date.now()
  const sample = { host: node_id, profile, account_id: account, account_epoch: 1, binding_revision: 1, observed_at_ms: now, truncated: false, buckets: [{ limit_id: 'tokens', observed_at_ms: now, valid_until_ms: now + 60000, windows: [{ window_id: 'primary', used_percent: 20, resets_at_ms: now + 120000, window_minutes: 60 }] }] }
  await admin.call('/api/v1/messaging/quota-snapshots', sample)
  assert.equal((await admin.call('/api/v1/messaging/resource-admission', policy)).reason, 'fresh_quota')
  const attachment = { attempt: 1, expected_revision: op.revision, policy }
  await assert.rejects(worker.call(`/api/v1/messaging/operations/${op.id}/resource`, attachment), /403/)
  const assigned = await admin.call(`/api/v1/messaging/operations/${op.id}/resource`, attachment)
  const legacy = { attempt: op.attempt, epoch: op.epoch, expected_revision: assigned.revision, action: { kind: 'claim', lease_ms: 10000 } }
  await assert.rejects(worker.call(`/api/v1/messaging/operations/${op.id}`, legacy), /explicit resource acknowledgement required/)
  await assert.rejects(worker.call(`/api/v1/messaging/operations/${op.id}`, { ...legacy, action: { kind: 'claim_resource', lease_ms: 10000, resource: { profile, account_epoch: 1, binding_revision: 999 } } }), /acknowledgement mismatch/)
  assert.equal((await admin.call(`/api/v1/messaging/operations/${op.id}`)).revision, assigned.revision)
  const binding = { id: op.id, attempt: op.attempt, epoch: op.epoch }
  await assert.rejects(acquireOperationLease(worker, binding, { node_id, session_id: id, profile_id: 'wrong' }), /resource does not match/)
  const lease = await acquireOperationLease(worker, binding, { node_id, session_id: id, profile_id: profile }, { leaseMs: 10000 })
  try {
    sample.observed_at_ms++; sample.buckets[0].observed_at_ms++; sample.buckets[0].windows[0].used_percent = 100
    await admin.call('/api/v1/messaging/quota-snapshots', sample)
    assert.equal((await admin.call('/api/v1/messaging/resource-admission', policy)).reason, 'provider_exhausted')
    await assert.rejects(lease.assertActive(), /resource is not available/)
    assert.equal(lease.signal.aborted, true)
  } finally { lease.dispose() }
})

/** End-to-end internal accounting stays on home; only trusted Host collectors submit. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { isolatedHub, pairHubs } from './support/isolated-hub.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { AgentRuntimeAdapter, profileRoute } from '../src/agent-runtime.js'
import { acquireOperationLease } from '../src/operation-lease.js'
import { UsageOutbox } from '../src/usage-outbox.js'

test('remote native usage recovers lost response on home without giving Workers accounting authority', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 40000 }, async () => {
  let home, remote, adapter, outbox
  try {
    home = await isolatedHub('accounting-home'); remote = await isolatedHub('accounting-worker'); await pairHubs(home, remote)
    const id = 'worker'
    const registration = await remote.client.call('/api/v1/messaging/sessions', { session_id: id, title: 'Metered remote fixture', runtime: 'external' })
    const worker = remote.client.forSession(registration.owner_token)
    const op = await home.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'metered', worker: { node_id: remote.node, session_id: id }, budget_required: true })
    const now = Date.now()
    await home.client.call('/api/v1/messaging/budgets', { id: 'team', scope: 'team', scope_id: 'team', unit: 'credits', limit: 100, starts_at: now - 1000, ends_at: now + 60000, expected_revision: 0 })
    await home.client.call('/api/v1/messaging/budget-reservations', { id: 'hold', budget_ids: ['team'], amount: 50, unit: 'credits', operation_id: op.id })
    await home.client.call('/api/v1/messaging/price-versions', { id: 'price', model: 'fixture', unit: 'credits', model_policy: 'requested_model', input_per_million: 1000000, cached_per_million: 1000000, output_per_million: 1000000 })
    await home.client.call('/api/v1/messaging/budget-reservations/hold/pricing', { price_id: 'price' })
    await home.client.call(`/api/v1/messaging/operations/${op.id}/budget`, { attempt: op.attempt, expected_revision: op.revision, reservation_id: 'hold' })
    const path = `/api/v1/messaging/operation-accounting-relay/${home.node}`
    const envelope = action => ({ operation_id: op.id, worker_session: id, command: null, accounting: { attempt: op.attempt, action } })
    await assert.rejects(worker.call(path, envelope({ kind: 'context' })), /403/)
    await assert.rejects(worker.call(`/api/v1/messaging/operation-relay/${home.node}`, envelope({ kind: 'context' })), /403/)
    const context = await remote.client.call(path, envelope({ kind: 'context' }))
    assert.equal(context.price.id, 'price')
    const foreign = { event_id: 'bad', reservation_id: 'foreign', expected_revision: 1, model: 'fixture', input_tokens: 1, cached_input_tokens: 0, output_tokens: 0, attribution: { kind: 'requested_model', rerouted: false, cache_write_input_tokens: 0 } }
    await assert.rejects(remote.client.call(path, envelope({ kind: 'usage', usage: foreign })), /foreign usage reservation/)
    await assert.rejects(remote.client.call(path, envelope({ kind: 'usage', usage: { ...foreign, reservation_id: 'hold', attribution: { kind: 'admin_attested' } } })), /explicit internal attribution/)
    await assert.rejects(remote.client.call(path, { ...envelope({ kind: 'context' }), worker_session: 'stranger' }), /foreign remote operation/)
    const profilePath = join(remote.root, 'profiles.json')
    const profiles = await new AgentProfiles(profilePath).open([{ id: 'fixture', name: 'Fixture', type: 'codex', executable: process.execPath, args: [fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))], env: { KODE_FIXTURE_USAGE: '1' } }])
    await profiles.bind(id, 'fixture')
    const binding = { id: op.id, attempt: op.attempt, epoch: op.epoch, home_node: home.node, budget_required: true }
    await profiles.patchBinding(id, { managedOperation: binding, operationClosed: false })
    let posts = 0, disconnected = false
    const lossy = { call: async (url, body, signal) => {
      if (disconnected) throw new Error('fixture collector offline')
      const result = await remote.client.call(url, body, signal)
      if (body?.accounting?.action.kind === 'usage') { posts++; disconnected = true; throw new Error('fixture usage response lost') }
      return result
    } }
    outbox = new UsageOutbox(lossy, profiles)
    const agent = { id, session: { header: { cwd: remote.root }, append() {} }, ctx: { parallel: async () => {}, get: name => name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'read-only', workspaceRoot: remote.root }) } : undefined, tools: { execute: async () => { throw new Error('unexpected tool') } } } }
    const ctx = { agents: { get: () => agent }, sessionProjections: { stateOf: () => ({ lastTurn: 1, lastStepBoundary: { kind: 'start', step: 1 } }) }, get: name => name === 'kodeOperationLeases' ? { acquire: (_agent, binding, signal) => acquireOperationLease(worker, binding, { node_id: remote.node, session_id: id }, { signal, leaseMs: 12000 }) } : undefined }
    adapter = new AgentRuntimeAdapter(ctx, profiles, { recordNative() {}, usageOutbox: outbox })
    for await (const _ of adapter.stream({ sessionId: id, provider: profileRoute('fixture'), model: 'fixture', signal: AbortSignal.timeout(20000), messages: [{ id: 'input', role: 'user', content: [{ type: 'text', text: 'fixture work' }] }] })) {}
    await outbox.tick(); await outbox.close()
    assert.equal(posts, 1)
    const submittedEvent = profiles.binding(id).usageOutbox[outbox.key(binding)].command.event_id
    assert.equal((await home.client.call('/api/v1/messaging/budgets/team')).budget.spent, 13)
    await assert.rejects(remote.client.call('/api/v1/messaging/budgets/team'))
    // Restart the home authority itself; the remote collector reopens only its persisted queue.
    await home.stop('SIGKILL'); await home.start()
    const reopened = await new AgentProfiles(profilePath).open()
    outbox = new UsageOutbox(remote.client, reopened)
    await outbox.tick()
    const row = reopened.binding(id).usageOutbox[outbox.key(binding)]
    assert.equal(row.done, true)
    assert.equal(row.home_node, home.node)
    assert.equal(row.receipt.reservation.charged, 13)
    assert.equal(row.receipt.reservation.finalized, false)
    assert.equal(row.receipt.attribution.kind, 'requested_model')
    assert.equal((await home.client.call('/api/v1/messaging/budgets/team')).budget.spent, 13)
    const other = await home.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'other', worker: { node_id: remote.node, session_id: id }, budget_required: true })
    await home.client.call('/api/v1/messaging/budget-reservations', { id: 'other-hold', budget_ids: ['team'], amount: 10, unit: 'credits', operation_id: other.id })
    await home.client.call(`/api/v1/messaging/operations/${other.id}/budget`, { attempt: 1, expected_revision: other.revision, reservation_id: 'other-hold' })
    await assert.rejects(remote.client.call(path, { operation_id: other.id, worker_session: id, command: null, accounting: { attempt: 1, action: { kind: 'receipt', event_id: submittedEvent } } }), /foreign usage receipt/)
    // Changing only the attempt cannot read another attempt's reservation/receipt.
    await assert.rejects(remote.client.call(path, { ...envelope({ kind: 'context' }), accounting: { attempt: 2, action: { kind: 'context' } } }), /unknown attempt accounting binding/)
  } finally { await adapter?.close(); await outbox?.close(); await home?.close(); await remote?.close() }
})

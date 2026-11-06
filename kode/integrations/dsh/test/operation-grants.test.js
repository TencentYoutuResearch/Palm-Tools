import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
import { acquireOperationLease } from '../src/operation-lease.js'

test('bound operation grant fences claims, renewal and official admission after revocation', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let hub, lease
  try {
    hub = await isolatedHub('operation-grant')
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const policy = { id: 'grant', team_id: 'team', enabled: true, expires_at: Date.now() + 12000, targets: [{ host: hub.node, workspace: 'workspace', root: '/srv/fixture' }], capabilities: ['read'], tools: ['read'], network: false, budget_ids: [] }
    await hub.client.call('/api/v1/messaging/team-grants', { expected_revision: 0, policy })
    const op = await hub.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'grant', grant_required: true, worker: { node_id: hub.node, session_id: 'worker' } })
    const binding = { grant_id: 'grant', attempt: 1, epoch: 1, scope: { team_id: 'team', revision: 1, target: policy.targets[0], capabilities: ['read'], tools: ['read'], network: false, budget_ids: [] } }
    const path = `/api/v1/messaging/operations/${op.id}`
    await assert.rejects(worker.call(path, { attempt: 1, epoch: 1, expected_revision: 1, action: { kind: 'claim', lease_ms: 3000 } }), /grant missing/)
    await assert.rejects(worker.call(`${path}/grant`, { expected_revision: 1, binding }), /403/)
    const bound = await hub.client.call(`${path}/grant`, { expected_revision: 1, binding })
    assert.equal(bound.grant_required, true)
    assert.equal((await hub.client.call(`${path}/grant`, { expected_revision: 1, binding })).revision, bound.revision)
    await assert.rejects(hub.client.call(`${path}/grant`, { expected_revision: bound.revision, binding: { ...binding, scope: { ...binding.scope, tools: [] } } }), /immutable/)
    lease = await acquireOperationLease(worker, { id: op.id, attempt: 1, epoch: 1 }, { node_id: hub.node, session_id: 'worker', grant_enforcement: true }, { leaseMs: 15000 })
    const active = await hub.client.call(path)
    assert.equal(active.grant_available, true); assert.equal(active.lease_until, policy.expires_at); assert.ok(active.lease_duration_ms < 15000)
    await hub.client.call('/api/v1/messaging/team-grants', { expected_revision: 1, policy: { ...policy, enabled: false } })
    assert.equal((await hub.client.call(path)).grant_available, false)
    await assert.rejects(lease.assertActive(), /grant is not available/)
    assert.equal(lease.signal.aborted, true)
    const command = action => ({ attempt: active.attempt, epoch: active.epoch, expected_revision: active.revision, action })
    await assert.rejects(worker.call(path, command({ kind: 'renew', lease_ms: 3000 })), /grant denied/)
    await assert.rejects(hub.client.call('/api/v1/messaging/official-calls', { call_id: 'denied', operation_id: op.id, attempt: 1, epoch: 1, worker_session: 'worker', provider: 'fixture', model: 'model' }), /grant denied/)
    assert.equal((await worker.call(path, command({ kind: 'report', report_id: 'revoked', content: 'must not apply' }))).applied, false)
    const cancelled = (await hub.client.call(path, command({ kind: 'cancel' }))).operation
    const stopped = (await hub.client.call(path, { attempt: cancelled.attempt, epoch: cancelled.epoch, expected_revision: cancelled.revision, action: { kind: 'attest_stopped', reason: 'fixture stopped' } })).operation
    const next = (await hub.client.call(path, { attempt: stopped.attempt, epoch: stopped.epoch, expected_revision: stopped.revision, action: { kind: 'next_attempt' } })).operation
    assert.equal(next.grant_required, true)
    await assert.rejects(worker.call(path, { attempt: next.attempt, epoch: next.epoch, expected_revision: next.revision, action: { kind: 'claim', lease_ms: 3000 } }), /grant attempt changed/)
    await hub.stop('SIGKILL'); await hub.start()
    assert.equal((await hub.client.call(path)).grant_available, false)
  } finally { lease?.dispose(); await hub?.close() }
})

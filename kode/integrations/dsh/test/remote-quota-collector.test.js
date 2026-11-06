/** Real idle native telemetry traverses two authenticated Hubs; no model turn. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { isolatedHub, pairHubs } from './support/isolated-hub.js'
import { CodexSession } from '../src/codex-session.js'
import { RemoteQuotaInvalidations } from '../src/remote-quota-invalidations.js'
import { prepareRemoteQuotaCollector } from '../src/remote-quota-collector.js'

for (const complete of [false, true]) test(`remote ${complete ? 'complete' : 'partial'} quota stays scoped and account change revokes home admission`, { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let home, remote, session
  try {
    home = await isolatedHub('quota-home'); remote = await isolatedHub('quota-worker'); await pairHubs(home, remote)
    const registered = await remote.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Quota fixture', runtime: 'external' })
    const worker = remote.client.forSession(registered.owner_token)
    const op = await home.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'quota', worker: { node_id: remote.node, session_id: 'worker' }, resource_required: true })
    await home.client.call('/api/v1/messaging/resource-accounts', { id: 'account', enabled: true, expected_epoch: 0 })
    await home.client.call('/api/v1/messaging/resource-bindings', { host: remote.node, profile: 'profile', account_id: 'account', account_epoch: 1, expected_revision: 0 })
    const policy = { host: remote.node, profile: 'profile', account_id: 'account', account_epoch: 1, binding_revision: 1, limit_ids: ['fixture'], unknown_quota: 'require_fresh' }
    await home.client.call(`/api/v1/messaging/operations/${op.id}/resource`, { attempt: 1, expected_revision: 1, policy })
    const path = `/api/v1/messaging/operation-accounting-relay/${home.node}`
    const envelope = action => ({ operation_id: op.id, worker_session: 'worker', command: null, accounting: { attempt: 1, action } })
    await assert.rejects(worker.call(path, envelope({ kind: 'resource_context' })), /403/)
    const now = Date.now()
    const foreign = { host: remote.node, profile: 'another-profile', account_id: 'account', account_epoch: 1, binding_revision: 1, observed_at_ms: now, buckets: [], truncated: false }
    await assert.rejects(remote.client.call(path, envelope({ kind: 'quota', sample: foreign })), /foreign quota resource/)
    const operation = { id: op.id, attempt: 1, home_node: home.node }
    const collector = await prepareRemoteQuotaCollector(remote.client, remote.node, 'profile', 'worker', operation)
    let finish, fail, admitted = false, sampled, sampledDecision
    const done = new Promise((resolve, reject) => { finish = resolve; fail = reject }); done.catch(() => {})
    session = new CodexSession({ executable: process.execPath, args: [fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))], env: { KODE_FIXTURE_QUOTA: '1', KODE_FIXTURE_QUOTA_ACCOUNT_CHANGE: '1', KODE_FIXTURE_QUOTA_COMPLETE: complete ? '1' : '0' } }, remote.root, { quota: async observation => {
      try {
        await collector.publish(observation)
        const decision = await home.client.call('/api/v1/messaging/resource-admission', policy)
        if (observation.status === 'reported') { admitted ||= decision.allowed; sampled = observation; sampledDecision = decision }
        if (observation.account_changed) finish(decision)
      } catch (error) { fail(error) }
    } })
    await session.open({}, [], AbortSignal.timeout(12000))
    let timer
    const denied = await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Remote quota publication timed out')), 12000) })]).finally(() => clearTimeout(timer))
    assert.equal(admitted, complete); assert.equal(sampledDecision.reason, complete ? 'fresh_quota' : 'fresh_quota_required'); assert.equal(denied.allowed, false); assert.equal(denied.reason, 'binding_unavailable')
    assert.equal(session.active, undefined)
    assert.equal((await collector.publish(sampled)).status, 'binding_invalidated')
    // Duplicate invalidation recovers its receipt; old assignment cannot revoke a newer binding.
    assert.equal((await remote.client.call(path, envelope({ kind: 'invalidate_quota' }))).invalidated, true)
    await home.client.call('/api/v1/messaging/resource-bindings', { host: remote.node, profile: 'profile', account_id: 'account', account_epoch: 1, expected_revision: 2 })
    await assert.rejects(remote.client.call(path, envelope({ kind: 'invalidate_quota' })), /revision conflict/)
    const profiles = { bindings: { worker: { profile: { id: 'profile' } } }, update: async fn => fn(profiles) }
    const invalidations = new RemoteQuotaInvalidations(remote.client, profiles)
    try {
      await invalidations.record('worker', 'profile', home.node, operation, 1)
      await invalidations.tick()
      assert.equal(invalidations.pending().length, 0)
      assert.equal(invalidations.fence(home.node, 'profile'), 1)
    } finally { await invalidations.close() }
    const reopened = await prepareRemoteQuotaCollector(remote.client, remote.node, 'profile', 'worker', operation)
    assert.equal((await reopened.publish(sampled)).status, 'binding_unavailable')
    assert.equal((await home.client.call(`/api/v1/messaging/resource-binding?host=${remote.node}&profile=profile`)).binding_current, true)
  } finally { await session?.close(); await home?.close(); await remote?.close() }
})

import { resourceCoverage } from '../src/resource-coverage.js'
/** Production routing + runtime callbacks + spawned native fixture + two real Hubs. No inference. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { isolatedHub, pairHubs } from './support/isolated-hub.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { AgentRuntimeAdapter } from '../src/agent-runtime.js'
import { runtimeQuotaCollector } from '../src/runtime-quota-collector.js'
import { RemoteQuotaInvalidations } from '../src/remote-quota-invalidations.js'

test('runtime automatically publishes quota to home and durably fences before a lost invalidation response', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let home, remote, runtime, adapter, replay
  try {
    home = await isolatedHub('quota-runtime-home'); remote = await isolatedHub('quota-runtime-worker'); await pairHubs(home, remote)
    await remote.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Quota runtime fixture', runtime: 'external' })
    const op = await home.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'quota-runtime', worker: { node_id: remote.node, session_id: 'worker' }, resource_required: true })
    await home.client.call('/api/v1/messaging/resource-accounts', { id: 'account', enabled: true, expected_epoch: 0 })
    await home.client.call('/api/v1/messaging/resource-bindings', { host: remote.node, profile: 'profile', account_id: 'account', account_epoch: 1, expected_revision: 0 })
    const policy = { host: remote.node, profile: 'profile', account_id: 'account', account_epoch: 1, binding_revision: 1, limit_ids: ['fixture'], unknown_quota: 'require_fresh' }
    await home.client.call(`/api/v1/messaging/operations/${op.id}/resource`, { attempt: 1, expected_revision: 1, policy })
    const path = join(remote.root, 'profiles.json')
    const profiles = await new AgentProfiles(path).open([{ id: 'profile', name: 'Fixture', type: 'codex', executable: process.execPath, args: [fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))], env: { KODE_FIXTURE_QUOTA: '1', KODE_FIXTURE_QUOTA_ACCOUNT_CHANGE: '1', KODE_FIXTURE_QUOTA_COMPLETE: '1' } }])
    await profiles.bind('worker', 'profile')
    await profiles.patchBinding('worker', { managedOperation: { id: op.id, attempt: 1, home_node: home.node } })
    let sampled = false, lost = false
    const client = { call: async (route, body, signal) => {
      assert.ok(route.includes('operation-accounting-relay'), 'remote telemetry must not fall back to local authority')
      const kind = body.accounting.action.kind
      if (kind === 'invalidate_quota') {
        const disk = await new AgentProfiles(path).open()
        assert.equal(disk.binding('worker').remoteQuotaFences[0].revision, 1, 'fence durable before network side effect')
      }
      const result = await remote.client.call(route, body, signal)
      if (kind === 'quota') {
        sampled ||= (await home.client.call('/api/v1/messaging/resource-admission', policy)).allowed
        const inventory = await resourceCoverage({ profiles, hasRuntime: () => true }, remote.client, remote.node)
        const scope = inventory.items[0].remote_attempts[0]
        assert.equal(scope.quota_status, 'reported')
        assert.equal(scope.account.id, 'account')
        assert.equal(scope.assignment_binding_current, true)
        assert.equal(inventory.items[0].quota_status, 'account_unbound', 'remote account never becomes a local replica')
      }
      if (kind === 'invalidate_quota' && !lost) { lost = true; throw new Error('lost committed response') }
      return result
    } }
    replay = new RemoteQuotaInvalidations(client, profiles)
    const agent = { id: 'worker', session: { header: { cwd: remote.root }, append() {} }, ctx: { get: () => undefined, parallel: async () => {} } }
    const ctx = { sessionProjections: { stateOf: () => ({ lastTurn: 1, lastStepBoundary: { kind: 'end', step: 1 } }) } }
    adapter = new AgentRuntimeAdapter(ctx, profiles, { recordNative(_session, data) { assert.equal(data.turn, undefined, 'idle telemetry must not invent a turn') }, quotaCollector: runtimeQuotaCollector({ backendClient: client, quotaHost: remote.node }, profiles, replay) })
    runtime = await adapter.createRuntime(agent, profiles.binding('worker'), [], AbortSignal.timeout(12000))
    const deadline = Date.now() + 5000
    while (!lost && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    await runtime.quotaWrites
    assert.equal(sampled, true)
    assert.equal(lost, true)
    assert.equal(profiles.binding('worker').quotaPublication.status, 'publication_failed')
    assert.equal(profiles.binding('worker').quotaFenceRevision, undefined, 'remote revision never contaminates local fence')
    assert.equal((await home.client.call('/api/v1/messaging/resource-admission', policy)).allowed, false)
    await replay.close()
    const reopened = await new AgentProfiles(path).open()
    replay = new RemoteQuotaInvalidations(remote.client, reopened)
    await replay.tick()
    assert.equal(replay.pending().length, 0)
    assert.equal(replay.fence(home.node, 'profile'), 1)
    const inventory = await resourceCoverage({ profiles: reopened, hasRuntime: () => true }, remote.client, remote.node)
    assert.equal(inventory.items[0].remote_attempts[0].quota_status, 'binding_unavailable')
    assert.equal(runtime.active, undefined)
  } finally { await runtime?.close(); await adapter?.close(); await replay?.close(); await home?.close(); await remote?.close() }
})

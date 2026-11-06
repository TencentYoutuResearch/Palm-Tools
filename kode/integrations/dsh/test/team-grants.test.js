/** Actual administrator API; no inference or privileged project actions. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'

test('team grants retain immutable revisions, enforce owner writes and survive revocation restart', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let hub
  try {
    hub = await isolatedHub('team-grants')
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const input = { expected_revision: 0, policy: { id: 'grant', team_id: 'team', enabled: true, expires_at: Date.now() + 60000, targets: [{ host: hub.node, workspace: 'fixture-workspace', root: '/srv/fixture' }], capabilities: ['read', 'workspace_write'], tools: ['read-file', 'edit-file'], network: false, budget_ids: ['team-budget'] } }
    await assert.rejects(worker.call('/api/v1/messaging/team-grants', input), /403/)
    await assert.rejects(worker.call('/api/v1/messaging/team-grants/grant'), /403/)
    const first = await hub.client.call('/api/v1/messaging/team-grants', input)
    assert.equal(first.grant.revision, 1); assert.equal(first.grant.grantor, 'home_administrator'); assert.equal(first.duplicate, false)
    assert.equal((await hub.client.call('/api/v1/messaging/team-grants', input)).duplicate, true)
    await assert.rejects(hub.client.call('/api/v1/messaging/team-grants', { ...input, policy: { ...input.policy, tools: ['*'] } }), /explicit/)
    await assert.rejects(hub.client.call('/api/v1/messaging/team-grants', { ...input, policy: { ...input.policy, tools: ['other'] } }), /revision conflict/)
    await assert.rejects(hub.client.call('/api/v1/messaging/team-grants', { ...input, expected_revision: 1, policy: { ...input.policy, team_id: 'other' } }), /team identity/)
    await assert.rejects(hub.client.call('/api/v1/messaging/team-grants', { ...input, policy: { ...input.policy, targets: [{ ...input.policy.targets[0], root: '/srv/../private' }] } }), /workspace root/)
    await assert.rejects(hub.client.call('/api/v1/messaging/team-grants', { ...input, grantor: 'human' }), /400|422/)
    const check = { team_id: 'team', revision: 1, target: input.policy.targets[0], capabilities: ['read'], tools: ['read-file'], network: false, budget_ids: ['team-budget'] }
    const path = '/api/v1/messaging/team-grants/grant/check'
    assert.equal((await hub.client.call(path, check)).allowed, true)
    await assert.rejects(worker.call(path, check), /403/)
    for (const [override, reason] of [[{ team_id: 'other' }, 'foreign_team'], [{ revision: 2 }, 'revision_changed'], [{ target: { ...check.target, host: 'foreign' } }, 'workspace_denied'], [{ capabilities: ['deploy'] }, 'capability_denied'], [{ tools: ['shell'] }, 'tool_denied'], [{ network: true }, 'network_denied'], [{ budget_ids: ['foreign'] }, 'budget_denied']]) {
      const decision = await hub.client.call(path, { ...check, ...override })
      assert.equal(decision.allowed, false); assert.equal(decision.reason, reason)
    }
    const revoked = { expected_revision: 1, policy: { ...input.policy, enabled: false } }
    await hub.client.call('/api/v1/messaging/team-grants', revoked)
    await hub.stop('SIGKILL'); await hub.start()
    const current = await hub.client.call('/api/v1/messaging/team-grants/grant')
    assert.equal(current.revision, 2); assert.equal(current.policy.enabled, false)
    assert.equal((await hub.client.call(path, check)).reason, 'revision_changed')
    assert.equal((await hub.client.call(path, { ...check, revision: 2 })).reason, 'revoked')
    const historical = await hub.client.call('/api/v1/messaging/team-grants/grant?revision=1')
    assert.deepEqual(historical.policy, input.policy)
    assert.equal((await hub.client.call('/api/v1/messaging/team-grants', revoked)).duplicate, true)
    await assert.rejects(hub.client.call('/api/v1/messaging/team-grants', input), /revision conflict/)
    await assert.rejects(hub.client.call('/api/v1/messaging/team-grants/grant?revision=3'), /404/)
  } finally { await hub?.close() }
})

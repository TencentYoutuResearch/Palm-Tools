/** Actual reservation scope, not a caller's declared budget list, controls admission. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'

test('grant and reservation binding intersect in either order and reject foreign teams atomically', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let hub
  try {
    hub = await isolatedHub('grant-budgets')
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token), now = Date.now()
    for (const [id, scope, scope_id] of [['own', 'team', 'team'], ['shared', 'shared', 'all'], ['foreign', 'team', 'other'], ['unlisted', 'shared', 'all']]) {
      await hub.client.call('/api/v1/messaging/budgets', { id, scope, scope_id, unit: 'credits', limit: 1000, starts_at: now - 1000, ends_at: now + 60000, expected_revision: 0 })
    }
    const target = { host: hub.node, workspace: 'workspace', root: '/srv/fixture' }
    await hub.client.call('/api/v1/messaging/team-grants', { expected_revision: 0, policy: { id: 'grant', team_id: 'team', enabled: true, expires_at: now + 60000, targets: [target], capabilities: ['read'], tools: [], network: false, budget_ids: ['own', 'shared', 'foreign'] } })
    for (const order of ['grant-first', 'budget-first']) for (const budget_ids of [['unlisted'], ['foreign'], ['own', 'shared']]) {
      let op = await hub.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: `${order}-${budget_ids.join('-')}`, worker: { node_id: hub.node, session_id: 'worker' }, grant_required: true, budget_required: true })
      const path = `/api/v1/messaging/operations/${op.id}`
      const hold = `hold-${order}-${budget_ids.join('-')}`
      await hub.client.call('/api/v1/messaging/budget-reservations', { id: hold, budget_ids, amount: 10, unit: 'credits', operation_id: op.id })
      const binding = { grant_id: 'grant', attempt: 1, epoch: 1, scope: { team_id: 'team', revision: 1, target, capabilities: ['read'], tools: [], network: false, budget_ids: ['own', 'shared', 'foreign'] } }
      const attachGrant = () => hub.client.call(`${path}/grant`, { expected_revision: op.revision, binding })
      const attachBudget = () => hub.client.call(`${path}/budget`, { attempt: 1, expected_revision: op.revision, reservation_id: hold })
      op = await (order === 'grant-first' ? attachGrant() : attachBudget())
      const second = order === 'grant-first' ? attachBudget : attachGrant
      if (budget_ids[0] !== 'own') {
        await assert.rejects(second(), budget_ids[0] === 'foreign' ? /another team/ : /budget scope/)
        assert.equal((await hub.client.call(path)).revision, op.revision, 'rejected attachment must not mutate operation')
        await assert.rejects(worker.call(path, { attempt: 1, epoch: 1, expected_revision: op.revision, action: { kind: 'claim', lease_ms: 3000 } }), /grant|reservation/)
      } else {
        op = await second()
        const claimed = await worker.call(path, { attempt: 1, epoch: 1, expected_revision: op.revision, action: { kind: 'claim', lease_ms: 3000 } })
        assert.equal(claimed.applied, true)
        assert.equal(claimed.operation.grant_available, true)
      }
    }
  } finally { await hub?.close() }
})

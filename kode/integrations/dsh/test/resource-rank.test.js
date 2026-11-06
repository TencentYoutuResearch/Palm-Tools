/** Real Hub recommendation reads durable capability and account state; never dispatches. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
const path = '/api/v1/messaging/resources/rank'
test('ranking applies quota and quality before preference and explains missing soft evidence', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('rank-home')
  try {
    const call = (path, body) => hub.client.call(`/api/v1/messaging/${path}`, body)
    await call('resource-accounts', { id: 'account', expected_epoch: 0, enabled: true })
    const candidates = []
    for (const [id, quality, cost, stale] of [['good', 85, 'medium', false], ['cheap', 40, 'low', false], ['missing', 85, null, false], ['stale', 99, 'low', true]]) {
      await call('resource-bindings', { host: 'host', profile: id, account_id: 'account', account_epoch: 1, expected_revision: 0 })
      const at = Date.now()
      const assessment = evaluation => ({ evaluation, source: 'user', confidence: 0.8, evidence: [], pinned: false, updated_at: at - 10000, valid_until: stale ? at - 1000 : at + 60000 })
      await call('capability-profiles', { id, expected_revision: 0, host: 'host', profile: id, model: 'model', assessments: {
        quality: assessment({ kind: 'task_fit', tag: 'coding', score: quality }),
        ...(cost ? { cost: assessment({ kind: 'cost_tier', tier: cost }) } : {}),
      } })
      candidates.push({ capability_id: id, capability_revision: 1, model: 'model', preferred: id === 'cheap', resource: {
        host: 'host', profile: id, account_id: 'account', account_epoch: 1, binding_revision: 1, limit_ids: ['primary'], unknown_quota: 'team_budget',
      } })
    }
    const input = { task_tag: 'coding', minimum_quality: 70, minimum_confidence: 0.5, weights: { quality: 1, cost: 1, latency: 0 }, candidates }
    const registration = await call('sessions', { session_id: 'worker', title: 'Worker', runtime: 'external' })
    await assert.rejects(hub.client.forSession(registration.owner_token).call(path, input), /403/)
    const result = await hub.client.call(path, input)
    assert.deepEqual(result.candidates.map(row => row.profile), ['good', 'missing'])
    assert.deepEqual(result.excluded.map(row => row.profile), ['cheap', 'stale'])
    assert.ok(result.excluded.every(row => row.reason === 'quality_evidence_missing_or_below_floor'))
    assert.equal(result.candidates[1].components.cost_preference, null)
    assert.ok(result.candidates.every(row => !row.eligible_for_dispatch && row.quota.requires_team_budget))
    assert.equal(result.eligible_for_dispatch, false)
    assert.ok(result.pending_checks.includes('workspace_and_grant'))
    const preferred = structuredClone(input); preferred.candidates[2].preferred = true
    assert.equal((await hub.client.call(path, preferred)).candidates[0].profile, 'missing')
    const fresh = structuredClone(input); fresh.candidates.forEach(row => { row.resource.unknown_quota = 'require_fresh' })
    assert.ok((await hub.client.call(path, fresh)).excluded.every(row => row.reason === 'fresh_quota_required'))
    const mismatch = structuredClone(input); mismatch.candidates[0].model = 'other'
    assert.equal((await hub.client.call(path, mismatch)).excluded[0].reason, 'capability_identity_mismatch')
    await assert.rejects(hub.client.call(path, { ...input, candidates: [candidates[0], candidates[0]] }), /duplicate/)
    const observed = Date.now()
    await call('quota-snapshots', { host: 'host', profile: 'good', account_id: 'account', account_epoch: 1, binding_revision: 1,
      observed_at_ms: observed, truncated: false, buckets: [{ limit_id: 'primary', observed_at_ms: observed, valid_until_ms: observed + 60000,
        windows: [{ window_id: 'hour', used_percent: 100, resets_at_ms: observed + 60000, window_minutes: 60 }] }] })
    const exhausted = await hub.client.call(path, input)
    assert.equal(exhausted.excluded.find(row => row.profile === 'good').reason, 'provider_exhausted')
    assert.ok(!exhausted.candidates.some(row => row.profile === 'good'))
    await call('resource-accounts', { id: 'account', expected_epoch: 1, enabled: false })
    assert.ok((await hub.client.call(path, input)).excluded.every(row => row.reason === 'binding_unavailable'))
  } finally { await hub.close() }
})

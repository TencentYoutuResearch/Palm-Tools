import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'

test('official calls aggregate estimated budget charges once and unknown usage blocks further admission', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let hub
  try {
    hub = await isolatedHub('official-accounting')
    const now = Date.now(), api = hub.client
    const op = await api.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'budgeted-calls', worker: { node_id: hub.node, session_id: 'worker' }, budget_required: true })
    await api.call('/api/v1/messaging/budgets', { id: 'team', scope: 'team', scope_id: 'team', unit: 'credits', limit: 100, starts_at: now - 1000, ends_at: now + 60000, expected_revision: 0 })
    await api.call('/api/v1/messaging/budget-reservations', { id: 'hold', budget_ids: ['team'], amount: 80, unit: 'credits', operation_id: op.id })
    await api.call('/api/v1/messaging/price-versions', { id: 'price', model: 'model', unit: 'credits', model_policy: 'requested_model', input_per_million: 1000000, cached_per_million: 1000000, output_per_million: 1000000 })
    await api.call('/api/v1/messaging/budget-reservations/hold/pricing', { price_id: 'price' })
    const attached = await api.call(`/api/v1/messaging/operations/${op.id}/budget`, { attempt: 1, expected_revision: 1, reservation_id: 'hold' })
    const active = (await api.call(`/api/v1/messaging/operations/${op.id}`, { attempt: 1, epoch: 1, expected_revision: attached.revision, action: { kind: 'claim', lease_ms: 60000 } })).operation
    const request = { call_id: 'one', operation_id: op.id, attempt: 1, epoch: active.epoch, worker_session: 'worker', provider: 'fixture', model: 'model' }
    const path = '/api/v1/messaging/official-calls'
    await assert.rejects(api.call(path, { ...request, model: 'wrong' }), /matching requested-model/)
    await api.call(path, request)
    await assert.rejects(api.call(path, { ...request, call_id: 'two' }), /requires reconciliation/)
    const event = { sequence: 1, kind: 'finished', usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 2, cache_write_input_tokens: 0 }, reason: 'stop' }
    const first = await api.call(`${path}/one/events`, event)
    assert.equal(first.call.accounting.price_id, 'price')
    assert.equal(first.call.accounting_status, 'estimated_pending_reconciliation')
    assert.equal((await api.call('/api/v1/messaging/budgets/team')).budget.spent, 12)
    await api.call(`${path}/one/events`, event)
    assert.equal((await api.call('/api/v1/messaging/budgets/team')).budget.spent, 12)
    await api.call(path, { ...request, call_id: 'two' })
    await api.call(`${path}/two/events`, { ...event, kind: 'usage' })
    assert.equal((await api.call('/api/v1/messaging/budgets/team')).budget.spent, 24)
    await api.call(`${path}/two/events`, { sequence: 2, kind: 'finished', usage: null, reason: 'missing_usage' })
    assert.equal((await api.call('/api/v1/messaging/budgets/team')).budget.spent, 24, 'missing usage never refunds known consumption')
    await assert.rejects(api.call(path, { ...request, call_id: 'three' }), /requires reconciliation/)
    await hub.stop('SIGKILL'); await hub.start()
    assert.equal((await hub.client.call('/api/v1/messaging/budgets/team')).budget.spent, 24)
    assert.equal((await hub.client.call(`${path}/two`)).accounting_status, 'usage_unresolved')
  } finally { await hub?.close() }
})

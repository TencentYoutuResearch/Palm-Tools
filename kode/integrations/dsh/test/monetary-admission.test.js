/** Actual Hub lease admission against controlled, scoped monetary observations. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
import { parseProviderBalance } from '../src/provider-balances.js'
import { acquireOperationLease } from '../src/operation-lease.js'
const root = '/api/v1/messaging'
test('monetary exhaustion survives partial evidence and blocks actual lease renewal', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('monetary-admission')
  let lease
  try {
    const call = (path, body) => hub.client.call(`${root}/${path}`, body)
    const { node_id: host } = await call('node')
    await call('resource-accounts', { id: 'account', expected_epoch: 0, enabled: true })
    await call('resource-bindings', { host, profile: 'p', account_id: 'account', account_epoch: 1, expected_revision: 0 })
    const identity = { host, profile: 'p', account_id: 'account', account_epoch: 1, binding_revision: 1 }
    const policy = { ...identity, limit_ids: [], monetary: [{ source: 'deepseek_balance', currency: 'cny' }], unknown_quota: 'require_fresh' }
    const budgetPolicy = { ...policy, unknown_quota: 'team_budget' }
    assert.equal((await call('resource-admission', policy)).allowed, false)
    assert.equal((await call('resource-admission', budgetPolicy)).requires_team_budget, true)
    let observed = Date.now() - 1000
    const publish = async (source, body, status = 'reported', transform = value => value) => {
      observed++
      const sample = status === 'reported' ? transform(parseProviderBalance(source, body, observed)) : null
      return call('monetary-quota', { ...identity, source, status, observed_at_ms: observed, sample })
    }
    const ds = amount => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: amount, granted_balance: '0', topped_up_balance: amount }] })
    await publish('deepseek_balance', ds('10'))
    assert.equal((await call('resource-admission', policy)).allowed, true)
    const registration = await call('sessions', { session_id: 'worker', title: 'Worker', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const op = await call('operations', { owner_session: 'owner', request_key: 'money-operation', worker: { node_id: host, session_id: 'worker' }, resource_required: true })
    await call(`operations/${op.id}/resource`, { attempt: 1, expected_revision: op.revision, policy })
    lease = await acquireOperationLease(worker, { id: op.id, attempt: op.attempt, epoch: op.epoch }, { node_id: host, session_id: 'worker', profile_id: 'p' }, { leaseMs: 10000 })
    await publish('deepseek_balance', ds('0'))
    assert.equal((await call('resource-admission', budgetPolicy)).reason, 'provider_monetary_exhausted')
    await assert.rejects(lease.assertActive(), /resource is not available/)
    assert.equal(lease.signal.aborted, true); lease.dispose(); lease = null
    await publish('deepseek_balance', ds('1'), 'reported', sample => { sample.limits[0].remaining = null; sample.limits[0].reached = null; sample.completeness = 'partial'; return sample })
    await hub.stop('SIGKILL'); await hub.start()
    assert.equal((await call('resource-admission', budgetPolicy)).reason, 'provider_monetary_exhausted')
    await publish('deepseek_balance', ds('2'))
    assert.equal((await call('resource-admission', policy)).allowed, true)
    await publish('deepseek_balance', null, 'authentication_unavailable')
    await publish('deepseek_balance', null, 'unavailable')
    assert.equal((await call('resource-admission', budgetPolicy)).reason, 'authentication_unavailable')
    await publish('deepseek_balance', ds('2'))
    assert.equal((await call('resource-admission', policy)).allowed, true)
    const otherCurrency = structuredClone(policy); otherCurrency.monetary[0].currency = 'usd'
    assert.equal((await call('resource-admission', otherCurrency)).allowed, false)
    const key = { data: { limit: 10, limit_remaining: 5, usage: 5, limit_reset: null, include_byok_in_limit: false, budgets: [], free_model_daily_requests: { limit: 50, remaining: 0, used: 50 } } }
    await publish('openrouter_key', key)
    const paid = { ...policy, monetary: [{ source: 'openrouter_key', currency: 'usd', free_models: false }] }
    assert.equal((await call('resource-admission', paid)).allowed, true)
    const free = { ...paid, monetary: [{ source: 'openrouter_key', currency: 'usd', free_models: true }] }
    assert.equal((await call('resource-admission', free)).reason, 'provider_monetary_exhausted')
    key.data.budgets.push({ budget_id: 'org', scope: 'organization', include_byok: false, limit_usd: 2, remaining_usd: 0, spend_usd: 2, resets_at: null })
    await publish('openrouter_key', key)
    assert.equal((await call('resource-admission', paid)).reason, 'provider_monetary_exhausted')
    key.data.budgets = []
    await publish('openrouter_key', key)
    assert.equal((await call('resource-admission', paid)).reason, 'provider_monetary_exhausted', 'omitted organization budget cannot clear exhaustion')
  } finally { lease?.dispose(); await hub.close() }
})

/** Host scheduler + real Hub; authorized transport is controlled and never reads credentials. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { MonetaryCollectors } from '../src/monetary-service.js'
import { isolatedHub } from './support/isolated-hub.js'
const root = '/api/v1/messaging'
const facts = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '3', granted_balance: '0', topped_up_balance: '3' }] }
async function until(predicate) {
  for (let n = 0; n < 300; n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail('collector condition not reached')
}
test('Host opt-in scheduler publishes idle facts, pins authority and stops cleanly', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('monetary-service')
  const manager = new MonetaryCollectors(hub.client, hub.node, { intervalMs: 10 })
  let polls = 0, missingPolls = 0
  try {
    assert.deepEqual(manager.list(), [])
    await hub.client.call(`${root}/resource-accounts`, { id: 'account', expected_epoch: 0, enabled: true })
    await hub.client.call(`${root}/resource-bindings`, { host: hub.node, profile: 'p', account_id: 'account', account_epoch: 1, expected_revision: 0 })
    const config = { profile: 'p', source: 'deepseek_balance', ttlMs: 1000, authorizedFetch: async (url, options) => {
      polls++; assert.equal(url, 'https://api.deepseek.com/user/balance'); assert.equal(options.method, 'GET')
      return Response.json(facts)
    } }
    const remove = manager.register(config)
    assert.throws(() => manager.register(config), /already registered/)
    const absent = manager.register({ ...config, profile: 'missing', authorizedFetch: async () => { missingPolls++; return Response.json(facts) } })
    await until(() => manager.list().some(row => row.status === 'reported') && manager.list().some(row => row.status === 'binding_unavailable'))
    assert.equal(polls, 1); assert.equal(missingPolls, 0)
    assert.ok(!JSON.stringify(manager.list()).includes('authorizedFetch'))
    const query = `${root}/monetary-quota?host=${hub.node}&profile=p`
    assert.equal((await hub.client.call(query)).sources[0].last_reported.sample.limits[0].remaining, '3')
    await hub.client.call(`${root}/resource-accounts`, { id: 'account', expected_epoch: 1, enabled: true })
    await until(() => manager.list().some(row => row.status === 'publication_unavailable'))
    assert.equal(polls, 2)
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(polls, 2, 'failed publication retries pinned sample without repoll or rebind')
    await remove(); await absent()
    assert.deepEqual(manager.list(), [])
    await manager.close()
    assert.throws(() => manager.register(config), /unavailable/)
  } finally { await manager.close(); await hub.close() }
})

test('blocked provider does not starve another collector and shutdown aborts transport', async () => {
  let aborted = false, completed = false
  const client = { call: async (path, body) => body ? { accepted: true } : { binding_current: true, account_id: 'account', account_epoch: 1, revision: 1 } }
  const manager = new MonetaryCollectors(client, 'host', { intervalMs: 10 })
  try {
    manager.register({ profile: 'slow', source: 'deepseek_balance', authorizedFetch: (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('private transport failure')) }, { once: true })
    }) })
    manager.register({ profile: 'fast', source: 'deepseek_balance', authorizedFetch: async () => { completed = true; return Response.json(facts) } })
    await until(() => completed && manager.list().some(row => row.status === 'reported'))
    await manager.close()
    assert.equal(aborted, true)
    assert.deepEqual(manager.list(), [])
  } finally { await manager.close() }
})

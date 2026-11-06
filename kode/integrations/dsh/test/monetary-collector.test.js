/** Actual home Hub persistence with controlled provider facts; no provider credentials. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
import { parseProviderBalance } from '../src/provider-balances.js'
import { prepareMonetaryCollector } from '../src/monetary-collector.js'
const root = '/api/v1/messaging'
test('money samples recover lost publication, persist failure separately and reject changed accounts', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('money-home')
  try {
    const call = (path, body) => hub.client.call(`${root}/${path}`, body)
    await call('resource-accounts', { id: 'a', expected_epoch: 0, enabled: true })
    await call('resource-bindings', { host: 'host', profile: 'p', account_id: 'a', account_epoch: 1, expected_revision: 0 })
    let observed = Date.now() - 5000, polls = 0, failPublication = true, status = 'reported'
    const facts = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '2.00', granted_balance: '0', topped_up_balance: '2.00' }] }
    const source = { source: 'deepseek_balance', poll: async () => {
      polls++
      return status === 'reported' ? { status, sample: parseProviderBalance('deepseek_balance', facts, observed, 1000) }
        : { status, source: 'deepseek_balance', observed_at_ms: observed }
    } }
    const client = { call: async (path, input) => {
      const result = await hub.client.call(path, input)
      if (path.endsWith('/monetary-quota') && failPublication) { failPublication = false; throw new Error('fixture response lost') }
      return result
    } }
    const collector = await prepareMonetaryCollector(client, 'host', 'p', source)
    await assert.rejects(collector.poll(), /response lost/)
    assert.equal((await collector.poll()).status, 'publication_recovered'); assert.equal(polls, 1)
    const query = 'monetary-quota?host=host&profile=p'
    const before = (await call(query)).sources[0]
    assert.equal(before.last_reported.sample.limits[0].remaining, '2.00')
    assert.equal(before.last_reported_freshness, 'stale')
    const registration = await call('sessions', { session_id: 'worker', title: 'Worker', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    await assert.rejects(worker.call(`${root}/${query}`), /403/)
    await assert.rejects(worker.call(`${root}/monetary-quota`, before.last_reported), /403/)
    const changed = structuredClone(before.last_reported); changed.sample.limits[0].remaining = '9'
    await assert.rejects(call('monetary-quota', changed), /older or conflicts/)
    const bad = structuredClone(before.last_reported); bad.observed_at_ms++; bad.sample.observed_at_ms++
    bad.sample.limits[0].credential = 'forbidden-field'
    await assert.rejects(call('monetary-quota', bad), /invalid monetary limit fields/)
    status = 'authentication_unavailable'; observed++
    await collector.poll()
    await hub.stop('SIGKILL'); await hub.start()
    const failure = (await call(query)).sources[0]
    assert.equal(failure.status, 'authentication_unavailable')
    assert.deepEqual(failure.last_reported, before.last_reported)
    assert.equal(failure.eligible_for_dispatch, false)
    await call('resource-accounts', { id: 'a', expected_epoch: 1, enabled: true })
    assert.equal((await call(query)).sources[0].status, 'binding_changed')
    assert.equal((await call(query)).sources[0].last_reported, null)
    observed++
    await assert.rejects(collector.poll(), /binding is stale/)
    await call('resource-bindings', { host: 'host', profile: 'p', account_id: 'a', account_epoch: 2, expected_revision: 1 })
    const next = await prepareMonetaryCollector(hub.client, 'host', 'p', source)
    await next.poll()
    assert.equal((await call(query)).sources[0].last_reported, null)
  } finally { await hub.close() }
})

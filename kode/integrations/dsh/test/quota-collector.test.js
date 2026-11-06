import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareQuotaCollector } from '../src/quota-collector.js'
import { quotaObservation } from '../src/codex-quota.js'

test('collector pins binding, invalidates account changes and never retargets later samples', async () => {
  const calls = []
  const client = { call: async (path, input) => { calls.push({ path, input }); return { binding_current: true, revision: 4, account_id: 'a', account_epoch: 2 } } }
  const collector = await prepareQuotaCollector(client, 'home', 'worker')
  const observation = quotaObservation(null)
  assert.equal((await collector.publish(observation)).status, 'published')
  assert.equal(calls[1].input.binding_revision, 4)
  assert.equal(calls[1].input.account_epoch, 2)
  assert.equal((await collector.publish({ ...observation, account_changed: true })).status, 'binding_invalidated')
  const count = calls.length
  assert.equal((await collector.publish(observation)).status, 'binding_invalidated')
  assert.equal(calls.length, count)
  const fenced = await prepareQuotaCollector(client, 'home', 'worker', 4)
  assert.equal((await fenced.publish(observation)).status, 'binding_unavailable')
})

test('invalidation failure still fences the current collector', async () => {
  let writes = 0
  const client = { call: async (path, input) => { if (input) { writes++; throw new Error('offline') }; return { binding_current: true, revision: 1, account_id: 'a', account_epoch: 1 } } }
  const collector = await prepareQuotaCollector(client, 'home', 'worker')
  await assert.rejects(collector.publish({ ...quotaObservation(null), account_changed: true }), /offline/)
  assert.equal((await collector.publish(quotaObservation(null))).status, 'binding_invalidated')
  assert.equal(writes, 1)
})

test('a durable profile fence from another runtime blocks a previously pinned collector', async () => {
  let fence = 0, writes = 0
  const client = { call: async (_path, input) => { if (input) writes++; return { binding_current: true, revision: 2, account_id: 'a', account_epoch: 1 } } }
  const collector = await prepareQuotaCollector(client, 'home', 'worker', fence, () => fence)
  fence = 2
  assert.equal((await collector.publish(quotaObservation(null))).status, 'binding_invalidated')
  assert.equal(writes, 0)
})

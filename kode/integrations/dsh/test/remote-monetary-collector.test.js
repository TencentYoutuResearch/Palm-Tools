/** Two real authenticated Hubs and scoped monetary relay; provider data is controlled. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub, pairHubs } from './support/isolated-hub.js'
import { parseProviderBalance } from '../src/provider-balances.js'
import { prepareRemoteMonetaryCollector } from '../src/monetary-collector.js'
const root = '/api/v1/messaging'
test('remote monetary facts remain on home and cannot escape assigned source/account', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const home = await isolatedHub('money-relay-home'), remote = await isolatedHub('money-relay-worker')
  try {
    await pairHubs(home, remote)
    const call = (hub, path, input) => hub.client.call(`${root}/${path}`, input)
    const registration = await call(remote, 'sessions', { session_id: 'worker', title: 'Worker', runtime: 'external' })
    const worker = remote.client.forSession(registration.owner_token)
    const op = await call(home, 'operations', { owner_session: 'owner', request_key: 'money', worker: { node_id: remote.node, session_id: 'worker' }, resource_required: true })
    await call(home, 'resource-accounts', { id: 'account', expected_epoch: 0, enabled: true })
    await call(home, 'resource-bindings', { host: remote.node, profile: 'p', account_id: 'account', account_epoch: 1, expected_revision: 0 })
    const policy = { host: remote.node, profile: 'p', account_id: 'account', account_epoch: 1, binding_revision: 1, limit_ids: [], unknown_quota: 'require_fresh', monetary: [{ source: 'deepseek_balance', currency: 'cny' }] }
    await call(home, `operations/${op.id}/resource`, { attempt: 1, expected_revision: op.revision, policy })
    const path = `${root}/operation-accounting-relay/${home.node}`
    const envelope = action => ({ operation_id: op.id, worker_session: 'worker', command: null, accounting: { attempt: 1, action } })
    await assert.rejects(worker.call(path, envelope({ kind: 'monetary_context' })), /403/)
    const operation = { id: op.id, attempt: 1, home_node: home.node }
    let polls = 0, amount = '10', observed = Date.now() - 1000, lose = true, sent
    const provider = { source: 'deepseek_balance', poll: async () => {
      polls++; observed++
      return { status: 'reported', sample: parseProviderBalance('deepseek_balance', { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: amount, granted_balance: '0', topped_up_balance: amount }] }, observed) }
    } }
    const client = { call: async (path, input) => {
      const value = await remote.client.call(path, input)
      if (input.accounting.action.kind === 'monetary_quota') {
        sent = structuredClone(input)
        if (lose) { lose = false; throw new Error('fixture lost acknowledgement') }
      }
      return value
    } }
    const collector = await prepareRemoteMonetaryCollector(client, remote.node, 'p', 'worker', operation, provider)
    await assert.rejects(collector.poll(), /lost acknowledgement/)
    assert.equal((await collector.poll()).status, 'publication_recovered'); assert.equal(polls, 1)
    assert.equal((await call(home, 'resource-admission', policy)).allowed, true)
    assert.deepEqual((await call(remote, `monetary-quota?host=${remote.node}&profile=p`)).sources, [])
    const foreign = structuredClone(sent); foreign.accounting.action.observation.profile = 'foreign'
    await assert.rejects(remote.client.call(path, foreign), /foreign monetary resource/)
    const wrongSource = structuredClone(sent); wrongSource.accounting.action.observation.source = 'openrouter_key'
    await assert.rejects(remote.client.call(path, wrongSource), /foreign monetary resource or source/)
    await assert.rejects(prepareRemoteMonetaryCollector(remote.client, remote.node, 'p', 'worker', operation, { ...provider, source: 'openrouter_credits' }), /source unavailable/)
    amount = '0'; await collector.poll()
    assert.equal((await call(home, 'resource-admission', policy)).reason, 'provider_monetary_exhausted')
    await home.stop('SIGKILL'); await home.start()
    assert.equal((await call(home, 'resource-admission', policy)).reason, 'provider_monetary_exhausted')
    await call(home, 'resource-accounts', { id: 'account', expected_epoch: 1, enabled: true })
    await assert.rejects(collector.poll(), /binding is stale/)
    assert.equal((await call(home, `monetary-quota?host=${remote.node}&profile=p`)).sources[0].status, 'binding_changed')
  } finally { await home.close(); await remote.close() }
})

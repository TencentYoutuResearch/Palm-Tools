import test from 'node:test'
import assert from 'node:assert/strict'
import { resourceCoverage, registerResourceCoverage } from '../src/resource-coverage.js'
const profile = (id, type = 'codex') => ({ id, name: id, type, env: { PRIVATE: 'never-print-this' } })
const service = { profiles: { list: () => [profile('idle'), profile('unsupported', 'claude')], bindings: { old: { profile: profile('retired'), managedOperation: { home_node: 'remote-home' } } } }, hasRuntime: type => type === 'codex' }

test('inventory retains idle/unsupported/retired resources and pages without exposing configuration', async () => {
  const first = await resourceCoverage(service, null, 'host', { limit: 2 })
  const second = await resourceCoverage(service, null, 'host', { after: first.next_cursor, limit: 2 })
  const items = [...first.items, ...second.items]
  assert.equal(first.total, 3)
  assert.equal(second.next_cursor, null)
  assert.equal(new Set(items.map(row => row.profile_id)).size, 3)
  assert.equal(items.find(row => row.profile_id === 'unsupported').quota_status, 'source_unsupported')
  assert.deepEqual(items.find(row => row.profile_id === 'retired').remote_authorities, ['remote-home'])
  assert.ok(items.every(row => row.eligible_for_dispatch === false))
  assert.ok(items.every(row => row.grant_capability.status === 'unsupported' && !row.grant_capability.automatic_team_admission))
  assert.ok(!JSON.stringify(items).includes('never-print-this'))
})

test('inventory preserves authoritative exhaustion and explicitly reports unavailable resources', async () => {
  const one = { ...service, profiles: { list: () => [profile('p')], bindings: {} } }
  const client = { call: async path => path.includes('resource-binding?') ? { account_id: 'a', account_epoch: 1, revision: 2, binding_current: true } : { status: 'unavailable', buckets: [], exhaustion_evidence: { windows: [{ window_id: 'primary' }] } } }
  const result = await resourceCoverage(one, client, 'host')
  assert.equal(result.items[0].quota_status, 'exhausted')
  assert.equal(result.items[0].account.binding_revision, 2)
  const unavailable = await resourceCoverage(one, { call: async () => { throw new Error('private failure detail') } }, 'host')
  assert.equal(unavailable.items[0].quota_status, 'authority_unavailable')
  assert.ok(!JSON.stringify(unavailable).includes('private failure'))
})

test('coverage endpoint denies nonowners before reading resources and rejects invalid pages', async () => {
  let route, owner = false, reads = 0
  registerResourceCoverage({ webServer: { register: value => { route = value } }, connection: { admit: () => ({ peer: { principal: { kind: owner ? 'owner' : 'agent' } } }) } }, { ...service, profiles: { list: () => { reads++; return [] }, bindings: {} } }, null, 'host')
  const invoke = async url => {
    const res = { writeHead(code) { this.status = code }, end(body) { this.body = JSON.parse(body) } }
    await route.handler({ method: 'GET', url }, res)
    return res
  }
  assert.equal((await invoke('/api/kode/resource-coverage')).status, 403)
  assert.equal(reads, 0)
  owner = true
  assert.equal((await invoke('/api/kode/resource-coverage?limit=101')).status, 400)
  assert.equal((await invoke('/api/kode/resource-coverage')).status, 200)
})


test('coverage refuses to join a snapshot from a different account binding revision', async () => {
  const one = { ...service, profiles: { list: () => [profile('p')], bindings: {} } }
  const client = { call: async path => path.includes('resource-binding?') ? { account_id: 'new', account_epoch: 1, revision: 3, binding_current: true } : { account_id: 'old', account_epoch: 1, binding_revision: 1, buckets: [], exhaustion_evidence: { windows: [{ window_id: 'primary' }] } } }
  const { items } = await resourceCoverage(one, client, 'host')
  assert.equal(items[0].quota_status, 'binding_unavailable')
  assert.equal(items[0].exhausted, false)
})


for (const mode of ['legacy', 'foreign', 'offline']) test(`remote coverage reports ${mode} context without assuming quota`, async () => {
  const p = profile('p')
  const one = { ...service, profiles: { list: () => [p], bindings: { s: { profile: p, managedOperation: { id: 'op', attempt: 1, home_node: 'home' } } } } }
  const client = { call: async path => {
    if (!path.includes('operation-accounting-relay')) return {}
    if (mode === 'offline') throw new Error('offline')
    return { policy: { host: mode === 'foreign' ? 'foreign' : 'host', profile: 'p' }, binding: { host: 'host', profile: 'p' } }
  } }
  const { items } = await resourceCoverage(one, client, 'host')
  assert.equal(items[0].remote_attempts[0].quota_status, mode === 'legacy' ? 'snapshot_unsupported' : 'authority_unavailable')
  assert.equal(items[0].remote_attempts[0].eligible_for_dispatch, false)
})


test('official provider grant capability is conditional, never blanket team eligibility', async () => {
  const result = await resourceCoverage({ profiles: { list: () => [profile('official', 'dsh')], bindings: {} }, hasRuntime: () => true, officialResourceDirectory: () => ({ status: 'registered_only', items: [{ provider_id: 'fixture', name: 'Fixture', registered: true }] }) }, null, 'host')
  assert.equal(result.items.length, 2)
  for (const row of result.items) {
    assert.equal(row.grant_capability.status, 'conditional')
    assert.equal(row.grant_capability.automatic_team_admission, false)
    assert.equal(row.eligible_for_dispatch, false)
  }
})

test('coverage keeps monetary facts separate and old Hub absence does not erase quota windows', async () => {
  const one = { ...service, profiles: { list: () => [profile('p')], bindings: {} } }
  let moneyAvailable = true
  const client = { call: async path => {
    if (path.includes('monetary-quota')) {
      if (!moneyAvailable) throw new Error('unsupported endpoint')
      return { host: 'host', profile: 'p', sources: [{ source: 'deepseek_balance', status: 'authentication_unavailable', last_reported: null }], scope: 'provider_facts_not_team_budget' }
    }
    if (path.includes('resource-binding?')) return { account_id: 'a', account_epoch: 1, revision: 1, binding_current: true }
    return { buckets: [], exhaustion_evidence: { windows: [{ window_id: 'hour' }] } }
  } }
  const row = (await resourceCoverage(one, client, 'host')).items[0]
  assert.equal(row.provider_monetary.sources[0].status, 'authentication_unavailable')
  assert.equal(row.quota_status, 'exhausted')
  moneyAvailable = false
  const legacy = (await resourceCoverage(one, client, 'host')).items[0]
  assert.equal(legacy.provider_monetary.status, 'unavailable'); assert.equal(legacy.quota_status, 'exhausted')
})

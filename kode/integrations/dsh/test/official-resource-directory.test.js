import test from 'node:test'
import assert from 'node:assert/strict'
import { officialResourceDirectory } from '../src/official-resource-directory.js'
import { resourceCoverage } from '../src/resource-coverage.js'

test('official directory includes dormant routes and uses only cached allowlisted metadata', async () => {
  const llm = {
    listProviders: () => [{ id: 'live', name: 'Live', private: 'do-not-export' }, { id: 'kode-agent-p', name: 'Native' }],
    listConfigurableProviders: () => [{ provider: 'live', displayName: 'Old' }, { provider: 'dormant', displayName: 'Dormant', settingsNs: 'private', settingsPath: ['secret'] }],
    listModels: () => { throw new Error('must not start discovery') },
    exportProviderConfig: () => { throw new Error('must not read settings') },
  }
  const directory = officialResourceDirectory(llm)
  assert.equal(directory.status, 'registered_and_declared')
  assert.deepEqual(directory.items, [{ provider_id: 'live', name: 'Live', registered: true }, { provider_id: 'dormant', name: 'Dormant', registered: false }])
  const service = { profiles: { list: () => [], bindings: {} }, officialResourceDirectory: () => directory }
  const first = await resourceCoverage(service, null, 'host', { limit: 1 })
  const second = await resourceCoverage(service, null, 'host', { limit: 1, after: first.next_cursor })
  assert.equal(first.total, 2)
  assert.equal(second.next_cursor, null)
  for (const row of [...first.items, ...second.items]) {
    assert.equal(row.resource_kind, 'official_loop_provider')
    assert.equal(row.eligible_for_dispatch, false)
    assert.equal(row.model_catalog_status, 'not_collected')
    assert.equal(row.quota_status, 'source_not_connected')
  }
  assert.ok(!JSON.stringify(first).includes('secret'))
  assert.ok(!JSON.stringify(second).includes('do-not-export'))
})

test('directory removal and discovery failure are reflected without stale fallback', () => {
  let items = [{ id: 'live', name: 'Live' }]
  const llm = { listProviders: () => items }
  assert.equal(officialResourceDirectory(llm).status, 'registered_only')
  items = []
  assert.equal(officialResourceDirectory(llm).items.length, 0)
  assert.equal(officialResourceDirectory({ listProviders() { throw new Error('private provider failure') } }).status, 'unavailable')
  assert.equal(officialResourceDirectory(null).status, 'unavailable')
})

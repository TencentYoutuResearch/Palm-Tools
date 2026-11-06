import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentProfiles } from '../src/agent-profiles.js'
import { QuotaInvalidations } from '../src/quota-invalidations.js'

test('lost invalidation response recovers across restart without releasing the local fence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-quota-replay-'))
  const path = join(root, 'profiles.json')
  let service
  try {
    const profiles = await new AgentProfiles(path).open([{ id: 'worker', type: 'codex', name: 'Worker' }])
    await profiles.bind('session', 'worker')
    await profiles.patchBinding('session', { quotaFenceRevision: 3 })
    let current = { revision: 3, binding_current: true }, posts = 0
    const client = { call: async (_path, input) => {
      if (!input) return current
      posts++; current = { revision: 4, binding_current: false }
      throw new Error('response lost after commit')
    } }
    service = new QuotaInvalidations(client, 'home', profiles)
    await service.tick()
    assert.equal(profiles.binding('session').quotaFenceReconciledRevision, undefined)
    await service.close()
    const reopened = await new AgentProfiles(path).open()
    service = new QuotaInvalidations(client, 'home', reopened)
    await service.tick()
    assert.equal(posts, 1)
    assert.equal(reopened.binding('session').quotaFenceReconciledRevision, 3)
    assert.equal(reopened.binding('session').quotaFenceRevision, 3)
    await service.tick()
    assert.equal(service.pending().length, 0)
  } finally { await service?.close(); await rm(root, { recursive: true, force: true }) }
})

test('replay never revokes a newer owner binding and coalesces concurrent ticks', async () => {
  let reads = 0, writes = 0, release
  const profiles = { bindings: { one: { profile: { id: 'p' }, quotaFenceRevision: 2 }, two: { profile: { id: 'p' }, quotaFenceRevision: 2 } }, update: async operation => operation(profiles) }
  const client = { call: async (_path, body) => {
    if (body) { writes++; throw new Error('must not invalidate newer binding') }
    reads++; await new Promise(resolve => { release = resolve })
    return { revision: 4, binding_current: true }
  } }
  const service = new QuotaInvalidations(client, 'home', profiles)
  try {
    const first = service.tick(), second = service.tick()
    assert.equal(first, second)
    release(); await first
    assert.equal(reads, 1); assert.equal(writes, 0)
    assert.equal(profiles.bindings.two.quotaFenceReconciledRevision, 2)
  } finally { await service.close() }
})

test('failed resources do not starve later invalidations and closed service stops polling', async () => {
  const profiles = { bindings: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i, { profile: { id: `p${i}` }, quotaFenceRevision: 1 }])), update: async operation => operation(profiles) }
  const seen = new Set()
  const service = new QuotaInvalidations({ call: async path => { seen.add(path); throw new Error('offline') } }, 'home', profiles)
  await service.tick(); await service.tick()
  assert.equal(seen.size, 20)
  assert.equal(service.pending().length, 20)
  await service.close()
  await service.tick()
  assert.equal(seen.size, 20)
})

test('shutdown aborts an in-flight retry without acknowledging it', async () => {
  const profiles = { bindings: { one: { profile: { id: 'p' }, quotaFenceRevision: 1 } }, update: async () => { throw new Error('must not mark reconciled') } }
  let transportSignal
  const client = { call: async (_path, _body, signal) => { transportSignal = signal; await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) } }
  const service = new QuotaInvalidations(client, 'home', profiles)
  const pending = service.tick()
  await service.close(); await pending
  assert.equal(transportSignal.aborted, true)
  assert.equal(profiles.bindings.one.quotaFenceReconciledRevision, undefined)
})

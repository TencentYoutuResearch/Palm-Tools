import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProfiles } from '../src/agent-profiles.js'
import { RemoteQuotaInvalidations } from '../src/remote-quota-invalidations.js'

test('remote fence survives restart and retries its frozen home/attempt after lost response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-remote-quota-fence-'))
  const path = join(root, 'profiles.json')
  let service
  try {
    const profiles = await new AgentProfiles(path).open([{ id: 'worker', type: 'codex', name: 'Worker' }])
    await profiles.bind('session', 'worker')
    const calls = []
    const client = { call: async (route, command) => {
      if (command.accounting.action.kind === 'resource_context') throw new Error('home offline')
      calls.push({ route, command })
      if (calls.length === 1) throw new Error('response lost after commit')
      return { invalidated: true }
    } }
    service = new RemoteQuotaInvalidations(client, profiles)
    await service.record('session', 'worker', 'home-a', { id: 'op', attempt: 2 }, 3)
    await service.record('session', 'worker', 'home-a', { id: 'op', attempt: 2 }, 3)
    assert.equal(service.pending().length, 1)
    await service.tick()
    assert.equal(service.pending().length, 1)
    await service.close()
    const reopened = await new AgentProfiles(path).open()
    await reopened.patchBinding('session', { managedOperation: { id: 'replacement', attempt: 1, home_node: 'home-b' } })
    service = new RemoteQuotaInvalidations(client, reopened)
    assert.equal(service.fence('home-a', 'worker'), 3)
    assert.equal(service.fence('home-b', 'worker'), 0)
    await service.tick()
    assert.deepEqual(calls[1], calls[0])
    assert.equal(calls[1].command.accounting.attempt, 2)
    assert.equal(service.pending().length, 0)
    assert.equal(service.fence('home-a', 'worker'), 3, 'acknowledgement never clears the local fence')
  } finally { await service?.close(); await rm(root, { recursive: true, force: true }) }
})

test('remote invalidation shutdown aborts without acknowledging pending work', async () => {
  const profiles = { bindings: { session: { profile: { id: 'p' } } }, update: async fn => fn(profiles) }
  let signal
  const service = new RemoteQuotaInvalidations({ call: async (_route, _body, value) => {
    signal = value
    await new Promise((_, reject) => value.addEventListener('abort', () => reject(value.reason), { once: true }))
  } }, profiles)
  await service.record('session', 'p', 'home', { id: 'op', attempt: 1 }, 1)
  const first = service.tick()
  assert.equal(first, service.tick())
  await service.close(); await first
  assert.equal(signal.aborted, true)
  assert.equal(service.pending().length, 1)
})

for (const mode of ['newer', 'older', 'foreign', 'unchanged']) test(`remote invalidation reconciliation: ${mode}`, async () => {
  const profiles = { bindings: { session: { profile: { id: 'p' } } }, update: async fn => fn(profiles) }
  let writes = 0
  const service = new RemoteQuotaInvalidations({ call: async (_route, body) => {
    if (body.accounting.action.kind === 'invalidate_quota') { writes++; throw new Error('revision conflict') }
    return { policy: { host: 'worker-host', profile: 'p', binding_revision: 3 },
      binding: { host: 'worker-host', profile: mode === 'foreign' ? 'other' : 'p', revision: mode === 'older' ? 2 : mode === 'unchanged' ? 3 : 5, binding_current: true } }
  } }, profiles)
  try {
    await service.record('session', 'p', 'home', { id: 'op', attempt: 1 }, 3)
    await service.tick()
    assert.equal(service.pending().length, mode === 'newer' ? 0 : 1)
    assert.equal(service.fence('home', 'p'), 3)
    assert.equal(writes, 1)
  } finally { await service.close() }
})


test('acknowledged history compacts per home while all pending attempts remain durable', async () => {
  const profiles = { bindings: { session: { profile: { id: 'p' } } }, update: async fn => fn(profiles) }
  const service = new RemoteQuotaInvalidations({ call: async (_route, body) => {
    if (body.operation_id === 'pending') throw new Error('offline')
    return { invalidated: true }
  } }, profiles)
  try {
    await service.record('session', 'p', 'home', { id: 'pending', attempt: 1 }, 1)
    for (let revision = 2; revision <= 40; revision++) {
      await service.record('session', 'p', 'home', { id: `op${revision}`, attempt: 1 }, revision)
      await service.tick()
    }
    await service.record('session', 'p', 'other-home', { id: 'other', attempt: 1 }, 2)
    await service.tick()
    assert.equal(service.pending().length, 1)
    assert.equal(service.pending()[0].operation_id, 'pending')
    assert.equal(profiles.bindings.session.remoteQuotaFences.length, 3)
    assert.equal(service.fence('home', 'p'), 40)
    assert.equal(service.fence('other-home', 'p'), 2)
  } finally { await service.close() }
})

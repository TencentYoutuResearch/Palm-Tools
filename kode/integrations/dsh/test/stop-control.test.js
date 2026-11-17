import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerStopControl } from '../src/stop-control.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { AgentRuntimeAdapter } from '../src/agent-runtime.js'

test('stop control rejects non-owner before reading body or touching runtime', async () => {
  let route
  registerStopControl({ webServer: { register: value => { route = value } }, connection: { admit: () => ({ peer: { principal: { kind: 'agent' } } }) }, get() { throw new Error('must not access runtime') } })
  const response = { writeHead(status) { this.status = status }, end(text) { this.body = JSON.parse(text) } }
  await route.handler({ async *[Symbol.asyncIterator]() { throw new Error('must not read body') } }, response)
  assert.equal(response.status, 403)
})

test('owner reconciliation persists attestation, rejects stale fence and never marks execution successful', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-stop-control-'))
  const profiles = await new AgentProfiles(join(root, 'agents.json')).open([{ id: 'fixture', name: 'Fixture', type: 'codex', executable: process.execPath }])
  await profiles.bind('worker', 'fixture')
  const evidence = { spawned: true, leader_exited: false, signal_failures: [], descendants_confirmed: false }
  await profiles.patchBinding('worker', { stopBlocked: true, stopFenceId: 'first-fence', stopEvidence: evidence, lastOutcome: 'uncertain' })
  let route, wakes = 0
  const ctx = { agents: { get: () => ({ wake() { wakes++ } }) }, webServer: { register: value => { route = value } }, connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }, get: () => ({ adapter }) }
  const adapter = new AgentRuntimeAdapter(ctx, profiles)
  registerStopControl(ctx)
  const call = async input => {
    const res = { writeHead(status) { this.status = status }, end(text) { this.body = JSON.parse(text) } }
    await route.handler({ method: 'POST', headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield JSON.stringify(input) } }, res)
    return res
  }
  const request = { session_id: 'worker', action: 'reconcile', expected_fence_id: 'first-fence', processes_checked: true, reason: 'Inspected owned processes and external work' }
  try {
    assert.equal((await call({ session_id: 'worker', action: 'status' })).body.fence_id, 'first-fence')
    assert.equal((await call({ ...request, processes_checked: false })).status, 400)
    adapter.busy.add('worker')
    assert.equal((await call(request)).status, 400)
    adapter.busy.delete('worker')
    assert.equal((await call(request)).status, 200)
    assert.equal(wakes, 0, 'release alone does not resume queued work')
    assert.equal((await call(request)).status, 200)
    assert.equal(profiles.binding('worker').stopReconciliations.length, 1)
    assert.equal(profiles.binding('worker').lastOutcome, 'uncertain')
    const reopened = await new AgentProfiles(profiles.path).open()
    assert.equal(reopened.binding('worker').stopReconciliations[0].kind, 'manual_attestation')
    await profiles.patchBinding('worker', { stopBlocked: true, stopFenceId: 'new-fence' })
    assert.equal((await call({ ...request, resume: true })).status, 400)
    assert.equal(wakes, 0)
    assert.equal(profiles.binding('worker').stopBlocked, true)
    assert.equal((await call({ ...request, expected_fence_id: 'new-fence', resume: true })).status, 200)
    assert.equal(wakes, 1)
    assert.equal(profiles.binding('worker').stopReconciliations.length, 2)
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }) }
})
test('late stop cannot overwrite direct insertion fence; owner resume clears scheduler guards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-direct-fence-'))
  const profiles = await new AgentProfiles(join(root, 'agents.json')).open([{ id: 'fixture', name: 'Fixture', type: 'codex', executable: process.execPath }])
  await profiles.bind('worker', 'fixture')
  await profiles.patchBinding('worker', { stopBlocked: true, stopFenceId: 'direct-fence', directInsertFenceId: 'direct-fence' })
  let wakes = 0
  const agent = { id: 'worker', session: {}, parked: true, directInsertBlocked: true, wake() { assert.equal(this.parked, false); assert.equal(this.directInsertBlocked, false); wakes++ } }
  const ctx = { agents: { get: () => agent }, sessionProjections: { stateOf: () => ({ lastTurn: 1, lastStepBoundary: { kind: 'start', step: 1 } }) } }
  const adapter = new AgentRuntimeAdapter(ctx, profiles, { recordNative() {} })
  try {
    await adapter.recordStop(agent, { close: async () => ({ spawned: true, leader_exited: true, signal_scope: 'leader', signal_failures: [] }) })
    assert.equal(profiles.binding('worker').stopBlocked, true)
    assert.equal(profiles.binding('worker').stopFenceId, 'direct-fence')
    await adapter.reconcileStop({ session_id: 'worker', expected_fence_id: 'direct-fence', reason: 'Checked owned process group', processes_checked: true, resume: true })
    assert.equal(wakes, 1); assert.equal(profiles.binding('worker').directInsertFenceId, null)
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }) }
})

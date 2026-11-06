import test from 'node:test'
import assert from 'node:assert/strict'
import { registerOperationControl } from '../src/operation-control.js'
test('operation attachment requires owner and fences idle session while persisting binding', async () => {
  let route, principal = 'agent', maintenance = false, writes = 0
  const binding = {}, agent = { id: 'worker', isKodeNativeAgent: true, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, runMaintenance: async job => { maintenance = true; try { return await job() } finally { maintenance = false } } }
  const service = { adapter: { busy: new Set() }, profiles: { binding: () => binding, update: async job => { assert.equal(maintenance, true); writes++; return job({ bindings: { worker: binding } }) } } }
  const backend = { call: async path => { assert.equal(maintenance, true); return path.endsWith('/node') ? { node_id: 'local' } : { id: 'op', attempt: 1, epoch: 1, budget_required: true, revision: 1, state: 'prepared', worker: { node_id: 'local', session_id: 'worker' } } } }
  registerOperationControl({ webServer: { register: value => { route = value } }, connection: { admit: () => ({ peer: { principal: { kind: principal } } }) }, agents: { get: () => agent }, get: key => key === 'kodeAgents' ? service : backend })
  const call = async input => {
    const res = { writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
    await route.handler({ method: 'POST', headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield JSON.stringify(input) } }, res)
    return res
  }
  const request = { session_id: 'worker', operation_id: 'op', expected_revision: 1 }
  assert.equal((await call(request)).status, 403); assert.equal(writes, 0)
  principal = 'owner'
  assert.equal((await call({ ...request, expected_revision: 2 })).status, 400); assert.equal(writes, 0)
  const result = await call(request)
  assert.equal(result.status, 200); assert.equal(result.body.started, false)
  assert.deepEqual(binding.managedOperation, { id: 'op', attempt: 1, epoch: 1, budget_required: true })
  assert.equal((await call(request)).status, 400, 'cannot replace unresolved assignment')
})

test('remote attachment pins home Hub and preserves the mandatory budget requirement', async () => {
  let route, budget = false
  const binding = {}, agent = { id: 'worker', isKodeNativeAgent: true, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, runMaintenance: job => job() }
  const service = { adapter: { busy: new Set() }, profiles: { binding: () => binding, update: job => job({ bindings: { worker: binding } }) } }
  const backend = { call: async (path, body) => {
    if (path.endsWith('/node')) return { node_id: 'remote' }
    assert.equal(path, '/api/v1/messaging/operation-relay/home')
    assert.deepEqual(body, { operation_id: 'op', worker_session: 'worker', command: null })
    return { id: 'op', attempt: 1, epoch: 2, revision: 3, state: 'prepared', budget_required: budget, worker: { node_id: 'remote', session_id: 'worker' } }
  } }
  registerOperationControl({ webServer: { register: value => { route = value } }, connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }, agents: { get: () => agent }, get: key => key === 'kodeAgents' ? service : backend })
  const call = async () => {
    const res = { writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
    await route.handler({ method: 'POST', headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield JSON.stringify({ session_id: 'worker', operation_id: 'op', home_node: 'home', expected_revision: 3 }) } }, res)
    return res
  }
  budget = true
  assert.equal((await call()).status, 200)
  assert.equal(binding.managedOperation.budget_required, true)
  assert.equal(binding.managedOperation.home_node, 'home')
  assert.equal(binding.managedOperation.epoch, 2)
})

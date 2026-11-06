import test from 'node:test'
import assert from 'node:assert/strict'
import { acquireOperationLease } from '../src/operation-lease.js'
const binding = { id: 'operation', attempt: 1, epoch: 1 }, worker = { node_id: 'local', session_id: 'worker' }
function fixture() {
  const state = { row: { ...binding, worker, revision: 1, state: 'prepared' }, commands: [], failRenew: false }
  state.client = { call: async (_, command) => {
    if (!command) return structuredClone(state.row)
    state.commands.push(command)
    if (command.action.kind === 'renew' && state.failRenew) throw new Error('network unavailable')
    assert.equal(command.expected_revision, state.row.revision)
    state.row = { ...state.row, revision: state.row.revision + 1, state: command.action.kind === 'report' ? 'reported' : 'active' }
    return { applied: true, operation: structuredClone(state.row) }
  } }
  return state
}
test('operation lease validates every admission, reports once and never restarts an active operation', async () => {
  const h = fixture(), lease = await acquireOperationLease(h.client, binding, worker)
  try {
    await lease.assertActive()
    await lease.finish()
    assert.equal(h.row.state, 'reported')
    await assert.rejects(lease.assertActive(), /not active/)
    await assert.rejects(acquireOperationLease(h.client, binding, worker), /identity or state/)
    assert.equal(h.commands.filter(c => c.action.kind === 'claim').length, 1)
  } finally { lease.dispose() }
})
test('renewal transport failure aborts execution rather than extending local authority', async () => {
  const h = fixture(), lease = await acquireOperationLease(h.client, binding, worker, { leaseMs: 150 })
  h.failRenew = true
  try {
    await new Promise(resolve => lease.signal.addEventListener('abort', resolve, { once: true }))
    assert.match(lease.signal.reason.message, /network unavailable/)
    await assert.rejects(lease.assertActive(), /network unavailable/)
  } finally { lease.dispose() }
})
test('epoch changes and parent cancellation deny tool admission and new claims', async () => {
  const h = fixture(), lease = await acquireOperationLease(h.client, binding, worker)
  try {
    h.row.epoch++
    await assert.rejects(lease.assertActive(), /identity or state/)
    assert.equal(lease.signal.aborted, true)
  } finally { lease.dispose() }
  const abort = new AbortController(); abort.abort(new Error('cancelled before claim'))
  const fresh = fixture()
  await assert.rejects(acquireOperationLease(fresh.client, binding, worker, { signal: abort.signal }), /cancelled before claim/)
  assert.equal(fresh.commands.length, 0)
})
test('lost claim response leaves uncertain authority and never invokes another claim', async () => {
  const h = fixture(), call = h.client.call
  h.client.call = async (path, command) => { const result = await call(path, command); if (command?.action.kind === 'claim') throw new Error('response lost'); return result }
  await assert.rejects(acquireOperationLease(h.client, binding, worker), /response lost/)
  assert.equal(h.row.state, 'active')
  await assert.rejects(acquireOperationLease(h.client, binding, worker), /identity or state/)
  assert.equal(h.commands.length, 1)
})

test('a stuck renewal cannot outlive the independently armed local deadline', async () => {
  const h = fixture(), original = h.client.call
  h.client.call = (path, command) => command?.action.kind === 'renew' ? new Promise(() => {}) : original(path, command)
  const lease = await acquireOperationLease(h.client, binding, worker, { leaseMs: 150 })
  try {
    await new Promise(resolve => lease.signal.addEventListener('abort', resolve, { once: true }))
    assert.match(lease.signal.reason.message, /expired locally/)
  } finally { lease.dispose() }
})

test('budgeted leases respect shortened grants and reject budget revocation on tool admission', async () => {
  const h = fixture()
  Object.assign(h.row, { budget_required: true, budget_available: true, lease_duration_ms: 50 })
  const original = h.client.call
  h.client.call = async (path, command) => command?.action.kind === 'renew' ? new Promise(() => {}) : original(path, command)
  const lease = await acquireOperationLease(h.client, binding, worker, { leaseMs: 1000 })
  try {
    await new Promise(resolve => lease.signal.addEventListener('abort', resolve, { once: true }))
    assert.match(lease.signal.reason.message, /expired locally/)
  } finally { lease.dispose() }
  const other = fixture()
  Object.assign(other.row, { budget_required: true, budget_available: true, lease_duration_ms: 1000 })
  const live = await acquireOperationLease(other.client, binding, worker, { leaseMs: 1000 })
  try {
    other.row.budget_available = false
    await assert.rejects(live.assertActive(), /budget is not available/)
  } finally { live.dispose() }
})

test('remote lease routes worker-scoped calls home and aborts on relay loss', async () => {
  const h = fixture(), paths = []
  const client = { call: async (path, envelope, signal) => {
    paths.push(path)
    assert.equal(envelope.operation_id, binding.id)
    assert.equal(envelope.worker_session, worker.session_id)
    return h.client.call(path, envelope.command, signal)
  } }
  const lease = await acquireOperationLease(client, { ...binding, home_node: 'home' }, worker, { leaseMs: 150 })
  h.failRenew = true
  try {
    await new Promise(resolve => lease.signal.addEventListener('abort', resolve, { once: true }))
    assert.ok(paths.every(path => path === '/api/v1/messaging/operation-relay/home'))
    assert.equal(h.commands.filter(c => c.action.kind === 'claim').length, 1)
    await assert.rejects(lease.assertActive())
  } finally { lease.dispose() }
})

test('resource-required lease checks actual profile, resource revocation and capped duration', async () => {
  const h = fixture()
  h.row.resource_required = true; h.row.resource_available = true
  h.row.resource = { host: 'local', profile: 'configured', account_epoch: 2, binding_revision: 3 }; h.row.lease_duration_ms = 150
  await assert.rejects(acquireOperationLease(h.client, binding, worker, { leaseMs: 1000 }), /resource does not match/)
  assert.equal(h.commands.length, 0)
  const lease = await acquireOperationLease(h.client, binding, { ...worker, profile_id: 'configured' }, { leaseMs: 1000 })
  try {
    assert.deepEqual(h.commands[0].action.resource, { profile: 'configured', account_epoch: 2, binding_revision: 3 })
    assert.equal(h.commands[0].action.kind, 'claim_resource')
    h.row.resource_available = false
    await assert.rejects(lease.assertActive(), /resource is not available/)
    assert.equal(lease.signal.aborted, true)
  } finally { lease.dispose() }
})

test('strict selection capability is required before claim and frozen during the lease', async () => {
  const h = fixture()
  const policy = { profile_revision: 'revision', model: 'chosen', effort: null, scope: 'executor_configuration' }
  h.row.selection_policy = policy
  await assert.rejects(acquireOperationLease(h.client, binding, worker), error => error.code === 'selection_enforcement_unsupported')
  await assert.rejects(acquireOperationLease(h.client, binding, worker, { beforeClaim: async () => false }), /cannot enforce/)
  assert.equal(h.commands.length, 0)
  const lease = await acquireOperationLease(h.client, binding, worker, { beforeClaim: async value => { assert.deepEqual(value, policy); return true } })
  try {
    assert.deepEqual(h.commands[0].selection_ack, policy)
    const copy = lease.selectionPolicy; copy.model = 'tampered'
    assert.equal(lease.selectionPolicy.model, 'chosen')
    h.row.selection_policy = { ...policy, model: 'changed' }
    await assert.rejects(lease.assertActive(), /selection policy changed/)
    assert.equal(lease.signal.aborted, true)
    assert.equal(h.commands.filter(row => row.action.kind === 'report').length, 0)
  } finally { lease.dispose() }
})


test('reporting an unexpired lease tolerates exhausted resources but never revives fenced execution', async () => {
  for (const fault of ['resource', 'budget', 'epoch', 'abort']) {
    const h = fixture(), controller = new AbortController()
    Object.assign(h.row, { grant_required: true, grant_available: true, budget_required: true, budget_available: true,
      resource_required: true, resource_available: true, lease_duration_ms: 30000,
      resource: { host: 'local', profile: 'configured', account_epoch: 1, binding_revision: 1 } })
    const lease = await acquireOperationLease(h.client, binding, { ...worker, grant_enforcement: true, profile_id: 'configured' }, { signal: controller.signal })
    try {
      if (fault === 'epoch') h.row.epoch++
      else if (fault === 'abort') controller.abort(new Error('stopped'))
      else {
        h.row[`${fault}_available`] = false
        // Assignment availability combines execution readiness with authority;
        // the report command itself must recheck actual authority at the Hub.
        h.row.grant_available = false
      }
      if (fault === 'epoch' || fault === 'abort') {
        await assert.rejects(lease.finish(), /identity or state|stopped/)
        assert.equal(h.commands.filter(c => c.action.kind === 'report').length, 0)
      } else {
        await lease.assertReportable()
        await lease.finish()
        assert.equal(h.row.state, 'reported')
        await assert.rejects(lease.assertActive(), /not active/)
        assert.equal(h.commands.filter(c => c.action.kind === 'report').length, 1)
      }
    } finally { lease.dispose() }
  }
})

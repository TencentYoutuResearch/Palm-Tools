/** Actual HTTP + durable Hub ledger. No model inference or user configuration. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'

const options = { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }
const command = (op, action) => ({ attempt: op.attempt, epoch: op.epoch, expected_revision: op.revision, action })
const evidence = op => ({
  record_id: 'selection', operation_id: op.id, worker_session: 'worker', attempt: op.attempt, epoch: op.epoch,
  profile_revision: 'profile-revision', thread_id: 'thread', turn_id: 'turn', input_ids: ['input'],
  scope: 'executor_configuration', observed_at: 1, rejected: false,
  model: { requested: 'chosen', observed: 'different', status: 'reported', source: 'session/set_config_option' },
  effort: { requested: 'high', observed: null, status: 'unverifiable', source: null },
})
async function setup(name) {
  const hub = await isolatedHub(name)
  try {
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const op = await hub.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: name, worker: { node_id: hub.node, session_id: 'worker' } })
    return { hub, worker, op }
  } catch (error) { await hub.close(); throw error }
}

test('home selection rejection survives restart and cannot be overwritten by positive evidence', options, async () => {
  const { hub, worker, op } = await setup('selection-home')
  const path = `/api/v1/messaging/operations/${op.id}`
  const route = '/api/v1/messaging/selection-evidence'
  try {
    const input = evidence(op)
    await assert.rejects(worker.call(route, input), /403/)
    await assert.rejects(hub.client.call(route, input), /admitted attempt/)
    const active = (await worker.call(path, command(op, { kind: 'claim', lease_ms: 60000 }))).operation
    await assert.rejects(hub.client.call(route, { ...input, worker_session: 'foreign' }), /foreign/)
    await assert.rejects(hub.client.call(route, { ...input, epoch: 2 }), /foreign/)
    await assert.rejects(hub.client.call(route, { ...input, attempt: 2 }), /foreign/)
    await assert.rejects(hub.client.call(route, { ...input, input_ids: [] }), /bounds/)
    const receipt = await hub.client.call(route, input)
    assert.equal(receipt.rejected, true) // derived despite caller false/reported
    await hub.stop('SIGKILL'); await hub.start()
    const replay = await hub.client.call(route, input)
    assert.equal(replay.duplicate, true); assert.equal(replay.sequence, receipt.sequence)
    await assert.rejects(hub.client.call(route, { ...input, rejected: true }), /identity conflict/)
    const positive = { ...input, record_id: 'later-match', model: { ...input.model, observed: 'chosen' } }
    assert.equal((await hub.client.call(route, positive)).rejected, false)
    await assert.rejects(worker.call(path, command(active, { kind: 'renew', lease_ms: 60000 })), /selection evidence rejected/)
    await assert.rejects(hub.client.call('/api/v1/messaging/official-calls', {
      call_id: 'blocked-call', operation_id: op.id, worker_session: 'worker', attempt: 1, epoch: 1, provider: 'fixture', model: 'chosen',
    }), /selection evidence rejected/)
    const denied = await worker.call(path, command(active, { kind: 'report', report_id: 'report', content: 'ready' }))
    assert.equal(denied.applied, false); assert.equal(denied.reason, 'selection_rejected')
    assert.equal(denied.operation.state, 'active')
    const cancelled = (await hub.client.call(path, command(active, { kind: 'cancel' }))).operation
    const stopped = (await hub.client.call(path, command(cancelled, { kind: 'attest_stopped', reason: 'fixture has no executing process' }))).operation
    const next = (await hub.client.call(path, command(stopped, { kind: 'next_attempt' }))).operation
    const active2 = (await worker.call(path, command(next, { kind: 'claim', lease_ms: 60000 }))).operation
    // Old-attempt rejection is retained, but cannot poison the new attempt.
    await hub.client.call(route, { ...input, record_id: 'late-old' })
    const reported = await worker.call(path, command(active2, { kind: 'report', report_id: 'report-2', content: 'new attempt' }))
    assert.equal(reported.applied, true)
    const late = { ...evidence(active2), record_id: 'late-terminal' }
    await hub.client.call(route, late)
    const duplicate = await worker.call(path, command(active2, { kind: 'report', report_id: 'report-2', content: 'new attempt' }))
    assert.equal(duplicate.applied, true) // historical receipt remains immutable
    const audit = await hub.client.call(`${path}/events?after=0`)
    assert.equal(audit.events.filter(row => row.data.kind === 'selection_evidence').length, 4)
  } finally { await hub.close() }
})

test('unknown selection remains unknown; explicit missing-confirmation rejection blocks reporting', options, async () => {
  const { hub, worker, op } = await setup('selection-unknown')
  const path = `/api/v1/messaging/operations/${op.id}`
  const route = '/api/v1/messaging/selection-evidence'
  try {
    let active = (await worker.call(path, command(op, { kind: 'claim', lease_ms: 60000 }))).operation
    const input = { ...evidence(op), model: { requested: 'chosen', observed: null, status: 'unverifiable', source: null } }
    assert.equal((await hub.client.call(route, input)).rejected, false)
    active = (await worker.call(path, command(active, { kind: 'renew', lease_ms: 60000 }))).operation
    await assert.rejects(hub.client.call(route, { ...input, record_id: 'invalid', model: { ...input.model, status: 'reported' } }), /requires observation/)
    const denied = await hub.client.call(route, { ...input, record_id: 'missing-confirmation', rejected: true })
    assert.equal(denied.evidence.model.status, 'unverifiable'); assert.equal(denied.rejected, true)
    const result = await worker.call(path, command(active, { kind: 'report', report_id: 'report', content: 'ready' }))
    assert.equal(result.applied, false); assert.equal(result.reason, 'selection_rejected')
  } finally { await hub.close() }
})

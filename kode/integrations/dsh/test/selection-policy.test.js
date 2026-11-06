import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'

test('home selection policy is immutable and requires one matching reported observation', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let hub
  try {
    hub = await isolatedHub('selection-policy')
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const selection_policy = { profile_revision: 'revision', model: 'chosen', effort: 'high', scope: 'inference' }
    const prepare = { owner_session: 'owner', request_key: 'strict', worker: { node_id: hub.node, session_id: 'worker' }, selection_policy }
    const op = await hub.client.call('/api/v1/messaging/operations', prepare)
    assert.deepEqual(op.selection_policy, selection_policy)
    assert.equal((await hub.client.call('/api/v1/messaging/operations', prepare)).id, op.id)
    await assert.rejects(hub.client.call('/api/v1/messaging/operations', { ...prepare, selection_policy: null }), /conflict/)
    await assert.rejects(hub.client.call('/api/v1/messaging/operations', { ...prepare, selection_policy: { ...selection_policy, effort: null } }), /conflict/)
    const path = `/api/v1/messaging/operations/${op.id}`
    const claim = { attempt: 1, epoch: 1, expected_revision: 1, action: { kind: 'claim', lease_ms: 60000 } }
    await assert.rejects(worker.call(path, claim), /policy acknowledgement required/)
    await assert.rejects(worker.call(path, { ...claim, selection_ack: { ...selection_policy, effort: null } }), /policy acknowledgement required/)
    assert.equal((await hub.client.call(path)).state, 'prepared')
    const active = (await worker.call(path, { ...claim, selection_ack: selection_policy })).operation
    const renewal = { attempt: 1, epoch: 1, expected_revision: active.revision, action: { kind: 'renew', lease_ms: 60000 } }
    await assert.rejects(worker.call(path, renewal), /policy acknowledgement required/)
    assert.equal((await hub.client.call(path)).revision, active.revision)
    let count = 0
    const report = () => worker.call(path, { attempt: 1, epoch: 1, expected_revision: active.revision, action: { kind: 'report', report_id: `report-${++count}`, content: 'done' } })
    const denied = async () => { const result = await report(); assert.equal(result.applied, false); assert.equal(result.reason, 'selection_unverified') }
    await denied()
    const base = { operation_id: op.id, worker_session: 'worker', attempt: 1, epoch: 1, profile_revision: 'revision', thread_id: 'thread', turn_id: 'turn', input_ids: ['input'], scope: 'inference', observed_at: 1, rejected: false,
      model: { requested: 'chosen', observed: 'chosen', status: 'reported', source: 'fixture' }, effort: { requested: 'high', observed: 'high', status: 'reported', source: 'fixture' } }
    const record = (id, changes) => hub.client.call('/api/v1/messaging/selection-evidence', { record_id: id, ...base, ...changes })
    await record('pending', { model: { requested: 'chosen', observed: null, status: 'pending', source: null } }); await denied()
    await record('configuration', { scope: 'executor_configuration' }); await denied()
    await record('old-profile', { profile_revision: 'old' }); await denied()
    await record('wrong-model', { model: { ...base.model, requested: 'other', observed: 'other' } }); await denied()
    await record('model-only', { effort: { requested: 'high', observed: null, status: 'unverifiable', source: null } }); await denied()
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual((await hub.client.call(path)).selection_policy, selection_policy)
    await denied()
    await record('matching', {})
    assert.equal((await report()).applied, true)
  } finally { await hub?.close() }
})

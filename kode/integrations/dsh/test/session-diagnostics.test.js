import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'

test('session diagnostics are scoped, bounded and preserve durable evidence across restart', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let hub
  try {
    hub = await isolatedHub('diagnostics')
    const register = async id => hub.client.call('/api/v1/messaging/sessions', { session_id: id, title: id, runtime: 'external' })
    const a = await register('sender'), b = await register('worker')
    const sender = hub.client.forSession(a.owner_token), worker = hub.client.forSession(b.owner_token)
    const path = '/api/v1/messaging/sessions/worker/diagnostics'
    await assert.rejects(sender.call(path), /403/)
    const empty = await worker.call(path)
    assert.deepEqual(empty.incoming.counts, {})
    assert.equal(empty.runtime_liveness, 'not_probed')
    for (let i = 0; i < 13; i++) await sender.call('/api/v1/messaging/messages', {
      target: { node_id: hub.node, session_id: 'worker' }, content: 'private fixture content', idempotency_key: `diag-${i}`,
    })
    const initial = await worker.call(path)
    assert.equal(initial.incoming.counts.received, 13)
    assert.equal(initial.incoming.samples.length, 10)
    assert.equal(initial.incoming.samples_truncated, true)
    const claim = await worker.call('/api/v1/messaging/sessions/worker/claim', {})
    const id = claim.messages[0].id
    for (const phase of ['prepared', 'queued']) await worker.call(`/api/v1/messaging/messages/${id}/delivery`, { session_id: 'worker', input_id: 'input', phase })
    await sender.call(`/api/v1/messaging/messages/${id}/cancellation`, {})
    const queued = await worker.call(path)
    assert.equal(queued.incoming.counts.accepted, 1)
    assert.deepEqual(queued.delivery_evidence, { prepared: 0, queued: 1, consumed: 0 })
    assert.equal(queued.pending_cancellations, 1)
    assert.ok(!JSON.stringify(queued).includes('private fixture content'))
    assert.equal((await sender.call('/api/v1/messaging/sessions/sender/diagnostics')).outgoing.counts.accepted, 1)
    await hub.stop('SIGKILL'); await hub.start()
    const restored = await hub.client.forSession(b.owner_token).call(path)
    assert.deepEqual(restored.delivery_evidence, queued.delivery_evidence)
    assert.equal(restored.pending_cancellations, 1)
    await hub.client.forSession(b.owner_token).call(`/api/v1/messaging/messages/${id}/delivery`, { session_id: 'worker', input_id: 'input', phase: 'consumed', event_seq: 1 })
    assert.deepEqual((await hub.client.forSession(b.owner_token).call(path)).delivery_evidence, { prepared: 0, queued: 0, consumed: 1 })
  } finally { await hub?.close() }
})

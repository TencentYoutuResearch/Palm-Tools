/** Immutable soft evaluations through the actual home Hub, without model inference. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
const path = '/api/v1/messaging/capability-profiles'
test('capability revisions retain pins, provenance and stale evidence across Hub restart', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('capability-home')
  try {
    const time = Date.now()
    const command = { id: 'frontend', expected_revision: 0, host: 'remote', profile: 'worker', model: 'configurable-model', assessments: {
      design: { evaluation: { kind: 'task_fit', tag: 'frontend', score: 80 }, source: 'user', confidence: 0.6, evidence: [], updated_at: time - 10000, valid_until: time - 1000, pinned: true },
    } }
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Worker', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    await assert.rejects(worker.call(path, command), /403/)
    const first = await hub.client.call(path, command)
    assert.equal(first.revision, 1)
    await assert.rejects(worker.call(`${path}/frontend/1`), /403/)
    await assert.rejects(hub.client.call(path, command), /revision conflict/)
    const changed = structuredClone(command); changed.expected_revision = 1
    changed.assessments.design.evaluation.score = 90
    await assert.rejects(hub.client.call(path, changed), /pinned assessment/)
    await assert.rejects(hub.client.call(path, { ...changed, assessments: {} }), /pinned assessment/)
    const invalid = structuredClone(changed); invalid.replace_pins = true; invalid.assessments.design.source = 'measured'
    await assert.rejects(hub.client.call(path, invalid), /invalid capability assessment/)
    await assert.rejects(hub.client.call(path, { ...changed, model: 'different', replace_pins: true }), /identity is immutable/)
    const second = await hub.client.call(path, { ...changed, replace_pins: true })
    assert.equal(second.revision, 2)
    await hub.stop('SIGKILL'); await hub.start()
    const saved = await hub.client.call(`${path}/frontend/1`)
    assert.deepEqual(saved.assessments, command.assessments)
    assert.equal(saved.freshness.design, 'stale')
    assert.equal((await hub.client.call(`${path}/frontend/2`)).assessments.design.evaluation.score, 90)
    await assert.rejects(hub.client.call(`${path}/frontend/3`), /404/)
  } finally { await hub.close() }
})

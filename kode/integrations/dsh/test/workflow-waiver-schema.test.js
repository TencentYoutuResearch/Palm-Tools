import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'

test('explicit waiver permission is immutable and preserves legacy identity when absent', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
 const hub = await isolatedHub('waiver-schema')
 try {
  const path = '/api/v1/messaging/workflows'
  const pack = { id: 'flow', version: '1', inputs: ['request'], stages: [
   { id: 'build', role: 'author', requires: ['request'], produces: ['artifact'], independent_from: [] },
   { id: 'review', role: 'reviewer', requires: ['build'], produces: ['reviewed'], independent_from: ['build'] },
  ], completion_stages: ['review'], evidence_rules: { artifact: { kind: 'artifact', repository_binding: 'code' }, reviewed: { kind: 'review', artifact_output: 'artifact' } } }
  const legacy = await hub.client.call(path, pack)
  assert.equal(legacy.hash_format, 'kode.workflow.evidence.v2')
  const absent = structuredClone(pack); absent.stages[1].waiver = null
  assert.deepEqual(await hub.client.call(path, absent), legacy)
  const allowed = structuredClone(pack); allowed.version = '2'; allowed.stages[1].waiver = { allow_delivery: false }
  const saved = await hub.client.call(path, allowed)
  assert.equal(saved.hash_format, 'kode.workflow.execution.v6')
  assert.deepEqual(saved.pack.stages[1].waiver, { allow_delivery: false })
  const deliverable = structuredClone(allowed); deliverable.version = '3'; deliverable.stages[1].waiver.allow_delivery = true
  const delivery = await hub.client.call(path, deliverable)
  assert.notEqual(saved.hash, delivery.hash)
  for (const mutate of [
   p => p.stages[0].waiver = { allow_delivery: true },
   p => p.stages[1].waiver.actor = 'agent',
   p => p.stages[1].waiver.capabilities = ['network'],
   p => p.stages[1].waiver.budget_ids = ['other'],
   p => p.stages[1].waiver.allow_delivery = 'true',
   p => delete p.stages[1].waiver.allow_delivery,
  ]) { const invalid = structuredClone(allowed); mutate(invalid); await assert.rejects(hub.client.call(path + '/validate', invalid)) }
  const changed = structuredClone(allowed); changed.stages[1].waiver.allow_delivery = true
  await assert.rejects(hub.client.call(path, changed), /immutable/)
  await hub.stop('SIGKILL'); await hub.start()
  assert.deepEqual(await hub.client.call(path, allowed), saved)
  assert.deepEqual(await hub.client.call(path, pack), legacy)
 } finally { await hub.close() }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
test('escalation policies preserve legacy workflow identity and reject permission or model overrides', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
 const hub = await isolatedHub('escalation-schema')
 try {
  const path = '/api/v1/messaging/workflows'
  const pack = { id: 'flow', version: '1', inputs: ['request'], stages: [{ id: 'build', role: 'builder', requires: ['request'], produces: ['artifact'], independent_from: [], execution: { task_tag: 'ordinary', repository_binding: 'code', capabilities: ['read'], tools: [], network: false } }], completion_stages: ['build'], evidence_rules: { artifact: { kind: 'artifact', repository_binding: 'code' } } }
  const legacy = await hub.client.call(path, pack)
  assert.equal(legacy.hash_format, 'kode.workflow.execution.v4')
  const empty = structuredClone(pack); empty.stages[0].execution.escalation = []
  assert.deepEqual(await hub.client.call(path, empty), legacy)
  const upgraded = structuredClone(pack); upgraded.version = '2'
  upgraded.stages[0].execution.escalation = [{ after_reworks: 1, task_tag: 'specialist', minimum_quality: 80 }, { after_reworks: 3, task_tag: 'expert', minimum_quality: 95 }]
  const saved = await hub.client.call(path, upgraded)
  assert.equal(saved.hash_format, 'kode.workflow.execution.v5'); assert.notEqual(saved.hash, legacy.hash)
  for (const mutate of [
   p => p.stages[0].execution.escalation[0].after_reworks = 0,
   p => p.stages[0].execution.escalation[1].after_reworks = 1,
   p => p.stages[0].execution.escalation[1].minimum_quality = 70,
   p => p.stages[0].execution.escalation[0].minimum_quality = 101,
   p => delete p.stages[0].execution.task_tag,
   p => p.stages[0].execution.escalation[0].model = 'caller-chosen',
   p => p.stages[0].execution.escalation[0].capabilities = ['workspace_write'],
   p => p.stages[0].execution.escalation[0].budget_ids = ['foreign'],
  ]) { const bad = structuredClone(upgraded); mutate(bad); await assert.rejects(hub.client.call(path + '/validate', bad)) }
  const changed = structuredClone(upgraded); changed.stages[0].execution.escalation[0].task_tag = 'different'
  await assert.rejects(hub.client.call(path, changed), /immutable/)
  await hub.stop('SIGKILL'); await hub.start()
  assert.deepEqual(await hub.client.call(path, upgraded), saved)
  assert.deepEqual(await hub.client.call(path, pack), legacy)
 } finally { await hub.close() }
})

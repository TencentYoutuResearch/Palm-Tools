import test from 'node:test'
import assert from 'node:assert/strict'
import { ManagedCodexAdapter } from '../src/managed-codex-adapter.js'
import { normalizeProfile } from '../src/agent-profiles.js'

test('legacy managed catalog reads independent local defaults only as a hint after its allowed-model policy', async () => {
  const profile = normalizeProfile({ id: 'legacy-worker', name: 'CLI', type: 'codex', defaultModel: 'legacy-model', managedInference: { endpoint: 'https://example.com/responses', roles: ['worker'] } })
  const profiles = { list: () => [profile], bindings: {}, defaultModelFor: id => { assert.equal(id, profile.id); return { model: 'local-choice' } } }
  const adapter = new ManagedCodexAdapter({}, profiles), before = structuredClone(profile), provider = 'kode-workflow-legacy-worker'
  assert.deepEqual((await adapter.listModels(provider)).map(row => row.id), ['local-choice'])
  assert.deepEqual(profile, before)
  profile.allowedModels = ['authorized-model']
  assert.deepEqual((await adapter.listModels(provider)).map(row => row.id), ['authorized-model'])
  await assert.rejects(adapter.resolveModel(provider, 'local-choice'), /configured scope/)
  delete profile.allowedModels
  profiles.defaultModelFor = () => undefined
  assert.deepEqual((await adapter.listModels(provider)).map(row => row.id), ['legacy-model'])
  delete profiles.defaultModelFor
  assert.deepEqual((await adapter.listModels(provider)).map(row => row.id), ['legacy-model'])
  delete profile.defaultModel
  assert.deepEqual(await adapter.listModels(provider), [])
  assert.equal(adapter.active.size, 0, 'catalog lookup never starts a decision')
})

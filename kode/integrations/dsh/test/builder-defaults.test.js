import test from 'node:test'
import assert from 'node:assert/strict'
import { proposeBuilderDefaults } from '../src/builder-defaults.js'
const input = () => ({ draft: { id: 'draft', revision: 1, home_hub: 'home', interview: { workspace_refs: [{ host_id: 'home', workspace_id: 'workspace', root_ref: '/fixture' }] } }, profiles: [{ id: 'profile', type: 'dsh', runtime_available: true }], providers: [{ provider_id: 'provider', registered: true }], listModels: async provider => [{ provider, id: 'model' }], resolveModelInfo: async (provider, id) => ({ provider, id, reasoning: { efforts: [{ id: 'deliberate' }] } }) })
test('unique registered resources propose a selection without model-name assumptions or authority', async () => {
 const result = await proposeBuilderDefaults(input())
 assert.equal(result.state, 'proposed'); assert.equal(result.selection.model, 'model'); assert.equal(result.eligible_for_execution, false)
 assert.deepEqual(result.basis, { profile: 'only_available', provider: 'only_available', model: 'only_allowed' })
})
test('configured defaults preserve provider identity, allowed model and effort', async () => {
 const value = input(); value.profiles[0] = { ...value.profiles[0], defaultModel: 'preferred', allowedModels: ['preferred'], defaultReasoningEffort: 'deliberate' }
 value.providers.push({ provider_id: 'another', registered: true }); value.configured = { provider: 'provider' }
 value.listModels = async provider => [{ provider, id: 'other' }, { provider, id: 'preferred' }]
 const result = await proposeBuilderDefaults(value)
 assert.equal(result.selection.model, 'preferred'); assert.equal(result.selection.effort, 'deliberate')
 value.configured.model = 'other'; assert.deepEqual((await proposeBuilderDefaults(value)).fields, ['model'])
 value.configured.model = 'preferred'; value.configured.effort = 'unsupported'; assert.deepEqual((await proposeBuilderDefaults(value)).fields, ['effort'])
})
test('ambiguous or unavailable resources never fall back to catalog order', async () => {
 for (const [field, mutate] of [
  ['execution_profile', value => value.profiles.push({ ...value.profiles[0], id: 'second' })],
  ['execution_profile', value => value.defaultProfileId = 'missing'],
  ['provider', value => value.providers.push({ provider_id: 'second', registered: true })],
  ['workspace', value => value.draft.interview.workspace_refs.push({ host_id: 'home', workspace_id: 'second' })],
  ['model', value => value.listModels = async provider => [{ provider, id: 'one' }, { provider, id: 'two' }]],
 ]) { const value = input(); mutate(value); const result = await proposeBuilderDefaults(value); assert.equal(result.state, 'needs_configuration'); assert.deepEqual(result.fields, [field]); assert.equal(result.eligible_for_execution, false) }
})
test('foreign and duplicate model metadata cannot become a proposal', async () => {
 const value = input(); value.listModels = async () => [{ provider: 'foreign', id: 'model' }]
 await assert.rejects(proposeBuilderDefaults(value), /Invalid model metadata/)
 value.listModels = async provider => [{ provider, id: 'model' }, { provider, id: 'model' }]
 await assert.rejects(proposeBuilderDefaults(value), /Invalid model metadata/)
 value.listModels = input().listModels; value.resolveModelInfo = async () => ({ provider: 'foreign', id: 'model' })
 await assert.rejects(proposeBuilderDefaults(value), /Wrong model identity/)
})

test('an explicit automatic effort does not inherit a different profile effort', async () => {
 const value = input(); value.profiles[0].defaultReasoningEffort = 'deliberate'
 value.configured = { effort: null }
 const result = await proposeBuilderDefaults(value)
 assert.equal(result.selection.effort, null)
 delete value.configured.effort
 assert.equal((await proposeBuilderDefaults(value)).selection.effort, 'deliberate')
})

test('native Builder defaults require role opt-in and the exact registered profile route', async () => {
 const value = input()
 value.profiles = [{ id: 'native', type: 'codex', runtime_available: true, managedInference: { roles: ['builder'] } }]
 value.providers = [{ provider_id: 'ordinary', registered: true }, { provider_id: 'kode-workflow-native', registered: true },
  { provider_id: 'kode-workflow-other', registered: true }]
 const proposed = await proposeBuilderDefaults(value)
 assert.equal(proposed.state, 'proposed')
 assert.equal(proposed.selection.profile_id, 'native')
 assert.equal(proposed.selection.provider, 'kode-workflow-native')
 assert.equal(proposed.eligible_for_execution, false)
 value.configured = { provider: 'ordinary' }
 assert.deepEqual((await proposeBuilderDefaults(value)).fields, ['provider'])
 value.configured = {}
 value.providers[1].registered = false
 assert.deepEqual((await proposeBuilderDefaults(value)).fields, ['provider'])
 value.profiles[0].managedInference.roles = ['worker']
 assert.deepEqual((await proposeBuilderDefaults(value)).fields, ['execution_profile'])
 delete value.profiles[0].managedInference.roles
 assert.deepEqual((await proposeBuilderDefaults(value)).fields, ['execution_profile'])
})

test('ordinary Builder defaults cannot select a managed native profile route', async () => {
 const value = input()
 value.providers = [{ provider_id: 'kode-workflow-native', registered: true }]
 assert.deepEqual((await proposeBuilderDefaults(value)).fields, ['provider'])
})

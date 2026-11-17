import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeProfile, profileRevision } from '../src/agent-profiles.js'
import { builderProfileMetadata } from '../src/builder-profile-metadata.js'
import { registerBuilderModels } from '../src/builder-models-route.js'
import { resourceCoverage } from '../src/resource-coverage.js'
const profile = () => normalizeProfile({ id: 'builder', name: 'Builder', type: 'claude', executable: '/fixture/tclaude', defaultModel: 'exact-model', managedInference: { roles: ['builder'], bootstrap: { executable: '/fixture/claude', pathVariable: 'TCLAUDE_CLAUDE_PATH', provider: 'fixture', home: '/fixture/home' } } })
const providers = [{ id: 'kode-workflow-builder', name: 'Builder' }]
test('Builder configuration eligibility validates pinned bootstrap, explicit role and registered exact route', () => {
 const valid = profile()
 assert.equal(builderProfileMetadata(valid, true, providers).builder_selection_eligible, true)
 for (const invalid of [{ ...valid, managedInference: undefined }, { ...valid, args: ['--dangerously-skip-permissions'] }, { ...valid, managedInference: { roles: ['builder'] } }, { ...valid, managedInference: { ...valid.managedInference, roles: ['worker'] } }]) {
  assert.equal(builderProfileMetadata(invalid, true, providers).builder_selection_eligible, false)
 }
 assert.equal(builderProfileMetadata(valid, false, providers).builder_selection_eligible, false)
 assert.equal(builderProfileMetadata(valid, true, [{ id: 'kode-workflow-other' }]).builder_selection_eligible, false)
})
test('Managed catalogs require owner, exact current profile revision and recheck after asynchronous discovery', async () => {
 let current = profile(), registered = providers, route, status, body, calls = 0, change, kind = 'owner'
 const service = { profiles: { list: () => [current] }, hasRuntime: () => true }
 const llm = { listProviders: () => registered, listModels: async provider => { calls++; change?.(); return [{ provider, id: 'exact-model', name: 'Model' }] } }
 registerBuilderModels({ webServer: { register: value => route = value }, connection: { admit: () => ({ peer: { principal: { kind } } }) } }, llm, 'home', service)
 const get = async (suffix = `&profile_id=builder&profile_revision=${profileRevision(current)}`) => {
  await route.handler({ method: 'GET', url: '/api/kode/builder/models?provider=kode-workflow-builder' + suffix }, { writeHead: value => status = value, end: value => body = JSON.parse(value) })
 }
 await get(''); assert.equal(status, 404); assert.equal(calls, 0)
 await get('&profile_id=builder&profile_revision=stale'); assert.equal(status, 404)
 kind = 'worker'; await get(); assert.equal(status, 403); kind = 'owner'
 await get(); assert.equal(status, 200); assert.equal(body.profile_revision, profileRevision(current)); assert.equal(body.eligible_for_dispatch, false)
 assert.doesNotMatch(JSON.stringify(body), /fixture\/home|bootstrap|executable/)
 change = () => { current = { ...current, env: { CHANGED: 'yes' } } }; await get(); assert.equal(status, 404)
 change = () => { registered = [] }; await get(); assert.equal(status, 404)
 registered = providers; change = undefined; current = { ...current, managedInference: undefined }; await get(); assert.equal(status, 404)
})
test('Coverage projects eligibility without granting dispatch or promoting retired bindings', async () => {
 const p = profile()
 const service = { profiles: { list: () => [p], bindings: { retired: { profile: { ...p, id: 'retired' } } } }, hasRuntime: () => true, registeredBuilderProviders: () => [...providers, { id: 'kode-workflow-retired' }] }
 const result = await resourceCoverage(service, null, 'home')
 const row = result.items.find(row => row.profile_id === 'builder')
 assert.deepEqual(row.managed_roles, ['builder']); assert.equal(row.managed_provider_id, 'kode-workflow-builder'); assert.equal(row.builder_selection_eligible, true); assert.equal(row.eligible_for_dispatch, false)
 assert.equal(result.items.find(row => row.profile_id === 'retired').builder_selection_eligible, false)
})

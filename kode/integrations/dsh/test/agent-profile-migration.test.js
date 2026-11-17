import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProfiles, normalizeProfile, profileRevision } from '../src/agent-profiles.js'
import { BackendAgentProfiles } from '../src/backend-state.js'
import { planAgentProfileMigration, planRegistryAgentProfileMigration, previewPlainAgentSync, applyAgentProfileMigration, rollbackAgentProfileMigration } from '../src/agent-profile-migration.js'
import { LocalAgentPreferences } from '../src/local-agent-preferences.js'
import { controlledBinding, managedCodexRoute } from '../src/managed-codex-profile.js'
import { ManagedCodexAdapter } from '../src/managed-codex-adapter.js'
import { managedBuilderSnapshot } from '../src/builder-profile-metadata.js'
import { assertOfficialProfile, preflightOfficialSelection } from '../src/official-selection-preflight.js'

const legacy = () => [
  { id: 'builtin-codex', name: 'Codex', type: 'codex', executable: '/fixture/codex' },
  { id: 'backend', name: 'Backend Astra', type: 'codex', executable: '/fixture/codex', defaultModel: 'astra' },
  ...[['frontend', 'opus', 'worker'], ['verifier', 'hy4', 'worker'], ['coordinator', 'hy4', 'coordinator'], ['builder', 'hy4', 'builder']].map(([id, model, role]) => ({
    id, name: `${id} ${model}`, type: 'claude', executable: '/fixture/tclaude', defaultModel: model, allowedModels: [model],
    env: { FIXTURE_HOME: '/fixture/config' }, managedInference: { roles: [role], reasoningEfforts: [],
      bootstrap: { executable: '/fixture/claude', pathVariable: 'TCLAUDE_CLAUDE_PATH', provider: 'fixture', home: '/fixture/config' }, responseModels: { [model]: `${model}-reported` } },
  })),
].map(normalizeProfile)
const recipe = () => ({ id: 'separate-agent-model-role-v1', groups: [
  { id: 'builtin-codex', sourceProfileIds: ['backend'] },
  { id: 'native-tclaude', name: 'tclaude', sourceProfileIds: ['frontend', 'verifier', 'coordinator', 'builder'] },
], teamRoles: { development: Object.fromEntries(['frontend', 'backend', 'verifier', 'coordinator', 'builder'].map(sourceProfileId => [sourceProfileId, { sourceProfileId }])) } })
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'kode-profile-migration-'))
  try { const registry = await new AgentProfiles(join(root, 'agents.json')).open(legacy()); await run(registry, root) }
  finally { await rm(root, { recursive: true, force: true }) }
}
test('explicit local migration separates Agent identity, model choice and Team roles without rewriting legacy data', async () => fixture(async registry => {
  await registry.bind('old-conversation', 'frontend')
  await registry.patchBinding('old-conversation', { threadId: 'old-native-thread', seenInputs: ['first'], selection: { model: 'opus' } })
  const bytes = await readFile(registry.path, 'utf8'), binding = registry.binding('old-conversation'), source = registry.list()
  const plan = planAgentProfileMigration(source, registry.localPreferences.snapshot(), recipe())
  await assert.rejects(stat(registry.localPreferences.path), { code: 'ENOENT' }, 'planning does not write preferences')
  assert.equal(plan.eligibleForExecution, false)
  assert.equal((await applyAgentProfileMigration(registry, plan)).status, 'applied')
  assert.deepEqual(registry.listAgents().map(row => row.id), ['builtin-codex', 'native-tclaude'])
  const canonical = registry.get('native-tclaude')
  assert.equal(canonical.name, 'tclaude')
  for (const key of ['defaultModel', 'defaultReasoningEffort', 'allowedModels', 'managedInference']) assert.equal(canonical[key], undefined)
  assert.equal(controlledBinding({ profile: canonical, managedBuilder: {} }), false, 'migration must not union managed authority')
  assert.equal(registry.defaultModelFor(canonical.id), undefined, 'no winning model is guessed')
  assert.deepEqual(registry.teamRolesFor('development').frontend, { profileId: canonical.id, model: 'opus', sourceProfileId: 'frontend', sourceProfileRevision: profileRevision(registry.get('frontend')) })
  assert.equal(registry.teamRolesFor('development').verifier.model, 'hy4')
  assert.equal(registry.teamRolesFor('development').backend.profileId, 'builtin-codex')
  assert.equal(await readFile(registry.path, 'utf8'), bytes)
  assert.deepEqual(registry.binding('old-conversation'), binding)
  for (const row of source) assert.deepEqual(registry.get(row.id), row, 'every legacy reference resolves exactly')
  const revision = registry.localPreferences.state.revision
  await applyAgentProfileMigration(registry, plan)
  assert.equal(registry.localPreferences.state.revision, revision, 'retry is idempotent')
  const reopened = await new AgentProfiles(registry.path).open()
  assert.deepEqual(reopened.listAgents(), registry.listAgents())
  assert.equal((await stat(registry.localPreferences.path)).mode & 0o777, 0o600)
  await rollbackAgentProfileMigration(reopened, plan.id)
  assert.deepEqual(reopened.listAgents().map(row => row.id), source.map(row => row.id))
  assert.deepEqual(reopened.binding('old-conversation'), binding)
  assert.equal(await readFile(registry.path, 'utf8'), bytes)
  const undone = reopened.localPreferences.state.revision
  await rollbackAgentProfileMigration(reopened, plan.id)
  assert.equal(reopened.localPreferences.state.revision, undone)
  assert.equal((await applyAgentProfileMigration(reopened, plan)).status, 'rolled_back')
}))
test('migration rejects different executable identities, duplicate sources, permission-bearing canonical targets and ambiguous role sources', () => {
  const state = new LocalAgentPreferences('/unused').snapshot()
  for (const mutate of [rows => rows[3].executable = '/different/wrapper', rows => rows[3].args = ['--another-account'], rows => rows[3].env = { FIXTURE_HOME: '/different/account' }]) {
    const rows = legacy(); mutate(rows)
    assert.throws(() => planAgentProfileMigration(rows, state, recipe()), /distinct CLI|pinned wrapper/)
  }
  const managedTarget = legacy(); managedTarget[0].allowedModels = ['astra']
  assert.throws(() => planAgentProfileMigration(managedTarget, state, recipe()), /plain CLI/)
  const duplicated = recipe(); duplicated.groups[1].sourceProfileIds.push('frontend')
  assert.throws(() => planAgentProfileMigration(legacy(), state, duplicated), /duplicate/)
  const foreign = recipe(); foreign.teamRoles.development.other = { sourceProfileId: 'builtin-codex' }
  assert.throws(() => planAgentProfileMigration(legacy(), state, foreign), /declared/)
})
test('stale profiles and stale preferences cannot be migrated; rollback cannot discard newer choices', async () => fixture(async registry => {
  const plan = planAgentProfileMigration(registry.list(), registry.localPreferences.snapshot(), recipe())
  await registry.update(state => { state.profiles.find(row => row.id === 'frontend').name = 'edited' })
  await assert.rejects(applyAgentProfileMigration(registry, plan), /Legacy Agent changed/)
  const current = planAgentProfileMigration(registry.list(), registry.localPreferences.snapshot(), recipe())
  await registry.setDefaultModel('backend', { model: 'chosen' })
  await assert.rejects(applyAgentProfileMigration(registry, current), /preferences changed/)
  const final = planAgentProfileMigration(registry.list(), registry.localPreferences.snapshot(), recipe())
  await applyAgentProfileMigration(registry, final)
  await registry.setDefaultModel('native-tclaude', { model: 'opus' })
  await assert.rejects(rollbackAgentProfileMigration(registry, final.id), /newer choices/)
  assert.equal(registry.defaultModelFor('native-tclaude').model, 'opus')
}))
test('rollback retains a newly bound native identity and never changes its session snapshot', async () => fixture(async registry => {
  const plan = planAgentProfileMigration(registry.list(), registry.localPreferences.snapshot(), recipe())
  await applyAgentProfileMigration(registry, plan)
  await registry.bind('new-conversation', 'native-tclaude')
  await registry.bindNative('new-conversation', 'native-tclaude', 'new-thread')
  const binding = registry.binding('new-conversation')
  await rollbackAgentProfileMigration(registry, plan.id)
  assert.deepEqual(registry.binding('new-conversation'), binding)
  assert.deepEqual(registry.get('native-tclaude'), binding.profile)
}))
test('personal defaults and Team role changes never write to the remote Agent document', async () => fixture(async (local, root) => {
  let state = { version: 1, dsh_migrated: true, profiles: legacy(), bindings: {}, modelDefaults: { backend: { model: 'legacy-shared' } } }, revision = 0
  const writes = [], client = { async call(path, input) {
    assert.equal(path, '/api/v1/messaging/workbench/documents/agents')
    if (input) { assert.equal(input.expected_revision, revision); state = structuredClone(input.value); writes.push(state); revision++ }
    return { value: structuredClone(state), revision }
  } }
  const registry = await new BackendAgentProfiles(client, join(root, 'shared.json')).open()
  assert.equal(registry.defaultModelFor('backend').model, 'legacy-shared')
  await registry.setDefaultModel('backend', { model: 'private-personal-model', reasoningEffort: 'high', fast: false })
  await registry.setTeamRoles('private-team', { frontend: { profileId: 'frontend', model: 'private-role-model' } })
  const plan = planAgentProfileMigration(registry.list(), registry.localPreferences.snapshot(), recipe())
  await applyAgentProfileMigration(registry, plan)
  assert.equal(writes.length, 0)
  await registry.bind('old-session', 'frontend')
  assert.equal(writes.length, 1)
  const serialized = JSON.stringify(writes[0])
  for (const forbidden of ['private-personal-model', 'private-role-model', 'private-team', 'profileAliases', 'agentCatalog', 'native-tclaude']) assert.ok(!serialized.includes(forbidden), forbidden)
  const reopened = await new BackendAgentProfiles(client, registry.path).open()
  assert.equal(reopened.defaultModelFor('backend').model, 'private-personal-model')
  assert.equal(reopened.teamRolesFor('private-team').frontend.model, 'private-role-model')
  const anotherHost = await new BackendAgentProfiles(client, join(root, 'different-host.json')).open()
  assert.equal(anotherHost.defaultModelFor('backend').model, 'legacy-shared')
  assert.deepEqual(anotherHost.teamRolesFor('private-team'), {})
  await reopened.setDefaultModel('backend', null)
  assert.equal(reopened.defaultModelFor('backend'), undefined, 'reset does not revive the shared default')
}))
test('concurrent local writers serialize and invalid role settings or stale revisions fail closed', async () => fixture(async (registry, root) => {
  const a = registry.localPreferences, b = await new LocalAgentPreferences(a.path).open()
  await Promise.all([a.setModel('a', { model: 'one' }), b.setModel('b', { model: 'two' })])
  await a.open()
  assert.deepEqual(a.state.modelDefaults, { a: { model: 'one' }, b: { model: 'two' } })
  await assert.rejects(a.setTeamRoles('team', {}, 0), /preferences changed/)
  assert.throws(() => a.setTeamRoles('team', { role: { profileId: 'a', model: 'one', permission: 'all' } }), /assignment/)
  assert.throws(() => a.setTeamRoles('team', { role: { profileId: 'a', model: 'one', sourceProfileId: 'a' } }), /legacy role/)
  await assert.rejects(stat(join(root, 'agents.json.preferences.json.lock')), { code: 'ENOENT' })
}))

test('pre-existing local modelDefaults remain available after shared import without being uploaded', async () => fixture(async registry => {
  await registry.update(state => { state.modelDefaults.backend = { model: 'private-legacy-default', reasoningEffort: 'high' } })
  const original = await readFile(registry.path, 'utf8')
  let state, revision = 0
  const writes = [], client = { async call(_path, input) {
    if (input) { state = structuredClone(input.value); writes.push(state); revision++ }
    return { value: structuredClone(state), revision }
  } }
  const shared = await new BackendAgentProfiles(client, registry.path).open()
  assert.deepEqual(shared.defaultModelFor('backend'), { model: 'private-legacy-default', reasoningEffort: 'high' })
  assert.ok(!JSON.stringify(writes).includes('private-legacy-default'))
  assert.equal(await readFile(registry.path, 'utf8'), original)
  const reopened = await new BackendAgentProfiles(client, registry.path).open()
  await reopened.patchBinding('missing', {}).catch(() => {})
  assert.equal(reopened.defaultModelFor('backend').model, 'private-legacy-default')
  assert.ok(!JSON.stringify(writes).includes('private-legacy-default'))
}))
test('editing a canonical source invalidates the view instead of silently changing CLI identity or old bindings', async () => fixture(async registry => {
  const plan = planAgentProfileMigration(registry.list(), registry.localPreferences.snapshot(), recipe())
  await applyAgentProfileMigration(registry, plan)
  await registry.bind('canonical-session', 'native-tclaude')
  const snapshot = registry.binding('canonical-session')
  await registry.update(state => { state.profiles.find(row => row.id === 'frontend').executable = '/fixture/different-tclaude' })
  assert.throws(() => registry.get('native-tclaude'), /unknown/)
  assert.equal(registry.canonicalProfileId('frontend'), 'frontend')
  assert.ok(registry.listAgents().some(row => row.id === 'frontend'))
  assert.deepEqual(registry.binding('canonical-session'), snapshot)
  const saved = JSON.parse(await readFile(registry.localPreferences.path, 'utf8'))
  assert.ok(saved.agentCatalog.every(row => Object.keys(row).sort().join(',') === 'id,name,sourceProfileId,sourceProfileRevision'))
  assert.ok(!JSON.stringify(saved).includes('/fixture/config'), 'catalog stores references, not a parallel CLI configuration')
}))


test('migration rejects duplicate source identities and canonical/source chains before writing', () => {
  const preferences = new LocalAgentPreferences('/unused').snapshot()
  const rows = legacy()
  assert.throws(() => planAgentProfileMigration([...rows, rows[0]], preferences, recipe()), /Unique source/)
  const chain = recipe()
  chain.groups.push({ id: 'another-codex', name: 'Codex', sourceProfileIds: ['builtin-codex'] })
  assert.throws(() => planAgentProfileMigration(rows, preferences, chain), /duplicate legacy/)
})

test('role migration preserves personal choices and resets rather than reviving embedded defaults', async () => fixture(async registry => {
  await registry.setDefaultModel('frontend', { model: 'personal-model', reasoningEffort: 'high', fast: false })
  const plan = planAgentProfileMigration(registry.list(), registry.localPreferences.snapshot(), recipe())
  assert.deepEqual(plan.after.teamRoles.development.frontend, {
    profileId: 'native-tclaude', model: 'personal-model', reasoningEffort: 'high', fast: false,
    sourceProfileId: 'frontend', sourceProfileRevision: profileRevision(registry.get('frontend')),
  })
  const explicit = recipe(); explicit.teamRoles.development.frontend.model = 'another-model'
  const changed = planAgentProfileMigration(registry.list(), registry.localPreferences.snapshot(), explicit)
  assert.equal(changed.after.teamRoles.development.frontend.reasoningEffort, undefined)
  assert.equal(changed.after.teamRoles.development.frontend.fast, undefined)
  await registry.setDefaultModel('frontend', null)
  assert.throws(() => planAgentProfileMigration(registry.list(), registry.localPreferences.snapshot(), recipe()), /Invalid model/)
  assert.equal(planAgentProfileMigration(registry.list(), registry.localPreferences.snapshot(), explicit).after.modelDefaults.frontend, null)
}))

test('queued migration owns its reviewed plan snapshot', async () => fixture(async registry => {
  const plan = planAgentProfileMigration(registry.list(), registry.localPreferences.snapshot(), recipe())
  let release
  registry.localPreferences.chain = new Promise(resolve => { release = resolve })
  const applying = applyAgentProfileMigration(registry, plan)
  plan.after.teamRoles.development.frontend.model = 'mutated-after-review'
  release()
  await applying
  assert.equal(registry.teamRolesFor('development').frontend.model, 'opus')
}))

test('migrated ordinary CLI cannot enter managed routing, official selection or Builder admission', async () => fixture(async registry => {
  await registry.bind('old-builder', 'builder')
  await registry.patchBinding('old-builder', { managedBuilder: {}, managedOperation: { id: 'existing-operation' },
    usageOutbox: { call: { state: 'pending' } }, stopBlocked: true })
  const old = registry.binding('old-builder')
  await applyAgentProfileMigration(registry, planAgentProfileMigration(registry.list(), registry.localPreferences.snapshot(), recipe()))
  const canonical = registry.get('native-tclaude'), revision = profileRevision(canonical)
  const route = managedCodexRoute(canonical.id)
  const service = { profiles: registry, hasRuntime: () => true }
  const llm = { listProviders: () => [{ id: route }, { id: managedCodexRoute('builder') }] }
  assert.equal(managedBuilderSnapshot(service, llm, route, canonical.id, revision), null)
  assert.ok(managedBuilderSnapshot(service, llm, managedCodexRoute('builder'), 'builder', old.revision))
  const adapter = new ManagedCodexAdapter({ agents: { get: () => ({ id: 'forged' }) }, get: () => ({ officialExecution: {
    assertModelRequest: () => assert.fail('ordinary profile must be rejected before admission'),
  } }) }, registry)
  assert.throws(() => adapter.profile(route), /provider unavailable/)
  assert.equal(adapter.profile(managedCodexRoute('builder')).id, 'builder')
  for (const role of ['managedAssignment', 'managedBuilder', 'managedCoordinator']) {
    const binding = { profile: canonical, revision, [role]: {}, managedOperation: { id: 'forged' } }
    const policy = { profile_revision: revision, model: 'opus', scope: 'executor_configuration' }
    assert.throws(() => assertOfficialProfile(registry, binding, policy), /Official executor profile/)
    await assert.rejects(preflightOfficialSelection({}, registry, binding, policy, { provider: route, model: 'opus' }), /Official executor profile/)
  }
  await registry.bind('forged', canonical.id)
  await registry.patchBinding('forged', { managedBuilder: {}, managedOperation: { id: 'forged' } })
  await assert.rejects(adapter.streamBound(canonical, { sessionId: 'forged', provider: route, model: 'opus' }).next(), /workflow execution unavailable/)
  assert.deepEqual(registry.binding('old-builder'), old, 'migration preserves cancellation and pending accounting fences')
  assert.deepEqual(registry.get('builder').allowedModels, ['hy4'])
  assert.deepEqual(registry.get('builder').managedInference, old.profile.managedInference)
}))


for (const source of ['modelDefaults', 'legacyLocalModelDefaults']) {
  test(`migration preserves effective ${source} and rejects its concurrent change`, async () => fixture(async registry => {
    registry.modelDefaults.frontend = { model: 'shared-choice', reasoningEffort: 'medium' }
    if (source === 'legacyLocalModelDefaults') registry.legacyLocalModelDefaults = { frontend: { model: 'local-choice', reasoningEffort: 'high', fast: false } }
    const expected = registry.defaultModelFor('frontend')
    const plan = planRegistryAgentProfileMigration(registry, recipe())
    assert.deepEqual(plan.sourceSelections.frontend, expected)
    assert.deepEqual(plan.after.modelDefaults.frontend, expected)
    assert.equal(plan.after.teamRoles.development.frontend.model, expected.model)
    assert.equal(plan.after.teamRoles.development.frontend.reasoningEffort, expected.reasoningEffort)
    registry[source].frontend = { model: 'concurrent-choice' }
    await assert.rejects(applyAgentProfileMigration(registry, plan), /source model selection changed/)
    assert.deepEqual(registry.teamRolesFor('development'), {})
    registry[source].frontend = expected
    await applyAgentProfileMigration(registry, plan)
    assert.deepEqual(registry.defaultModelFor('frontend'), expected)
    assert.equal(registry.teamRolesFor('development').frontend.model, expected.model)
    await rollbackAgentProfileMigration(registry, plan.id)
    await registry.setDefaultModel('frontend', null)
    const explicit = recipe(); explicit.id = 'reset-migration'; explicit.teamRoles.development.frontend.model = 'explicit-choice'
    const reset = planRegistryAgentProfileMigration(registry, explicit)
    assert.equal(reset.sourceSelections.frontend, null)
    assert.equal(reset.after.modelDefaults.frontend, null)
    await applyAgentProfileMigration(registry, reset)
    assert.equal(registry.defaultModelFor('frontend'), undefined)
  }))
}


test('archive hides role rows without claiming CLI equivalence, changing safety or touching bindings', async () => fixture(async registry => {
  await registry.bind('historic-worker', 'frontend')
  const binding = registry.binding('historic-worker'), bytes = await readFile(registry.path, 'utf8')
  const archive = { id: 'archive-roles', groups: [], archiveProfileIds: ['frontend', 'verifier', 'coordinator', 'builder'] }
  const plan = planRegistryAgentProfileMigration(registry, archive)
  await applyAgentProfileMigration(registry, plan)
  assert.deepEqual(registry.listAgents().map(row => row.id), ['builtin-codex', 'backend'])
  assert.equal(registry.canonicalProfileId('frontend'), 'frontend', 'archive never claims an alias')
  assert.ok(registry.get('frontend').managedInference)
  assert.deepEqual(registry.get('frontend').allowedModels, ['opus'])
  assert.deepEqual(registry.binding('historic-worker'), binding)
  assert.equal(await readFile(registry.path, 'utf8'), bytes)
  await registry.update(state => { state.profiles.find(row => row.id === 'frontend').name = 'review again' })
  assert.ok(registry.listAgents().some(row => row.id === 'frontend'), 'changed profile is visible until reviewed again')
  await rollbackAgentProfileMigration(registry, plan.id)
  assert.deepEqual(registry.localPreferences.state.archivedProfiles, {})
  assert.deepEqual(registry.binding('historic-worker'), binding)
}))

test('archive validates duplicates, built-ins, overlap and source revisions', async () => fixture(async registry => {
  for (const ids of [['frontend', 'frontend'], ['builtin-codex'], ['missing']]) {
    assert.throws(() => planRegistryAgentProfileMigration(registry, { id: 'archive', groups: [], archiveProfileIds: ids }), /archived Agent/)
  }
  assert.throws(() => planRegistryAgentProfileMigration(registry, { ...recipe(), archiveProfileIds: ['frontend'] }), /archived Agent/)
  const plan = planRegistryAgentProfileMigration(registry, { id: 'archive', groups: [], archiveProfileIds: ['frontend'] })
  await registry.update(state => { state.profiles.find(row => row.id === 'frontend').name = 'changed after preview' })
  await assert.rejects(applyAgentProfileMigration(registry, plan), /Legacy Agent changed/)
}))

test('safe sync diff imports only plain CLI definitions, never state or argument/environment values', () => {
  const source = [
    { id: 'tcodex', name: 'TCodex', type: 'codex', executable: 'tcodex', defaultModel: 'do-not-copy' },
    { id: 'tclaude', name: 'TClaude', type: 'claude', executable: 'tclaude' },
    { id: 'buddy', name: 'CodeBuddy', type: 'codebuddy', executable: 'codebuddy' },
    { id: 'gateway', name: 'Gateway', type: 'codex', executable: '/usr/bin/env', args: ['fixture-private-argument'] },
    { id: 'environment', name: 'Environment', type: 'codex', env: { FIXTURE_SECRET: 'fixture-private-value' } },
    { id: 'restricted', name: 'Restricted', type: 'codex', allowedModels: ['only-one'] },
  ]
  const result = previewPlainAgentSync(source, [])
  assert.deepEqual(result.additions.map(row => row.id), ['tcodex', 'tclaude', 'buddy'])
  for (const row of result.additions) {
    assert.equal(row.defaultModel, undefined); assert.equal(row.allowedModels, undefined); assert.equal(row.managedInference, undefined)
    assert.deepEqual(row.args, []); assert.deepEqual(row.env, {})
  }
  assert.equal(result.skipped.length, 3)
  assert.ok(!JSON.stringify(result).includes('fixture-private'))
  const repeat = previewPlainAgentSync(source, result.additions)
  assert.equal(repeat.additions.length, 0)
  assert.deepEqual(repeat.unchanged, ['tcodex', 'tclaude', 'buddy'])
  const collision = previewPlainAgentSync([source[1]], [{ ...result.additions[1], executable: '/another/tclaude' }])
  assert.equal(collision.additions.length, 0); assert.equal(collision.skipped.length, 1)
})

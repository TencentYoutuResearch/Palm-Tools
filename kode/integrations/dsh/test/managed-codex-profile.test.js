import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProfiles, normalizeProfile, profileRevision } from '../src/agent-profiles.js'
import { controlledBinding, managedCodexRoute } from '../src/managed-codex-profile.js'

const profile = { id: 'cli', name: 'CLI', type: 'codex', executable: 'codex', defaultModel: 'configured-model',
  defaultReasoningEffort: 'configured-effort', managedInference: { endpoint: 'https://example.com/responses',
    apiKeyVariable: 'FIXTURE_API_KEY_NAME', reasoningEfforts: ['configured-effort'] } }

test('managed routing freezes explicit endpoint and effort capabilities without changing ordinary profiles', () => {
  const row = normalizeProfile(profile)
  assert.equal(row.managedInference.endpoint, profile.managedInference.endpoint)
  assert.equal(managedCodexRoute(row.id), 'kode-workflow-cli')
  assert.equal(controlledBinding({ profile: row, managedAssignment: { id: 'assignment' } }), true)
  assert.equal(controlledBinding({ profile: row, managedCoordinator: {} }), false)
  assert.equal(controlledBinding({ profile: row, managedAssignment: {}, managedBuilder: {} }), false)
  const ordinary = normalizeProfile({ id: 'ordinary', name: 'Ordinary', type: 'codex' })
  assert.equal(Object.hasOwn(ordinary, 'managedInference'), false)
  assert.notEqual(profileRevision(row), profileRevision({ ...row, managedInference: { ...row.managedInference, endpoint: 'https://example.com/other' } }))
})

test('managed profile rejects inline authentication, unsupported protocols and undeclared defaults', () => {
  for (const managedInference of [
    { endpoint: 'https://fixture:fixture@example.com/responses' },
    { endpoint: 'http://example.com/responses' },
    { endpoint: 'https://example.com/responses', authorization: 'fixture' },
    { endpoint: 'https://example.com/responses', apiKeyVariable: 'invalid name' },
    { endpoint: 'https://example.com/responses', reasoningEfforts: ['duplicate', 'duplicate'] },
    { endpoint: 'https://example.com/responses', timeoutMs: 0 },
  ]) assert.throws(() => normalizeProfile({ ...profile, managedInference }))
  assert.throws(() => normalizeProfile({ ...profile, type: 'claude' }))
  assert.throws(() => normalizeProfile({ ...profile, managedInference: { endpoint: 'https://example.com/responses' } }))
})

test('explicit native roles are versioned and reject ambiguous runtime identities', () => {
  const worker = normalizeProfile(profile)
  const configured = normalizeProfile({ ...profile,
    managedInference: { ...profile.managedInference, roles: ['builder', 'coordinator'] } })
  assert.notEqual(profileRevision(worker), profileRevision(configured))
  assert.equal(controlledBinding({ profile: configured, managedBuilder: {} }), true)
  assert.equal(controlledBinding({ profile: configured, managedCoordinator: {} }), true)
  assert.equal(controlledBinding({ profile: configured, managedAssignment: {} }), false)
  assert.equal(controlledBinding({ profile: configured }), false)
  assert.equal(controlledBinding({ profile: configured, managedBuilder: {}, managedCoordinator: {} }), false)
  for (const roles of [[], ['unknown'], ['builder', 'builder'], 'builder']) {
    assert.throws(() => normalizeProfile({ ...profile, managedInference: { ...profile.managedInference, roles } }), /roles/)
  }
})

test('ordinary profile edits preserve managed configuration and reject inconsistent merged defaults atomically', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kode-managed-profile-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'profiles.json'), profiles = await new AgentProfiles(path).open([profile])
  await profiles.save({ id: 'cli', name: 'Renamed', type: 'codex', executable: 'codex', defaultModel: 'configured-model' })
  const before = profiles.get('cli')
  assert.deepEqual(before.managedInference, normalizeProfile(profile).managedInference)
  const inconsistent = { ...before, defaultReasoningEffort: 'different' }
  delete inconsistent.managedInference
  await assert.rejects(profiles.save(inconsistent))
  assert.deepEqual(profiles.get('cli'), before)
  assert.deepEqual((await new AgentProfiles(path).open()).get('cli'), before)
})

test('explicit wrapper bootstrap is versioned and rejects ambiguous engine hooks', () => {
  const bootstrap = { executable: '/fixture/native-engine', pathVariable: 'FIXTURE_CODEX_PATH' }
  const configured = normalizeProfile({ ...profile, managedInference: { ...profile.managedInference, bootstrap } })
  assert.deepEqual(configured.managedInference.bootstrap, bootstrap)
  assert.notEqual(profileRevision(configured), profileRevision(normalizeProfile(profile)))
  assert.throws(() => normalizeProfile({ ...profile, managedInference: { ...profile.managedInference,
    apiKeyVariable: bootstrap.pathVariable, bootstrap } }), /conflicts with authentication/)
  for (const invalid of [
    { ...bootstrap, executable: 'engine' },
    { ...bootstrap, executable: '/fixture/engine\nother' },
    { ...bootstrap, pathVariable: 'PATH' },
    { ...bootstrap, pathVariable: 'HOME' },
    { ...bootstrap, command: 'fixture' },
  ]) assert.throws(() => normalizeProfile({ ...profile, managedInference: { ...profile.managedInference, bootstrap: invalid } }))
})

test('wrapper-authenticated transport freezes provider and existing wrapper home', () => {
  const inference = { reasoningEfforts: ['configured-effort'], bootstrap: {
    executable: '/fixture/native-engine', pathVariable: 'FIXTURE_CODEX_PATH', provider: 'fixture', home: '/fixture/home' } }
  const configured = normalizeProfile({ ...profile, managedInference: inference })
  assert.deepEqual(configured.managedInference, inference)
  for (const managedInference of [{ ...inference, endpoint: 'https://example.com/responses' },
    { ...inference, apiKeyVariable: 'FIXTURE_KEY' },
    { ...inference, bootstrap: { ...inference.bootstrap, provider: 'invalid.provider' } },
    { ...inference, bootstrap: { ...inference.bootstrap, home: 'relative' } }]) {
    assert.throws(() => normalizeProfile({ ...profile, managedInference }))
  }
})

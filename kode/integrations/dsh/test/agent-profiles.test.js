import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProfiles, normalizeProfile } from '../src/agent-profiles.js'

test('multiple configurations of the same Agent type retain stable independent identities and session snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-agent-profiles-')), file = join(root, 'profiles.json')
  try {
    const profiles = await new AgentProfiles(file).open([{ name: 'Initial', type: 'dsh' }])
    const reopened = await new AgentProfiles(file).open()
    assert.equal(reopened.list()[0].id, profiles.list()[0].id, 'generated initial IDs persist before the first conversation')
    await profiles.remove(profiles.list()[0].id)
    const official = await profiles.save({ name: 'Codex', type: 'codex' })
    const company = await profiles.save({ name: 'Company Codex', type: 'codex', executable: 'tcodex', env: { CODEX_HOME: '/fixtures/company' } })
    assert.notEqual(official.id, company.id)
    assert.equal(official.executable, 'codex')
    await Promise.all([profiles.bind('one', official.id), profiles.bind('two', company.id), profiles.bind('three', company.id)])
    await profiles.patchBinding('one', { threadId: 'same-native-id' })
    await profiles.patchBinding('two', { threadId: 'same-native-id' })
    await profiles.save({ ...company, executable: 'new-tcodex' })
    assert.equal(profiles.binding('two').profile.executable, 'tcodex', 'live bindings retain the launch snapshot')
    await profiles.bind('four', company.id)
    assert.equal(profiles.binding('four').profile.executable, 'new-tcodex')
    const restored = await new AgentProfiles(file).open()
    assert.equal(restored.list().length, 2)
    assert.equal(restored.binding('one').profile.id, official.id)
    assert.equal(restored.binding('two').profile.id, company.id)
    await assert.rejects(restored.bind('one', company.id), /new conversation/)
    await restored.remove(company.id)
    assert.equal(restored.binding('two').threadId, 'same-native-id', 'removing a profile does not destroy existing conversations')
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('type chooses defaults without inferring a type from an executable name', () => {
  assert.equal(normalizeProfile({ id: 'wrapper', name: 'Wrapper', type: 'codex', executable: 'unrelated-name' }).type, 'codex')
  assert.equal(normalizeProfile({ name: 'Claude', type: 'claude' }).executable, 'claude')
  assert.throws(() => normalizeProfile({ name: 'Unknown', executable: 'codex' }), /type/)
  assert.throws(() => normalizeProfile({ name: 'Custom', type: 'custom' }), /executable/)
  assert.throws(() => normalizeProfile({ name: 'Leaked host credential', type: 'codex', env: { KODE_BRIDGE_TOKEN: 'test-only' } }), /owned by the Host/)
  assert.equal(normalizeProfile({ name: 'ACP wrapper', type: 'custom', executable: 'my-agent' }).protocol, 'acp')
  assert.equal(normalizeProfile({ name: 'Codex wrapper', type: 'custom', executable: 'my-agent', protocol: 'codex' }).protocol, 'codex')
  assert.throws(() => normalizeProfile({ name: 'Unknown wire', type: 'custom', executable: 'my-agent', protocol: 'terminal' }), /protocol/)
})

test('default model selections persist independently of built-in executable profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-model-defaults-')), file = join(root, 'profiles.json')
  try {
    const profiles = await new AgentProfiles(file).open([{ id: 'worker', name: 'Worker', type: 'codex' }])
    await profiles.setDefaultModel('worker', { model: 'fixture', reasoningEffort: 'high', fast: true })
    assert.throws(() => profiles.setDefaultModel('worker', { model: 'fixture', fast: 'yes' }), /Fast/)
    const reopened = await new AgentProfiles(file).open()
    assert.deepEqual(reopened.defaultModelFor('worker'), { model: 'fixture', reasoningEffort: 'high', fast: true })
    const builtin = { id: 'builtin-codex', name: 'Codex', type: 'codex' }
    await reopened.ensureBuiltins([builtin])
    await reopened.setDefaultModel('builtin-codex', { model: 'builtin-model', reasoningEffort: 'medium', fast: false })
    await reopened.ensureBuiltins([builtin])
    assert.deepEqual(reopened.defaultModelFor('builtin-codex'), { model: 'builtin-model', reasoningEffort: 'medium', fast: false })
    await reopened.remove('worker')
    assert.equal(reopened.defaultModelFor('worker'), undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('model restrictions and default effort survive editing and reopening, with explicit clearing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-selection-profile-'))
  const file = join(root, 'profiles.json')
  try {
    const profiles = await new AgentProfiles(file).open()
    const original = await profiles.save({ name: 'Restricted', type: 'codex', allowedModels: ['small', 'small'], defaultReasoningEffort: 'low' })
    await profiles.bind('existing', original.id)
    await profiles.save({ id: original.id, name: 'Renamed', type: 'codex' })
    const reopened = await new AgentProfiles(file).open()
    const edited = reopened.list().find(row => row.id === original.id)
    assert.deepEqual(edited.allowedModels, ['small'])
    assert.equal(edited.defaultReasoningEffort, 'low')
    await reopened.save({ ...edited, allowedModels: null, defaultReasoningEffort: null })
    const cleared = (await new AgentProfiles(file).open()).list().find(row => row.id === original.id)
    assert.equal(cleared.allowedModels, undefined)
    assert.equal(cleared.defaultReasoningEffort, undefined)
    assert.deepEqual(reopened.binding('existing').profile.allowedModels, ['small'])
    assert.throws(() => normalizeProfile({ name: 'Invalid', type: 'codex', allowedModels: [] }), /nonempty/)
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('unused binding cleanup cannot discard pending or acknowledged quota fences', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-fence-cleanup-'))
  try {
    const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'p', name: 'Fixture', type: 'codex' }])
    for (const [id, patch] of Object.entries({ local: { quotaFenceRevision: 1 }, remote: { remoteQuotaFences: [{ home: 'home', profile: 'p', revision: 2, reconciled: false }] }, acknowledged: { remoteQuotaFences: [{ home: 'home', profile: 'p', revision: 3, reconciled: true }] } })) {
      await profiles.bind(id, 'p')
      await profiles.patchBinding(id, patch)
      await assert.rejects(profiles.clearUnusedBinding(id), /new conversation/)
      assert.ok(profiles.binding(id))
    }
    await profiles.bind('empty', 'p')
    await profiles.clearUnusedBinding('empty')
    assert.equal(profiles.binding('empty'), undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})

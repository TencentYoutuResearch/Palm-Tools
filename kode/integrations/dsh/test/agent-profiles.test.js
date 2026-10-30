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

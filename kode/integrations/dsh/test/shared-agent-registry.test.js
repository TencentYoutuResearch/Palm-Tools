import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BackendClient } from '../src/backend-client.js'
import { BackendAgentProfiles } from '../src/backend-state.js'
import { CodexSession } from '../src/codex-session.js'
import { importBackendProfiles, saveNativeTab } from '../src/workbench-import.js'

test('shared registry reloads desktop edits without rewriting them through legacy import', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kode-shared-registry-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let state = { version: 1, dsh_migrated: true, shared_registry_version: 1,
    desktop_ids: { stable: 'arbitrary-id' }, desktop_backends: {}, bindings: {},
    profiles: [{ id: 'stable', name: 'Desktop name', type: 'codex', executable: 'codex', args: ['--original'], env: {} }] }
  let revision = 1
  const client = { call: async (path, update) => {
    if (path.endsWith('/catalog')) return { backends: {} }
    if (path.endsWith('/session-index')) return { revision: 1, value: { gui: { tabs: [] } } }
    if (update) { assert.equal(update.expected_revision, revision); state = structuredClone(update.value); revision++ }
    return { revision, value: structuredClone(state) }
  } }
  const profiles = await new BackendAgentProfiles(client, join(root, 'legacy.json')).open()
  state.profiles[0].name = 'Renamed in desktop'; state.profiles[0].args = ['--updated']; revision++
  await profiles.reload()
  await importBackendProfiles(client, profiles)
  assert.equal(profiles.list().length, 1)
  assert.equal(profiles.get('stable').name, 'Renamed in desktop')
  await profiles.bind('conversation', 'stable')
  assert.deepEqual(state.desktop_ids, { stable: 'arbitrary-id' })
  assert.equal(state.shared_registry_version, 1)
  state.bindings.native = { threadId: 'original-thread', profile: { ...state.profiles[0], args: ['--old-service'] }, runtime: 'pty' }; revision++
  await profiles.bindNative('imported-conversation', 'stable', 'original-thread')
  assert.deepEqual(profiles.binding('imported-conversation').profile.args, ['--old-service'])
  assert.deepEqual(profiles.get('stable').args, ['--updated'])
})

const url = process.env.KODE_SHARED_AGENT_TEST_URL
const tokenFile = process.env.KODE_SHARED_AGENT_TEST_TOKEN_FILE
test('desktop and dsh share Agent edits, native identities and immutable launch snapshots over the real backend', { skip: !url || !tokenFile }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kode-shared-agent-e2e-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const client = new BackendClient(url, (await readFile(tokenFile, 'utf8')).trim())
  const path = '/api/v1/messaging/workbench/agents'
  const fixture = fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))
  const config = { command: '/usr/bin/env', protocol: 'codex', enabled: true,
    args: ['KODE_FIXTURE_AGENT_LABEL=original-desktop', process.execPath, fixture], model_flag: '--model' }
  await client.call(path, { action: 'save', key: 'integration-native', name: 'Shared native', config })
  await client.call(path, { action: 'save', key: 'integration-gateway', name: 'Shared gateway', config })
  const profiles = await new BackendAgentProfiles(client, join(root, 'legacy.json')).open()
  await importBackendProfiles(client, profiles)
  const native = profiles.get('kode-integration-native')
  assert.equal(native.type, 'codex')
  assert.equal(native.env.KODE_FIXTURE_AGENT_LABEL, 'original-desktop')
  await client.call(path, { action: 'bind', key: 'integration-native', thread_id: 'shared-native-thread', config, cwd: root, title: 'Desktop conversation', model: 'fixture' })
  await profiles.save({ ...native, name: 'Renamed in dsh', env: { KODE_FIXTURE_AGENT_LABEL: 'updated-in-dsh' } })
  let desktop = await client.call(path)
  assert.equal(desktop.names['integration-native'], 'Renamed in dsh')
  assert.equal(desktop.backends['integration-native'].args[0], 'KODE_FIXTURE_AGENT_LABEL=updated-in-dsh')
  assert.equal(desktop.backends['integration-native'].protocol, 'codex')
  await client.call(path, { action: 'save', key: 'integration-native', name: 'Renamed in desktop', config: desktop.backends['integration-native'] })
  await profiles.reload()
  assert.equal(profiles.get(native.id).name, 'Renamed in desktop')
  const binding = await profiles.bindNative('dsh-adopted-desktop', native.id, 'shared-native-thread')
  assert.equal(binding.profile.env.KODE_FIXTURE_AGENT_LABEL, 'original-desktop')
  const session = new CodexSession(binding.profile, root)
  try {
    assert.ok((await session.listModels()).length)
    await session.open(binding, [])
    const events = []
    for await (const event of session.turn([{ type: 'text', text: 'snapshot verification' }])) events.push(event)
    assert.equal(events.find(event => event.method === 'item/agentMessage/delta').params.delta, 'original-desktop: snapshot verification')
  } finally { await session.close() }
  await saveNativeTab(client, profiles, { id: 'dsh-adopted-desktop', session: { header: { cwd: root }, requestHeader: () => ({ config: { model: 'fixture' } }) } }, 'Same native conversation')
  const catalog = await client.call('/api/v1/messaging/workbench/sessions')
  const rows = catalog.tabs.filter(row => row.session_id === 'shared-native-thread')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].backend_key, 'integration-native', 'same executable must not select another Agent')
  assert.equal(rows[0].agent_id, native.id)
  await client.call(path, { action: 'remove', key: 'integration-native' })
  await profiles.reload()
  assert.equal(profiles.list().some(profile => profile.id === native.id), false)
  assert.equal(profiles.binding('dsh-adopted-desktop').threadId, 'shared-native-thread')
})

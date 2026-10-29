import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { profilePresentations } from '../src/agent-presentation.js'
import { SessionAppearance } from '../src/session-appearance.js'
import { classifyCommands } from '../src/command-skills.js'
import { registerAvatarApi } from '../src/session-appearance.js'
import { createServer } from 'node:http'
import { BackendClient } from '../src/backend-client.js'
import { BackendAgentProfiles } from '../src/backend-state.js'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
test('the configured native CodeBuddy is one built-in choice; independently added CodeBuddy profiles coexist', () => {
  const profiles = [{ id: 'builtin-codebuddy', name: 'CodeBuddy', type: 'codebuddy', origin: 'builtin' }, { id: 'kode-codebuddy', name: 'codebuddy', type: 'codebuddy', origin: 'custom', executable: '/example/codebuddy', args: ['--profile', 'work'] }, { id: 'work-buddy', name: 'Team Buddy', type: 'codebuddy', origin: 'custom' }]
  const before = structuredClone(profiles)
  const rows = profilePresentations(profiles, { desktop_ids: { 'kode-codebuddy': 'codebuddy', 'work-buddy': 'work-buddy' } })
  assert.equal(rows.length, 2); assert.equal(rows[0].name, 'CodeBuddy'); assert.equal(rows[0].origin, 'builtin'); assert.equal(rows[0].id, 'kode-codebuddy')
  assert.deepEqual(rows[0].args, ['--profile', 'work']); assert.equal(rows[1].origin, 'custom'); assert.deepEqual(profiles, before)
})
test('session avatars are independent for conversations using the same Agent and guard gallery paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-avatar-'))
  let value = { version: 1, native_sessions: [{ backend_key: 'codex', session_id: 'native-a', dsh_session_id: 'session-a' }, { backend_key: 'codex', session_id: 'native-b', dsh_session_id: 'session-b' }] }, revision = 0
  const client = { async call(_path, body) { if (body) { assert.equal(body.expected_revision, revision); value = body.value; revision++ } return { value: structuredClone(value), revision } } }
  const profiles = { get: id => { assert.equal(id, 'work') }, reload: async () => {}, list: () => [] }
  const appearance = new SessionAppearance(client, profiles, { avatarDirectory: root })
  try {
    await mkdir(join(root, 'gallery/person/idle'), { recursive: true }); await writeFile(join(root, 'gallery/person/idle/frame-01.png'), Buffer.from('example-image'))
    assert.equal((await appearance.gallery())[0].id, 'gallery/person')
    assert.equal(await appearance.imagePath('gallery/../../outside', 'idle'), undefined)
    await writeFile(join(root, 'outside.png'), 'outside'); await mkdir(join(root, 'gallery/symlink'), { recursive: true }); await symlink('/etc/passwd', join(root, 'gallery/symlink/frame-01.png'))
    assert.equal(await appearance.imagePath('gallery/symlink', 'idle'), undefined)
    await appearance.setSession('session-a', 'gallery/person'); assert.equal(value.native_sessions[0].avatar_id, 'gallery/person'); assert.equal(value.native_sessions[1].avatar_id, undefined)
    await appearance.setSession('session-new', 'gallery/entry-host-only'); assert.equal(value.presentation.sessionAvatars['session-new'], 'gallery/entry-host-only')
    await assert.rejects(appearance.setSession('session-a', 'gallery/../escape'), /无效/)
    await appearance.setSession('session-a', null); assert.equal(value.native_sessions[0].avatar_id, null); assert.equal(appearance.avatarForSession('session-new', 'codex').id, 'gallery/entry-host-only')
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('skill categories come from manifests or native metadata rather than treating every slash command as a skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-command-kind-'))
  try {
    await mkdir(join(root, '.agents/skills/reviewer'), { recursive: true }); await writeFile(join(root, '.agents/skills/reviewer/SKILL.md'), '---\nname: fixture-review\n---\nSkill instructions')
    const rows = await classifyCommands([{ name: 'fixture-review' }, { name: 'team:fixture-review' }, { name: 'mcp:fixture-review' }, { name: 'compact' }, { name: 'native-skill', _meta: { type: 'skill' } }], { type: 'claude', env: {} }, root, { home: join(root, 'home') })
    assert.deepEqual(rows.map(row => row.kind), ['skill', 'skill', 'command', 'command', 'skill'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('avatar delivery is owner-only and cannot read files outside the configured library', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kode-avatar-http-')), appearance = new SessionAppearance({}, {}, { avatarDirectory: root })
  let route
  registerAvatarApi({ webServer: { register: value => { route = value; return () => {} } }, connection: { admit: req => req.headers['x-test-owner'] === 'yes' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } } }, appearance)
  const server = createServer((req, res) => route.handler(req, res)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${server.address().port}/api/kode/avatars`
  assert.equal((await fetch(base + '/media?type=codebuddy')).status, 403)
  const image = await fetch(base + '/media?type=codebuddy', { headers: { 'x-test-owner': 'yes' } })
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png')
  assert.equal(Buffer.from(await image.arrayBuffer()).subarray(1, 4).toString(), 'PNG')
  assert.equal((await fetch(base + '/media?avatar=gallery/../../outside', { headers: { 'x-test-owner': 'yes' } })).status, 404)
})
test('session avatars persist in Kode session metadata without changing a bound Agent snapshot', { skip: !process.env.KODE_TEST_BACKEND_URL }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-avatar-backend-')), token = randomBytes(32).toString('hex')
  await writeFile(join(root, 'token'), token, { mode: 0o600 }); await writeFile(join(root, 'config.json'), JSON.stringify({ node_id: 'appearance-fixture', database: join(root, 'state.sqlite'), peers: [] }))
  const backend = spawn(fileURLToPath(new URL('../../../target/debug/kode-session-server', import.meta.url)), ['--config', join(root, 'config.json'), '--token-file', join(root, 'token'), '--bind', '127.0.0.1:0'], { env: { ...process.env, KODE_GUI_STATE_PATH: join(root, 'gui-state.json') }, stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    const address = await new Promise((resolve, reject) => {
      let text = ''; const timer = setTimeout(() => reject(new Error('backend startup timed out')), 10000)
      backend.on('exit', () => { clearTimeout(timer); reject(new Error('backend exited')) })
      backend.stdout.on('data', bytes => { text += bytes; const match = text.match(/kode-session-server appearance-fixture (127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]) } })
    })
    const client = new BackendClient(`http://${address}`, token), profiles = await new BackendAgentProfiles(client, join(root, 'profiles.json')).open()
    const profile = await profiles.save({ name: 'Appearance fixture', type: 'codex', executable: '/example/codex', args: ['--profile', 'fixture'] })
    await profiles.bind('appearance-fixture', profile.id)
    const before = profiles.binding('appearance-fixture'), appearance = new SessionAppearance(client, profiles)
    await appearance.setSession('session-avatar-a', 'gallery/entry-host-only')
    const value = await client.call('/api/v1/messaging/workbench/documents/session-index')
    assert.equal(value.value.presentation.sessionAvatars['session-avatar-a'], 'gallery/entry-host-only')
    const agents = await client.call('/api/v1/messaging/workbench/documents/agents')
    assert.deepEqual(agents.value.bindings['appearance-fixture'], before)
    assert.equal(appearance.profileView(before.profile, 'session-avatar-a').avatar.id, 'gallery/entry-host-only')
    assert.equal(appearance.profileView(before.profile, 'session-avatar-b').avatar.id, null)
  } finally { if (backend.exitCode === null && backend.signalCode === null) { const exited = once(backend, 'exit'); backend.kill('SIGINT'); await exited } await rm(root, { recursive: true, force: true }) }
})

test('built-in and custom Agent avatars persist independently and session overrides win', async () => {
  let value = { version: 1, native_sessions: [{ backend_key: 'codex', session_id: 'native', dsh_session_id: 'session-a' }] }, revision = 0
  const client = { async call(_path, body) { if (body) { assert.equal(body.expected_revision, revision); value = body.value; revision++ } return { value: structuredClone(value), revision } } }
  const rows = [{ id: 'builtin-codex', type: 'codex', origin: 'builtin' }, { id: 'work', type: 'codex', name: 'Work', executable: '/work/codex' }]
  const profiles = { list: () => rows }, before = structuredClone(rows)
  const appearance = new SessionAppearance(client, profiles)
  await appearance.setAgent('builtin-codex', 'gallery/default')
  await appearance.setAgent('work', 'gallery/work')
  assert.equal(appearance.profilesView()[0].avatar.id, 'gallery/default')
  assert.equal(appearance.profileView(rows[1], 'session-a').avatar.id, 'gallery/work')
  await appearance.setSession('session-a', 'gallery/personal')
  assert.equal(appearance.profileView(rows[1], 'session-a').avatar.id, 'gallery/personal')
  await appearance.setSession('session-a', null)
  assert.equal(appearance.profileView(rows[1], 'session-a').avatar.id, null)
  const reloaded = new SessionAppearance(client, profiles)
  await reloaded.load()
  assert.equal(reloaded.profileView(rows[1], 'another-session').avatar.id, 'gallery/work')
  await assert.rejects(appearance.setAgent('missing', null), /不存在/)
  await assert.rejects(appearance.setAgent('work', 'gallery/../escape'), /无效/)
  assert.deepEqual(rows, before)
})

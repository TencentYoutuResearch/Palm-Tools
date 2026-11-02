import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { ExtensionHub, HUB_PATH } from '../src/extension-hub.js'
import { goalSnapshot, registerAgentHubApi } from '../src/agent-hub-api.js'
import { CodexSession } from '../src/codex-session.js'
import { projectSessionEvent } from '../src/runtime-bridge.js'

test('extension adapter delegates writes and reads backend changes before launching an Agent', async () => {
  const calls = []; let path = '/srv/fixtures/release-1'
  const backend = { call: async (endpoint, input) => { calls.push({ endpoint, input }); return { sources: [{ targets: ['claude'], plugins: { claude: [{ path }] } }] } } }
  const hub = new ExtensionHub(backend), profile = { type: 'claude', args: ['--fixture'] }
  assert.deepEqual((await hub.nativeProfile(profile)).args, ['--fixture', '--plugin-dir', path])
  path = '/srv/fixtures/release-2'
  assert.deepEqual((await hub.nativeProfile(profile)).args, ['--fixture', '--plugin-dir', path])
  assert.deepEqual(profile.args, ['--fixture'])
  const input = { action: 'sync-source', id: 'team' }; await hub.change(input)
  assert.ok(calls.every(call => call.endpoint === HUB_PATH)); assert.equal(calls.at(-1).input, input)
})
test('native goal controls update the persisted UI snapshot', async () => {
  const events = [], fixture = fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))
  const session = new CodexSession({ executable: process.execPath, args: [fixture] }, tmpdir(), { goal: goal => events.push({ type: 'plugin:kode/goal-state', data: { goal } }) })
  try {
    await session.open({}, [])
    await session.goal('a goal'); assert.equal(goalSnapshot({ snapshotEvents: () => events }).objective, 'a goal')
    await session.goal('pause'); assert.equal(goalSnapshot({ snapshotEvents: () => events }).status, 'paused')
    await session.goal('edit changed'); assert.equal(goalSnapshot({ snapshotEvents: () => events }).objective, 'changed')
    assert.equal(goalSnapshot({ snapshotEvents: () => events }).status, 'paused')
    await session.goal('resume'); assert.equal(goalSnapshot({ snapshotEvents: () => events }).status, 'active')
    await session.goal('clear'); assert.equal(goalSnapshot({ snapshotEvents: () => events }), null)
  } finally { await session.close() }
})
test('publications retain provenance for backend filtering and exclude hidden reasoning from text', () => {
  const event = projectSessionEvent({ seq: 1, type: 'user/message', data: { id: 'peer', source: { kind: 'agent-message' }, content: [{ type: 'text', text: 'Peer context' }] } })[0]
  assert.equal(event.payload.source_kind, 'agent-message')
  const assistant = projectSessionEvent({ seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Visible' }, { type: 'reasoning', text: 'Hidden' }] } } })[0]
  assert.equal(assistant.payload.text, 'Visible')
})
test('HTTP adapter authenticates owners and delegates shared operations to the backend after publishing history', async t => {
  const calls = [], events = [{ type: 'plugin:kode/goal-state', data: { goal: { objective: 'durable', status: 'paused' } } }]
  let handler, resumed = 0, closed = 0, published = false; const controlled = []
  const backend = { call: async (path, input) => { calls.push({ path, input }); if (path.endsWith('/handoff')) { assert.equal(published, true); return { sessionId: 'target' } } return { sources: [], keepAwake: false, power: { active: false } } } }
  const hub = new ExtensionHub(backend)
  const agent = { id: 'source', status: 'idle', session: { snapshotEvents: () => events }, ctx: { sessionProjections: { stateOf: () => ({ lastUsed: { model: 'fixture' } }) } } }
  const ctx = {
    webServer: { register: route => { handler = route.handler; return () => {} } },
    connection: { admit: req => req.headers['x-role'] === 'owner' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } },
    agents: { get: () => null }, get: name => ({
      sessionController: { list: async () => ({ items: [{ sessionId: 'source' }] }), resolveAgent: async () => { resumed++; return { agent } } },
      sessionPersistence: { open: async () => ({ read: async () => ({ events }), close: async () => { closed++ } }) },
      kodeRuntimeBridge: { publish: async () => { published = true } },
    })[name],
  }
  const service = { profiles: { binding: () => ({ profile: { type: 'codex' } }) }, adapter: { catalogs: new Map(), live: new Map([['source', { goal() {} }]]), controlGoal: async (_agent, input) => { controlled.push(input) } } }
  registerAgentHubApi(ctx, { hub, backend, service })
  const server = http.createServer((req, res) => void handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const url = 'http://127.0.0.1:' + server.address().port + '/api/kode/agent-hub'
  const request = (body, suffix = '', role = 'owner') => fetch(url + suffix, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-role': role }, ...(body ? { body: JSON.stringify(body) } : {}) })
  assert.equal((await request({ action: 'power', enabled: true }, '', 'guest')).status, 403); assert.equal(calls.length, 0)
  assert.equal((await request({ action: 'unknown' })).status, 400)
  assert.equal((await request({ action: 'sync-source', id: 'team' })).status, 200)
  assert.deepEqual(calls.at(-1), { path: HUB_PATH, input: { action: 'sync-source', id: 'team' } })
  assert.equal((await request({ action: 'handoff', sessionId: 'source', profileId: 'target-agent', requestId: 'fixture-request' })).status, 200)
  assert.deepEqual(calls.at(-1), { path: '/api/v1/messaging/workbench/handoff', input: { source_session_id: 'source', source_runtime: 'dsh', profile_id: 'target-agent', target_runtime: 'dsh', request_id: 'fixture-request' } })
  const response = await request(undefined, '?session_id=source')
  assert.equal((await response.json()).goal.objective, 'durable'); assert.equal(resumed, 0); assert.equal(closed, 1)
  assert.equal((await request({ action: 'goal', sessionId: 'source', command: 'pause' })).status, 200)
  assert.deepEqual(controlled, ['pause']); assert.equal(resumed, 1)
  assert.equal((await request({ action: 'goal', sessionId: 'source', command: 'x'.repeat(4001) })).status, 400)
})

test('real backend owns native plugin snapshots, installer updates, and removal without a running dsh Host', { skip: !process.env.KODE_TEST_BACKEND_URL || process.env.KODE_TEST_NATIVE_PLUGIN_CLI !== '1' }, async t => {
  const { BackendClient } = await import('../src/backend-client.js'), { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises'), { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'kode-plugin-backend-')); t.after(() => rm(root, { recursive: true, force: true }))
  const backend = new BackendClient(process.env.KODE_TEST_BACKEND_URL, (await readFile(process.env.KODE_TEST_TOKEN_FILE, 'utf8')).trim())
  const source = join(root, 'source'); await mkdir(join(source, '.codex-plugin'), { recursive: true })
  const manifest = version => writeFile(join(source, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'kode-backend-fixture', version, description: 'Offline fixture' }))
  const id = 'backend-fixture'; await manifest('0.0.1')
  await backend.call(HUB_PATH, { action: 'save-source', source: { id, kind: 'local', location: source, targets: ['codex'] } })
  t.after(() => backend.call(HUB_PATH, { action: 'remove-source', id }))
  let synced = await backend.call(HUB_PATH, { action: 'sync-source', id })
  assert.equal(synced.sources.find(row => row.id === id).nativeStatus.codex, 'installed')
  await manifest('0.0.2'); synced = await backend.call(HUB_PATH, { action: 'sync-source', id })
  assert.equal(synced.sources.find(row => row.id === id).nativeStatus.codex, 'installed')
  const independent = new BackendClient(backend.url, backend.token)
  assert.equal((await independent.call(HUB_PATH)).sources.find(row => row.id === id).nativeStatus.codex, 'installed')
})

test('real backend dispatches an idempotent handoff through the existing dsh runtime bridge', { skip: !process.env.KODE_TEST_BACKEND_URL }, async t => {
  const { BackendClient } = await import('../src/backend-client.js'), { BackendAgentProfiles } = await import('../src/backend-state.js'), { RuntimeBridge } = await import('../src/runtime-bridge.js')
  const { mkdtemp, readFile, rm } = await import('node:fs/promises'), { join } = await import('node:path'), { randomUUID } = await import('node:crypto')
  const root = await mkdtemp(join(tmpdir(), 'kode-handoff-backend-')); t.after(() => rm(root, { recursive: true, force: true }))
  const backend = new BackendClient(process.env.KODE_TEST_BACKEND_URL, (await readFile(process.env.KODE_TEST_TOKEN_FILE, 'utf8')).trim())
  const profiles = await new BackendAgentProfiles(backend, join(root, 'agents.json')).open()
  const profile = await profiles.save({ id: 'handoff-fixture-' + randomUUID(), name: 'Handoff fixture', type: 'codex', executable: process.execPath })
  t.after(() => profiles.remove(profile.id))
  const sourceId = 'handoff-source-' + randomUUID(), sourceEvents = [
    { seq: 0, type: 'user/message', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'Original fixture task' }] } },
    { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'a1', content: [{ type: 'text', text: 'Original fixture answer' }, { type: 'reasoning', text: 'PRIVATE REASONING' }] } } },
    { seq: 2, type: 'user/message', data: { id: 'p1', source: { kind: 'agent-message' }, content: [{ type: 'text', text: 'PRIVATE PEER' }] } },
  ]
  await profiles.bind(sourceId, profile.id)
  const events = new Map([[sourceId, sourceEvents]]), live = new Map(); let created = 0, submitted = 0
  const rows = () => [...events.keys()].map(sessionId => ({ sessionId, cwd: root, projections: { values: { title: 'Fixture history' } } }))
  const controller = {
    list: async () => ({ items: rows() }), inspect: async id => ({ events: events.get(id) }),
    create: async ({ sessionId }) => { created++; events.set(sessionId, []); live.set(sessionId, { id: sessionId, session: { header: { cwd: root }, snapshotEvents: () => events.get(sessionId), requestHeader: () => ({ config: { model: 'fixture' } }) }, ctx: { sessions: { flush: async () => {} } }, selectModel() {} }); return { sessionId } },
    resolveAgent: async id => ({ agent: live.get(id) }),
    prompt: async input => { submitted++; const text = input.content[0].text; assert.match(text, /Original fixture task/); assert.match(text, /Original fixture answer/); assert.doesNotMatch(text, /PRIVATE REASONING|PRIVATE PEER/); return { accepted: true } },
  }
  const services = { sessionController: controller, agents: { get: id => live.get(id) }, kodeAgents: { profiles, hasRuntime: () => true, adapter: { listModels: async () => [{ id: 'fixture', isDefault: true }] }, recordBinding() {} }, workspaceRegistry: { resolveByPath: async () => ({ id: 'fixture-workspace' }) } }
  const bridge = new RuntimeBridge({ get: key => services[key], logger: { warn() {} } }, backend, { intervalMs: 10 })
  await bridge.publish(); bridge.start(); t.after(() => bridge.close())
  const request = { source_session_id: sourceId, source_runtime: 'dsh', profile_id: profile.id, target_runtime: 'dsh', request_id: 'handoff-' + randomUUID() }
  const first = await backend.call('/api/v1/messaging/workbench/handoff', request)
  const repeated = await backend.call('/api/v1/messaging/workbench/handoff', request)
  assert.deepEqual(repeated, first); assert.equal(created, 1); assert.equal(submitted, 1); assert.notEqual(first.sessionId, sourceId)
})

test('the backend owns and releases its screen-off idle inhibitor', { skip: !process.env.KODE_TEST_BACKEND_URL || process.platform !== 'darwin' }, async t => {
  const { BackendClient } = await import('../src/backend-client.js'), { readFile } = await import('node:fs/promises')
  const backend = new BackendClient(process.env.KODE_TEST_BACKEND_URL, (await readFile(process.env.KODE_TEST_TOKEN_FILE, 'utf8')).trim())
  t.after(() => backend.call(HUB_PATH, { action: 'power', enabled: false }))
  await backend.call(HUB_PATH, { action: 'power', enabled: true })
  await new Promise(resolve => setTimeout(resolve, 50))
  const state = await backend.call(HUB_PATH)
  assert.equal(state.keepAwake, true); assert.equal(state.power.active, true)
  const released = await backend.call(HUB_PATH, { action: 'power', enabled: false })
  assert.equal(released.keepAwake, false); assert.equal(released.power.active, false)
})

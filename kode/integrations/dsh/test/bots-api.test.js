import test from 'node:test'
import assert from 'node:assert/strict'
import { agentFor, botsView, registerBotsApi, runBotForWatch } from '../src/bots-api.js'

const runtime = {
  hasRuntime: type => type !== 'missing',
  profiles: {
    list: () => [{ id: 'p-claude', name: 'Claude Code', type: 'claude' }, { id: 'p-tclaude', name: 'TClaude', type: 'claude' }, { id: 'p-x', name: 'Gone', type: 'missing' }],
    sharedState: { desktop_ids: { 'p-claude': 'claude', 'p-tclaude': 'tclaude' } },
  },
}

test('a bot never picks a built-in Agent that dsh hides behind its desktop twin', () => {
  const twins = {
    hasRuntime: () => true,
    appearance: { profilesView: () => [{ id: 'p-desk', name: 'Cursor', type: 'cursor' }] },
    profiles: { list: () => [{ id: 'builtin-cursor', name: 'Cursor', type: 'cursor', origin: 'builtin' }, { id: 'p-desk', name: 'Cursor', type: 'cursor' }], sharedState: { desktop_ids: {} } },
  }
  assert.equal(agentFor(twins, 'cursor').id, 'p-desk')
})

test('bots map to the dsh Agent that runs their backend and only keep live main sessions', () => {
  assert.equal(agentFor(runtime, 'tclaude').id, 'p-tclaude', 'the desktop key wins over the Agent family')
  assert.equal(agentFor(runtime, 'codex'), null)
  const roster = { default_bot: 'b1', bots: [
    { id: 'b1', name: 'Kit', backend_key: 'tclaude', main_session: { runtime: 'dsh', session_id: 'live' } },
    { id: 'b2', name: 'Rex', backend_key: 'codex', main_session: { runtime: 'dsh', session_id: 'archived' } },
    { id: 'b3', name: 'Ann', backend_key: 'claude', main_session: { runtime: 'gui', session_id: 'live' } },
  ] }
  const view = botsView(roster, { runtime, sessions: [{ sessionId: 'live' }, { sessionId: 'archived' }], archived: new Set(['archived']), workspaces: [{ id: 'w', title: 'kode', path: '/p/kode', extra: 1 }] })
  assert.deepEqual(view.bots.map(bot => [bot.agent, bot.agent_type, bot.main_session_id]), [['TClaude', 'claude', 'live'], [null, null, null], ['Claude Code', 'claude', null]])
  assert.deepEqual(view.agents.map(agent => agent.backend_key), ['claude', 'tclaude'])
  assert.deepEqual(view.workspaces, [{ id: 'w', title: 'kode', path: '/p/kode' }])
})

function harness({ owner = true } = {}) {
  const calls = [], created = []
  let handler
  const roster = { default_bot: 'b1', bots: [{ id: 'b1', name: 'Kit', backend_key: 'claude', permission_ceiling: 'plan', default_cwd: '/p/kode', model: null }], workspaces: { b1: '/p/kode' }, persona_prompts: { b1: '<kode-agent-persona name="Kit">…</kode-agent-persona>' } }
  const services = {
    kodeAgents: runtime,
    kodeSessionCreator: { create: async input => { created.push(input); return { address: { session_id: 'session-new' } } } },
    sessionController: { list: async () => ({ items: [] }) },
    workspaceRegistry: { list: () => [], archivedSessionIds: [] },
  }
  const ctx = {
    get: name => services[name],
    connection: { admit: () => ({ peer: { principal: { kind: owner ? 'owner' : 'guest' } } }) },
    webServer: { register: route => { handler = route.handler; return () => {} } },
  }
  registerBotsApi(ctx, { call: async (path, body) => { calls.push(body); return roster } })
  const request = async (method, body) => {
    const req = { method, headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body) } }
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v }, end(text) { this.body = JSON.parse(text) } }
    await handler(req, res)
    return res
  }
  return { request, calls, created }
}

test('starting a bot conversation sends the persona first, caps permissions and records the main session', async () => {
  const { request, calls, created } = harness()
  const res = await request('POST', { action: 'start', id: 'b1', message: 'Review src/lib.rs', idempotency_key: 'k1' })
  assert.deepEqual(res.body, { sessionId: 'session-new' })
  assert.equal(created[0].agent, 'p-claude')
  assert.equal(created[0].workspace, '/p/kode')
  assert.equal(created[0].permission, 'read-only', 'a plan-only bot starts read-only')
  assert.ok(created[0].task.startsWith('<kode-agent-persona') && created[0].task.endsWith('\n\nReview src/lib.rs'))
  assert.deepEqual(calls.at(-1), { action: 'set_main_session', id: 'b1', session: { runtime: 'dsh', session_id: 'session-new' } })
  assert.equal((await request('POST', { action: 'start', id: 'b1', message: '  ' })).statusCode, 400)
  assert.equal((await request('POST', { action: 'start', id: 'nope', message: 'hi' })).body.error, '这个伙伴已不存在')
  assert.equal((await request('POST', { action: 'drop_tables' })).statusCode, 400)
})

test('only the Host owner reaches bots', async () => {
  const { request } = harness({ owner: false })
  assert.equal((await request('GET')).statusCode, 403)
})

test("a bot without a chosen workspace starts in its own folder, created and registered on first use", async () => {
  const { mkdtemp, stat } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'kode-bots-'))
  const own = join(root, 'b1')
  const registered = [], created = []
  let handler
  const roster = { default_bot: 'b1', bots: [{ id: 'b1', name: 'Kit', backend_key: 'claude', permission_ceiling: 'default', model: null }], workspaces: { b1: own }, persona_prompts: { b1: 'P' } }
  const services = {
    kodeAgents: runtime,
    kodeSessionCreator: { create: async input => { created.push(input); return { address: { session_id: 's' } } } },
    workspaceRegistry: { list: () => registered, resolveByPath: async path => registered.find(row => row.path === path), create: async (path, title) => { registered.push({ path, title }) } },
  }
  registerBotsApi({ get: name => services[name], connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }, webServer: { register: route => { handler = route.handler } } }, { call: async () => roster })
  const res = { setHeader() {}, end(text) { this.body = JSON.parse(text) } }
  await handler({ method: 'POST', async *[Symbol.asyncIterator]() { yield JSON.stringify({ action: 'start', id: 'b1', message: 'hi' }) } }, res)
  assert.deepEqual(res.body, { sessionId: 's' })
  assert.ok((await stat(own)).isDirectory())
  assert.deepEqual(registered, [{ path: own, title: 'Kit' }])
  assert.equal(created[0].workspace, own)
})

test('a watch run starts the bot in the watched folder at the capped mode, keyed by the Kode request', async () => {
  const registered = [], created = []
  const roster = { bots: [{ id: 'b1', name: 'Kit', backend_key: 'claude', permission_ceiling: 'acceptEdits', model: 'm' }], workspaces: { b1: '/bots/b1' }, persona_prompts: { b1: 'P' } }
  const services = {
    kodeAgents: runtime,
    kodeSessionCreator: { create: async input => { created.push(input); return { address: { session_id: `s${created.length}` } } } },
    workspaceRegistry: { list: () => registered, resolveByPath: async path => registered.find(row => row.path === path), create: async (path, title) => { registered.push({ path, title }) } },
  }
  const ctx = { get: name => services[name] }
  const backend = { call: async () => roster }
  const id = await runBotForWatch(ctx, backend, { bot_id: 'b1', task: 'Check docs', workspace: '/repo', permission: 'plan', title: 'Kit · Docs' }, 'watch.run-1')
  assert.equal(id, 's1')
  assert.deepEqual(registered, [{ path: '/repo', title: undefined }], 'a watched folder joins dsh as itself')
  assert.equal(created[0].permission, 'read-only')
  assert.equal(created[0].title, 'Kit · Docs')
  assert.equal(created[0].model, 'm')
  assert.equal(created[0].task, 'P\n\nCheck docs')
  await runBotForWatch(ctx, backend, { bot_id: 'b1', task: 'again', workspace: '/repo', permission: 'acceptEdits' }, 'watch.run-1')
  assert.equal(created[1].idempotency_key, created[0].idempotency_key, 'a retried Kode request reuses its creation')
  assert.equal(created[1].permission, 'workspace-write')
  await assert.rejects(runBotForWatch(ctx, backend, { bot_id: 'gone', task: 'x' }, 'r'), /不存在/)
})

test('watch actions pass through to Kode as its own actions', async () => {
  let handler
  const calls = []
  registerBotsApi({ get: () => undefined, connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }, webServer: { register: route => { handler = route.handler } } }, { call: async (path, body) => { calls.push([path, body]); return { revision: 3 } } })
  const res = () => ({ setHeader() {}, end(text) { this.body = JSON.parse(text) } })
  const post = res()
  await handler({ method: 'POST', async *[Symbol.asyncIterator]() { yield JSON.stringify({ action: 'watch_toggle', id: 'w1', enabled: false }) } }, post)
  assert.deepEqual(calls.at(-1), ['/api/v1/messaging/workbench/watches', { action: 'toggle', id: 'w1', enabled: false }])
  await handler({ method: 'GET', url: '/api/kode/bots?watches=1&after=2' }, res())
  assert.deepEqual(calls.at(-1), ['/api/v1/messaging/workbench/watches?after=2', undefined])
  await handler({ method: 'GET', url: '/api/kode/bots?watches=1&after=x' }, res())
  assert.deepEqual(calls.at(-1), ['/api/v1/messaging/workbench/watches', undefined])
})

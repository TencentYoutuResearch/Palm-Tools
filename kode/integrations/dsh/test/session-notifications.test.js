import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { registerSessionNotifications, registerNotificationSettings } from '../src/session-notifications.js'
import { installSessionNotifications } from '../packages/transport/notifications.js'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function host() {
  const ctx = new Context(), agents = new Map(), routes = []
  ctx.provide('agents', { get: id => agents.get(id), roots: () => [...agents.values()].filter(a => !a.child) })
  ctx.provide('webServer', { register: route => { routes.push(route); return () => routes.splice(routes.indexOf(route), 1) } })
  ctx.provide('connection', { admit: req => req.owner ? { peer: { principal: { kind: 'owner' } } } : { rejection: 403 } })
  const dispose = registerSessionNotifications(ctx, { waitMs: 5 })
  const agent = { id: 'fixture-session', status: 'running', session: { header: { title: 'Fixture conversation' } }, inbox: { nextTurn: [], nextStep: [] } }
  agents.set(agent.id, agent); agent.session.id = agent.id
  const open = (options = {}) => {
    const res = new EventEmitter(); res.chunks = []; res.writeHead = status => { res.status = status }; res.write = text => { res.chunks.push(text); return true }; res.end = () => res.emit('close')
    routes[0].handler({ owner: true, method: 'GET', headers: {}, ...options }, res)
    res.rows = () => res.chunks.flatMap(chunk => chunk.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))))
    return res
  }
  return { ctx, agent, open, dispose, event: (kind, seq = 1) => ctx.emit('session/event', agent.session, { type: 'turn/end', seq, data: { reason: { kind } } }), idle() { agent.status = 'idle'; ctx.emit('agent/status', { agent, status: 'idle' }) } }
}
test('completion waits for the idle edge, skips queued work, cancellation, errors and child Agents', () => {
  const h = host(), stream = h.open()
  try {
    h.event('completed'); assert.equal(stream.rows().length, 0)
    h.idle(); assert.equal(stream.rows()[0].kind, 'completed')
    h.idle(); assert.equal(stream.rows().length, 1)
    h.agent.inbox.nextTurn.push({}); h.event('completed', 2); h.idle(); h.agent.inbox.nextTurn = []
    h.event('completed', 3); h.event('error', 4); h.idle()
    for (const kind of ['aborted', 'interrupted', 'error']) { h.event(kind); h.idle() }
    h.agent.child = true; h.event('completed'); h.idle()
    assert.equal(stream.rows().length, 1)
  } finally { h.dispose() }
})
test('owner-only SSE reconnects after its cursor and never replays old completion on a fresh connection', () => {
  const h = host()
  try {
    assert.equal(h.open({ owner: false }).status, 403)
    assert.equal(h.open({ method: 'POST' }).status, 405)
    const stream = h.open(); h.event('completed'); h.idle()
    const cursor = stream.rows()[0].id; h.event('completed', 2); h.idle()
    assert.equal(h.open().rows().length, 0)
    assert.deepEqual(h.open({ headers: { 'last-event-id': cursor } }).rows().map(row => row.key), [`${h.agent.id}:2`])
  } finally { h.dispose() }
})
for (const event of ['user-questions/request', 'approval/request']) test(`${event}: live wait notifies once, resolves and preserves the answerer`, async () => {
  const h = host(), stream = h.open(), gate = Promise.withResolvers()
  const off = h.ctx.on(event, () => gate.promise)
  try {
    const waiting = h.ctx.waterfall(event, { agent: h.agent }, () => { throw Error('must not lose the answerer') })
    await delay(15); assert.equal(stream.rows().length, 1)
    assert.equal(h.open().rows()[0].id, stream.rows()[0].id)
    gate.resolve('original-answer'); assert.equal(await waiting, 'original-answer')
    assert.equal(stream.rows().at(-1).kind, 'resolved'); assert.equal(h.open().rows().length, 0)
  } finally { gate.resolve(); off(); h.dispose() }
})
test('instant answers, cancellation and teardown do not emit spurious wait notifications', async () => {
  const h = host(), stream = h.open()
  h.ctx.on('user-questions/request', async () => 'instant')
  await h.ctx.waterfall('user-questions/request', { agent: h.agent }, () => {})
  await delay(10); assert.equal(stream.rows().length, 0)
  const abort = new AbortController(); abort.abort()
  await h.ctx.waterfall('user-questions/request', { agent: h.agent, signal: abort.signal }, () => {})
  h.dispose(); await delay(10); assert.equal(stream.rows().length, 0)
})
function browser() {
  const notifications = [], events = [], effects = [], hooks = new Map(), opened = [], changes = new Set()
  let current = 'local', focused = false, selected = 'other', saved
  class Notification {
    static permission = 'granted'
    static async requestPermission() { return Notification.permission }
    constructor(title, options) { Object.assign(this, { title, options }); notifications.push(this) }
    close() { this.closed = true; this.onclose?.() }
  }
  class EventSource { constructor(path) { this.path = path; events.push(this) } close() { this.closed = true } }
  const env = { Notification, EventSource, document: { visibilityState: 'visible', hasFocus: () => focused }, window: { focus() {}, addEventListener: (key, fn) => hooks.set(key, fn), removeEventListener: key => hooks.delete(key) }, localStorage: { getItem: () => saved, setItem: (_key, value) => { saved = value } }, setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer }, clearTimeout }
  const ctx = { get: name => name === 'sessions' ? { list: { getSnapshot: () => ({ byId: { [selected]: { retainedBy: { mainView: 1 } } } }) } } : undefined, provide() {}, effect: fn => effects.push(fn()) }
  const transport = { get current() { return current }, getSnapshot: () => ({ switching: false }), path: (path, host) => `${host}${path}`, subscribe: fn => { changes.add(fn); return () => changes.delete(fn) }, async select(host, target) { opened.push({ host, ...target }) } }
  const service = installSessionNotifications(ctx, transport, env)
  const send = (patch = {}, stream = 0) => events[stream].onmessage({ data: JSON.stringify({ id: 'event-1', kind: 'completed', sessionId: 's', key: 's:turn1', title: 'My task', ...patch }) })
  return { env, service, send, events, notifications, opened, dispose: () => effects.forEach(fn => fn()), focus: id => { focused = true; selected = id }, switch(host) { current = host; for (const fn of changes) fn() } }
}
test('browser deduplicates, notifies the visible session, honors preferences and navigates notification clicks', async () => {
  const b = browser()
  try {
    b.send(); b.send(); assert.equal(b.notifications.length, 1)
    b.notifications[0].onclick(); await delay(0)
    assert.deepEqual(b.opened, [{ host: 'local', sessionId: 's' }])
    b.focus('s'); b.send({ id: 'event-2', key: 's:turn2' }); assert.equal(b.notifications.length, 2)
    b.service.update({ waiting: false }); b.send({ kind: 'question', id: 'q', key: 'q', sessionId: 'other' }); assert.equal(b.notifications.length, 2)
    b.service.update({ waiting: true }); b.send({ kind: 'question', id: 'q2', key: 'q2', sessionId: 'other' }); assert.equal(b.notifications.length, 3)
    b.send({ kind: 'resolved', key: 'q2' }); assert.equal(b.notifications[2].closed, true)
    b.env.Notification.permission = 'denied'; b.send({ id: 'event-3', sessionId: 'other' }); assert.equal(b.notifications.length, 3)
  } finally { b.dispose() }
})
test('visited SSH notification streams remain active after switching Hosts and are released on unload', () => {
  const b = browser()
  b.switch('fixture-ssh'); b.switch('local')
  assert.equal(b.events.length, 2); assert.equal(b.events[0].closed, undefined)
  b.send({ id: 'ssh-event', sessionId: 'remote' }, 1)
  b.notifications[0].onclick()
  assert.equal(b.opened[0].host, 'fixture-ssh')
  b.dispose(); assert.ok(b.events.every(stream => stream.closed)); assert.equal(b.notifications[0].closed, true)
})

test('notification settings explain denied permission and expose independently named switches', async () => {
  const { readFile } = await import('node:fs/promises'), vm = await import('node:vm')
  const source = await readFile(new URL('../src/agent-client.js', import.meta.url), 'utf8')
  const fragment = source.slice(source.indexOf('  function NotificationSettingsBody()'), source.indexOf('  const settingsSections ='))
  const h = (type, props, ...children) => ({ type, props, children: children.flat() })
  const state = { permission: 'denied', completed: true, waiting: false }, service = { subscribe() {}, getSnapshot: () => state }
  const scope = { h, React: { Fragment: 'fragment', useCallback: fn => fn, useMemo: fn => fn() }, useSyncExternalStore: (_subscribe, get) => get(), useState: initial => [initial, () => {}], Button: 'button', Failure: 'failure', avatarContext: { get: () => service } }
  vm.runInNewContext(fragment, scope)
  const view = scope.NotificationSettingsBody(), nodes = []
  const visit = value => { if (!value || typeof value !== 'object') return; nodes.push(value); for (const child of value.children ?? []) visit(child) }; visit(view)
  assert.ok(JSON.stringify(view).includes('macOS 系统设置'))
  assert.equal(nodes.filter(node => node.props?.role === 'switch').length, 2)
  assert.equal(nodes.some(node => node.type === 'button'), false)
  state.permission = 'granted'
  assert.ok(!JSON.stringify(scope.NotificationSettingsBody()).includes('发送测试通知'))
  state.systemSettings = true
  assert.ok(JSON.stringify(scope.NotificationSettingsBody()).includes('前往系统设置'))
  assert.ok(!JSON.stringify(scope.NotificationSettingsBody()).includes('已获授权'))
})


test('system settings are local, owner-only, POST-only and use a fixed macOS destination', async () => {
  let route
  const calls = []
  const ctx = { webServer: { register(value) { route = value; return () => {} } }, connection: { admit: req => req.owner ? { peer: { principal: { kind: 'owner' } } } : { rejection: 403 } } }
  const request = async patch => {
    const res = { writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
    await route.handler({ owner: true, method: 'POST', ...patch }, res)
    return res
  }
  registerNotificationSettings(ctx, { platform: 'darwin', open: async (...args) => calls.push(args) })
  assert.equal((await request({ owner: false })).status, 403)
  assert.equal((await request({ method: 'GET' })).status, 405)
  assert.equal(calls.length, 0)
  assert.equal((await request({})).status, 200)
  assert.deepEqual(calls[0], ['/usr/bin/open', ['x-apple.systempreferences:com.apple.Notifications-Settings.extension'], { timeout: 5000 }])
  registerNotificationSettings(ctx, { platform: 'linux', open: async () => assert.fail('must not open settings on a remote non-macOS Host') })
  assert.equal((await request({})).status, 400)
  registerNotificationSettings(ctx, { platform: 'darwin', open: async () => { throw new Error('failed') } })
  assert.equal((await request({})).status, 503)
})

test('notification failures reach settings and the test notification action is absent', () => {
  const b = browser()
  try {
    assert.equal(b.service.test, undefined)
    b.send()
    b.notifications[0].onerror()
    assert.equal(b.service.getSnapshot().deliveryError, true)
    b.notifications[0].onshow()
    assert.equal(b.service.getSnapshot().deliveryError, false)
  } finally { b.dispose() }
})

test('Desktop permission flow opens local system settings even while viewing SSH', async () => {
  const b = browser(), calls = []
  b.dispose()
  const env = { ...b.env, navigator: { platform: 'MacIntel', userAgent: 'Chrome Electron/44.7.0' } }
  const ctx = { get() {}, provide() {}, effect() {} }
  const transport = { current: 'fixture-ssh', getSnapshot: () => ({ switching: true }), subscribe: () => () => {}, async fetch(...args) { calls.push(args); return { ok: true } } }
  const service = installSessionNotifications(ctx, transport, env)
  await service.enable()
  assert.deepEqual(calls[0], ['/api/kode/notification-settings', { method: 'POST' }, 'local'])
})


test('Desktop uses the native carrier, reports failures and routes native clicks', async () => {
  const b = browser(), calls = []
  let click, disposed = false
  b.env.Notification.permission = 'denied'
  b.env.kodeDesktop = {
    async notify(data) { calls.push(data); return { status: 'failed' } },
    onNotificationClick(fn) { click = fn; return () => { disposed = true } },
  }
  // Install after the bridge exists, as happens before client boot in Desktop.
  b.dispose()
  const effects = [], streams = []
  b.env.EventSource = class { constructor() { streams.push(this) } close() {} }
  const opened = []
  const service = installSessionNotifications({ provide() {}, effect: fn => effects.push(fn()) }, {
    current: 'local', getSnapshot: () => ({}), path: p => p, subscribe: () => () => {},
    async select(host, target) { opened.push({ host, ...target }) },
  }, b.env)
  streams[0].onopen()
  assert.equal(service.getSnapshot().connection, 'connected')
  streams[0].onmessage({ data: JSON.stringify({ id: 'native-1', kind: 'completed', sessionId: 'native-session', key: 'native-key', title: 'Native task' }) })
  await delay(0)
  assert.equal(calls[0].title, '本轮已完成 · Kode')
  assert.equal(b.notifications.length, 0)
  assert.equal(service.getSnapshot().deliveryError, true)
  click('local:native-key'); await delay(0)
  assert.deepEqual(opened, [{ host: 'local', sessionId: 'native-session' }])
  assert.deepEqual(calls[1], { key: 'local:native-key', close: true })
  effects.forEach(fn => fn())
  assert.equal(disposed, true)
})

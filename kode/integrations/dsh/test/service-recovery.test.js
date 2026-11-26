import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm, access, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { Readable } from 'node:stream'
import vm from 'node:vm'
import { hasActiveSharedSessions, hasPendingSessions, localRecoverySupported, backendArguments, prepareLocalRecovery, processCommand } from '../src/service-recovery.js'
import { ProjectHosts } from '../src/project-hosts.js'
import { registerIntegrationApi } from '../src/integration-api.js'
import { readAgentClientSource } from '../scripts/build-agent-client.js'

const source = await readAgentClientSource()
const client = { window: { __ModuleLoader__: { load() {} } }, Date, Error }
vm.runInNewContext(source, client)

function recoveryPanel(host, capabilities, fetcher = async () => new Response('{"status":"restarting"}', { status: 202 })) {
  const states = [], refs = [], pending = [], window = {}
  let cursor = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => { const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }] },
    useRef: initial => { const index = cursor++; return refs[index] ??= { current: initial } }, useEffect() {}, useId: () => 'recovery-hint',
  }
  window.__ModuleLoader__ = { load: definition => definition.factory(name => name === 'react' ? react : new Proxy({}, { get: (_, key) => key })) }
  vm.runInNewContext(source.replace("  return { inject: ['slots'", "  window.recoveryPanel = ServiceRecovery;\n  return { inject: ['slots'"), { window, fetch: fetcher, AbortController, Date, Error, setTimeout, clearTimeout })
  let retried = 0
  const settings = { request: () => new Promise(resolve => pending.push(resolve)), retry: () => retried++ }
  states[0] = { current: 'local', hosts: [], ...capabilities }
  return { render() { cursor = 0; return window.recoveryPanel({ host, settings }) }, pending, retried: () => retried }
}
function descendants(node) { return !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flat(Infinity).flatMap(descendants)] }
function textOf(node) { return node == null || typeof node === 'boolean' ? '' : typeof node === 'object' ? (node.children ?? []).map(textOf).join(' ') : String(node) }

test('recovery buttons target the selected Host, disable during work, and reconnect after readiness', async () => {
  const sent = [], panel = recoveryPanel('local', { localRecoverySupported: true }, async (url, options) => { sent.push({ url, body: JSON.parse(options.body) }); return new Response('{"status":"restarting"}', { status: 202 }) })
  let tree = panel.render()
  const button = descendants(tree).find(node => textOf(node) === '重启服务')
  assert.ok(button); assert.equal(button.props.disabled, false)
  button.props.onClick()
  tree = panel.render()
  assert.equal(tree.props['aria-busy'], true)
  assert.ok(descendants(tree).filter(node => node.type === 'Button').every(node => node.props.disabled))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent[0].url, '/api/kode/project-hosts?current=local'); assert.equal(sent[0].body.id, 'local')
  panel.pending[0]({ settings: {} }); await new Promise(resolve => setImmediate(resolve))
  assert.equal(panel.retried(), 1); assert.equal(panel.render().props['aria-busy'], false)
  assert.match(textOf(recoveryPanel('ssh-1', { deploymentSupported: true }).render()), /更新并部署服务/)
  const unsupportedPanel = recoveryPanel('local', { localRecoverySupported: false }), unsupported = unsupportedPanel.render()
  assert.match(textOf(unsupported), /此启动方式不支持在这里重启本机服务/)
  assert.doesNotMatch(textOf(unsupported), /重启服务/)
})

test('missing UI and backend routes both carry a recoverable code, including JSON and plain-text 404s', async () => {
  for (const response of [new Response('not found', { status: 404 }), new Response('{"error":"not found"}', { status: 404 })]) {
    await assert.rejects(client.parseHostJson(response), error => error.code === 'KODE_SERVICE_UPDATE_REQUIRED')
  }
  let handler
  registerIntegrationApi({ webServer: { register: route => { handler = route.handler } }, connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) } }, { call: async () => { throw Object.assign(new Error('old backend'), { status: 404 }) } })
  let body
  const res = { setHeader() {}, end: value => { body = JSON.parse(value) } }
  await handler({ method: 'GET' }, res)
  assert.equal(res.statusCode, 503); assert.equal(body.code, 'KODE_SERVICE_UPDATE_REQUIRED')
})

test('local recovery waits for the replacement API; remote recovery waits for deployment before probing settings', async () => {
  const stop = new AbortController(), requests = [], states = []
  let probes = 0
  const value = await client.recoverHostService('local', { signal: stop.signal, request: async body => { requests.push(body); return { status: 'restarting' } }, readSettings: async () => { if (++probes === 1) throw new Error('restarting'); return 'ready' }, progress: job => states.push(job.status), delay: async () => {} })
  assert.equal(value, 'ready'); assert.equal(requests.length, 1); assert.equal(probes, 2)
  probes = 0
  await client.recoverHostService('remote', { signal: stop.signal, request: async (body, id) => { requests.push({ body, id }); return body ? { id: 'job', status: 'running' } : { id, status: 'done' } }, readSettings: async () => { probes++; return 'ready' }, progress() {}, delay: async () => {} })
  assert.equal(probes, 1); assert.equal(requests.at(-1).id, 'job')
})

test('Desktop waits for the restart job before querying an already reachable backend', async () => {
  const events = []
  let polling = 0
  const result = await client.recoverHostService('local', {
    signal: new AbortController().signal,
    request: async (body, id) => {
      if (body) { events.push('start'); return { id: 'desktop-restart', status: 'running' } }
      assert.equal(id, 'desktop-restart')
      events.push('poll')
      return { id, status: ++polling === 2 ? 'done' : 'running' }
    },
    progress: job => events.push(job.status),
    delay: async () => {},
    readSettings: async () => { assert.equal(polling, 2); events.push('settings'); return 'ready' },
  })
  assert.equal(result, 'ready')
  assert.deepEqual(events, ['start', 'running', 'poll', 'running', 'poll', 'done', 'settings'])
})

test('recovery propagates deployment and auth failures and stops polling on unmount', async () => {
  const base = { signal: new AbortController().signal, progress() {}, delay: async () => {}, readSettings: async () => { throw Object.assign(new Error('auth'), { status: 403 }) } }
  await assert.rejects(client.recoverHostService('remote', { ...base, request: async () => ({ status: 'failed', error: 'busy sessions' }) }), /busy sessions/)
  await assert.rejects(client.recoverHostService('local', { ...base, request: async () => ({ status: 'restarting' }) }), /auth/)
  const stop = new AbortController(); stop.abort(new Error('unmounted'))
  await assert.rejects(client.recoverHostService('local', { ...base, signal: stop.signal, request: () => assert.fail('must not restart after unmount') }), /unmounted/)
})

test('only an idle CLI Web Host can prepare recovery; backend launch arguments require a configured loopback service', async () => {
  assert.equal(hasPendingSessions([{ running: true }]), true)
  assert.equal(hasPendingSessions([{ projections: { values: { inbox: { waiting: [{}] } } } }]), true)
  assert.equal(hasPendingSessions([{ projections: { values: { kodeInbox: { 'next-turn': [{}], 'next-step': [] } } } }]), true)
  assert.equal(hasPendingSessions([{ projections: { values: { inbox: {}, kodeInbox: { 'next-step': [{}] } } } }]), true)
  assert.equal(hasPendingSessions([{ projections: { values: { kodeInbox: { 'next-turn': [], 'next-step': [] } } } }]), false)
  assert.equal(hasPendingSessions([{ running: false }]), false)
  const ctx = { get: name => name === 'appExit' ? () => {} : { list: async () => ({ items: [{ running: true }] }) } }
  assert.equal(localRecoverySupported(ctx, ['/opt/node', '/opt/node_modules/@deepseek-ai/dsh/lib/bin.js', 'web']), true)
  assert.equal(localRecoverySupported(ctx, ['/opt/electron', '/opt/desktop-host/lib/index.js']), false)
  assert.throws(() => backendArguments({ url: 'https://server.example' }), /本机/)
  assert.deepEqual(backendArguments({ url: 'http://127.0.0.1:49000', serverCommand: '/opt/kode-session-server', serverConfig: '/srv/config.json', tokenFile: '/srv/token' }), ['--config', '/srv/config.json', '--token-file', '/srv/token', '--bind', '127.0.0.1:49000'])
  const argv = process.argv
  try {
    process.argv = ['/opt/node', '/opt/node_modules/@deepseek-ai/dsh/lib/bin.js', 'web']
    await assert.rejects(prepareLocalRecovery(ctx, {}), /运行中或排队/)
  } finally { process.argv = argv }
})

test('Desktop can only restart a configured standalone service and respects active shared sessions', async () => {
  const argv = ['/opt/electron', '/opt/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'], versions = { electron: '1' }
  const ctx = { get: name => name === 'sessionController' ? { list: async () => ({ items: [] }) } : undefined }
  const config = { url: 'http://127.0.0.1:47870', serverCommand: '/opt/kode-session-server', serverConfig: '/srv/config.json', tokenFile: '/srv/token', backendClient: { call: async path => {
    assert.equal(path, '/api/v1/messaging/runtime/sessions')
    return { sessions: [{ status: 'busy', runtime_online: true }] }
  } } }
  assert.equal(localRecoverySupported(ctx, argv, config, versions), true)
  assert.equal(localRecoverySupported(ctx, argv, { ...config, serverCommand: '/opt/Kode' }, versions), false)
  assert.equal(localRecoverySupported(ctx, argv, config, {}), false)
  assert.equal(localRecoverySupported(ctx, argv, { ...config, url: 'https://server.example' }, versions), false)
  assert.equal(hasActiveSharedSessions([{ status: 'starting' }, { status: 'idle' }]), true)
  assert.equal(hasActiveSharedSessions([{ status: 'busy', owner_alive: false }, { status: 'idle' }]), false)
  await assert.rejects(prepareLocalRecovery(ctx, config, { argv, versions }), /有客户端正在使用共享 Kode 服务/)
  await assert.rejects(prepareLocalRecovery(ctx, { ...config, backendClient: { call: async () => null } }, { argv, versions }), /无法检查其他客户端/)
})

test('Desktop restart status is readable while the shared backend is down', async () => {
  const manager = new ProjectHosts({}, {})
  manager.document = { read() { assert.fail('Polling must not require the backend under restart') } }
  manager.localRecoveryJob = { id: 'fixture-recovery', status: 'running' }
  const query = id => new Promise((resolve, reject) => {
    const res = { writeHead(status) { this.status = status }, end(data) { resolve([this.status, JSON.parse(data)]) } }
    manager.handle({ method: 'GET', url: '/api/kode/project-hosts?recovery=' + id }, res).catch(reject)
  })
  assert.deepEqual(await query('fixture-recovery'), [200, { id: 'fixture-recovery', status: 'running' }])
  manager.localRecoveryJob.status = 'done'
  assert.deepEqual(await query('fixture-recovery'), [200, { id: 'fixture-recovery', status: 'done' }])
  assert.equal((await query('different-recovery'))[0], 404)
})

test('SSH recovery uses the saved target and ignores request-supplied replacement addresses', async () => {
  const manager = new ProjectHosts({}, {})
  manager.hosts = [{ id: 'ssh-1', name: 'Builder', host: 'user@builder.example', port: 2200, config_file: '/example/ssh.conf', token: 'private' }]
  let input, payload
  manager.startDeployment = value => { input = value; return { id: 'job', status: 'running' } }
  const req = Readable.from([JSON.stringify({ action: 'recover-service', id: 'ssh-1', host: 'attacker.example' })])
  req.method = 'POST'; req.headers = { 'content-type': 'application/json' }
  await manager.handle(req, { writeHead(status) { assert.equal(status, 202) }, end(value) { payload = JSON.parse(value) } }, 'ssh-1')
  assert.equal(input.host, 'user@builder.example'); assert.equal(input.configFile, '/example/ssh.conf')
  assert.equal(payload.status, 'running'); assert.equal(JSON.stringify(payload).includes('private'), false)
})

for (const matchingIdentity of [true, false]) test(`Desktop recovery leaves its Host up and ${matchingIdentity ? 'probes the new backend PID' : 'rejects a stale backend identity'}`, { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-desktop-recovery-test-'))
  const backend = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
  const host = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
  let worker, newPid
  try {
    await Promise.all([once(backend, 'spawn'), once(host, 'spawn')])
    const socket = createServer().listen(0, '127.0.0.1')
    await once(socket, 'listening')
    const port = socket.address().port
    await new Promise(resolve => socket.close(resolve))
    const marker = join(root, 'backend.pid'), tokenFile = join(root, 'token'), staging = join(root, 'recovery')
    await mkdir(staging); await writeFile(tokenFile, 'fixture-token')
    const command = `const s = require('http').createServer((req, res) => {
      if (req.url !== '/api/v1/messaging/node' || req.headers.authorization !== 'Bearer fixture-token') return res.writeHead(403).end();
      res.end(JSON.stringify({pid: process.pid}));
    }); s.listen(${port}, '127.0.0.1', () => require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)));
    process.on('SIGINT', () => s.close());`
    const plan = { backendOnly: true, parent: host.pid, backend: { pid: backend.pid, command: matchingIdentity ? await processCommand(backend.pid) : 'another process' }, command: process.execPath, args: ['-e', command], url: 'http://127.0.0.1:' + port, tokenFile, cwd: root, env: process.env }
    const file = join(staging, 'plan.json'); await writeFile(file, JSON.stringify(plan), { mode: 0o600 })
    worker = fork(new URL('../src/service-recovery-worker.js', import.meta.url), [file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    assert.deepEqual((await once(worker, 'message'))[0], { ready: true })
    const exit = once(worker, 'exit'), finished = once(worker, 'message')
    worker.send({ commit: true })
    const [{ result }] = await finished
    await exit
    assert.equal(host.exitCode, null); assert.equal(host.signalCode, null)
    if (matchingIdentity) {
      newPid = Number(await readFile(marker, 'utf8'))
      assert.notEqual(newPid, backend.pid)
      assert.deepEqual(result, { status: 'done' })
      assert.equal(backend.signalCode, 'SIGINT')
    } else {
      await assert.rejects(access(marker))
      assert.equal(result.status, 'failed')
      assert.equal(backend.signalCode, null)
    }
  } finally {
    for (const child of [worker, host, backend]) if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    if (newPid) process.kill(newPid, 'SIGINT')
    await rm(root, { recursive: true, force: true })
  }
})

for (const matchingIdentity of [true, false]) test(`detached worker relaunches the Host and ${matchingIdentity ? 'replaces the verified backend' : 'preserves a mismatched process'}`, { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-recovery-test-'))
  const parent = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
  const backend = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
  let worker
  try {
    await Promise.all([once(parent, 'spawn'), once(backend, 'spawn')])
    const marker = join(root, 'host-started'), server = join(root, 'backend-started')
    const plan = { parent: parent.pid, backend: { pid: backend.pid, command: matchingIdentity ? await processCommand(backend.pid) : 'another process' }, command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(server)},'ready')`], executable: process.execPath, argv: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'ready')`], cwd: root, env: process.env }
    const staging = join(root, 'recovery'); await mkdir(staging)
    const file = join(staging, 'plan.json'); await writeFile(file, JSON.stringify(plan), { mode: 0o600 })
    worker = fork(new URL('../src/service-recovery-worker.js', import.meta.url), [file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    const [ready] = await once(worker, 'message'); assert.equal(ready.ready, true)
    worker.send({ commit: true }); worker.disconnect()
    const exited = once(worker, 'exit'); parent.kill('SIGTERM'); await exited
    const deadline = Date.now() + 3000
    while (true) { try { await access(marker); if (matchingIdentity) await access(server); break } catch { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20)) } }
    if (matchingIdentity) { await access(server); assert.ok(backend.exitCode !== null || backend.signalCode !== null) }
    else { await assert.rejects(access(server)); assert.equal(backend.exitCode, null); assert.equal(backend.signalCode, null) }
  } finally {
    for (const child of [worker, parent, backend]) if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await rm(root, { recursive: true, force: true })
  }
})

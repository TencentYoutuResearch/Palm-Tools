import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { registerModelUsageApi } from '../src/model-usage-api.js'
import { BackendClient } from '../src/backend-client.js'
function fixture(call, hosts) {
  let handler, owner = true
  registerModelUsageApi({ get: () => hosts, webServer: { register(route) { handler = route.handler; return () => {} } }, connection: { admit: () => ({ peer: { principal: { kind: owner ? 'owner' : 'session' } } }) } }, { call })
  return { setOwner(value) { owner = value }, async request(query = '', method = 'GET') {
    let status, body, headers
    await handler({ method, url: '/api/kode/model-usage' + query }, { writeHead(code, h) { status = code; headers = h }, end(value) { body = JSON.parse(value) } })
    return { status, body, headers }
  } }
}
test('usage is owner-only, read-only, and validates period and timezone before contacting backend', async () => {
  let calls = 0
  const api = fixture(async () => { calls++; return {} })
  api.setOwner(false); assert.equal((await api.request()).status, 403)
  api.setOwner(true); assert.equal((await api.request('', 'POST')).status, 405)
  for (const query of ['?period=unknown', '?timezone_offset_minutes=1440', '?timezone_offset_minutes=1.5', '?timezone_offset_minutes=']) assert.equal((await api.request(query)).status, 400)
  assert.equal(calls, 0)
})
test('concurrent usage requests share one scan and use the viewer calendar boundary for remote machines', async () => {
  const paths = [], snapshot = { totals: { total_tokens: 12 }, rows: [], daily: [] }
  const api = fixture(async path => { paths.push(path); return snapshot })
  const [first, second] = await Promise.all([api.request('?period=month&timezone_offset_minutes=480'), api.request('?period=month&timezone_offset_minutes=480')])
  assert.deepEqual(first.body, { ...snapshot, until_ms: first.body.until_ms }); assert.deepEqual(second.body, first.body); assert.equal(paths.length, 1)
  assert.equal(first.headers['cache-control'], 'no-store')
  const url = new URL(paths[0], 'https://fixture.example'), since = Number(url.searchParams.get('since_ms')), calendar = new Date(since + 480 * 60000)
  assert.equal(calendar.getUTCDate(), 1); assert.equal(calendar.getUTCHours(), 0)
  await api.request('?period=all&timezone_offset_minutes=-300')
  assert.equal(new URL(paths[1], 'https://fixture.example').searchParams.has('since_ms'), false)
})
test('failed scans may be retried and errors do not expose backend credentials', async () => {
  let calls = 0
  const api = fixture(async () => { if (++calls === 1) throw Object.assign(new Error('secret-internal-path'), { status: 404 }); return { totals: {} } })
  const first = await api.request(); assert.equal(first.status, 503); assert.ok(!JSON.stringify(first).includes('secret-internal-path'))
  assert.equal((await api.request()).status, 200); assert.equal(calls, 2)
})

test('device usage adds Kode bridges and DSH-only SSH hosts once, preserving time buckets when a host is offline', async t => {
  const paths = [], transfers = [], visits = []
  const day = '2026-01-12', hour = day + 'T09:00'
  const snapshot = (query, total_tokens) => {
    const row = { source: 'local', backend: 'codex', model: 'shared', input_tokens: total_tokens - 1, output_tokens: 1, cached_tokens: 0, total_tokens }
    return { period: query.get('period'), until_ms: Number(query.get('until_ms')), rows: [row], totals: row,
      timeline: [{ date: hour, rows: [row] }], daily: [{ date: day, total_tokens }], warnings: [] }
  }
  const server = createServer((req, res) => {
    transfers.push({ url: req.url, auth: req.headers.authorization })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(snapshot(new URL(req.url, 'http://localhost').searchParams, 30)))
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  let closed = 0
  const hosts = {
    async usageHosts() { return [
      { id: 'duplicate-build', name: 'Build alias', host: 'developer@build.example', port: 2222 },
      { id: 'test', name: 'Test host', host: 'test.example' },
      { id: 'offline', name: 'Offline host', host: 'offline.example' },
      { id: 'old', name: 'Old host', host: 'old.example' },
    ] },
    async openTunnel(config) {
      assert.deepEqual(config, { host: 'developer@build.example', port: 2222, remote_port: 9870, use_config_port: true })
      return { url: `http://127.0.0.1:${server.address().port}`, async close() { closed++ } }
    },
    async connect(id) {
      visits.push(id)
      if (id === 'offline') throw new Error('sensitive connection detail')
      return { async usage(query) {
        assert.equal(query.get('since_ms'), '1768208400000')
        return id === 'old' ? { ...snapshot(query, 500), until_ms: null } : snapshot(query, 20)
      } }
    },
  }
  const api = fixture(async path => {
    paths.push(path)
    if (path.includes('/catalog?')) return { endpoints: [
      { id: 'build', display_name: 'Build', ssh_host: 'developer@build.example', ssh_port: 2222, token: 'bridge-fixture-token' },
    ] }
    return snapshot(new URL(path, 'https://fixture.example').searchParams, 10)
  }, hosts)
  const query = '?scope=devices&period=today&since_ms=1768208400000&until_ms=1768212000000&timezone_offset_minutes=480'
  const [first, second] = await Promise.all([api.request(query), api.request(query)])
  assert.equal(first.status, 200)
  assert.deepEqual(first, second)
  const { body } = first
  assert.equal(body.totals.total_tokens, 60)
  assert.deepEqual(body.rows.map(row => row.source), ['local', 'endpoint:build', 'ssh:test'])
  assert.deepEqual(body.devices.map(device => device.name), ['此计算机', 'Build', 'Test host'])
  assert.deepEqual(body.timeline, [{ date: hour, rows: body.rows }])
  assert.deepEqual(body.daily, [{ date: day, total_tokens: 60 }])
  assert.deepEqual(body.warnings, ['Offline host 的 token 用量暂不可用。', 'Old host 的 token 用量暂不可用。'])
  assert.equal(body.until_ms, 1768212000000)
  assert.equal(paths.length, 2)
  assert.equal(transfers.length, 1)
  assert.match(transfers[0].url, /^\/api\/v1\/model-usage\?/)
  assert.equal(new URL(transfers[0].url, 'http://localhost').searchParams.get('until_ms'), String(body.until_ms))
  assert.equal(transfers[0].auth, 'Bearer bridge-fixture-token')
  assert.equal(JSON.stringify(body).includes('bridge-fixture-token'), false)
  assert.deepEqual(visits, ['test', 'offline', 'old'])
  assert.equal(closed, 1)
})
test('backend usage access retains server authentication and accepts only the messaging namespace', async () => {
  let captured
  const backend = new BackendClient('https://backend.example', 'fixture-token', { fetch: async (url, options) => { captured = { url, options }; return Response.json({ totals: {} }) } })
  await backend.call('/api/v1/messaging/model-usage?period=today&timezone_offset_minutes=480&since_ms=1780000000000')
  assert.equal(captured.options.headers.authorization, 'Bearer fixture-token'); assert.equal(captured.options.method, 'GET'); assert.equal(captured.options.redirect, 'error')
  for (const path of ['/api/v1/model-usage', '/api/v1/sessions']) await assert.rejects(backend.call(path), /unsupported/)
})

test('standalone server serves the real CLI collector through the authenticated messaging route', { skip: !process.env.KODE_TEST_BACKEND_URL }, async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os'), { join } = await import('node:path'), { fileURLToPath } = await import('node:url')
  const { spawn } = await import('node:child_process'), { once } = await import('node:events')
  const root = await mkdtemp(join(tmpdir(), 'kode-usage-http-')), token = 'fixture-administrator-token-32-characters'
  let child
  try {
    await mkdir(join(root, 'codex/sessions'), { recursive: true })
    await writeFile(join(root, 'codex/sessions/rollout-range-fixture.jsonl'), [
      { type: 'turn_context', payload: { model: 'fixture-model' } },
      ...[10, 30, 60].map((total, index) => ({ timestamp: `2026-01-12T${String(9 + index).padStart(2, '0')}:00:00Z`, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total, output_tokens: 0, total_tokens: total } } } })),
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    await writeFile(join(root, 'admin.token'), token, { mode: 0o600 })
    await writeFile(join(root, 'config.json'), JSON.stringify({ node_id: 'usage-fixture', database: join(root, 'db.sqlite'), peers: [] }))
    const endpoint = { id: 'build', display_name: 'Build', ssh_host: 'build.example', token: 'fixture-only' }
    await writeFile(join(root, 'gui.json'), JSON.stringify({ endpoints: [endpoint], tabs: [{ session_id: 'fixture' }] }))
    const project = fileURLToPath(new URL('../../../', import.meta.url))
    const binary = join(process.env.CARGO_TARGET_DIR ?? join(project, 'target'), 'debug/kode-session-server')
    child = spawn(binary, ['--config', join(root, 'config.json'), '--token-file', join(root, 'admin.token'), '--bind', '127.0.0.1:0'], {
      env: { ...process.env, HOME: root, CODEX_HOME: join(root, 'codex'), XDG_CONFIG_HOME: join(root, 'config'), KODE_AGENT_HUB_HOME: join(root, 'agents'), KODE_GUI_STATE_PATH: join(root, 'gui.json'), KODE_CLOUD_SYNC_CONFIG: join(root, 'cloud.json'), KODE_MEMORY_ROOT: join(root, 'memory') }, stdio: ['ignore', 'pipe', 'ignore'] })
    const address = await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 10000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.stdout.on('data', bytes => { output += bytes; const match = output.match(/kode-session-server usage-fixture (127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]) } })
    })
    const backend = new BackendClient(`http://${address}`, token)
    assert.deepEqual(await backend.call('/api/v1/messaging/workbench/catalog?view=endpoints'), { endpoints: [endpoint] })
    const api = fixture(path => backend.call(path))
    const response = await api.request('?period=today&timezone_offset_minutes=480')
    assert.equal(response.status, 200); assert.equal(response.body.period, 'today')
    assert.equal(response.body.daily.length, 1); assert.equal(response.body.totals.total_tokens, 0)
    assert.deepEqual(response.body.rows, [])
    const since = Date.parse('2026-01-12T09:30:00Z'), until = Date.parse('2026-01-12T10:30:00Z')
    const bounded = await api.request(`?period=today&since_ms=${since}&until_ms=${until}`)
    assert.equal(bounded.status, 200)
    assert.equal(bounded.body.until_ms, until)
    assert.equal(bounded.body.totals.total_tokens, 20)
    assert.equal(bounded.body.timeline.reduce((total, bucket) => total + bucket.rows.reduce((n, row) => n + row.total_tokens, 0), 0), 20)
    assert.equal(bounded.body.daily.length, 1)
    assert.equal(bounded.body.daily[0].total_tokens, 20)
  } finally {
    if (child && child.exitCode === null && child.pid) { const exited = once(child, 'exit'); child.kill('SIGINT'); await exited }
    await rm(root, { recursive: true, force: true })
  }
})


test('a custom start overrides calendar presets and separates cached ranges', async () => {
  const paths = [], api = fixture(async path => { paths.push(path); return { rows: [] } })
  const since = new Date('2026-01-12T08:23:00Z').getTime()
  await api.request(`?period=today&since_ms=${since}`)
  await api.request(`?period=today&since_ms=${since + 60000}`)
  assert.equal(paths.length, 2)
  assert.equal(new URL(paths[0], 'https://fixture.example').searchParams.get('since_ms'), String(since))
  for (const value of ['-1', 'bad', '1.5', String(Date.now() + 86400000)]) assert.equal((await api.request(`?since_ms=${value}`)).status, 400)
  assert.equal(paths.length, 2)
})


test('end time is forwarded, isolates cached intervals, and rejects inverted or invalid ranges', async () => {
  const paths = [], api = fixture(async path => { paths.push(path); return { rows: [], until_ms: Number(new URL(path, 'https://fixture.example').searchParams.get('until_ms')) } })
  const since = new Date('2026-01-12T08:23:00Z').getTime(), until = since + 3600000
  const first = await api.request(`?period=today&since_ms=${since}&until_ms=${until}`)
  assert.equal(first.body.until_ms, until)
  assert.equal(new URL(paths[0], 'https://fixture.example').searchParams.get('until_ms'), String(until))
  await api.request(`?period=today&since_ms=${since}&until_ms=${until + 1000}`)
  assert.equal(paths.length, 2)
  for (const value of ['-1', 'bad', '1.5', String(Date.now() + 86400000), String(since - 1)]) {
    assert.equal((await api.request(`?since_ms=${since}&until_ms=${value}`)).status, 400)
  }
  assert.equal(paths.length, 2)
})


test('a Host that ignores the end boundary cannot display unbounded totals as a selected range', async () => {
  const api = fixture(async () => ({ totals: { total_tokens: 100 } }))
  const result = await api.request('?period=all&since_ms=100&until_ms=200')
  assert.equal(result.status, 503)
  assert.match(result.body.error, /更新并重启/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { registerModelUsageApi } from '../src/model-usage-api.js'
import { BackendClient } from '../src/backend-client.js'
function fixture(call) {
  let handler, owner = true
  registerModelUsageApi({ webServer: { register(route) { handler = route.handler; return () => {} } }, connection: { admit: () => ({ peer: { principal: { kind: owner ? 'owner' : 'session' } } }) } }, { call })
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
  assert.deepEqual(first.body, snapshot); assert.deepEqual(second.body, snapshot); assert.equal(paths.length, 1)
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
    await writeFile(join(root, 'admin.token'), token, { mode: 0o600 })
    await writeFile(join(root, 'config.json'), JSON.stringify({ node_id: 'usage-fixture', database: join(root, 'db.sqlite'), peers: [] }))
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
    const api = fixture(path => backend.call(path))
    const response = await api.request('?period=today&timezone_offset_minutes=480')
    assert.equal(response.status, 200); assert.equal(response.body.period, 'today')
    assert.equal(response.body.daily.length, 84); assert.equal(response.body.totals.total_tokens, 0)
    assert.deepEqual(response.body.rows, [])
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

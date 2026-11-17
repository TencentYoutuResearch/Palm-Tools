/** Real stdio + loopback HTTP transport, fabricated data only; no Kode services/providers. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

async function fixture({ directInsert = true, redirect = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kode-interop-stdio-')), calls = [], pending = new Map()
  let next = 0, stderr = '', aborted = false
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : null
    calls.push({ path: req.url, token: req.headers.authorization, body })
    res.setHeader('content-type', 'application/json')
    if (req.headers.authorization !== 'Bearer fictional-session-token') { res.writeHead(403); res.end('{}'); return }
    if (req.url.endsWith('/self')) return res.end(JSON.stringify({ address: { node_id: 'fixture-node', session_id: 'fixture-caller' } }))
    if (req.url.endsWith('/node')) return res.end(JSON.stringify({ direct_insert: directInsert }))
    if (req.url === '/api/kode/session-interop') {
      if (redirect) { res.writeHead(302, { location: '/must-not-follow' }); return res.end('{}') }
      if (body.system_prompt === 'hold-until-cancel') { res.on('close', () => { aborted = true }); return }
      if (body.session_id === 'denied-target') { res.writeHead(403); return res.end(JSON.stringify({ error: 'Explicit owner grant required' })) }
      return res.end(JSON.stringify(body.action === 'summary' ? { summary: 'Fixture summary', snapshot_only: true } : { selected: { model: body.model }, effective: 'next_turn' }))
    }
    if (req.url.endsWith('/messages')) return res.end(JSON.stringify({ id: 'fixture-message', ...body }))
    res.writeHead(404); res.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`, tokenFile = join(root, 'fixture.token')
  await writeFile(tokenFile, 'fictional-session-token', { mode: 0o600 })
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.js', import.meta.url))], { env: { PATH: process.env.PATH, HOME: root, KODE_MESSAGING_URL: origin, KODE_MESSAGING_TOKEN_FILE: tokenFile, KODE_SESSION_INTEROP_URL: origin }, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  child.stderr.setEncoding('utf8'); child.stderr.on('data', data => { stderr += data })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => { const value = JSON.parse(line); pending.get(value.id)?.(value); pending.delete(value.id) })
  const call = (method, params) => {
    const id = ++next
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Fixture MCP timeout: ${stderr}`)) }, 5000)
      pending.set(id, value => { clearTimeout(timer); resolve(value) })
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return { id, result }
  }
  return { calls, call, child, aborted: () => aborted, async close() { child.stdin.end(); await exited; lines.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) } }
}
const invoke = async (f, name, args) => (await f.call('tools/call', { name, arguments: args }).result).result

test('real MCP transport forwards summary/model/direct_insert with session credentials and propagates denial', async () => {
  const f = await fixture()
  try {
    const tools = (await f.call('tools/list', {}).result).result.tools
    assert.ok(tools.some(t => t.name === 'kode_sessions_summary'))
    assert.ok(tools.some(t => t.name === 'kode_sessions_set_model'))
    const summary = await invoke(f, 'kode_sessions_summary', { session_id: 'fixture-target', system_prompt: 'Summarize fabricated task' })
    assert.equal(JSON.parse(summary.content[0].text).summary, 'Fixture summary')
    const model = await invoke(f, 'kode_sessions_set_model', { session_id: 'fixture-target', model: 'fixture-model' })
    assert.equal(JSON.parse(model.content[0].text).effective, 'next_turn')
    const denied = await invoke(f, 'kode_sessions_summary', { session_id: 'denied-target', system_prompt: 'Summary' })
    assert.equal(denied.isError, true); assert.match(denied.content[0].text, /owner grant/)
    const args = { node_id: 'fixture-node', session_id: 'fixture-target', content: 'Fabricated input', idempotency_key: 'fixture-key' }
    await invoke(f, 'kode_sessions_send', { ...args, direct_insert: true })
    await invoke(f, 'kode_sessions_send', { ...args, direct_insert: false })
    const sends = f.calls.filter(c => c.path.endsWith('/messages'))
    assert.equal(sends[0].body.direct_insert, true); assert.equal(Object.hasOwn(sends[1].body, 'direct_insert'), false)
    assert.ok(f.calls.every(c => c.token === 'Bearer fictional-session-token'))
  } finally { await f.close() }
})
test('MCP refuses unsupported direct insertion before sending and never follows interop redirects', async () => {
  const f = await fixture({ directInsert: false, redirect: true })
  try {
    const result = await invoke(f, 'kode_sessions_send', { direct_insert: true })
    assert.equal(result.isError, true); assert.equal(f.calls.some(c => c.path.endsWith('/messages')), false)
    assert.equal((await invoke(f, 'kode_sessions_summary', { system_prompt: 'Fixture' })).isError, true)
    assert.equal(f.calls.some(c => c.path === '/must-not-follow'), false)
  } finally { await f.close() }
})
test('MCP cancellation aborts pending summary HTTP rather than leaving inference request connected', async () => {
  const f = await fixture()
  try {
    const request = f.call('tools/call', { name: 'kode_sessions_summary', arguments: { system_prompt: 'hold-until-cancel' } })
    const deadline = Date.now() + 3000
    while (!f.calls.some(c => c.body?.system_prompt === 'hold-until-cancel')) { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 10)) }
    f.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: request.id } }) + '\n')
    assert.equal((await request.result).result.isError, true)
    while (!f.aborted()) { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 10)) }
  } finally { await f.close() }
})

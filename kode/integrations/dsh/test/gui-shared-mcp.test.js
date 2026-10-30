/** The desktop's bundled MCP uses the same backend as dsh, with a scoped identity. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { BackendClient } from '../src/backend-client.js'

test('GUI session MCP bootstraps its own identity and uses backend communication and reviewed memory', { skip: !process.env.KODE_TEST_BACKEND_URL }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-gui-shared-mcp-'))
  const admin = new BackendClient(process.env.KODE_TEST_BACKEND_URL, (await readFile(process.env.KODE_TEST_TOKEN_FILE, 'utf8')).trim())
  const nativeId = Math.floor(Math.random() * 100000) + 1, processId = process.pid
  const projection = await admin.call('/api/v1/messaging/runtime/publish', { runtime: 'gui', boot_id: randomUUID(), sessions: [{ session_id: `gui-${randomUUID()}`, dto: { title: 'GUI shared MCP fixture', native_runtime_id: nativeId, native_process_id: processId, status: 'idle', backend_key: 'codex' }, events: [] }] })
  const publicId = projection.sessions[0].id
  const target = await admin.call('/api/v1/messaging/sessions', { session_id: `target-${randomUUID()}`, title: 'dsh recipient', runtime: 'dsh' })
  const descriptor = join(root, 'connection.json')
  await writeFile(descriptor, JSON.stringify({ url: process.env.KODE_TEST_BACKEND_URL, token_file: process.env.KODE_TEST_TOKEN_FILE }), { mode: 0o600 })
  const binary = fileURLToPath(new URL('../../../target/debug/kode-session-mcp', import.meta.url))
  const child = spawn(binary, [], { env: { ...process.env, KODE_HOST: '1', KODE_BACKEND_KEY: 'codex', KODE_SESSION_ID: String(nativeId), KODE_GUI_PROCESS_ID: String(processId), KODE_WORKBENCH_CONNECTION: descriptor }, stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = createInterface({ input: child.stdout }), pending = new Map(); let cursor = 0
  lines.on('line', line => { const response = JSON.parse(line); pending.get(response.id)?.(response); pending.delete(response.id) })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++cursor, timer = setTimeout(() => reject(new Error(`GUI MCP ${method} timed out`)), 10000)
    pending.set(id, response => { clearTimeout(timer); resolve(response) }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  try {
    assert.equal((await call('initialize', { protocolVersion: '2024-11-05' })).result.serverInfo.name, 'kode-shared-services')
    const tools = (await call('tools/list')).result.tools.map(tool => tool.name)
    assert.ok(tools.includes('kode_sessions_send')); assert.ok(tools.includes('memory_search')); assert.ok(!tools.includes('memory_review'))
    const sent = await call('tools/call', { name: 'kode_sessions_send', arguments: { ...target.session.address, content: 'GUI to dsh', idempotency_key: randomUUID() } })
    assert.equal(sent.result.isError, undefined)
    assert.equal(JSON.parse(sent.result.content[0].text).source.session_id, `kode:runtime:gui:${publicId}`)
    const proposal = await call('tools/call', { name: 'memory_propose', arguments: { scope: 'shared', body: `Shared MCP fixture ${randomUUID()} keeps proposals pending until user review.` } })
    assert.equal(proposal.result.isError, undefined); assert.equal(JSON.parse(proposal.result.content[0].text).status, 'pending_review')
    const search = await call('tools/call', { name: 'memory_search', arguments: { query: 'Shared MCP fixture' } })
    assert.deepEqual(JSON.parse(search.result.content[0].text).hits, [])
  } finally {
    const exited = once(child, 'exit'); child.stdin.end(); await exited; lines.close(); await rm(root, { recursive: true, force: true })
  }
})

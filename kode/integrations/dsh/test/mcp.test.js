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
const url = process.env.KODE_TEST_BACKEND_URL
const tokenFile = process.env.KODE_TEST_TOKEN_FILE

test('MCP exposes session-bound model tools over real stdio and HTTP', { skip: !url || !tokenFile }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-mcp-'))
  const admin = new BackendClient(url, (await readFile(tokenFile, 'utf8')).trim())
  const source = await admin.call('/api/v1/messaging/sessions', { session_id: `mcp-${randomUUID()}`, title: 'MCP caller', runtime: 'external' })
  const target = await admin.call('/api/v1/messaging/sessions', { session_id: `target-${randomUUID()}`, title: 'Target', runtime: 'external' })
  const ownToken = join(root, 'session.token'); await writeFile(ownToken, source.owner_token, { mode: 0o600 })
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.js', import.meta.url))], { env: { ...process.env, KODE_MESSAGING_URL: url, KODE_MESSAGING_TOKEN_FILE: ownToken }, stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map(); let next = 0
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => { const result = JSON.parse(line); pending.get(result.id)?.(result); pending.delete(result.id) })
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++next; const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 5000)
    pending.set(id, response => { clearTimeout(timer); resolve(response) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  try {
    const initialized = await call('initialize', { protocolVersion: '2024-11-05' })
    assert.equal(initialized.result.serverInfo.name, 'kode-sessions')
    const list = await call('tools/list', {}); assert.equal(list.result.tools.length, 4)
    const sent = await call('tools/call', { name: 'kode_sessions_send', arguments: { ...target.session.address, content: 'MCP peer message', idempotency_key: randomUUID() } })
    assert.equal(sent.result.isError, undefined)
    const message = JSON.parse(sent.result.content[0].text)
    assert.equal(message.source.session_id, source.session.address.session_id)
    assert.equal(message.content, 'MCP peer message')
    const unknown = await call('tools/call', { name: 'unknown', arguments: {} }); assert.equal(unknown.result.isError, true)
  } finally {
    const exited = once(child, 'exit'); child.stdin.end(); await exited
    await rm(root, { recursive: true, force: true })
  }
})

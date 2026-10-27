import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { BackendClient } from '../src/backend-client.js'
import { connectBackend } from '../src/service-launcher.js'
const url = process.env.KODE_TEST_BACKEND_URL, tokenFile = process.env.KODE_TEST_TOKEN_FILE

test('connecting to an existing backend never owns or stops it', { skip: !url || !tokenFile }, async () => {
  const client = new BackendClient(url, (await readFile(tokenFile, 'utf8')).trim())
  const backend = await connectBackend(client, { serverCommand: 'must-not-run', serverConfig: 'must-not-read' })
  assert.ok(backend.node.node_id); await backend.close()
  assert.ok((await client.call('/api/v1/messaging/node')).node_id)
})

test('dsh can start and stop its own backend without opening kode GUI', { skip: !tokenFile }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-owned-backend-'))
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve))
  const config = join(root, 'node.json'); await writeFile(config, JSON.stringify({ node_id: 'owned', database: join(root, 'messages.sqlite'), peers: [] }))
  const client = new BackendClient(`http://127.0.0.1:${port}`, (await readFile(tokenFile, 'utf8')).trim())
  let backend
  try {
    backend = await connectBackend(client, { tokenFile, serverConfig: config, serverCommand: resolve(fileURLToPath(new URL('../../..', import.meta.url)), 'target/debug/kode-session-server') })
    assert.equal(backend.node.node_id, 'owned'); await backend.close(); backend = null
    await assert.rejects(client.call('/api/v1/messaging/node'), TypeError)
  } finally { await backend?.close(); await rm(root, { recursive: true, force: true }) }
})

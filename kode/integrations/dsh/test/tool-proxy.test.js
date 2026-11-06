import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createToolProxy } from '../src/tool-proxy.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

test('Desktop MCP launch explicitly retains Electron Node mode', async () => {
  const original = Object.getOwnPropertyDescriptor(process.versions, 'electron')
  Object.defineProperty(process.versions, 'electron', { value: '44.7.0', configurable: true })
  let proxy
  const client = new Client({ name: 'desktop-launch-test', version: '1' })
  try {
    proxy = await createToolProxy([], async () => { throw new Error('unexpected tool call') })
    const env = Object.fromEntries(proxy.definition.env.map(({ name, value }) => [name, value]))
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
    // Launch the emitted MCP definition as a CLI would, without inherited Host env.
    await client.connect(new StdioClientTransport({ ...proxy.definition, env }))
    assert.deepEqual((await client.listTools()).tools, [])
  } finally {
    if (original) Object.defineProperty(process.versions, 'electron', original)
    else delete process.versions.electron
    await client.close()
    await proxy?.close()
  }
})
test('MCP tool bridges reject foreign credentials and expose only their owning Agent tools', async () => {
  const tools = [{ name: 'kode_sessions_list', description: 'List', parameters: { type: 'object' } }]
  const calls = []
  const a = await createToolProxy(tools, async (name, args) => { calls.push({ name, args }); return { success: true, contentItems: [{ type: 'inputText', text: 'owned directory' }] } })
  const b = await createToolProxy([], async () => { throw new Error('foreign execution') })
  const client = new Client({ name: 'test', version: '1' })
  try {
    const token = await readFile(a.tokenFile, 'utf8')
    assert.equal((await fetch(b.url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })).status, 401)
    assert.equal((await fetch(a.url, { method: 'POST', body: '{}' })).status, 401)
    assert.equal((await fetch(a.url, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: 'https://untrusted.example' }, body: '{}' })).status, 403)
    await client.connect(new StreamableHTTPClientTransport(new URL(a.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['kode_sessions_list'])
    assert.equal((await client.callTool({ name: 'kode_sessions_list', arguments: {} })).content[0].text, 'owned directory')
    await assert.rejects(client.callTool({ name: 'foreign_tool', arguments: {} }), /unadvertised/)
    assert.equal(calls.length, 1)
  } finally { await client.close(); await Promise.all([a.close(), b.close()]) }
})

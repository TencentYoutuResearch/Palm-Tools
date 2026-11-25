import test from 'node:test'
import assert from 'node:assert/strict'
import { BackendClient } from '../src/backend-client.js'
const path = '/api/v1/messaging/runtime/sessions'
const client = response => new BackendClient('http://localhost:47870', 'test-token', { fetch: async () => response })
test('missing backend API reports the version mismatch instead of a JSON parser error', async () => {
  await assert.rejects(client(new Response(null, {status:404})).call(path), /missing .*runtime\/sessions.*HTTP 404.*update/)
})
test('empty or malformed JSON responses identify the backend endpoint', async () => {
  await assert.rejects(client(new Response(null, {status:200})).call(path), /empty response.*HTTP 200/)
  await assert.rejects(client(new Response('{', {status:502})).call(path), /invalid JSON.*HTTP 502/)
})
test('valid backend payloads and error messages retain their behavior', async () => {
  assert.deepEqual(await client(Response.json({sessions:[]})).call(path), {sessions:[]})
  await assert.rejects(client(Response.json({error:'denied'}, {status:403})).call(path), /kode backend \(403\): denied/)
})
test('binary backend assets retain authentication, content type and byte payloads', async () => {
  let request
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
  const binary = new BackendClient('http://localhost:47870', 'test-token', { fetch: async (url, options) => {
    request = { url, options }
    return new Response(bytes, { headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) } })
  } })
  const result = await binary.asset('/api/v1/messaging/workbench/agent-hub?logo=team&package=0')
  assert.equal(request.options.headers.authorization, 'Bearer test-token'); assert.equal(request.options.redirect, 'error')
  assert.equal(result.contentType, 'image/png'); assert.deepEqual([...result.body], [...bytes])
  await assert.rejects(client(new Response('<html></html>', { headers: { 'content-type': 'text/html' } })).asset(path), /image/)
})

test('CLI update waits for the installer response and preserves owner authentication', async t => {
  const { createServer } = await import('node:http')
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const valid = req.method === 'POST' && req.headers.authorization === 'Bearer test-token'
      && JSON.parse(body).update_profile === 'cursor'
    res.writeHead(valid ? 200 : 403).end(JSON.stringify({ updated: valid }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const api = new BackendClient('http://127.0.0.1:' + server.address().port, 'test-token')
  assert.deepEqual(await api.call('/api/v1/messaging/workbench/agent-versions', { update_profile: 'cursor' }), { updated: true })
})

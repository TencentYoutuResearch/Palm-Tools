import test from 'node:test'
import assert from 'node:assert/strict'
import { BackendClient } from '../src/backend-client.js'

test('client binds credentials, refuses redirects and never admits arbitrary paths', async () => {
  let request
  const client = new BackendClient('http://127.0.0.1:47870', 'scoped-session-token', { fetch: async (url, init) => {
    request = { url, ...init }; return Response.json({ sessions: [] })
  } })
  assert.deepEqual(await client.call('/api/v1/messaging/sessions'), { sessions: [] })
  assert.equal(request.headers.authorization, 'Bearer scoped-session-token')
  assert.equal(request.redirect, 'error')
  await assert.rejects(client.call('/api/v1/sessions'), /unsupported/)
  assert.throws(() => new BackendClient('http://user:secret@example.com', 'token'), /origin/)
  assert.throws(() => new BackendClient('file:///tmp/socket', 'token'), /origin/)
})

test('client reports structured backend failures', async () => {
  const client = new BackendClient('http://127.0.0.1', 'token', { fetch: async () => Response.json({ error: 'idempotency conflict' }, { status: 400 }) })
  await assert.rejects(client.call('/api/v1/messaging/messages', {}), /400.*idempotency conflict/)
})

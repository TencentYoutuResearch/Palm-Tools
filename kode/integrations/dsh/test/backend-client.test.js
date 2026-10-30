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

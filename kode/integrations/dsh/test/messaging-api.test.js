import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { registerMessagingApi, syncSessionTitles } from '../src/messaging-api.js'

test('visual name directory is owner-only and contains no backend credentials', async () => {
  let handler, calls = 0
  registerMessagingApi({
    webServer: { register: route => { handler = route.handler } },
    connection: { admit: req => req.headers['x-test-role'] === 'owner' ? { peer: { principal: { kind: 'owner' } } } : req.headers['x-test-role'] === 'guest' ? { peer: { principal: { kind: 'guest' } } } : { rejection: 401 } },
  }, { call: async path => { calls++; assert.equal(path, '/api/v1/messaging/sessions'); return { sessions: [{ address: { node_id: 'remote', session_id: 'review' }, title: '评审会话', online: true, token: 'never-expose', runtime: 'external' }] } } }, 'local')
  const server = http.createServer((req, res) => { void handler(req, res) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal((await fetch(url)).status, 401)
    assert.equal((await fetch(url, { headers: { 'x-test-role': 'guest' } })).status, 403)
    assert.equal((await fetch(url, { method: 'POST', headers: { 'x-test-role': 'owner' } })).status, 405)
    assert.equal(calls, 0)
    const result = await (await fetch(url, { headers: { 'x-test-role': 'owner' } })).json()
    assert.equal(result.nodeId, 'local')
    assert.equal(result.sessions[0].title, '评审会话')
    assert.equal(result.sessions[0].token, undefined)
  } finally { await new Promise(resolve => server.close(resolve)) }
})


test('name backfill reads persisted titles without resuming or touching unowned sessions', async () => {
  const calls = []
  await syncSessionTitles({ list: async () => ({ items: [
    { sessionId: 'owned', projections: { values: { title: 'Code review' } } },
    { sessionId: 'foreign', projections: { values: { title: 'Other project' } } },
  ] }) }, { call: async (path, body) => { calls.push({ path, body }) } }, new Set(['owned']))
  assert.deepEqual(calls, [{ path: '/api/v1/messaging/sessions/owned/title', body: { title: 'Code review' } }])
})

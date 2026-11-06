import test from 'node:test'
import assert from 'node:assert/strict'
import { registerBuilderDrafts } from '../src/builder-drafts-route.js'
test('owner draft recovery bridge rejects mixed identities and preserves fixed read paths', async () => {
  let route, status, body, calls = [], admission = { rejection: 401 }, failure
  registerBuilderDrafts({ webServer: { register: value => { route = value } }, connection: { admit: () => admission } }, { backendClient: { async call(...args) { calls.push(args); if (failure) throw failure; return { items: [] } } } })
  const read = (query = '', method = 'GET') => route.handler({ method, url: '/api/kode/builder/drafts' + query }, { writeHead(code, headers) { status = code; assert.equal(headers['cache-control'], 'no-store') }, end(value) { body = JSON.parse(value) } })
  await read(); assert.equal(status, 401)
  admission = { peer: { principal: { kind: 'agent' } } }; await read(); assert.equal(status, 403)
  admission.peer.principal.kind = 'owner'
  await read('', 'POST'); assert.equal(status, 405)
  for (const query of ['?draft_id=d&limit=2', '?draft_id=d&draft_id=e', '?host=other', '?after=../d', '?limit=51']) { await read(query); assert.equal(status, 400) }
  assert.equal(calls.length, 0)
  await read('?draft_id=d'); assert.equal(status, 200); assert.deepEqual(calls.pop(), ['/api/v1/messaging/superagents/drafts/d'])
  await read('?after=d&limit=2'); assert.deepEqual(calls.pop(), ['/api/v1/messaging/superagents/drafts?after=d&limit=2'])
  failure = Object.assign(new Error('private diagnostic'), { status: 404 }); await read('?draft_id=missing'); assert.equal(status, 404); assert.deepEqual(body, { error: 'Builder drafts unavailable' })
})

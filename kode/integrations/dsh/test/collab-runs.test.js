import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
import { conversationTeam } from './support/conversation-team.js'
import { registerCollabRuns } from '../src/collab-api.js'
test('team work history includes terminal runs, pages without context payload and survives restart', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('collab-run-history')
  try {
    await conversationTeam(hub)
    const root = '/api/v1/messaging'
    const create = id => hub.client.call(`${root}/work-runs`, { id, request_id: id, team_id: 'team', team_revision: 1, binding_id: 'local', inputs: { request: '需求'.repeat(200) }, prior_run_id: null })
    const a = await create('a'); await create('b')
    await hub.client.call(`${root}/work-runs/a`, { action: 'cancel', request_id: 'cancel-a', expected_revision: a.revision })
    await create('c')
    const first = await hub.client.call(`${root}/teams/team/work-runs?limit=1`)
    assert.deepEqual(first.items.map(row => row.id), ['a']); assert.equal(first.items[0].state, 'cancelled')
    assert.equal(first.items[0].completion_authorized, false); assert.equal(first.items[0].request_preview.length, 240)
    assert.equal('context' in first.items[0], false); assert.equal(first.next_cursor, 'a')
    const next = await hub.client.call(`${root}/teams/team/work-runs?limit=2&after=a`)
    assert.deepEqual(next.items.map(row => row.id), ['b', 'c']); assert.equal(next.next_cursor, null)
    await assert.rejects(hub.client.call(`${root}/teams/missing/work-runs`), /404/)
    await assert.rejects(hub.client.call(`${root}/teams/team/work-runs?limit=51`))
    const registered = await hub.client.call(`${root}/sessions`, { session_id: 'worker', title: 'worker', runtime: 'external' })
    await assert.rejects(hub.client.forSession(registered.owner_token).call(`${root}/teams/team/work-runs`), /403/)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(`${root}/teams/team/work-runs?limit=1`), first)
    let route, status, result, kind = 'agent', calls = 0
    registerCollabRuns({ webServer: { register: value => { route = value } }, connection: { admit: () => ({ peer: { principal: { kind } } }) } }, { backendClient: { call: (...args) => { calls++; assert.equal(args.length, 1); return hub.client.call(...args) } } })
    const read = query => route.handler({ method: 'GET', url: `/api/kode/collab/runs${query}` }, { writeHead: value => { status = value }, end: value => { result = JSON.parse(value) } })
    await read('?team_id=team'); assert.equal(status, 403); assert.equal(calls, 0); kind = 'owner'
    for (const query of ['?team_id=team&team_id=other', '?team_id=team&limit=51', '?team_id=team&host=other', '?team_id=../team']) { await read(query); assert.equal(status, 400) }
    assert.equal(calls, 0); await read('?team_id=team&limit=1'); assert.equal(status, 200); assert.deepEqual(result, first)
  } finally { await hub.close() }
})

test('work history bridge rejects mutations and sanitizes unavailable backend responses', async () => {
  let route, status, result, headers, admission = { rejection: 401 }, backendError
  const ctx = { webServer: { register(value) { route = value } }, connection: { admit: () => admission } }
  const config = { backendClient: { async call() { throw backendError } } }
  registerCollabRuns(ctx, config)
  const read = (method = 'GET') => route.handler({ method, url: '/api/kode/collab/runs?team_id=team' }, {
    writeHead(value, valueHeaders) { status = value; headers = valueHeaders }, end(value) { result = JSON.parse(value) },
  })
  await read(); assert.equal(status, 401)
  admission = { peer: { principal: { kind: 'owner' } } }
  await read('POST'); assert.equal(status, 405)
  for (const code of [404, 500]) {
    backendError = Object.assign(new Error('private backend diagnostic'), { status: code })
    await read(); assert.equal(status, code === 404 ? 404 : 503)
    assert.deepEqual(result, { error: 'Work history unavailable' }); assert.equal(headers['cache-control'], 'no-store')
  }
  registerCollabRuns(ctx, {})
  await read(); assert.equal(status, 503)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { registerCollabEvidence } from '../src/collab-api.js'
import { isolatedHub } from './support/isolated-hub.js'
import { conversationTeam } from './support/conversation-team.js'
test('evidence owner bridge pins path and rejects arbitrary observation lookup', async () => {
  let route, status, result, headers, calls = [], kind = 'agent', failure
  registerCollabEvidence({ webServer: { register: value => { route = value } }, connection: { admit: () => ({ peer: { principal: { kind } } }) } }, { backendClient: { async call(...args) { calls.push(args); if (failure) throw failure; return { sequence: 1 } } } })
  const read = (query, method = 'GET') => route.handler({ method, url: `/api/kode/collab/evidence${query}` }, { writeHead(code, value) { status = code; headers = value }, end(value) { result = JSON.parse(value) } })
  const valid = '?run_id=run&stage_id=review&output=report'
  await read(valid); assert.equal(status, 403); kind = 'owner'
  for (const query of [valid + '&seq=1', valid + '&output=other', '?run_id=run&stage_id=review', '?run_id=../run&stage_id=review&output=report']) { await read(query); assert.equal(status, 400) }
  await read(valid, 'POST'); assert.equal(status, 405); assert.equal(calls.length, 0)
  await read(valid); assert.equal(status, 200); assert.deepEqual(calls, [['/api/v1/messaging/work-runs/run/stages/review/outputs/report']]); assert.equal(headers['cache-control'], 'no-store')
  for (const code of [404, 500]) { failure = Object.assign(new Error('private diagnostic'), { status: code }); await read(valid); assert.equal(status, code === 404 ? 404 : 503); assert.deepEqual(result, { error: 'Evidence unavailable' }) }
})
test('actual Hub denies Worker evidence reads and returns missing selection without executing work', { skip: !process.env.KODE_TEST_BACKEND_URL }, async () => {
  const hub = await isolatedHub('evidence-read')
  try {
    await conversationTeam(hub)
    await hub.client.call('/api/v1/messaging/work-runs', { id: 'run', request_id: 'run', team_id: 'team', team_revision: 1, binding_id: 'local', inputs: { request: 'inspect' }, prior_run_id: null })
    const path = '/api/v1/messaging/work-runs/run/stages/inspect/outputs/artifact'
    await assert.rejects(hub.client.call(path), /404/)
    const worker = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'worker', runtime: 'external' })
    await assert.rejects(hub.client.forSession(worker.owner_token).call(path), /403/)
    await hub.stop('SIGKILL'); await hub.start()
    await assert.rejects(hub.client.call(path), /404/)
  } finally { await hub.close() }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
test('Builder runtime selection is revisioned owner intent and survives lost replies and restart', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('builder-selection')
  try {
    const workspace = { host_id: hub.node, workspace_id: 'project', root_ref: '/fixture/project' }
    const draft = { id: 'draft', request_id: 'create', expected_revision: 0, revoked: false, interview: { purpose: 'Create a team', workspace_refs: [workspace], answers: {}, questions: [], proposed_team: null } }
    await hub.client.call('/api/v1/messaging/superagents/drafts', draft)
    const path = '/api/v1/messaging/superagents/drafts/draft/selection'
    assert.equal((await hub.client.call(path)).record, null)
    const command = { request_id: 'select', draft_revision: 1, expected_revision: 0, selection: { profile_id: 'runtime', provider: 'provider', model: 'model', effort: null, workspace } }
    const first = await hub.client.call(path, command)
    assert.equal(first.revision, 1); assert.equal(first.eligible_for_execution, false)
    assert.deepEqual(await hub.client.call(path, command), first)
    await assert.rejects(hub.client.call(path, { ...command, selection: { ...command.selection, model: 'changed' } }), /identity conflict/)
    await assert.rejects(hub.client.call(path, { ...command, request_id: 'stale' }), /revision conflict/)
    await assert.rejects(hub.client.call(path, { ...command, request_id: 'foreign', expected_revision: 1, selection: { ...command.selection, workspace: { ...workspace, root_ref: '/different' } } }), /workspace not selected/)
    const worker = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Worker', runtime: 'external' })
    const agent = hub.client.forSession(worker.owner_token)
    await assert.rejects(agent.call(path), /403/); await assert.rejects(agent.call(path, command), /403/)
    const race = await Promise.allSettled(['a', 'b'].map(model => hub.client.call(path, { ...command, request_id: model, expected_revision: 1, selection: { ...command.selection, model } })))
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1)
    await hub.client.call('/api/v1/messaging/superagents/drafts', { ...draft, request_id: 'edit', expected_revision: 1, interview: { ...draft.interview, workspace_refs: [] } })
    const changed = await hub.client.call(path)
    assert.equal(changed.draft_revision, 2); assert.equal(changed.record.draft_revision, 1)
    await assert.rejects(hub.client.call(path, { ...command, request_id: 'old-draft', expected_revision: 2 }), /revision conflict/)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(path, command), first, 'original receipt survives later draft and selection revisions')
    assert.deepEqual(await hub.client.call(path), changed)
    assert.deepEqual((await hub.client.call('/api/v1/messaging/teams')).items, [])
  } finally { await hub.close() }
})

test('selection bridge restricts owner commands to the fixed draft endpoint', async () => {
  const { registerBuilderSelection } = await import('../src/builder-selection-route.js')
  const { Readable } = await import('node:stream')
  let route, kind = 'worker', status, body, calls = [], failure = false
  registerBuilderSelection({ webServer: { register: value => { route = value } }, connection: { admit: () => ({ peer: { principal: { kind } } }) } }, { backendClient: { async call(...args) { calls.push(args); if (failure) throw Error('private failure'); return { recorded: true } } } })
  const send = async (method, query = '', command) => {
    const req = Readable.from(command ? [JSON.stringify(command)] : [])
    Object.assign(req, { method, url: '/api/kode/builder/selection' + query, headers: { 'content-type': 'application/json' } })
    await route.handler(req, { writeHead(code, headers) { status = code; assert.equal(headers['cache-control'], 'no-store') }, end(value) { body = JSON.parse(value) } })
  }
  await send('GET', '?draft_id=draft'); assert.equal(status, 403); kind = 'owner'
  for (const query of ['?draft_id=../draft', '?draft_id=draft&draft_id=other', '?draft_id=draft&host=remote']) { await send('GET', query); assert.equal(status, 400) }
  await send('DELETE'); assert.equal(status, 405); assert.equal(calls.length, 0)
  await send('GET', '?draft_id=draft'); assert.equal(status, 200); assert.equal(calls[0][0], '/api/v1/messaging/superagents/drafts/draft/selection')
  const command = { draft_id: 'draft', request_id: 'save', expected_revision: 0, draft_revision: 1, selection: {} }
  await send('POST', '', { ...command, grant: 'injected' }); assert.equal(status, 400)
  await send('POST', '', command); assert.equal(status, 200); assert.equal(calls[1][1].draft_id, undefined)
  failure = true; await send('POST', '', command); assert.equal(status, 409); assert.equal(body.retry, 'same_request'); assert.ok(!JSON.stringify(body).includes('private'))
})

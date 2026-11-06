import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { isolatedHub } from './support/isolated-hub.js'
import { registerBuilderCreate } from '../src/builder-create-route.js'
test('new UI drafts retain the complete interview, advance three questions at a time and recover older intake receipts', { skip: !process.env.KODE_TEST_BACKEND_URL }, async () => {
  const hub = await isolatedHub('builder-create-interview')
  try {
    let route, status, result, owner = true
    registerBuilderCreate({ webServer: { register(value) { route = value } }, connection: { admit: () => ({ peer: { principal: { kind: owner ? 'owner' : 'agent' } } }) } }, { backendClient: hub.client })
    const create = async input => {
      const req = Readable.from([JSON.stringify(input)]); req.method = 'POST'; req.headers = { 'content-type': 'application/json' }
      await route.handler(req, { writeHead(code) { status = code }, end(value) { result = JSON.parse(value) } })
      return result
    }
    const input = { draft_id: 'draft', request_id: 'create', purpose: 'Generic engineering' }
    owner = false; await create(input); assert.equal(status, 403); owner = true
    const initial = await create(input); assert.equal(status, 200)
    const ids = initial.interview.questionnaire.questions.map(row => row.id)
    for (const id of ['delivery', 'workflow', 'resources', 'budget', 'permissions', 'verification', 'failure', 'concurrency']) assert.ok(ids.includes(id))
    assert.equal(initial.interview.questions.length, 3)
    let draft = initial, seen = []
    while (draft.interview.questions.length) {
      const questions = draft.interview.questions; assert.ok(questions.length <= 3); seen.push(...questions.map(row => row.id))
      const answers = Object.fromEntries(questions.map(row => [row.id, row.id === 'task_kind' ? '缺陷修复' : 'explicit preference']))
      draft = await hub.client.call('/api/v1/messaging/superagents/drafts/draft/answers', { request_id: 'answer-' + draft.revision, expected_revision: draft.revision, answers })
    }
    assert.ok(seen.includes('reproduction')); assert.ok(seen.includes('budget')); assert.ok(seen.includes('permissions'))
    assert.equal(draft.eligible_for_execution, false)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await create(input), initial)
    const legacy = await hub.client.call('/api/v1/messaging/superagents/drafts', { id: 'legacy', request_id: 'legacy-create', expected_revision: 0, revoked: false, interview: { purpose: 'Legacy purpose', workspace_refs: [], answers: {}, questions: [{ id: 'delivery', prompt: 'Finish where?' }], questionnaire: { id: 'kode-team-intake', version: '1', questions: [{ id: 'delivery', prompt: 'Finish where?' }] }, proposed_team: null } })
    assert.deepEqual(await create({ draft_id: 'legacy', request_id: 'legacy-create', purpose: 'Legacy purpose' }), legacy)
    await create({ ...input, purpose: 'changed' }); assert.equal(status, 409)
    assert.deepEqual((await hub.client.call('/api/v1/messaging/teams')).items, [])
  } finally { await hub.close() }
})

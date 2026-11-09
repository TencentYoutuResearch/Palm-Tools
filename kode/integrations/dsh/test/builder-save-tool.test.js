/** Only an authoritative pre-save schema rejection can return a no-effect diagnostic. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { saveOfficialBuilderDraft } from '../src/builder-save-tool.js'

const path = '/api/v1/messaging/superagents/drafts'
const operation = { id: 'operation', attempt: 1, epoch: 2 }
const agent = { id: 'builder' }
const fixed = { draft_id: 'draft' }
const args = { expected_revision: 3, request_id: 'proposal', questions: [], proposed_team: null }
const draft = { revision: 3, interview: { answers: {}, questions: [], proposed_team: null } }
const receipt = {
  id: 'draft', request_id: 'proposal', revision: 4,
  actor: { kind: 'builder', operation_id: operation.id, attempt: 1, epoch: 2, node_id: 'home', session_id: agent.id },
  interview: { questions: [], proposed_team: null },
}

function fixture(error, committed = null) {
  let writes = 0
  const runtime = { host: 'home', client: { async call(route, body) {
    if (route === `${path}/draft/commands/proposal`) return { receipt: writes ? committed : null }
    assert.equal(route, path)
    assert.equal(body.request_id, args.request_id)
    assert.equal(body.expected_revision, args.expected_revision)
    writes++
    throw error
  } } }
  return {
    save: () => saveOfficialBuilderDraft(runtime, agent, fixed, operation, args, async () => structuredClone(draft)),
    writes: () => writes,
  }
}

test('pre-transaction JSON rejection returns a correctable diagnostic without replaying a save', async () => {
  const error = Object.assign(new Error('missing field purpose'), { status: 422, path })
  const current = fixture(error)
  const result = await current.save()
  assert.equal(result.status, 'rejected')
  assert.equal(result.effect, 'none')
  assert.equal(result.error.code, 'INVALID_BUILDER_PROPOSAL')
  assert.equal(result.error.message, error.message)
  assert.equal(current.writes(), 1)
})

test('a matching committed receipt takes precedence over the response error classification', async () => {
  const current = fixture(Object.assign(new Error('schema response'), { status: 422, path }), receipt)
  assert.deepEqual(await current.save(), receipt)
  assert.equal(current.writes(), 1)
})

for (const [name, fields] of [
  ['transport loss', {}],
  ['other endpoint', { status: 422, path: '/api/v1/messaging/other' }],
  ['store rejection', { status: 400, path }],
]) test(`${name} remains fenced when no committed save can be recovered`, async () => {
  const error = Object.assign(new Error(name), fields)
  const current = fixture(error)
  await assert.rejects(current.save(), actual => actual === error)
  assert.equal(current.writes(), 1)
})

test('a conflicting receipt cannot be relabeled as a no-effect schema rejection', async () => {
  const current = fixture(Object.assign(new Error('schema response'), { status: 422, path }), { ...receipt, revision: 5 })
  await assert.rejects(current.save(), /identity conflict/)
  assert.equal(current.writes(), 1)
})

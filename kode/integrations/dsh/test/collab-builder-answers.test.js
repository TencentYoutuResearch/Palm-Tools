import test from 'node:test'
import assert from 'node:assert/strict'
import { submitAnswers } from '../packages/collab/builder-answers.js'
test('lost answer receipt retries immutable persisted patch and never dispatches after storage failure', async () => {
  let row, calls = [], fail = true
  const storage = { async reserve(_, candidate) { if (!row || row.state === 'accepted') row = candidate; return row }, async save(_, value) { row = value } }
  const draft = { id: 'draft', home_hub: 'home', revision: 1 }
  const request = async command => { calls.push(command); if (fail) throw Error('reply lost'); return { id: 'draft', home_hub: 'home', revision: 2, interview: { answers: { delivery: 'local' } } } }
  await assert.rejects(submitAnswers({ storage, draft, answers: { delivery: 'local' }, request, uuid: () => 'first' }))
  fail = false
  await submitAnswers({ storage, draft: { ...draft, revision: 2 }, answers: { delivery: 'changed' }, request, uuid: () => 'second' })
  assert.deepEqual(calls[0], calls[1]); assert.equal(calls[1].request_id, 'first'); assert.equal(row.state, 'accepted')
  await assert.rejects(submitAnswers({ storage: { reserve: async () => { throw Error('full') } }, draft, answers: {}, request }))
  assert.equal(calls.length, 2)
})

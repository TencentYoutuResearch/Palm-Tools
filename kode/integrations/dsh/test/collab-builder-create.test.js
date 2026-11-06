import test from 'node:test'
import assert from 'node:assert/strict'
import { createBuilderDraft } from '../packages/collab/builder-create.js'
test('ambiguous creation keeps original draft and request identity across reconstruction', async () => {
  let row, calls = [], fails = true, count = 0
  const storage = { async reserve(_, candidate) { return row ??= candidate }, async save(_, value) { row = value } }
  const request = async command => { calls.push(command); if (fails) throw Error('lost response'); return { id: command.draft_id, request_id: command.request_id, home_hub: 'home', revision: 1, eligible_for_execution: false, interview: { purpose: command.purpose } } }
  const options = { storage, home: 'home', purpose: 'original', request, uuid: () => `id-${++count}` }
  await assert.rejects(createBuilderDraft(options)); fails = false
  const result = await createBuilderDraft({ ...options, purpose: 'changed' })
  assert.deepEqual(calls[0], calls[1]); assert.equal(result.interview.purpose, 'original'); assert.equal(row.state, 'accepted')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { submitSelection } from '../packages/collab/builder-selection.js'
test('Builder selection retry preserves original model, workspace and both revisions', async () => {
  const draft = { id: 'draft', home_hub: 'home', revision: 4 }
  const selection = { profile_id: 'profile', provider: 'provider', model: 'model', effort: null, workspace: { host_id: 'home', workspace_id: 'project', root_ref: '/fixture/project' } }
  let row, fail = true, calls = []
  const storage = { async reserve(_, value) { return row ??= value }, async save(_, value) { row = value } }
  const request = async command => {
    calls.push(command)
    if (fail) throw Error('reply lost')
    return { home_hub: 'home', draft_id: 'draft', request_id: command.request_id, draft_revision: command.draft_revision, revision: command.expected_revision + 1, selection: command.selection, eligible_for_execution: false }
  }
  await assert.rejects(submitSelection({ storage, draft, revision: 0, selection, request, uuid: () => 'original' }))
  fail = false
  await submitSelection({ storage, draft: { ...draft, revision: 8 }, revision: 3, selection: { ...selection, model: 'changed' }, request, uuid: () => 'replacement' })
  assert.deepEqual(calls[1], calls[0]); assert.equal(row.state, 'accepted')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readBuilderPreparation, resolveBuilderPreparation } from '../packages/collab/builder-preparation-model.js'

const workspace = { host_id: 'home', workspace_id: 'project', root_ref: '/fixture/project' }
const draft = { id: 'draft', home_hub: 'home', revision: 3, status: 'draft', interview: { workspace_refs: [workspace], questions: [{ id: 'delivery', prompt: 'How should delivery work?' }], answers: {} } }
const selection = { revision: 2, draft_revision: 3, selection: { profile_id: 'builder', provider: 'provider', model: 'model', effort: null, workspace } }
const resource = { host: 'home', cursor: 'profile:builder', resource_kind: 'execution_profile', profile_id: 'builder', name: 'Builder', account: { id: 'account', current: true } }
const funding = { request: { draft_revision: 3, selection_revision: 2 }, selection, budget: { unit: 'credits', limit: 100, starts_at: 10, ends_at: 200 }, grant: { policy: { enabled: true, expires_at: 200 } } }
const state = patch => resolveBuilderPreparation({ draft, selection, resources: [resource], funding, now: 100, ...patch })

test('preparation starts at only the earliest missing requirement', () => {
  const empty = { ...draft, interview: { ...draft.interview, workspace_refs: [] } }
  assert.equal(state({ draft: empty, selection: null, funding: null }).step, 'workspace')
  assert.equal(state({ selection: null, funding: null }).step, 'selection')
  assert.equal(state({ resources: [{ ...resource, account: null }], funding: null }).step, 'account')
  assert.equal(state({ funding: null }).step, 'funding')
  assert.equal(state().step, 'ready')
  assert.equal(state().ready, true)
})

test('owner-confirmed workspaces and selection are reused without another questionnaire gate', () => {
  const current = state({ funding: null })
  assert.equal(current.step, 'funding')
  assert.equal(current.completed.workspace, true)
  assert.equal(current.completed.selection, true)
  assert.equal(current.completed.account, true)
  assert.equal(current.summaries.workspace, '/fixture/project')
  assert.equal(current.summaries.selection, 'Builder · model')
  assert.equal(draft.interview.questions.length, 1)
})

test('a changed draft revision requires selection confirmation again before funding', () => {
  const value = state({ draft: { ...draft, revision: 4 }, funding: null })
  assert.equal(value.step, 'selection')
  assert.equal(value.ready, false)
})

test('a foreign host or unselected workspace cannot satisfy preparation', () => {
  assert.equal(state({ draft: { ...draft, interview: { workspace_refs: [{ ...workspace, host_id: 'other' }] } }, funding: null }).step, 'workspace')
  assert.equal(state({ selection: { ...selection, selection: { ...selection.selection, workspace: { ...workspace, root_ref: '/other' } } }, funding: null }).step, 'selection')
  assert.equal(state({ resources: [{ ...resource, host: 'other' }], funding: null }).step, 'account')
  assert.equal(state({ resources: [{ ...resource, account: { ...resource.account, current: false } }], funding: null }).step, 'account')
})

test('funding stays bound to the exact original draft and selection', () => {
  for (const changed of [
    { draft: { ...draft, revision: 4 } },
    { selection: { ...selection, revision: 3 } },
    { funding: { ...funding, selection: { ...selection, selection: { ...selection.selection, model: 'other-model' } } } },
  ]) {
    const value = state(changed)
    assert.equal(value.ready, false)
    assert.match(value.blocked, /预算已绑定原配置/)
    assert.equal(value.funded, true)
  }
})

test('expired, future, disabled and revoked configuration stays blocked', () => {
  for (const patch of [
    { now: 201 },
    { now: 5 },
    { funding: { ...funding, grant: { policy: { enabled: false, expires_at: 200 } } } },
    { draft: { ...draft, status: 'revoked' } },
  ]) {
    const value = state(patch)
    assert.equal(value.ready, false)
    assert.ok(value.blocked)
  }
})

function fixtureRequest(patch = {}) {
  const calls = []
  const request = async path => {
    calls.push(path)
    if (path.startsWith('/api/kode/builder/selection')) return patch.selection ?? { home_hub: 'home', draft_id: 'draft', eligible_for_execution: false, record: selection }
    if (path.startsWith('/api/kode/builder/funding')) return patch.funding ?? { home_hub: 'home', draft_id: 'draft', activation_performed: false, record: funding }
    return patch.resources ?? { host: 'home', items: [resource], next_cursor: null }
  }
  return { calls, request }
}

test('preparation reads are scoped, read-only and preserve saved records', async () => {
  const { request, calls } = fixtureRequest()
  const value = await readBuilderPreparation(draft, request)
  assert.equal(value.selection, selection)
  assert.equal(value.funding, funding)
  assert.equal(value.draftRevision, draft.revision)
  assert.equal(value.draftId, draft.id)
  assert.equal(calls.length, 3)
  assert.ok(calls.every(path => path.startsWith('/api/kode/')))
})

test('preparation rejects foreign scope and malformed resource pagination', async () => {
  for (const patch of [
    { selection: { home_hub: 'other', draft_id: 'draft', record: selection } },
    { funding: { home_hub: 'home', draft_id: 'other', activation_performed: false, record: funding } },
    { resources: { host: 'home', items: [{ ...resource, host: 'other' }], next_cursor: null } },
    { resources: { host: 'home', items: [], next_cursor: 'again' } },
    { resources: { host: 'home', items: [resource], next_cursor: 'different' } },
  ]) await assert.rejects(readBuilderPreparation(draft, fixtureRequest(patch).request))
})

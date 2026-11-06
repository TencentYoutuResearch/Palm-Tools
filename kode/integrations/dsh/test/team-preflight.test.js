import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'

test('exact team revision preflight resolves pinned workflows and reports configured roles without admission', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('team-preflight-home')
  try {
    const root = '/api/v1/messaging'
    const workflow = await hub.client.call(`${root}/workflows`, { id: 'local', version: '1', inputs: ['request'], stages: [
      { id: 'produce', role: 'developer', requires: ['request'], produces: ['snapshot'], independent_from: [] },
      { id: 'assess', role: 'developer', requires: ['produce'], produces: ['verdict'], independent_from: ['produce'] },
      { id: 'summarize', role: 'coordinator', requires: ['assess'], produces: ['summary'], independent_from: [] },
    ], completion_stages: ['summarize'] })
    const ref = { id: workflow.id, version: workflow.version, hash: workflow.hash }
    const spec = { name: 'Draft', purpose: 'Local delivery', kind: 'coordinator', workspace_refs: [],
      execution_targets: [{ id: 'target', host_id: 'host', executor_profile_id: 'profile', provider_id: 'fixture', model_id: 'model', effort: null, account_binding_id: 'account', capability_profile_revision: '1' }],
      workers: [], coordinator_targets: ['target'], workflow_pack_refs: [], grant_id: null, budget_policy_id: null, scheduling_policy_id: null,
      limits: { max_active_assignments: 2, max_active_runs: 1 }, proactive_mode: 'off' }
    let revision = 0
    const save = async () => { const row = await hub.client.call(`${root}/teams`, { id: 'team', request_id: `edit-${revision}`, expected_revision: revision, spec }); revision = row.revision; return row }
    const check = rev => hub.client.call(`${root}/teams/team/revisions/${rev}/workflow-preflight`)
    await save()
    assert.deepEqual((await check(revision)).issues.map(i => i.code), ['workflow_required'])
    spec.workflow_pack_refs = [{ ...ref, version: 'missing' }]; await save()
    assert.deepEqual((await check(revision)).issues.map(i => i.code), ['workflow_version_missing'])
    spec.workflow_pack_refs = [{ ...ref, hash: '0'.repeat(64) }]; await save()
    assert.deepEqual((await check(revision)).issues.map(i => i.code), ['workflow_hash_mismatch'])
    spec.workflow_pack_refs = [ref]; await save()
    const unassignedRevision = revision
    assert.deepEqual((await check(revision)).issues.map(i => i.stage_id), ['produce', 'assess'])
    spec.workers = [{ id: 'developer', role: 'developer', responsibilities: ['Implement or independently review'], allowed_target_ids: ['target'], required_capabilities: [], workspace_refs: [], max_parallel: 1 }]
    await save()
    const result = await check(revision)
    assert.equal(result.workflow_bindings_valid, true)
    assert.equal(result.eligible_for_execution, false, 'configured target is not proof of resource availability')
    assert.equal(result.team_revision, revision)
    assert.deepEqual(result.workflows[0].stages[1].configured_candidates[0].target_ids, ['target'])
    assert.equal(result.workflows[0].stages[1].requires_distinct_assignment_context, true, 'same worker role still requires independent runtime assignments')
    assert.equal(result.workflows[0].stages[2].configured_candidates[0].kind, 'coordinator')
    assert.equal((await check(unassignedRevision)).workflow_bindings_valid, false, 'new draft does not alter historical revision diagnostics')
    const registration = await hub.client.call(`${root}/sessions`, { session_id: 'worker', title: 'Worker', runtime: 'external' })
    await assert.rejects(hub.client.forSession(registration.owner_token).call(`${root}/teams/team/revisions/${revision}/workflow-preflight`), /403/)
    await assert.rejects(check(999), /404/)
    assert.equal((await hub.client.call(`${root}/teams/team`)).status, 'draft')
    assert.equal((await hub.client.call(`${root}/teams/team/events`)).events.length, revision, 'preflight does not mutate audit or team')
  } finally { await hub.close() }
})

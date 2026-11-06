import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
import { conversationTeam } from './support/conversation-team.js'

test('owner capability update atomically revises draft references and preserves active snapshots', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
 const hub = await isolatedHub('capability-update')
 try {
  const call = (path, body) => hub.client.call('/api/v1/messaging/' + path, body)
  const original = await conversationTeam(hub)
  const active = await call('teams/team/activation'), schedule = await call('team-policies/schedule')
  const at = Date.now(), fact = { evaluation: { kind: 'task_fit', tag: 'inspection', score: 80 }, source: 'user', confidence: 0.8, evidence: [], updated_at: at, valid_until: at + 60000, pinned: true }
  const command = { request_id: 'edit', team_revision: 1, target_id: 'control', scheduling_revision: 1, capability_revision: 1, assessments: { inspection: fact }, replace_pins: false }
  const path = 'teams/team/capability-update'
  // Invalid provenance and stale expectations must not append any part of the transaction.
  for (const invalid of [
   { ...command, team_revision: 2 }, { ...command, scheduling_revision: 2 }, { ...command, capability_revision: 2 },
   { ...command, assessments: { inspection: { ...fact, source: 'measured', evidence: ['unverified assertion'] } } },
   { ...command, activation_performed: true },
  ]) await assert.rejects(call(path, invalid))
  const unauthenticated = await fetch(hub.url + '/api/v1/messaging/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) })
  assert.equal(unauthenticated.status, 401)
  // Team request collision occurs after capability insertion; transaction must roll it back.
  await assert.rejects(call(path, { ...command, request_id: 'create' }), /identity conflict/)
  await assert.rejects(call('capability-profiles/capability/2'), /404/)
  assert.equal((await call('teams/team')).revision, 1)
  assert.equal((await call('team-policies/schedule')).revision, 1)
  assert.deepEqual(await call('teams/team/capability-update-requests/edit'), { result: null })
  const [saved, retry] = await Promise.all([call(path, command), call(path, command)])
  assert.deepEqual(retry, saved)
  assert.equal(saved.team.revision, 2); assert.equal(saved.capability_profile.revision, 2); assert.equal(saved.scheduling_policy.revision, 2)
  assert.equal(saved.activation_performed, false); assert.equal(saved.eligible_for_execution, false)
  const expectedSpec = structuredClone(original.spec); expectedSpec.execution_targets[0].capability_profile_revision = '2'
  assert.deepEqual(saved.team.spec, expectedSpec)
  assert.equal(saved.team.superagent_id, original.superagent_id); assert.equal(saved.team.conversation_id, original.conversation_id)
  const expectedPolicy = structuredClone(schedule.policy); expectedPolicy.targets.control.capability_revision = 2
  assert.deepEqual(saved.scheduling_policy.policy, expectedPolicy)
  assert.deepEqual((await call('teams/team/activation')).snapshot, active.snapshot)
  await assert.rejects(call(path, { ...command, assessments: {} }), /identity conflict/)
  const remove = { ...command, request_id: 'remove', team_revision: 2, scheduling_revision: 2, capability_revision: 2, assessments: {} }
  await assert.rejects(call(path, remove), /pinned assessment/)
  assert.equal((await call('teams/team')).revision, 2)
  assert.equal((await call('team-policies/schedule')).revision, 2)
  assert.deepEqual(await call('teams/team/capability-update-requests/remove'), { result: null })
  const removed = await call(path, { ...remove, replace_pins: true })
  assert.equal(removed.capability_profile.revision, 3)
  assert.deepEqual(removed.capability_profile.assessments, {})
  await hub.stop('SIGKILL'); await hub.start()
  assert.deepEqual(await call(path, command), saved, 'historical retry must not overwrite newer revisions')
  assert.deepEqual(await call('teams/team/capability-update-requests/edit'), { result: saved })
  assert.equal((await call('teams/team')).revision, 3)
  assert.deepEqual((await call('teams/team/activation')).snapshot, active.snapshot)
 } finally { await hub.close() }
})

test('shared capability references stay frozen until each target is explicitly updated and activated', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
 const hub = await isolatedHub('capability-shared')
 try {
  const call = (path, body) => hub.client.call('/api/v1/messaging/' + path, body)
  const original = await conversationTeam(hub), active = await call('teams/team/activation')
  const spec = structuredClone(original.spec)
  spec.execution_targets.push({ ...spec.execution_targets[0], id: 'other' })
  await call('teams', { id: 'team', request_id: 'two-targets', expected_revision: 1, spec })
  const schedule = await call('team-policies/schedule'), policy = structuredClone(schedule.policy)
  policy.targets.other = structuredClone(policy.targets.control)
  await call('team-policies', { id: 'schedule', team_id: 'team', expected_revision: 1, policy })
  const at = Date.now(), assessments = { cost: { evaluation: { kind: 'cost_tier', tier: 'low' }, source: 'user', confidence: 1, evidence: [], updated_at: at, valid_until: at + 60000, pinned: false } }
  const command = { request_id: 'one-target', team_revision: 2, target_id: 'control', scheduling_revision: 2, capability_revision: 1, assessments, replace_pins: false }
  const saved = await call('teams/team/capability-update', command)
  assert.equal(saved.team.spec.execution_targets.find(t => t.id === 'other').capability_profile_revision, '1')
  assert.equal(saved.scheduling_policy.policy.targets.other.capability_revision, 1)
  assert.deepEqual((await call('teams/team/activation')).snapshot, active.snapshot)
  // The other target still points at history: do not silently merge latest profile facts.
  await assert.rejects(call('teams/team/capability-update', { ...command, request_id: 'stale-other', team_revision: 3, scheduling_revision: 3, target_id: 'other' }), /resource or revision changed/)
  const budget = await call('team-policies/budget-policy')
  const reference = row => ({ id: row.id, revision: row.revision, hash: row.hash })
  const activated = await call('teams/team/activation', { action: 'activate', request_id: 'activate-updated', expected_revision: active.revision, team_revision: 3, grant_revision: 1, budget_policy: reference(budget), scheduling_policy: reference(saved.scheduling_policy) })
  assert.equal(activated.snapshot.team.spec.execution_targets.find(t => t.id === 'control').capability_profile_revision, '2')
  assert.equal(activated.snapshot.team.spec.execution_targets.find(t => t.id === 'other').capability_profile_revision, '1')
 } finally { await hub.close() }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { activateReviewedTeam, verifyActivationReceipt } from '../packages/collab/team-activation.js'
const team = { id: 'team', home_hub: 'home' }
const policy = { id: 'policy', revision: 2, hash: 'a'.repeat(64) }
const command = { action: 'activate', request_id: 'consent', expected_revision: 0, team_revision: 1, grant_revision: 3, budget_policy: policy, scheduling_policy: policy }
const receipt = { team_id: 'team', home_hub: 'home', team_revision: 1, revision: 1, active: true, actor: { kind: 'human' }, snapshot: { grant: { revision: 3 }, policies: { budget: policy, scheduling: policy } } }
test('activation preserves consent across lost replies and local receipt failures', async () => {
  let row, calls = 0, failSave = true
  const storage = { async reserve(_, value) { return row ??= structuredClone(value) }, async save(_, value) { if (failSave) throw Error('disk'); row = structuredClone(value) } }
  const request = async input => { calls++; assert.deepEqual(input.command, command); if (calls === 1) throw Error('lost reply'); return structuredClone(receipt) }
  const run = prepared_command => activateReviewedTeam({ storage, team, review: { prepared_command }, request })
  await assert.rejects(run(command), /lost reply/)
  await assert.rejects(run({ ...command, request_id: 'new', grant_revision: 4 }), /disk/)
  failSave = false
  await run({ ...command, request_id: 'new' })
  assert.equal(row.state, 'activated'); assert.equal(calls, 3)
  await run(command); assert.equal(calls, 3)
  row.receipt.snapshot.policies.budget.hash = 'foreign'
  await assert.rejects(run(command), /Invalid activation receipt/)
})
test('activation rejects mismatched authority and requires durable intent before submission', async () => {
  for (const change of [r => r.home_hub = 'foreign', r => r.active = false, r => r.actor.kind = 'agent', r => r.snapshot.grant.revision++, r => r.snapshot.policies.scheduling.revision++, r => r.team_revision++, r => r.revision++]) {
    const value = structuredClone(receipt); change(value)
    assert.throws(() => verifyActivationReceipt(value, team, command), /Invalid activation receipt/)
  }
  await assert.rejects(activateReviewedTeam({ storage: { async reserve() { throw Error('disk') } }, team, review: { prepared_command: command }, request: async () => assert.fail('must not submit') }), /disk/)
})

test('only a freshly reviewed inactive revision can replace completed activation consent', async () => {
  let row = { state: 'activated', home_hub: team.home_hub, request_id: command.request_id, command: { team_id: team.id, command }, receipt: structuredClone(receipt) }, calls = 0
  const storage = { async reserve(_, value, canReplace) { if (canReplace?.(row)) row = structuredClone(value); return row }, async save(_, value) { row = value } }
  const next = { ...command, request_id: 'reactivate', expected_revision: 2 }
  const request = async input => { calls++; assert.deepEqual(input.command, next); return { ...receipt, revision: 3 } }
  const run = activation => activateReviewedTeam({ storage, team, review: { prepared_command: next, activation }, request })
  await run({ ...structuredClone(receipt), revision: 2 })
  await run({ active: false, revision: 2, team_id: 'foreign', home_hub: team.home_hub })
  await run({ active: false, revision: 1, team_id: team.id, home_hub: team.home_hub })
  assert.equal(calls, 0)
  await run({ active: false, revision: 2, team_id: team.id, home_hub: team.home_hub })
  assert.equal(calls, 1); assert.equal(row.receipt.revision, 3)
})

test('changed authority requires renewed confirmation even while the previous activation is active', async () => {
  let row = { state: 'activated', home_hub: team.home_hub, request_id: command.request_id, command: { team_id: team.id, command }, receipt: structuredClone(receipt) }
  const storage = { async reserve(_, value, canReplace) { if (canReplace?.(row)) row = value; return row }, async save(_, value) { row = value } }
  const next = { ...command, request_id: 'renew', expected_revision: 1, grant_revision: 4 }
  await activateReviewedTeam({ storage, team, review: { prepared_command: next, activation: structuredClone(receipt) }, request: async input => {
    assert.deepEqual(input.command, next)
    return { ...structuredClone(receipt), revision: 2, snapshot: { ...structuredClone(receipt.snapshot), grant: { revision: 4 } } }
  } })
  assert.equal(row.receipt.revision, 2); assert.equal(row.request_id, 'renew')
})

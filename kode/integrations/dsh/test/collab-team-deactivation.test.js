import test from 'node:test'
import assert from 'node:assert/strict'
import { deactivateTeam } from '../packages/collab/team-deactivation.js'
const team = { id: 'team', home_hub: 'home' }
const activation = { team_id: team.id, home_hub: team.home_hub, revision: 1, team_revision: 1, active: true, snapshot_hash: 'a'.repeat(64), actor: { kind: 'human' } }
test('deactivation preserves original revision and request through reply and local persistence failure', async () => {
  let row, failSave = true, calls = 0
  const storage = { async reserve(_, value) { if (!row || row.state === 'accepted') row = structuredClone(value); return row }, async save(_, value) { if (failSave) throw Error('disk'); row = value } }
  const request = async input => { calls++; assert.equal(input.command.request_id, 'stop'); assert.equal(input.command.expected_revision, 1); if (calls === 1) throw Error('lost'); return { ...activation, revision: 2, active: false } }
  const run = (value = activation, requestId = 'stop') => deactivateTeam({ storage, team, activation: value, requestId, request })
  await assert.rejects(run(), /lost/)
  await assert.rejects(run({ ...activation, revision: 3 }, 'different'), /disk/)
  failSave = false
  await run({ ...activation, revision: 3 }, 'different')
  assert.equal(row.state, 'accepted'); assert.equal(row.receipt.revision, 2)
  await deactivateTeam({ storage, team, activation: { ...activation, revision: 3 }, requestId: 'stop-again', request: async input => {
    assert.equal(input.command.request_id, 'stop-again'); assert.equal(input.command.expected_revision, 3)
    return { ...activation, revision: 4, active: false }
  } })
  assert.equal(row.receipt.revision, 4)
})
test('deactivation rejects unrelated or still-active receipts', async () => {
  for (const patch of [{ active: true }, { revision: 3 }, { team_revision: 2 }, { snapshot_hash: 'b'.repeat(64) }, { home_hub: 'other' }]) {
    let saved = false
    await assert.rejects(deactivateTeam({ storage: { async reserve(_, value) { return value }, async save() { saved = true } }, team, activation, requestId: 'stop', request: async () => ({ ...activation, revision: 2, active: false, ...patch }) }))
    assert.equal(saved, false)
  }
})

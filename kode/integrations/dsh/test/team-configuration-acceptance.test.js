import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareAcceptance, acceptConfiguration, verifyAcceptanceStatus, verifyAcceptanceReceipt, configurationAcceptanceKey } from '../packages/collab/team-configuration-acceptance.js'
const team = { id: 'team', home_hub: 'home', revision: 2, spec: { execution_mode: 'interactive_native', name: 'Team', workers: [] } }
const status = { team_id: 'team', team_revision: 2, accepted: false, parent_accepted_revision: 1, builder_lineage: { team: { id: 'team' }, home_hub: 'home', actor: { kind: 'human' }, draft_id: 'builder', draft_revision: 3 } }
const receipt = command => ({ request: command, team, home_hub: 'home', actor: { kind: 'human', id: 'local_owner' }, activation_performed: false, eligible_for_execution: false, builder_lineage: { team: { id: 'team' }, home_hub: 'home', actor: { kind: 'human' }, draft_id: 'builder', draft_revision: 3 } })
const storage = () => { let value; return { read: async () => value, reserve: async (_, next) => value ??= next, save: async (_, next) => { assert.equal(value.request_id, next.request_id); value = next } } }
test('confirmation pins the complete current spec and original accepted revision', () => {
  const command = prepareAcceptance(team, status, 'request')
  assert.deepEqual(command, { request_id: 'request', expected_revision: 2, parent_accepted_revision: 1, spec: team.spec })
  assert.notEqual(command.spec, team.spec)
  assert.throws(() => prepareAcceptance(team, { ...status, accepted: true }, 'r'))
  assert.throws(() => prepareAcceptance(team, { ...status, parent_accepted_revision: null }, 'r'))
  assert.throws(() => prepareAcceptance(team, { ...status, builder_lineage: null }, 'r'))
  assert.throws(() => verifyAcceptanceStatus(team, { ...status, team_revision: 1 }))
})
test('uncertain retry and reload preserve original command; changed command cannot overwrite it', async () => {
  const s = storage(), command = prepareAcceptance(team, status, 'request'), calls = []
  const request = async (_, input) => { calls.push(structuredClone(input)); if (calls.length === 1) throw Error('lost response'); return receipt(input) }
  await assert.rejects(acceptConfiguration({ team, command, storage: s, request }))
  assert.equal((await s.read(configurationAcceptanceKey(team))).state, 'prepared')
  await assert.rejects(acceptConfiguration({ team, command: { ...command, request_id: 'other' }, storage: s, request }))
  await acceptConfiguration({ team, command: (await s.read()).command, storage: s, request })
  assert.deepEqual(calls[0], calls[1]); assert.equal((await s.read()).state, 'confirmed')
  await acceptConfiguration({ team, command, storage: s, request }); assert.equal(calls.length, 2)
})
test('fail closed for altered spec, wrong owner, missing lineage and simulated execution receipts', () => {
  const command = prepareAcceptance(team, status, 'r')
  for (const patch of [{ actor: { kind: 'human', id: 'other' } }, { builder_lineage: null }, { activation_performed: true }, { eligible_for_execution: true }, { team: { ...team, spec: {} } }, { request: { ...command, expected_revision: 3 } }]) {
    assert.throws(() => verifyAcceptanceReceipt(team, command, { ...receipt(command), ...patch }))
  }
})

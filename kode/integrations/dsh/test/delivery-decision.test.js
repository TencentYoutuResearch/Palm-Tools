import test from 'node:test'
import assert from 'node:assert/strict'
import { decideDelivery, deliveryDecisionKey } from '../packages/collab/delivery-decision.js'
import { registerWorkDeliveryDecision } from '../src/work-delivery-decision-route.js'
const hash = 'a'.repeat(64)
const run = () => ({ id: 'run', home_hub: 'home', team_id: 'team', revision: 4, state: 'waiting_user', waiting_reason: 'human_delivery_acceptance_required', completion_authorized: false, human_acceptance: { revision: 4, state: 'pending', evidence_hash: hash } })
const receipt = (row, command) => ({ ...row, revision: 5, state: command.choice === 'accept' ? 'queued' : 'waiting_user', human_acceptance: { ...row.human_acceptance, state: command.choice === 'accept' ? 'accepted' : 'rejected', decision: { ...command, actor: { kind: 'human', id: 'local_owner' } } } })
function storage() {
  const rows = new Map()
  return { read: async key => rows.get(key), reserve: async (key, value) => { if (!rows.has(key)) rows.set(key, value); return rows.get(key) }, save: async (key, value) => { assert.equal(rows.get(key).request_id, value.request_id); rows.set(key, value) } }
}

test('owner decision bridge rejects expanded authority and preserves exact retry payload', async () => {
  let route, owner = false, status, body, fail = false
  const calls = []
  registerWorkDeliveryDecision({ webServer: { register: value => { route = value } }, connection: { admit: () => ({ peer: { principal: { kind: owner ? 'owner' : 'agent' } } }) } }, { backendClient: { call: async (...args) => { calls.push(args); if (fail) throw Error('private'); return {} } } })
  const invoke = async value => {
    await route.handler({ method: 'POST', url: route.path, headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield JSON.stringify(value) } }, { writeHead: value => { status = value }, end: value => { body = JSON.parse(value) } })
  }
  const command = { run_id: 'run', request_id: 'decision', expected_revision: 4, evidence_hash: hash, choice: 'accept', reason: 'Reviewed evidence' }
  await invoke(command); assert.equal(status, 403); assert.equal(calls.length, 0)
  owner = true
  for (const invalid of [{ ...command, actor: 'owner' }, { ...command, choice: 'waive' }, { ...command, expected_revision: 1.1 }, { ...command, reason: ' ' }, { ...command, evidence_hash: 'foreign' }]) { await invoke(invalid); assert.equal(status, 400) }
  assert.equal(calls.length, 0)
  await invoke(command); assert.equal(status, 200)
  assert.equal(calls[0][0], '/api/v1/messaging/work-runs/run/delivery-decision')
  assert.equal('run_id' in calls[0][1], false)
  fail = true; await invoke(command); assert.equal(status, 409); assert.equal(body.retry, 'same_request')
  assert.deepEqual(calls[1], calls[0]); assert.ok(!JSON.stringify(body).includes('private'))
})

test('lost decision response recovers exact stored decision and cannot switch choice or reason', async () => {
  const row = run(), disk = storage(), calls = []
  let lost = true
  const request = async command => { calls.push(command); if (lost) { lost = false; throw Error('lost response') } return receipt(row, command) }
  const args = { storage: disk, run: row, choice: 'accept', reason: 'Reviewed artifact', request, uuid: () => 'original' }
  await assert.rejects(decideDelivery(args), /lost response/)
  await assert.rejects(decideDelivery({ ...args, choice: 'reject' }), /different decision/)
  await assert.rejects(decideDelivery({ ...args, reason: 'Changed' }), /different decision/)
  const accepted = await decideDelivery({ ...args, uuid: () => 'must-not-replace' })
  assert.deepEqual(calls[1], calls[0]); assert.equal(accepted.completion_authorized, false)
  assert.deepEqual(await decideDelivery({ ...args, run: accepted }), accepted)
  assert.equal(calls.length, 2)
  assert.equal((await disk.read(deliveryDecisionKey(row))).state, 'accepted')
})

test('decision validation retains unresolved state after forged receipt and supports rejection', async () => {
  const row = run(), disk = storage()
  const args = { storage: disk, run: row, choice: 'reject', reason: 'Needs changes', uuid: () => 'reject' }
  await assert.rejects(decideDelivery({ ...args, request: async command => ({ ...receipt(row, command), completion_authorized: true }) }), /receipt/)
  assert.equal((await disk.read(deliveryDecisionKey(row))).state, 'prepared')
  const rejected = await decideDelivery({ ...args, request: async command => receipt(row, command) })
  assert.equal(rejected.state, 'waiting_user'); assert.equal(rejected.human_acceptance.state, 'rejected')
  await assert.rejects(decideDelivery({ ...args, storage: storage(), run: { ...row, state: 'completed' } }), /not pending/)
})

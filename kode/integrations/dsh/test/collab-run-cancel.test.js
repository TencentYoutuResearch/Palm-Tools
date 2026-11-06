import test from 'node:test'
import assert from 'node:assert/strict'
import { cancelRun } from '../packages/collab/run-cancel.js'
test('ambiguous cancellation retries the original revision and never asserts stop', async () => {
  let row, calls = [], fail = true
  const storage = { async reserve(_, value) { return row ??= value }, async save(_, value) { row = value } }
  const run = { id: 'run', team_id: 'team', home_hub: 'home', revision: 1 }
  const request = async command => { calls.push(command); if (fail) throw Error('lost'); return { ...run, revision: 2, state: 'cancelling', completion_authorized: false, cancellation: { request_id: command.request_id, stop_confirmed: false } } }
  await assert.rejects(cancelRun({ storage, run, request, uuid: () => 'cancel' })); fail = false
  const result = await cancelRun({ storage, run: { ...run, revision: 2 }, request, uuid: () => 'new' })
  assert.deepEqual(calls[0], calls[1]); assert.equal(result.cancellation.stop_confirmed, false); assert.equal(row.state, 'accepted')
})

test('storage failure and disposal prevent cancellation dispatch', async () => {
  const run = { id: 'run', team_id: 'team', home_hub: 'home', revision: 1 }
  let calls = 0
  const request = async () => { calls++; throw Error('unexpected dispatch') }
  await assert.rejects(cancelRun({ storage: { async reserve() { throw Error('storage unavailable') } }, run, request }))
  const controller = new AbortController()
  const storage = { async reserve(_, value) { controller.abort(); return value } }
  await assert.rejects(cancelRun({ storage, run, request, signal: controller.signal }), /Disposed/)
  assert.equal(calls, 0)
})

test('foreign and contradictory cancellation receipts retain the pending identity', async () => {
  const run = { id: 'run', team_id: 'team', home_hub: 'home', revision: 1 }
  const receipt = { ...run, revision: 2, state: 'cancelling', completion_authorized: false, cancellation: { request_id: 'cancel', stop_confirmed: false } }
  for (const patch of [{ id: 'other' }, { team_id: 'other' }, { home_hub: 'other' }, { revision: 3 }, { state: 'cancelled' }, { completion_authorized: true }, { cancellation: { request_id: 'other' } }]) {
    let row, saved = false
    const storage = { async reserve(_, value) { return row ??= value }, async save() { saved = true } }
    await assert.rejects(cancelRun({ storage, run, request: async () => ({ ...receipt, ...patch }), uuid: () => 'cancel' }), /Invalid cancellation receipt/)
    assert.equal(saved, false)
    assert.equal(row.state, 'prepared')
    assert.equal(row.request_id, 'cancel')
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { confirmBuilderStart } from '../packages/collab/builder-start-command.js'
const draft = { id: 'draft', home_hub: 'home' }
const command = { command_id: 'start', team_id: 'candidate', provider: 'provider', start: { draft_id: 'draft', operation: { worker: { node_id: 'home', session_id: 'builder' }, selection_policy: { profile_revision: 'revision', model: 'model', effort: null }, grant_scope: { target: { root: '/fixture' }, tools: ['read'] } } } }
const receipt = { state: 'created', request: { command_id: 'start', session_id: 'builder', provider: 'provider', model: 'model', effort: null, profile_revision: 'revision', cwd: '/fixture', builder: { draft_id: 'draft', team_id: 'candidate' }, operation: { id: 'operation', attempt: 1, epoch: 1 }, tools: ['read'] } }
test('uncertain or foreign startup results cannot become local creation receipts', async () => {
  for (const value of [{ ...receipt, state: 'uncertain' }, { ...receipt, request: { ...receipt.request, session_id: 'foreign' } }, { ...receipt, request: { ...receipt.request, tools: ['read', 'shell'] } }]) {
    let row, saved = false
    const storage = { async reserve(_, value) { return row ??= value }, async save() { saved = true } }
    await assert.rejects(confirmBuilderStart({ storage, draft, command, request: async () => value }), /not confirmed/)
    assert.equal(saved, false); assert.equal(row.state, 'prepared')
  }
})
test('startup requires durable intent and recovers after local receipt-write failure', async () => {
  let calls = 0, row, failSave = true
  const request = async () => { calls++; return receipt }
  await assert.rejects(confirmBuilderStart({ storage: { async reserve() { throw Error('disk unavailable') } }, draft, command, request }), /disk/)
  assert.equal(calls, 0)
  const storage = { async reserve(_, value) { return row ??= value }, async save(_, value) { if (failSave) throw Error('write failed'); row = value } }
  await assert.rejects(confirmBuilderStart({ storage, draft, command, request }), /write failed/)
  failSave = false
  await confirmBuilderStart({ storage, draft, command: { ...command, command_id: 'other' }, request: async value => { assert.equal(value.command_id, 'start'); return request() } })
  assert.equal(row.state, 'created')
  await confirmBuilderStart({ storage, draft, command, request: async () => assert.fail('must use terminal receipt') })
  assert.equal(calls, 2)
})

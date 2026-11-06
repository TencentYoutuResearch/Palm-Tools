import test from 'node:test'
import assert from 'node:assert/strict'
import { confirmWorkflowRegistration } from '../packages/collab/builder-workflow-command.js'
const proposal = { workflow: { id: 'flow', version: '1' }, project: { id: 'project', version: '1' }, delivery: { id: 'delivery', version: '1' } }
const draft = { id: 'draft', home_hub: 'home', revision: 3, interview: { proposed_workflow: proposal } }
const receipt = { draft_id: 'draft', draft_revision: 3, request_id: 'original', state: 'registered', activation_performed: false, eligible_for_execution: false, workflow: { ...proposal.workflow, hash: 'a'.repeat(64) }, project: { ...proposal.project, hash: 'b'.repeat(64) }, delivery_policy: { ...proposal.delivery, hash: 'c'.repeat(64) } }
test('workflow consent survives response and local-save loss without replacing the proposal', async () => {
  let row, calls = 0, failSave = true
  const storage = { async reserve(_, value) { return row ??= structuredClone(value) }, async save(_, value) { if (failSave) throw Error('disk'); row = structuredClone(value) } }
  const request = async command => { calls++; assert.deepEqual(command, { draft_id: 'draft', expected_revision: 3, request_id: 'original' }); if (calls === 1) throw Error('lost'); return structuredClone(receipt) }
  const run = () => confirmWorkflowRegistration({ draft, storage, request, uuid: () => calls ? 'replacement' : 'original' })
  await assert.rejects(run(), /lost/)
  await assert.rejects(run(), /disk/)
  failSave = false
  await run(); await run()
  assert.equal(calls, 3); assert.equal(row.state, 'registered')
  row.receipt.workflow.hash = 'invalid'
  await assert.rejects(run(), /Invalid workflow registration receipt/)
})
test('workflow confirmation rejects foreign or executable receipts and never writes before durable consent', async () => {
  for (const alter of [r => r.draft_id = 'foreign', r => r.draft_revision++, r => r.request_id = 'other', r => r.workflow.version = '2', r => r.activation_performed = true, r => r.eligible_for_execution = true]) {
    const value = structuredClone(receipt); alter(value)
    await assert.rejects(confirmWorkflowRegistration({ draft, storage: { async reserve(_, intent) { return intent }, async save() { assert.fail('invalid receipt') } }, request: async () => value, uuid: () => 'original' }), /Invalid workflow registration receipt/)
  }
  await assert.rejects(confirmWorkflowRegistration({ draft, storage: { async reserve() { throw Error('disk') } }, request: async () => assert.fail('must not submit') }), /disk/)
})
test('new draft revisions retain unresolved consent and replace only confirmed historical proposals', async () => {
  let row, calls = 0
  const storage = { async reserve(_, value, replace) { if (!row || replace?.(row)) row = structuredClone(value); return row }, async save(_, value) { row = structuredClone(value) } }
  const request = async command => { calls++; if (calls === 1) throw Error('lost'); return { ...structuredClone(receipt), request_id: command.request_id, draft_revision: command.expected_revision, workflow: { ...row.proposal.workflow, hash: 'd'.repeat(64) } } }
  const run = (value, replaceRegistered = false) => confirmWorkflowRegistration({ draft: value, storage, request, replaceRegistered, uuid: () => calls ? 'new' : 'original' })
  await assert.rejects(run(draft), /lost/)
  const next = { ...draft, revision: 4, interview: { proposed_workflow: { ...proposal, workflow: { id: 'flow', version: '2' } } } }
  await run(next, true)
  assert.equal(row.receipt.draft_revision, 3); assert.equal(row.receipt.workflow.version, '1')
  await run(next)
  assert.equal(calls, 2, 'new proposal requires separate review and confirmation')
  await run(next, true)
  assert.equal(row.receipt.draft_revision, 4); assert.equal(row.receipt.workflow.version, '2'); assert.equal(calls, 3)
  await assert.rejects(run(draft), /Wrong workflow scope/)
})

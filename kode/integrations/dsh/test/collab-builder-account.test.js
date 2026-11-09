import test from 'node:test'
import assert from 'node:assert/strict'
import { confirmBuilderAccount, selectedBuilderResource } from '../packages/collab/builder-account.js'
const draft = { id: 'draft', home_hub: 'home', revision: 1 }
const selection = { revision: 1, draft_revision: 1, selection: { profile_id: 'profile', provider: 'provider', model: 'model', effort: null, workspace: { host_id: 'home', workspace_id: 'workspace', root_ref: '/fixture' } } }
const command = { draft_id: 'draft', request_id: 'confirm', draft_revision: 1, selection_revision: 1, account_id: 'account', account_epoch: 1, create_account: true, expected_binding_revision: 0 }
const { draft_id, ...requestBody } = command
const receipt = { home_hub: 'home', draft_id, request: requestBody, selection: selection.selection, binding: { host: 'home', profile: 'profile', account_id: 'account', account_epoch: 1, revision: 1 }, quota_status: 'not_checked', execution_started: false, activation_performed: false, account_created: true }
test('account command recovery preserves original selection and refuses unrelated receipt', async () => {
  let row, failSave = true
  const storage = { async reserve(_, value) { return row ??= structuredClone(value) }, async save(_, value) { if (failSave) throw Error('disk'); row = value } }
  const run = (offered, result) => confirmBuilderAccount({ storage, draft, command: offered, selection, request: async value => { assert.deepEqual(value, command); return result } })
  await assert.rejects(run(command, { ...receipt, activation_performed: true }), /Invalid account receipt/)
  await assert.rejects(run({ ...command, account_id: 'changed' }, receipt), /disk/)
  failSave = false
  await run({ ...command, request_id: 'other' }, receipt)
  assert.equal(row.state, 'accepted'); assert.equal(row.receipt.binding.account_id, 'account')
})
test('account review rejects foreign or stale resource selection', async () => {
  for (const value of [{ home_hub: 'foreign', draft_id: 'draft', record: selection }, { home_hub: 'home', draft_id: 'draft', record: { ...selection, draft_revision: 2 } }]) {
    await assert.rejects(selectedBuilderResource(draft, async () => value), /Selection unavailable/)
  }
  await assert.rejects(selectedBuilderResource(draft, async path => path.includes('/selection?') ? { home_hub: 'home', draft_id: 'draft', record: selection } : { host: 'foreign', scope: 'host_execution_resources', items: [], next_cursor: null }), /Invalid coverage/)
})

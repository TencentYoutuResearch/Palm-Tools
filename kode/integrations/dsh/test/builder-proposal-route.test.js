import test from 'node:test'
import assert from 'node:assert/strict'
import { saveBuilderProposal, registerBuilderProposal } from '../src/builder-proposal-route.js'
function fixture() {
  const workspace = { host_id: 'fixture', workspace_id: 'workspace', root_ref: '/fixture' }
  const draft = { id: 'draft', home_hub: 'fixture', revision: 3, status: 'draft', interview: { purpose: 'Original purpose', answers: { language: 'Chinese' }, questions: [], workspace_refs: [workspace], proposed_team: null } }
  let receipt = null, writes = 0
  const selected = { draft_id: 'draft', home_hub: 'fixture', runtime_binding: null }
  const backend = { async call(path, input) {
    if (input) { writes++; assert.equal(path, '/api/v1/messaging/superagents/drafts'); assert.equal(input.builder_operation, undefined)
      assert.equal(input.expected_revision, 3); receipt = { ...input, revision: 4, eligible_for_execution: false }; return structuredClone(receipt) }
    if (path.includes('/commands/')) return { receipt: structuredClone(receipt) }
    if (path.endsWith('/selection')) return selected
    return structuredClone(draft)
  } }
  return { draft, backend, selected, writes: () => writes, input: { draft_id: 'draft', request_id: 'candidate', expected_revision: 3, proposed_team: { name: 'Candidate', workspace_refs: [workspace] } } }
}
test('candidate handoff preserves interview and retries exact receipt without Team activation', async () => {
  const f = fixture(), saved = await saveBuilderProposal(f.backend, f.input)
  assert.equal(saved.interview.purpose, f.draft.interview.purpose); assert.deepEqual(saved.interview.answers, f.draft.interview.answers)
  assert.equal(saved.eligible_for_execution, false); assert.equal(f.writes(), 1)
  assert.deepEqual(await saveBuilderProposal(f.backend, f.input), saved); assert.equal(f.writes(), 1)
  await assert.rejects(saveBuilderProposal(f.backend, { ...f.input, proposed_team: { ...f.input.proposed_team, name: 'Changed' } }), /identity conflict/)
})
test('candidate rejects cross-workspace, controlled conflicts and caller-provided authority', async () => {
  const f = fixture()
  await assert.rejects(saveBuilderProposal(f.backend, { ...f.input, builder_operation: {} }), /Invalid/)
  await assert.rejects(saveBuilderProposal(f.backend, { ...f.input, proposed_team: { workspace_refs: [{ host_id: 'other' }] } }), /workspace outside/)
  f.selected.runtime_binding = { state: 'active' }; await assert.rejects(saveBuilderProposal(f.backend, f.input), /controlled Builder/)
  assert.equal(f.writes(), 0)
})
test('candidate endpoint requires explicit owner POST and never exposes a model tool', async () => {
  let handler, reads = 0
  const ctx = { connection: { admit: () => ({ peer: { principal: { kind: 'agent' } } }) }, webServer: { register: row => { handler = row.handler } } }
  registerBuilderProposal(ctx, { backendClient: { call: () => reads++ } })
  let status; const res = { writeHead: value => { status = value }, end() {} }
  await handler({ method: 'POST' }, res); assert.equal(status, 403); assert.equal(reads, 0)
})

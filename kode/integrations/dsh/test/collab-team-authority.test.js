import test from 'node:test'
import assert from 'node:assert/strict'
import { authorityCommand, confirmTeamAuthority } from '../packages/collab/team-authority.js'
const team = { id: 'team', home_hub: 'home', revision: 1, spec: { kind: 'coordinator', grant_id: 'grant', workspace_refs: [{ host_id: 'home', workspace_id: 'workspace', root_ref: '/fixture' }], workers: [] } }
const policy = kind => ({ id: kind, team_id: 'team', revision: 1, policy: kind === 'budget' ? { kind, budget_ids: ['budget'], unit: 'credits', max_assignment_charge: 10 } : { kind, targets: {} } })
const review = { team, grant: null, configuration: { workflow_bindings_valid: true, project_delivery_bindings_valid: true, execution_policy_bindings_valid: true, policies: { budget: policy('budget'), scheduling: policy('scheduling') }, bindings: [{ workflow: { pack: { stages: [{ execution: { capabilities: ['read'], tools: ['kode_capture_output'], network: false } }] } } }] } }
test('Coordinator permission proposal includes delegation even without explicit Workers and grants nothing', () => {
  const command = authorityCommand(team, review, Date.now() + 60000, 'confirm')
  assert.deepEqual(command.grant.policy.capabilities, ['delegate', 'read'])
  assert.ok(command.grant.policy.tools.includes('kode_coordinator_workflow_start'))
  assert.ok(command.grant.policy.tools.includes('kode_capture_output'))
  assert.equal(command.grant.policy.network, false)
  assert.equal(review.grant, null)
  assert.throws(() => authorityCommand(team, { ...review, configuration: { ...review.configuration, execution_policy_bindings_valid: false } }, Date.now() + 60000, 'confirm'))
})
test('authority recovery preserves reviewed scope after lost response and rejects expanded grants', async () => {
  const command = authorityCommand(team, review, Date.now() + 60000, 'confirm')
  const receipt = { team_id: 'team', team_revision: 1, request_id: 'confirm', activation_performed: false, grant: { revision: 1, policy: command.grant.policy }, budget_policy: { ...review.configuration.policies.budget, revision: 2 }, scheduling_policy: { ...review.configuration.policies.scheduling, revision: 2 } }
  let row, calls = 0
  const storage = { async reserve(_, candidate) { return row ??= structuredClone(candidate) }, async save(_, candidate) { row = candidate } }
  const request = async input => { calls++; assert.deepEqual(input.command, command); if (calls === 1) throw Error('lost'); return receipt }
  await assert.rejects(confirmTeamAuthority({ storage, team, command, request }), /lost/)
  const expanded = structuredClone(receipt); expanded.grant.policy.network = true
  await assert.rejects(confirmTeamAuthority({ storage, team, command, request: async () => expanded }), /Invalid authority receipt/)
  await confirmTeamAuthority({ storage, team, command: { ...command, request_id: 'different' }, request })
  assert.equal(row.state, 'accepted'); assert.equal(row.receipt.grant.policy.network, false)
})

test('answer forwarding permission is added only to an explicitly selected authority proposal', () => {
  const expires = Date.now() + 60000
  const base = authorityCommand(team, review, expires, 'confirm')
  const selected = authorityCommand(team, review, expires, 'confirm', { allowClarificationAnswers: true })
  assert.equal(base.grant.policy.tools.includes('kode_coordinator_answer_clarification'), false)
  const extra = selected.grant.policy.tools.filter(name => !base.grant.policy.tools.includes(name))
  assert.deepEqual(extra, ['kode_coordinator_answer_clarification'])
  selected.grant.policy.tools = base.grant.policy.tools
  assert.deepEqual(selected, base)
  assert.throws(() => authorityCommand(team, review, expires, 'confirm', { allowClarificationAnswers: 'yes' }), /permission/)
})

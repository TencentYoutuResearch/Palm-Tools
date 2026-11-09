import test from 'node:test'
import assert from 'node:assert/strict'
import { schedulingCommand, confirmScheduling } from '../packages/collab/team-scheduling.js'
const team = { id: 'team', home_hub: 'home', revision: 1, spec: { scheduling_policy_id: 'schedule', execution_targets: [{ id: 'target', host_id: 'home', executor_profile_id: 'profile', account_binding_id: 'account', model_id: 'model', capability_profile_revision: '1' }] } }
const options = { team, eligible_for_execution: false, policy: null, options: [{ target_id: 'target', binding: { host: 'home', profile: 'profile', binding_current: true, account_id: 'account', account_epoch: 1, revision: 2 }, quota: { status: 'unavailable' }, capabilities: [{ id: 'capability', host: 'home', profile: 'profile', model: 'model', revision: 1 }] }] }
const preferences = { quality: '100', cost: '50', latency: '20', minimum_quality: '0', minimum_confidence: '0', allowUnknown: true }
const choices = { target: 'capability' }
test('scheduling review refuses unknown quota without explicit policy and rejects mismatched resources', () => {
  const build = (values = options, prefs = preferences) => schedulingCommand(team, values, choices, prefs, 'confirm')
  assert.throws(() => build(options, { ...preferences, allowUnknown: false }), /Quota source missing/)
  for (const mutation of [row => row.binding.binding_current = false, row => row.binding.account_id = 'other', row => row.capabilities[0].model = 'other']) {
    const values = structuredClone(options); mutation(values.options[0]); assert.throws(() => build(values))
  }
  for (const patch of [{ quality: '' }, { cost: '1001' }, { minimum_confidence: '1.1' }, { quality: '0', cost: '0', latency: '0' }]) assert.throws(() => build(options, { ...preferences, ...patch }))
  const command = build(); assert.deepEqual(command.policy.policy.targets.target.resource.limit_ids, [])
  assert.equal(command.policy.policy.targets.target.resource.binding_revision, 2)
})
test('scheduling lost reply recovers the original preferences and rejects altered policy receipts', async () => {
  const command = schedulingCommand(team, options, choices, preferences, 'confirm')
  const receipt = { home_hub: 'home', team_id: 'team', team_revision: 1, request_id: 'confirm', activation_performed: false, eligible_for_execution: false, policy: { id: 'schedule', team_id: 'team', revision: 1, policy: command.policy.policy } }
  let row, calls = 0
  const storage = { async reserve(_, value) { return row ??= structuredClone(value) }, async save(_, value) { row = value } }
  const request = async input => { assert.deepEqual(input.command, command); if (++calls === 1) throw Error('lost'); return receipt }
  await assert.rejects(confirmScheduling({ storage, team, command, request }), /lost/)
  const altered = structuredClone(receipt); altered.policy.policy.weights.cost = 999
  await assert.rejects(confirmScheduling({ storage, team, command, request: async () => altered }), /Invalid scheduling receipt/)
  await confirmScheduling({ storage, team, command: { ...command, request_id: 'other' }, request })
  assert.equal(row.state, 'accepted'); assert.equal(row.receipt.policy.policy.weights.cost, 50)
})

test('explicit internal rates retain exact versions on retry and require matching price receipts', async () => {
  const pricing = { target: { enabled: true, unit: 'credits', input_per_million: '2', cached_per_million: '0', output_per_million: '3' } }
  const build = values => schedulingCommand(team, options, choices, preferences, 'priced', values, () => 'price')
  const command = build(pricing)
  assert.equal(command.policy.policy.targets.target.internal_price_id, 'price')
  assert.equal(command.internal_prices.target.cached_per_million, 0)
  for (const value of ['', '-1', '1.2', '4000000000000001']) assert.throws(() => build({ target: { ...pricing.target, input_per_million: value } }))
  assert.throws(() => build({ foreign: pricing.target }))
  const receipt = { home_hub: 'home', team_id: 'team', team_revision: 1, request_id: 'priced', activation_performed: false, eligible_for_execution: false, policy: { id: 'schedule', team_id: 'team', revision: 1, policy: command.policy.policy }, internal_prices: { label: '内部计价', provider_invoice: false, prices: command.internal_prices } }
  let row
  const storage = { async reserve(_, value) { return row ??= structuredClone(value) }, async save(_, value) { row = value } }
  await assert.rejects(confirmScheduling({ storage, team, command, request: async () => { throw Error('lost') } }), /lost/)
  const wrong = structuredClone(receipt); wrong.internal_prices.prices.target.output_per_million++
  await assert.rejects(confirmScheduling({ storage, team, command, request: async () => wrong }), /Invalid internal price receipt/)
  await confirmScheduling({ storage, team, command: { ...command, request_id: 'new' }, request: async input => { assert.deepEqual(input.command, command); return receipt } })
  assert.equal(row.state, 'accepted')
})

test('shared account capacity requires explicit bounded input and exact versioned receipt', async () => {
  const build = value => schedulingCommand(team, options, choices, preferences, 'capacity', {}, undefined, { account: { enabled: true, value } })
  for (const value of ['', '0', '-1', '1.5', '1025', '1e2']) assert.throws(() => build(value), /capacity/)
  const command = build('2')
  assert.deepEqual(command.account_capacities, { account: { account_id: 'account', expected_revision: 0, max_active_assignments: 2 } })
  const receipt = { home_hub: 'home', team_id: 'team', team_revision: 1, request_id: 'capacity', activation_performed: false, eligible_for_execution: false, policy: { id: 'schedule', team_id: 'team', revision: 1, policy: command.policy.policy }, account_capacities: { scope: 'account_shared_across_teams', capacities: { account: { account_id: 'account', revision: 1, max_active_assignments: 2, held: 0 } } } }
  let row
  const storage = { async reserve(_, value) { return row ??= structuredClone(value) }, async save(_, value) { row = value } }
  await assert.rejects(confirmScheduling({ storage, team, command, request: async () => { throw Error('lost') } }), /lost/)
  const changed = structuredClone(receipt); changed.account_capacities.capacities.account.revision++
  await assert.rejects(confirmScheduling({ storage, team, command, request: async () => changed }), /capacity receipt/)
  await confirmScheduling({ storage, team, command: build('3'), request: async input => { assert.deepEqual(input.command, command); return receipt } })
  assert.equal(row.state, 'accepted')
})

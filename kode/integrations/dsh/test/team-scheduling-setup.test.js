import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
import { conversationTeam } from './support/conversation-team.js'
test('owner scheduling binds reviewed account and capability identities with restart-safe receipts', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('team-scheduling')
  try {
    const base = '/api/v1/messaging/', original = await conversationTeam(hub)
    await hub.client.call(base + 'teams', { id: 'new-team', request_id: 'create', expected_revision: 0, spec: { ...original.spec, scheduling_policy_id: 'new-schedule' } })
    const path = base + 'teams/new-team/', options = await hub.client.call(path + 'scheduling-options/1')
    assert.equal(options.policy, null); assert.equal(options.eligible_for_execution, false)
    const row = options.options[0]
    assert.equal(row.target_id, 'control'); assert.equal(row.binding.binding_current, true)
    assert.equal(row.capabilities[0].id, 'capability'); assert.equal(row.capabilities_truncated, false)
    const command = { request_id: 'configure', team_revision: 1, policy: { id: 'new-schedule', team_id: 'new-team', expected_revision: 0, policy: { kind: 'scheduling', targets: { control: { resource: { host: hub.node, profile: 'profile', account_id: 'account', account_epoch: 1, binding_revision: 1, limit_ids: [], unknown_quota: 'team_budget' }, capability_id: 'capability', capability_revision: 1, preferred: false } }, weights: { quality: 100, cost: 50, latency: 20 }, minimum_quality: 0, minimum_confidence: 0 } } }
    const worker = await hub.client.call(base + 'sessions', { session_id: 'worker', title: 'worker', runtime: 'external' })
    const agent = hub.client.forSession(worker.owner_token)
    await assert.rejects(agent.call(path + 'scheduling-options/1'), /403/)
    await assert.rejects(agent.call(path + 'scheduling', command), /403/)
    const mismatch = structuredClone(command); mismatch.policy.policy.targets.control.resource.binding_revision = 2
    await assert.rejects(hub.client.call(path + 'scheduling', mismatch), /binding changed/)
    assert.equal((await hub.client.call(path + 'scheduling-requests/configure')).receipt, null)
    const wrongCapability = structuredClone(command)
    await hub.client.call(base + 'capability-profiles', { id: 'foreign', expected_revision: 0, host: hub.node, profile: 'profile', model: 'different-model', assessments: {} })
    wrongCapability.policy.policy.targets.control.capability_id = 'foreign'
    await assert.rejects(hub.client.call(path + 'scheduling', wrongCapability), /capability identity mismatch/)
    const results = await Promise.all([hub.client.call(path + 'scheduling', command), hub.client.call(path + 'scheduling', command)])
    assert.deepEqual(results[0], results[1]); const saved = results[0]
    assert.equal(saved.policy.revision, 1); assert.equal(saved.activation_performed, false)
    assert.deepEqual(saved.policy.policy.weights, command.policy.policy.weights)
    await assert.rejects(hub.client.call(path + 'scheduling', { ...command, request_id: 'stale' }), /policy revision conflict/)
    await hub.client.call(base + 'resource-accounts', { id: 'account', expected_epoch: 1, enabled: false })
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(path + 'scheduling', command), saved)
    assert.deepEqual((await hub.client.call(path + 'scheduling-requests/configure')).receipt, { request: command, result: saved })
    assert.equal((await hub.client.call(path + 'scheduling-options/1')).options[0].binding.binding_current, false)
    await assert.rejects(hub.client.call(path + 'activation'), /404/)
  } finally { await hub.close() }
})

test('scheduling bridge accepts only fixed owner queries and policy confirmations', async () => {
  const { registerTeamScheduling } = await import('../src/team-scheduling-route.js')
  const { Readable } = await import('node:stream')
  let route, kind = 'agent', status, calls = []
  registerTeamScheduling({ webServer: { register(value) { route = value } }, connection: { admit: () => ({ peer: { principal: { kind } } }) } }, { backendClient: { async call(...args) { calls.push(args); return { configured: false } } } })
  const send = async (query, body) => {
    const req = Readable.from(body ? [JSON.stringify(body)] : []); Object.assign(req, { method: body ? 'POST' : 'GET', url: '/api/kode/teams/scheduling' + query, headers: { 'content-type': 'application/json' } })
    await route.handler(req, { writeHead(code) { status = code }, end() {} })
  }
  await send('?team_id=team&team_revision=1'); assert.equal(status, 403); kind = 'owner'
  for (const query of ['?team_id=team&team_revision=0', '?team_id=team&team_revision=1&request_id=request', '?team_id=team&request_id=../request']) { await send(query); assert.equal(status, 400) }
  assert.equal(calls.length, 0)
  await send('?team_id=team&team_revision=1'); assert.equal(status, 200); assert.equal(calls[0][0], '/api/v1/messaging/teams/team/scheduling-options/1')
  await send('?team_id=team&request_id=request'); assert.equal(status, 200); assert.equal(calls[1][0], '/api/v1/messaging/teams/team/scheduling-requests/request')
  const command = { request_id: 'configure', team_revision: 1, policy: { id: 'schedule', team_id: 'team', expected_revision: 0, policy: { kind: 'scheduling', targets: {} } } }
  await send('', { team_id: 'team', command }); assert.equal(status, 200)
  assert.deepEqual(calls[2], ['/api/v1/messaging/teams/team/scheduling', command])
  const withPrices = { ...command, internal_prices: { control: { id: 'price' } } }
  await send('', { team_id: 'team', command: withPrices }); assert.equal(status, 200); assert.deepEqual(calls.at(-1)[1], withPrices)
  await send('', { team_id: 'team', command: { ...command, actor: 'owner' } }); assert.equal(status, 400)
})

test('target prices and scheduling references commit atomically and recover after restart', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('scheduling-prices')
  try {
    const call = (path, body) => hub.client.call('/api/v1/messaging/' + path, body)
    const original = await conversationTeam(hub)
    await call('teams', { id: 'priced-team', request_id: 'create', expected_revision: 0, spec: { ...original.spec, budget_policy_id: 'priced-budget', scheduling_policy_id: 'priced-schedule' } })
    const at = Date.now()
    await call('teams/priced-team/budgets', { request_id: 'budget', team_revision: 1, budget: { id: 'priced-allowance', scope: 'team', scope_id: 'priced-team', unit: 'credits', limit: 100, starts_at: at - 1000, ends_at: at + 60000, expected_revision: 0 }, initial_policy: { max_assignment_charge: 10, settlement: 'internal_price' } })
    const policy = structuredClone((await call('team-policies/schedule')).policy)
    policy.targets.control.internal_price_id = 'reviewed-price'
    const price = { id: 'reviewed-price', model: 'model', model_policy: 'requested_model', unit: 'credits', input_per_million: 2, cached_per_million: 1, output_per_million: 3 }
    const command = { request_id: 'priced-setup', team_revision: 1, policy: { id: 'priced-schedule', team_id: 'priced-team', expected_revision: 0, policy }, internal_prices: { control: price }, account_capacities: { account: { account_id: 'account', expected_revision: 1, max_active_assignments: 1 } } }
    for (const change of [value => value.internal_prices.control.model = 'other', value => value.internal_prices.control.unit = 'USD', value => value.internal_prices.control.model_policy = 'admin_attested', value => value.internal_prices.control.id = 'unreferenced']) {
      const invalid = structuredClone(command); change(invalid)
      await assert.rejects(call('teams/priced-team/scheduling', invalid), /price differs/)
    }
    for (const change of [value => value.account_capacities.account.account_id = 'foreign', value => value.account_capacities.account.max_active_assignments = 0, value => value.account_capacities.account.expected_revision = 0]) {
      const invalid = structuredClone(command); change(invalid)
      await assert.rejects(call('teams/priced-team/scheduling', invalid), /capacity/)
      await assert.rejects(call('price-versions/reviewed-price'), /404|Query returned no rows/)
    }
    const invalidPolicy = structuredClone(command); invalidPolicy.policy.policy.minimum_quality = 101
    await assert.rejects(call('teams/priced-team/scheduling', invalidPolicy), /invalid/)
    await assert.rejects(call('price-versions/reviewed-price'), /404|Query returned no rows/)
    await assert.rejects(call('team-policies/priced-schedule'), /404/)
    assert.equal((await call('teams/priced-team/scheduling-requests/priced-setup')).receipt, null)
    const [saved, duplicate] = await Promise.all([call('teams/priced-team/scheduling', command), call('teams/priced-team/scheduling', command)])
    assert.deepEqual(saved, duplicate); assert.equal(saved.internal_prices.label, '内部计价'); assert.equal(saved.internal_prices.provider_invoice, false)
    assert.deepEqual(saved.internal_prices.prices.control, price)
    assert.deepEqual(saved.account_capacities, { scope: 'account_shared_across_teams', capacities: { account: { account_id: 'account', revision: 2, max_active_assignments: 1, held: 0 } } })
    assert.equal((await call('teams/priced-team/scheduling-options/1')).options[0].assignment_capacity.revision, 2)
    await call('assignment-capacities', { account_id: 'account', expected_revision: 2, max_active_assignments: 2 })
    assert.deepEqual(await call('teams/priced-team/scheduling', command), saved)
    assert.equal((await call('assignment-capacities/account')).max_active_assignments, 2, 'historical retry cannot overwrite a newer shared limit')

    assert.equal(saved.policy.policy.targets.control.internal_price_id, price.id)
    assert.deepEqual(await call('price-versions/reviewed-price'), price)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await call('teams/priced-team/scheduling', command), saved)
    const conflict = structuredClone(command); conflict.internal_prices.control.input_per_million++
    await assert.rejects(call('teams/priced-team/scheduling', conflict), /identity conflict/)
    assert.equal((await call('budgets/priced-allowance')).budget.reserved, 0)
    await assert.rejects(call('teams/priced-team/activation'), /404/)
  } finally { await hub.close() }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'

test('team execution policies pin immutable budget and scheduling decisions without spending or admission', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('team-policies')
  try {
    const root = '/api/v1/messaging', path = `${root}/team-policies`
    const worker = await hub.client.call(`${root}/sessions`, { session_id: 'worker', title: 'Worker', runtime: 'external' })
    const fromWorker = hub.client.forSession(worker.owner_token)
    const period = { starts_at: Date.now() - 1000, ends_at: Date.now() + 60000 }
    for (const [id, scope, scope_id] of [['team-budget', 'team', 'team'], ['shared-budget', 'shared', 'owner'], ['foreign-budget', 'team', 'foreign']]) {
      await hub.client.call(`${root}/budgets`, { id, scope, scope_id, unit: 'credits', limit: 100, expected_revision: 0, ...period })
    }
    const budget = { id: 'budget-policy', team_id: 'team', expected_revision: 0,
      policy: { kind: 'budget', budget_ids: ['team-budget', 'shared-budget'], unit: 'credits', max_assignment_charge: 20 } }
    await assert.rejects(fromWorker.call(path, budget), /403/)
    const first = await hub.client.call(path, budget)
    assert.equal(first.revision, 1); assert.equal(first.eligible_for_execution, false)
    assert.equal(first.actor.kind, 'human')
    assert.deepEqual(await hub.client.call(path, { ...budget, policy: { ...budget.policy, budget_ids: [...budget.policy.budget_ids].reverse() } }), first)
    for (const policy of [
      { ...budget.policy, budget_ids: ['missing'] },
      { ...budget.policy, budget_ids: ['foreign-budget'] },
      { ...budget.policy, unit: 'usd' },
      { ...budget.policy, max_assignment_charge: 101 },
      { ...budget.policy, max_assignment_charge: 0 },
      { ...budget.policy, budget_ids: ['team-budget', 'team-budget'] },
    ]) await assert.rejects(hub.client.call(path, { ...budget, id: 'invalid', policy }), /budget/)
    const edits = await Promise.allSettled([30, 40].map(max_assignment_charge => hub.client.call(path, {
      ...budget, expected_revision: 1, policy: { ...budget.policy, max_assignment_charge },
    })))
    assert.equal(edits.filter(r => r.status === 'fulfilled').length, 1)
    assert.match(edits.find(r => r.status === 'rejected').reason.message, /revision conflict/)
    const current = edits.find(r => r.status === 'fulfilled').value
    assert.equal(current.revision, 2); assert.notEqual(current.hash, first.hash)
    assert.deepEqual(await hub.client.call(path, budget), first, 'historical idempotent write cannot roll back current pointer')
    assert.deepEqual(await hub.client.call(`${path}/budget-policy`), current)
    await assert.rejects(hub.client.call(path, { ...budget, expected_revision: 2, team_id: 'foreign' }), /owner and kind/)
    const candidate = { resource: { host: 'host', profile: 'profile', account_id: 'account', account_epoch: 1, binding_revision: 1,
      limit_ids: ['weekly', 'daily'], unknown_quota: 'team_budget' }, capability_id: 'capability', capability_revision: 1, preferred: true }
    const schedule = { id: 'schedule-policy', team_id: 'team', expected_revision: 0, policy: { kind: 'scheduling',
      targets: { fast: candidate, expert: { ...candidate, preferred: false, resource: { ...candidate.resource, profile: 'expert-profile', unknown_quota: 'require_fresh' } } },
      weights: { quality: 100, cost: 50, latency: 20 }, minimum_quality: 60, minimum_confidence: 0.7 } }
    const routing = await hub.client.call(path, schedule)
    assert.equal(routing.eligible_for_execution, false, 'declared resource references are not live discovery')
    const retry = structuredClone(schedule); retry.policy.targets.fast.resource.limit_ids.reverse()
    assert.deepEqual(await hub.client.call(path, retry), routing)
    for (const mutate of [
      s => { s.policy.weights = { quality: 0, cost: 0, latency: 0 } },
      s => { s.policy.minimum_quality = 101 },
      s => { s.policy.minimum_confidence = 1.1 },
      s => { s.policy.targets.fast.resource.limit_ids = []; s.policy.targets.fast.resource.unknown_quota = 'require_fresh' },
      s => { s.policy.targets.fast.capability_revision = 0 },
      s => { s.policy.targets = {} },
    ]) { const invalid = structuredClone(schedule); invalid.id = 'invalid'; mutate(invalid); await assert.rejects(hub.client.call(path, invalid), /invalid/) }
    const budgetOnly = structuredClone(schedule); budgetOnly.id = 'budget-only-schedule'
    budgetOnly.policy.targets.fast.resource.limit_ids = []
    const declaredBudgetOnly = await hub.client.call(path, budgetOnly)
    assert.equal(declaredBudgetOnly.eligible_for_execution, false, 'budget-only declaration is not execution admission')
    assert.deepEqual(declaredBudgetOnly.policy.targets.fast.resource.limit_ids, [])
    assert.equal(declaredBudgetOnly.policy.targets.fast.resource.unknown_quota, 'team_budget')
    await assert.rejects(hub.client.call(path, { ...schedule, id: 'budget-policy', expected_revision: 2 }), /owner and kind/)
    const spec = { name: 'Team', purpose: 'Policy binding test', kind: 'coordinator', workspace_refs: [],
      execution_targets: Object.entries(schedule.policy.targets).map(([id,c]) => ({ id, host_id: c.resource.host, executor_profile_id: c.resource.profile,
        provider_id: 'fixture', model_id: 'configured-model', effort: null, account_binding_id: c.resource.account_id, capability_profile_revision: String(c.capability_revision) })),
      workers: [], coordinator_targets: ['fast'], workflow_pack_refs: [], grant_id: null, budget_policy_id: 'budget-policy', scheduling_policy_id: 'schedule-policy',
      limits: { max_active_assignments: 2, max_active_runs: 1 }, proactive_mode: 'off' }
    let revision = 0
    const checkSpec = async candidate => {
      revision++
      await hub.client.call(`${root}/teams`, { id: 'team', request_id: `edit-${revision}`, expected_revision: revision - 1, spec: candidate })
      return hub.client.call(`${root}/teams/team/revisions/${revision}/workflow-preflight`)
    }
    const configured = await checkSpec(spec)
    assert.equal(configured.execution_policy_bindings_valid, true)
    assert.deepEqual(configured.policies.budget, current)
    assert.deepEqual(configured.policies.scheduling, routing)
    assert.equal(configured.eligible_for_execution, false)
    for (const [mutate, code] of [
      [s => { s.budget_policy_id = null }, 'team_policy_required'],
      [s => { s.budget_policy_id = 'absent' }, 'team_policy_missing'],
      [s => { s.budget_policy_id = 'schedule-policy' }, 'team_policy_identity_mismatch'],
      [s => { s.execution_targets[0].account_binding_id = 'foreign' }, 'target_policy_identity_mismatch'],
      [s => { s.execution_targets.push({ ...s.execution_targets[0], id: 'extra' }) }, 'target_policy_missing'],
      [s => { s.execution_targets = s.execution_targets.filter(t => t.id === 'fast') }, 'target_policy_outside_team'],
    ]) {
      const candidate = structuredClone(spec); mutate(candidate)
      const checked = await checkSpec(candidate)
      assert.equal(checked.execution_policy_bindings_valid, false)
      assert.ok(checked.policy_issues.some(i => i.code === code), JSON.stringify(checked.policy_issues))
    }
    const ledger = await hub.client.call(`${root}/budgets/team-budget`)
    assert.equal(ledger.budget.spent, 0); assert.equal(ledger.budget.reserved, 0)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(`${path}/budget-policy?revision=1`), first)
    assert.deepEqual(await hub.client.call(`${path}/budget-policy`), current)
    assert.deepEqual(await hub.client.call(`${path}/schedule-policy`), routing)
    await assert.rejects(hub.client.call(`${path}/budget-policy?revision=999`), /404/)
    await assert.rejects(fromWorker.call(`${path}/budget-policy`), /403/)
    const internalBudget = await hub.client.call(path, { ...budget, id: 'internal-budget', policy: { ...budget.policy, settlement: 'internal_price' } })
    let pricedRevision = 0
    const pricedSpec = { ...spec, execution_targets: [spec.execution_targets[0]], budget_policy_id: internalBudget.id, scheduling_policy_id: 'priced-schedule' }
    const selectPrice = async price => {
      return hub.client.call(path, { ...schedule, id: 'priced-schedule', expected_revision: pricedRevision++, policy: { ...schedule.policy,
        targets: { fast: { ...candidate, internal_price_id: price } } } })
    }
    await selectPrice('missing-price')
    assert.ok((await checkSpec(pricedSpec)).policy_issues.some(issue => issue.code === 'target_price_missing'))
    const makePrice = (id, model, unit) => hub.client.call(`${root}/price-versions`, { id, model, unit, model_policy: 'requested_model', input_per_million: 1, cached_per_million: 1, output_per_million: 1 })
    await makePrice('wrong-model', 'different-model', 'credits')
    await makePrice('wrong-unit', 'configured-model', 'cents')
    for (const price of ['wrong-model', 'wrong-unit']) {
      await selectPrice(price)
      assert.ok((await checkSpec(pricedSpec)).policy_issues.some(issue => issue.code === 'target_price_identity_mismatch'))
    }
    const version = await makePrice('configured-price', 'configured-model', 'credits')
    const priced = await selectPrice(version.id)
    assert.ok((await checkSpec({ ...pricedSpec, budget_policy_id: 'budget-policy' })).policy_issues.some(issue => issue.code === 'target_price_settlement_mismatch'))
    const ready = await checkSpec(pricedSpec)
    assert.equal(ready.execution_policy_bindings_valid, true)
    assert.equal(ready.policies.scheduling.policy.targets.fast.internal_price_id, version.id)
    await assert.rejects(makePrice(version.id, 'different-model', 'credits'), /immutable/)
    await assert.rejects(hub.client.call(path, { ...schedule, id: 'bad-price', policy: { ...schedule.policy, targets: { fast: { ...candidate, internal_price_id: '../price' } } } }), /invalid scheduling candidate/)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(`${path}/priced-schedule`), priced)
    assert.equal((await hub.client.call(`${root}/budgets/team-budget`)).budget.reserved, 0, 'configuration does not reserve or spend')

  } finally { await hub.close() }
})

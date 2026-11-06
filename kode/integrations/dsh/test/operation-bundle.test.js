import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'

test('atomic operation bundles roll back partial preparation and retry the same fully funded operation', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('operation-bundle')
  try {
    const root = '/api/v1/messaging', path = `${root}/operation-bundles`, at = Date.now()
    const registration = await hub.client.call(`${root}/sessions`, { session_id: 'worker', title: 'Worker', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    await hub.client.call(`${root}/resource-accounts`, { id: 'account', expected_epoch: 0, enabled: true })
    await hub.client.call(`${root}/resource-bindings`, { host: hub.node, profile: 'profile', account_id: 'account', account_epoch: 1, expected_revision: 0 })
    for (const [id,limit] of [['budget',25],['small',5]]) await hub.client.call(`${root}/budgets`, {
      id, scope: 'team', scope_id: 'team', unit: 'credits', limit, starts_at: at - 1000, ends_at: at + 60000, expected_revision: 0,
    })
    const target = { host: hub.node, workspace: 'workspace', root: '/srv/fixture' }
    await hub.client.call(`${root}/team-grants`, { expected_revision: 0, policy: { id: 'grant', team_id: 'team', enabled: true,
      expires_at: at + 60000, targets: [target], capabilities: ['read'], tools: [], network: false, budget_ids: ['budget', 'small'] } })
    const request = { owner_session: 'owner', request_key: 'bundle', worker: { node_id: hub.node, session_id: 'worker' },
      selection_policy: { profile_revision: '1', model: 'fixture-model', effort: null, scope: 'executor_configuration' },
      funding: { budget_ids: ['budget'], amount: 10, unit: 'credits' },
      resource: { host: hub.node, profile: 'profile', account_id: 'account', account_epoch: 1, binding_revision: 1, limit_ids: ['daily'], unknown_quota: 'team_budget' },
      grant_id: 'grant', grant_scope: { team_id: 'team', revision: 1, target, capabilities: ['read'], tools: [], network: false, budget_ids: ['budget','small'] } }
    await assert.rejects(worker.call(path, request), /403/)
    let i = 0
    for (const [mutate,error] of [
      [r => { r.funding.budget_ids = ['budget','small'] }, /insufficient team budget/],
      [r => { r.grant_scope.tools = ['forbidden'] }, /tool_denied/],
      [r => { r.resource.account_epoch = 2 }, /binding_unavailable/],
    ]) {
      const bad = structuredClone(request); bad.request_key = `bad-${i++}`; mutate(bad)
      await assert.rejects(hub.client.call(path, bad), error)
      assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved, 0)
      assert.equal((await hub.client.call(`${root}/budgets/budget/reservations`)).reservations.length, 0, 'no ghost reservation survives partial preparation')
      const legacy = await hub.client.call(`${root}/operations`, { owner_session: bad.owner_session, request_key: bad.request_key, worker: bad.worker,
        selection_policy: bad.selection_policy, budget_required: true, resource_required: true, grant_required: true })
      assert.equal(legacy.revision, 1, 'failed bundle did not leave a partly attached operation')
      assert.deepEqual((await hub.client.call(`${root}/operations/${legacy.id}/events`)).events.map(e => e.data.kind), ['prepared'])
      await assert.rejects(hub.client.call(path, bad), /outside atomic bundle/, 'bundle cannot adopt unrelated legacy operation')
    }
    const [first,retry] = await Promise.all([hub.client.call(path,request),hub.client.call(path,request)])
    assert.deepEqual(first,retry)
    assert.equal(first.dispatch_state,'not_dispatched')
    assert.equal(first.operation.revision,4)
    assert.equal(first.resource_decision.requires_team_budget,true, 'missing provider quota is explicit')
    assert.equal(first.reservation.request.operation_id,first.operation.id)
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved,10)
    assert.equal((await hub.client.call(`${root}/budgets/budget/reservations`)).reservations.length,1)
    await assert.rejects(hub.client.call(path,{...request,funding:{...request.funding,amount:11}}),/identity conflict/)
    const fundingRace = await Promise.allSettled(['left','right'].map(request_key => hub.client.call(path,{...request,request_key})))
    assert.equal(fundingRace.filter(r=>r.status==='fulfilled').length,1)
    assert.match(fundingRace.find(r=>r.status==='rejected').reason.message,/insufficient team budget/)
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved,20)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(path,request),first)
    assert.equal((await hub.client.call(`${root}/budgets/budget/reservations`)).reservations.length,2)
    const op = await hub.client.call(`${root}/operations/${first.operation.id}`)
    assert.equal(op.grant_available,true); assert.equal(op.budget_available,true); assert.equal(op.resource_available,true)
    const claim = await worker.call(`${root}/operations/${op.id}`, { attempt:op.attempt,epoch:op.epoch,expected_revision:op.revision,
      selection_ack: request.selection_policy, action:{ kind:'claim_resource',lease_ms:3000,resource:{profile:'profile',account_epoch:1,binding_revision:1} } })
    assert.equal(claim.operation.state,'active')
    assert.deepEqual(await hub.client.call(path,request),first,'historical preparation receipt cannot rewind active operation')
    assert.equal((await hub.client.call(`${root}/operations/${op.id}`)).state,'active')
    const abandon = (bundle, command) => hub.client.call(`${path}/${bundle.operation.id}/abandon`, command)
    await assert.rejects(abandon(first, { request_id: 'active', expected_revision: claim.operation.revision }), /never-claimed/)
    const unclaimed = fundingRace.find(r => r.status === 'fulfilled').value
    const release = { request_id: 'abandon', expected_revision: unclaimed.operation.revision }
    await assert.rejects(worker.call(`${path}/${unclaimed.operation.id}/abandon`, release), /403/)
    const released = await Promise.all([abandon(unclaimed, release), abandon(unclaimed, release)])
    assert.deepEqual(released[0], released[1])
    assert.equal(released[0].operation.state, 'stopped')
    assert.equal(released[0].operation.epoch, unclaimed.operation.epoch + 1)
    assert.equal(released[0].reservation.finalized, true); assert.equal(released[0].reservation.held, 0)
    assert.equal(released[0].stop_basis, 'never_claimed')
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved, 10)
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.spent, 0)
    await assert.rejects(abandon(unclaimed, { ...release, expected_revision: release.expected_revision + 1 }), /identity conflict/)
    await assert.rejects(abandon(unclaimed, { ...release, request_id: 'different' }), /never-claimed/)
    const observed = await hub.client.call(path, { ...request, request_key: 'observed' })
    await hub.client.call(`${root}/budget-reservations/${observed.reservation.request.id}/settle`, { event_id: 'observation', expected_revision: 1, total_charge: 0, finalized: false, basis: 'reported' })
    await assert.rejects(abandon(observed, { request_id: 'unsafe-release', expected_revision: observed.operation.revision }), /accounting activity/)
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved, 20)
    const competing = await hub.client.call(path, { ...request, request_key: 'claim-race', funding: { ...request.funding, amount: 5 } })
    const competingOp = competing.operation
    const cancelRace = await Promise.allSettled([
      abandon(competing, { request_id: 'race', expected_revision: competingOp.revision }),
      worker.call(`${root}/operations/${competingOp.id}`, { attempt: competingOp.attempt, epoch: competingOp.epoch, expected_revision: competingOp.revision,
        selection_ack: request.selection_policy, action: { kind: 'claim_resource', lease_ms: 3000, resource: { profile: 'profile', account_epoch: 1, binding_revision: 1 } } }),
    ])
    assert.equal(cancelRace.filter(r => r.status === 'fulfilled').length, 1, 'claim and never-claimed release cannot both win')
    const live = await hub.client.call(`${root}/operations/${competingOp.id}`)
    assert.ok(['active','stopped'].includes(live.state))
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved, live.state === 'stopped' ? 20 : 25)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await abandon(unclaimed, release), released[0])
    assert.deepEqual(await hub.client.call(path, { ...request, request_key: unclaimed.operation.request_key }), unclaimed)
    assert.equal((await hub.client.call(`${root}/operations/${unclaimed.operation.id}`)).state, 'stopped')
    const events = (await hub.client.call(`${root}/operations/${unclaimed.operation.id}/events`)).events
    assert.equal(events.filter(e => e.data.kind === 'bundle_abandoned').length, 1)

  } finally { await hub.close() }
})

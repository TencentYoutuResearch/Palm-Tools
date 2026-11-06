import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
import { teamOwnerHttp } from './support/team-owner-http.js'
import { OFFICIAL_BUILDER_TOOLS } from '../src/official-builder-tools.js'

test('owner Builder close status explains durable missing usage without releasing its reservation', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('builder-accounting-diagnostic')
  let ownerHttp
  try {
    const call = (path, body) => hub.client.call(`/api/v1/messaging/${path}`, body)
    const at = Date.now()
    const registration = await call('sessions', { session_id: 'builder', title: 'Builder', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    await call('resource-accounts', { id: 'account', expected_epoch: 0, enabled: true })
    await call('resource-bindings', { host: hub.node, profile: 'profile', account_id: 'account', account_epoch: 1, expected_revision: 0 })
    await call('budgets', { id: 'creation', scope: 'team', scope_id: 'builder', unit: 'credits', limit: 30, starts_at: at - 1000, ends_at: at + 60000, expected_revision: 0 })
    const target = { host: hub.node, workspace: 'fixture', root: '/fixture' }
    const grantScope = { team_id: 'builder', revision: 1, target, capabilities: ['read', 'builder_draft_write'], tools: [...OFFICIAL_BUILDER_TOOLS], network: false, budget_ids: ['creation'] }
    await call('team-grants', { expected_revision: 0, policy: { id: 'grant', team_id: 'builder', enabled: true, expires_at: at + 60000, targets: [target], capabilities: grantScope.capabilities, tools: grantScope.tools, network: false, budget_ids: ['creation'] } })
    await call('price-versions', { id: 'price', model: 'model', model_policy: 'requested_model', unit: 'credits', input_per_million: 1000000, cached_per_million: 1000000, output_per_million: 1000000 })
    await call('superagents/drafts', { id: 'draft', request_id: 'create', expected_revision: 0, revoked: false, interview: { purpose: 'Create a team', workspace_refs: [{ host_id: hub.node, workspace_id: 'fixture', root_ref: '/fixture' }], answers: {}, questions: [], proposed_team: null } })
    const start = { draft_id: 'draft', draft_revision: 1, price_id: 'price', operation: {
      owner_session: 'owner', request_key: 'start', worker: { node_id: hub.node, session_id: 'builder' },
      selection_policy: { profile_revision: 'a'.repeat(64), model: 'model', effort: null, scope: 'executor_configuration' },
      funding: { budget_ids: ['creation'], amount: 10, unit: 'credits' },
      resource: { host: hub.node, profile: 'profile', account_id: 'account', account_epoch: 1, binding_revision: 1, limit_ids: ['daily'], unknown_quota: 'team_budget' },
      grant_id: 'grant', grant_scope: grantScope,
    } }
    const started = await call('superagents/builder-starts', start)
    const operation = started.bundle.operation
    const reservation = (await call(`operations/${operation.id}/budget?attempt=1`)).reservation
    const claimed = await worker.call(`/api/v1/messaging/operations/${operation.id}`, {
      attempt: 1, epoch: 1, expected_revision: operation.revision, selection_ack: start.operation.selection_policy,
      action: { kind: 'claim_resource', lease_ms: 3000, resource: { profile: 'profile', account_epoch: 1, binding_revision: 1 } },
    })
    await call('official-calls', { call_id: 'missing-usage-call', operation_id: operation.id, attempt: 1, epoch: claimed.operation.epoch, worker_session: 'builder', provider: 'fixture', model: 'model' })
    await call('official-calls/missing-usage-call/events', { sequence: 1, kind: 'usage', usage: null, reason: 'missing_usage' })

    const runtime = { host: hub.node, client: { call: (...args) => hub.client.call(...args) } }
    const ctx = { get: name => name === 'kodeAgents' ? { officialLoops: { execution: runtime } } : undefined }
    ownerHttp = await teamOwnerHttp(ctx, runtime.client)
    const statusPath = `builder/close?operation_id=${encodeURIComponent(operation.id)}`
    assert.equal((await ownerHttp.get(statusPath, false)).status, 401, 'diagnostic requires an authenticated owner')
    const inFlight = await ownerHttp.get(statusPath)
    assert.equal(inFlight.body.accounting.state, 'pending', 'a nonterminal call may still report usage')
    assert.equal(inFlight.body.accounting.reason, 'official_call_not_terminal')
    assert.equal('retryable' in inFlight.body.accounting, false)
    await call('official-calls/missing-usage-call/events', { sequence: 2, kind: 'finished', usage: null, reason: 'missing_usage' })
    const diag = await ownerHttp.get(statusPath)
    assert.equal(diag.status, 200)
    assert.equal(diag.body.accounting.state, 'waiting_accounting')
    assert.equal(diag.body.accounting.reason, 'needs_reconciliation')
    assert.equal(diag.body.accounting.retryable, false)
    assert.deepEqual(diag.body.accounting.unresolved_calls, [{ call_id: 'missing-usage-call', state: 'finished', accounting_status: 'usage_unresolved' }])
    assert.deepEqual(diag.body.accounting.budget, { reservation_id: reservation.request.id, unit: 'credits', charged: 0, held: 10, finalized: false, frozen: true })
    assert.equal('session_id' in diag.body.accounting.unresolved_calls[0], false)

    const unrelated = await call('operations', { owner_session: 'owner', request_key: 'not-builder', worker: { node_id: hub.node, session_id: 'other' }, budget_required: false })
    assert.equal((await ownerHttp.get(`builder/close?operation_id=${encodeURIComponent(unrelated.id)}`)).status, 404, 'owner proxy enforces Builder/Home scope')

    const evidence = { record_id: 'selection', operation_id: operation.id, worker_session: 'builder', attempt: 1,
      epoch: claimed.operation.epoch, profile_revision: start.operation.selection_policy.profile_revision, thread_id: 'thread', turn_id: 'turn', input_ids: ['input'],
      scope: 'executor_configuration', observed_at: Date.now(), rejected: false,
      model: { requested: 'model', observed: 'model', status: 'reported', source: 'fixture' },
      effort: { requested: null, observed: null, status: 'unverifiable', source: null } }
    await call('selection-evidence', evidence)
    const before = await call(`operations/${operation.id}`)
    const reported = (await call(`operations/${operation.id}`, { attempt: 1, epoch: before.epoch, expected_revision: before.revision,
      action: { kind: 'report', report_id: 'returned', content: 'Creation turn returned' } })).operation
    const accounting = await ownerHttp.request('POST', 'builder/accounting', { body: { operation_id: operation.id, command: {
      request_id: 'final', attempt: 1, epoch: reported.epoch, expected_revision: reported.revision, price_id: 'price', settlement: 'internal_price',
    } } })
    assert.equal(accounting.status, 409)
    assert.equal(accounting.body.state, 'waiting_accounting')
    assert.equal(accounting.body.reason, 'needs_reconciliation')
    assert.equal(accounting.body.retryable, false)
    assert.equal((await call('budgets/creation')).budget.reserved, 10)

    await hub.stop('SIGKILL')
    await hub.start()
    const recovered = await ownerHttp.get(statusPath)
    assert.equal(recovered.status, 200)
    assert.deepEqual(recovered.body.accounting, diag.body.accounting, 'Home restart preserves owner diagnostic and held reservation facts')
    assert.equal((await call('budgets/creation')).budget.reserved, 10)
  } finally {
    await ownerHttp?.close()
    await hub.close()
  }
})

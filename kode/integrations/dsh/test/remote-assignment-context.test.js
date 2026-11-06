import { assignmentHomeCall } from '../src/assignment-home.js'
/** Actual paired Hubs, owner-scoped context relay; no Worker execution. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub, pairHubs } from './support/isolated-hub.js'
test('remote Assignment context, admission and creation stay home-owned and execution-Host scoped', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('assignment-home'), remote = await isolatedHub('assignment-worker')
  try {
    await pairHubs(hub, remote)
    const root = '/api/v1/messaging', path = `${root}/teams/team/activation`, runs = `${root}/work-runs`
    const versionRef = r => ({ id: r.id, version: r.version, hash: r.hash })
    const policyRef = r => ({ id: r.id, revision: r.revision, hash: r.hash })
    const workspace = { host_id: remote.node, workspace_id: 'workspace', root_ref: '/srv/fixture' }
    const workflow = await hub.client.call(`${root}/workflows`, { id: 'flow', version: '1', inputs: ['request'],
      stages: [{ id: 'inspect', role: 'coordinator', requires: ['request'], produces: ['artifact'], independent_from: [], execution: { task_tag: 'inspection', repository_binding: 'code', capabilities: ['read'], tools: ['kode_artifact_capture'], network: false } },
        { id: 'followup', role: 'coordinator', requires: ['inspect'], produces: ['later'], independent_from: [], execution: { task_tag: 'inspection', repository_binding: 'code', capabilities: ['read'], tools: ['kode_artifact_capture'], network: false } }],
      completion_stages: ['followup'], evidence_rules: { artifact: { kind: 'artifact', repository_binding: 'code' }, later: { kind: 'artifact', repository_binding: 'code' } } })
    const project = await hub.client.call(`${root}/project-configs`, { id: 'project', version: '1', spec: { kind: 'project_bindings',
      repositories: { code: { repository_id: 'repository', workspace } }, environments: {}, commands: {}, connections: {} } })
    const delivery = await hub.client.call(`${root}/project-configs`, { id: 'delivery', version: '1', spec: { kind: 'delivery_policy',
      workflow: versionRef(workflow), project: versionRef(project), targets: [{ kind: 'local', repository_binding: 'code' }], required_outputs: ['artifact'] } })
    await hub.client.call(`${root}/budgets`, { id: 'budget', scope: 'team', scope_id: 'team', unit: 'credits', limit: 100,
      starts_at: Date.now() - 1000, ends_at: Date.now() + 60000, expected_revision: 0 })
    const budgetCommand = { id: 'budget-policy', team_id: 'team', expected_revision: 0,
      policy: { kind: 'budget', budget_ids: ['budget'], unit: 'credits', max_assignment_charge: 10 } }
    const budget = await hub.client.call(`${root}/team-policies`, budgetCommand)
    const schedule = await hub.client.call(`${root}/team-policies`, { id: 'schedule-policy', team_id: 'team', expected_revision: 0,
      policy: { kind: 'scheduling', targets: { target: { resource: { host: remote.node, profile: 'profile', account_id: 'account', account_epoch: 1,
        binding_revision: 1, limit_ids: ['daily'], unknown_quota: 'team_budget' }, capability_id: 'capability', capability_revision: 1, preferred: false } },
      weights: { quality: 100, cost: 50, latency: 20 }, minimum_quality: 60, minimum_confidence: 0.7 } })
    const spec = { name: 'Team', purpose: 'Fixture', kind: 'coordinator', workspace_refs: [workspace],
      execution_targets: [{ id: 'target', host_id: remote.node, executor_profile_id: 'profile', executor_profile_revision: 'f'.repeat(64), provider_id: 'fixture', model_id: 'model', effort: null,
        account_binding_id: 'account', capability_profile_revision: '1' }], workers: [], coordinator_targets: ['target'], workflow_pack_refs: [versionRef(workflow)],
      delivery_bindings: [{ id: 'local', workflow: versionRef(workflow), project: versionRef(project), delivery_policy: versionRef(delivery) }],
      grant_id: 'grant', budget_policy_id: 'budget-policy', scheduling_policy_id: 'schedule-policy',
      limits: { max_active_assignments: 2, max_active_runs: 8 }, proactive_mode: 'off' }
    await hub.client.call(`${root}/teams`, { id: 'team', request_id: 'new', expected_revision: 0, spec })
    const grantCommand = { expected_revision: 0, policy: { id: 'grant', team_id: 'team', enabled: true, expires_at: Date.now() + 60000,
      targets: [{ host: remote.node, workspace: 'workspace', root: '/srv/fixture' }], capabilities: ['read'], tools: ['kode_artifact_capture'], network: false, budget_ids: ['budget'] } }
    let grant = (await hub.client.call(`${root}/team-grants`, grantCommand)).grant
    const request = { id: 'before', request_id: 'before', team_id: 'team', team_revision: 1, binding_id: 'local', inputs: { request: 'Inspect' }, prior_run_id: null }
    const initial = await hub.client.call(runs, request)
    const command = { action: 'activate', request_id: 'activate', expected_revision: 0, team_revision: 1, grant_revision: grant.revision,
      budget_policy: policyRef(budget), scheduling_policy: policyRef(schedule) }

    await assert.rejects(hub.client.call(path, command), /capacity not configured/)
    await hub.client.call(`${root}/resource-accounts`, { id: 'account', expected_epoch: 0, enabled: true })
    await hub.client.call(`${root}/assignment-capacities`, { account_id: 'account', expected_revision: 0, max_active_assignments: 1 })
    await hub.client.call(path, command)
    const preparePath = `${runs}/before/stages/inspect/assignments`
    const prepare = { request_id: 'prepare', expected_revision: 2, target_id: 'target', worker_id: null }
    await assert.rejects(hub.client.call(preparePath, prepare), /not recommended/)
    assert.equal((await hub.client.call(`${runs}/before`)).revision, 2)
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved, 0)
    await hub.client.call(`${root}/resource-bindings`, { host: remote.node, profile: 'profile', account_id: 'account', account_epoch: 1, expected_revision: 0 })
    const at = Date.now()
    await hub.client.call(`${root}/capability-profiles`, { id: 'capability', expected_revision: 0, host: remote.node, profile: 'profile', model: 'model', assessments: {
      fit: { evaluation: { kind: 'task_fit', tag: 'inspection', score: 80 }, source: 'user', confidence: 0.9, evidence: [], pinned: false, updated_at: at - 1000, valid_until: at + 60000 },
    } })
    const [first, retry] = await Promise.all([hub.client.call(preparePath,prepare),hub.client.call(preparePath,prepare)])
    assert.deepEqual(first,retry); assert.equal(first.run_revision,3)
    const assignment=first.assignment, op=assignment.bundle.operation
    assert.equal(assignment.dispatch.command.operation.home_node, hub.node)
    assert.equal(assignment.state,'prepared'); assert.equal(assignment.dispatch.state,'blocked')
    assert.equal(assignment.stage_attempt,1); assert.equal(assignment.context_hash,initial.context_hash)
    assert.equal(assignment.dispatch.command.session_id,assignment.worker.session_id)
    assert.deepEqual(assignment.dispatch.command.tools,['kode_artifact_capture'])
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved,10)

    const route = `${root}/operation-accounting-relay/${hub.node}`
    const envelope = { operation_id: op.id, worker_session: assignment.worker.session_id, command: null,
      accounting: { attempt: op.attempt, action: { kind: 'assignment_context', assignment_id: assignment.id } } }
    const hostScope = { id: assignment.id, host: remote.node, worker: assignment.worker.session_id, operation: { ...op, home_node: hub.node } }
    assert.deepEqual(await assignmentHomeCall(remote.client, hostScope, 'context'), assignment)
    assert.deepEqual(await assignmentHomeCall(remote.client, hostScope, 'run_context'), await hub.client.call(`${runs}/before`))
    const runEnvelope = { ...envelope, accounting: { ...envelope.accounting, action: { kind: 'assignment_run_context', assignment_id: assignment.id } } }
    await assert.rejects(remote.client.call(route, { ...runEnvelope, worker_session: 'foreign' }), /foreign remote operation/)
    await assert.rejects(remote.client.call(route, { ...runEnvelope, accounting: { ...runEnvelope.accounting, attempt: 2 } }), /foreign Assignment/)
    const registered = await remote.client.call(`${root}/sessions`, { session_id: assignment.worker.session_id, title: 'Worker', runtime: 'external' })
    const questionRead = { ...envelope, accounting: { ...envelope.accounting, action: { kind: 'assignment_clarification_read', assignment_id: assignment.id, request_id: 'question' } } }
    assert.deepEqual(await remote.client.call(route, questionRead), { clarification: null })
    await assert.rejects(remote.client.forSession(registered.owner_token).call(route, questionRead), /403/)
    await assert.rejects(remote.client.call(route, { ...questionRead, worker_session: 'foreign' }), /foreign remote operation/)
    await assert.rejects(remote.client.call(route, { ...questionRead, accounting: { ...questionRead.accounting, attempt: 2 } }), /foreign Assignment/)
    await assert.rejects(remote.client.forSession(registered.owner_token).call(route, envelope), /403/)
    await assert.rejects(remote.client.forSession(registered.owner_token).call(route, runEnvelope), /403/)
    await assert.rejects(remote.client.call(route, { ...envelope, worker_session: 'foreign' }), /foreign remote operation/)
    await assert.rejects(remote.client.call(route, { ...envelope, accounting: { ...envelope.accounting, attempt: 2 } }), /foreign Assignment/)
    const other = await hub.client.call(`${root}/operations`, { owner_session: 'owner', request_key: 'other', worker: assignment.worker })
    await assert.rejects(remote.client.call(route, { ...envelope, operation_id: other.id }), /foreign Assignment/)
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved, 10)
    assert.equal((await hub.client.call(`${root}/operations/${op.id}`)).state, 'prepared')
    await assert.rejects(remote.client.call(`${root}/work-assignments/${assignment.id}`), /404/)
    const creation = { ...envelope, accounting: { attempt: op.attempt, action: { kind: 'assignment_creation', assignment_id: assignment.id,
      receipt: { request_id: 'remote-uncertain', command: assignment.dispatch.command, state: 'uncertain' } } } }
    await assert.rejects(remote.client.forSession(registered.owner_token).call(route, creation), /403/)
    await assert.rejects(remote.client.call(route, { ...creation, worker_session: 'foreign' }), /foreign remote operation/)
    await assert.rejects(hub.client.call(`${root}/work-assignments/${assignment.id}/creation`, creation.accounting.action.receipt), /foreign Assignment creation Host/)
    await assert.rejects(async () => { await remote.client.call(route, creation); throw new Error('fixture lost committed creation response') }, /lost committed creation response/)
    const receipts = await Promise.all([remote.client.call(route, creation), remote.client.call(route, creation)])
    assert.deepEqual(receipts[0], receipts[1]); assert.equal(receipts[0].state, 'uncertain')
    const changed = structuredClone(creation); changed.accounting.action.receipt.state = 'created'
    await assert.rejects(remote.client.call(route, changed), /identity conflict/)
    changed.accounting.action.receipt.request_id = 'remote-created'
    await assert.rejects(remote.client.call(route, changed), /no Host admission/)
    const forged = structuredClone(creation); forged.accounting.action.receipt.request_id = 'forged'
    forged.accounting.action.receipt.command.session_id = 'different'
    await assert.rejects(remote.client.call(route, forged), /command mismatch/)
    let current = await remote.client.call(route, envelope)
    assert.equal(current.revision, assignment.revision + 1)
    assert.equal(current.creation.state, 'uncertain')
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved, 10)
    const dispatch = assignment.dispatch.command
    const admit = { request_id: 'remote-admit', expected_revision: current.revision, worker_session: assignment.worker.session_id,
      profile_revision: dispatch.profile_revision, provider: dispatch.provider, model: dispatch.model, effort: dispatch.effort,
      tools: dispatch.tools, root: dispatch.cwd }
    const admission = { ...envelope, accounting: { attempt: op.attempt, action: { kind: 'assignment_admission', assignment_id: assignment.id, admission: admit } } }
    await assert.rejects(remote.client.call(route, admission), /resource holds missing/)
    await hub.client.call(`${root}/work-assignments/${assignment.id}/resources`, { request_id: 'hold', expected_revision: current.revision })
    current = await remote.client.call(route, envelope); admit.expected_revision = current.revision
    await assert.rejects(hub.client.call(`${root}/work-assignments/${assignment.id}/admit`, admit), /Host identity required/)
    await assert.rejects(remote.client.forSession(registered.owner_token).call(route, admission), /403/)
    const mismatch = structuredClone(admission); mismatch.accounting.action.admission.root = '/srv/foreign'
    await assert.rejects(remote.client.call(route, mismatch), /executor evidence mismatch/)
    const admitted = await assignmentHomeCall(remote.client, hostScope, 'admission', admit)
    assert.equal(admitted.admission.kind, 'official_remote_host')
    assert.equal(admitted.admission.inference_verified, false)
    assert.deepEqual(await remote.client.call(route, admission), admitted)
    await assert.rejects(remote.client.call(route, changed), /no claimed operation/)
    const claimed = await remote.client.forSession(registered.owner_token).call(`${root}/operation-relay/${hub.node}`, {
      operation_id: op.id, worker_session: assignment.worker.session_id,
      command: { attempt: op.attempt, epoch: op.epoch, expected_revision: op.revision, selection_ack: op.selection_policy,
        action: { kind: 'claim_resource', lease_ms: 60000, resource: { profile: 'profile', account_epoch: 1, binding_revision: 1 } } } })
    assert.equal(claimed.operation.state, 'active')
    const created = await assignmentHomeCall(remote.client, hostScope, 'creation', changed.accounting.action.receipt)
    assert.equal(created.state, 'created')
    const downgrade = structuredClone(creation); downgrade.accounting.action.receipt.request_id = 'downgrade'
    await assert.rejects(remote.client.call(route, downgrade), /cannot downgrade/)
    current = await remote.client.call(route, envelope)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await remote.client.call(route, creation), receipts[0])
    assert.deepEqual(await remote.client.call(route, envelope), current)
    assert.deepEqual(await remote.client.call(route, runEnvelope), await hub.client.call(`${runs}/before`))
    const audit = await hub.client.call(`${runs}/before/events`)
    const events = audit.events.filter(e => e.data.kind === 'assignment_creation_receipt')
    assert.equal(events.length, 2); assert.ok(events.every(e => e.data.actor.id === remote.node))
    assert.deepEqual(await remote.client.call(route, admission), admitted)
    assert.deepEqual(await remote.client.call(route, changed), created)
    const admissions = audit.events.filter(e => e.data.kind === 'assignment_host_admitted')
    assert.equal(admissions.length, 1); assert.equal(admissions[0].data.actor.id, remote.node)
  } finally { await hub.close(); await remote.close() }
})

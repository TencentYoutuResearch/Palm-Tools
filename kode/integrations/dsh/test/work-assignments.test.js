import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
test('stage assignments atomically reserve, fence dispatch, abandon and retain immutable retry receipts', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('work-assignment')
  try {
    const root = '/api/v1/messaging', path = `${root}/teams/team/activation`, runs = `${root}/work-runs`
    const versionRef = r => ({ id: r.id, version: r.version, hash: r.hash })
    const policyRef = r => ({ id: r.id, revision: r.revision, hash: r.hash })
    const workspace = { host_id: hub.node, workspace_id: 'workspace', root_ref: '/srv/fixture' }
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
      policy: { kind: 'scheduling', targets: { target: { resource: { host: hub.node, profile: 'profile', account_id: 'account', account_epoch: 1,
        binding_revision: 1, limit_ids: ['daily'], unknown_quota: 'team_budget' }, capability_id: 'capability', capability_revision: 1, preferred: false } },
      weights: { quality: 100, cost: 50, latency: 20 }, minimum_quality: 60, minimum_confidence: 0.7 } })
    const spec = { name: 'Team', purpose: 'Fixture', kind: 'coordinator', workspace_refs: [workspace],
      execution_targets: [{ id: 'target', host_id: hub.node, executor_profile_id: 'profile', executor_profile_revision: 'f'.repeat(64), provider_id: 'fixture', model_id: 'model', effort: null,
        account_binding_id: 'account', capability_profile_revision: '1' }], workers: [], coordinator_targets: ['target'], workflow_pack_refs: [versionRef(workflow)],
      delivery_bindings: [{ id: 'local', workflow: versionRef(workflow), project: versionRef(project), delivery_policy: versionRef(delivery) }],
      grant_id: 'grant', budget_policy_id: 'budget-policy', scheduling_policy_id: 'schedule-policy',
      limits: { max_active_assignments: 2, max_active_runs: 8 }, proactive_mode: 'off' }
    await hub.client.call(`${root}/teams`, { id: 'team', request_id: 'new', expected_revision: 0, spec })
    const grantCommand = { expected_revision: 0, policy: { id: 'grant', team_id: 'team', enabled: true, expires_at: Date.now() + 60000,
      targets: [{ host: hub.node, workspace: 'workspace', root: '/srv/fixture' }], capabilities: ['read'], tools: ['kode_artifact_capture'], network: false, budget_ids: ['budget'] } }
    let grant = (await hub.client.call(`${root}/team-grants`, grantCommand)).grant
    const request = { id: 'before', request_id: 'before', team_id: 'team', team_revision: 1, binding_id: 'local', inputs: { request: 'Inspect' }, prior_run_id: null }
    const initial = await hub.client.call(runs, request)
    const command = { action: 'activate', request_id: 'activate', expected_revision: 0, team_revision: 1, grant_revision: grant.revision,
      budget_policy: policyRef(budget), scheduling_policy: policyRef(schedule) }

    await assert.rejects(hub.client.call(path, command), /capacity not configured/)
    await hub.client.call(`${root}/resource-accounts`, { id: 'account', expected_epoch: 0, enabled: true })
    await hub.client.call(`${root}/assignment-capacities`,{account_id:'account',expected_revision:0,max_active_assignments:1})
    await hub.client.call(path, command)
    const preparePath = `${runs}/before/stages/inspect/assignments`
    const prepare = { request_id: 'prepare', expected_revision: 2, target_id: 'target', worker_id: null }
    await assert.rejects(hub.client.call(preparePath, prepare), /not recommended/)
    assert.equal((await hub.client.call(`${runs}/before`)).revision, 2)
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved, 0)
    await hub.client.call(`${root}/resource-bindings`, { host: hub.node, profile: 'profile', account_id: 'account', account_epoch: 1, expected_revision: 0 })
    const at = Date.now()
    await hub.client.call(`${root}/capability-profiles`, { id: 'capability', expected_revision: 0, host: hub.node, profile: 'profile', model: 'model', assessments: {
      fit: { evaluation: { kind: 'task_fit', tag: 'inspection', score: 80 }, source: 'user', confidence: 0.9, evidence: [], pinned: false, updated_at: at - 1000, valid_until: at + 60000 },
    } })
    const [first, retry] = await Promise.all([hub.client.call(preparePath,prepare),hub.client.call(preparePath,prepare)])
    assert.deepEqual(first,retry); assert.equal(first.run_revision,3)
    const assignment=first.assignment, op=assignment.bundle.operation
    assert.equal(assignment.state,'prepared'); assert.equal(assignment.dispatch.state,'blocked')
    assert.equal(assignment.stage_attempt,1); assert.equal(assignment.context_hash,initial.context_hash)
    assert.equal(assignment.dispatch.command.session_id,assignment.worker.session_id)
    assert.deepEqual(assignment.dispatch.command.tools,['kode_artifact_capture'])
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved,10)
    const resources = `${root}/work-assignments/${assignment.id}/resources`, resourceCommand = { request_id: 'resources', expected_revision: 1 }
    assert.equal((await hub.client.call(`${root}/work-assignments/${assignment.id}`)).revision,1)
    const [hold,holdRetry]=await Promise.all([hub.client.call(resources,resourceCommand),hub.client.call(resources,resourceCommand)])
    assert.deepEqual(hold,holdRetry); assert.equal(hold.resources.state,'held')
    assert.equal((await hub.client.call(`${root}/assignment-capacities/account`)).held,1)
    await assert.rejects(hub.client.call(resources,{...resourceCommand,request_id:'different'}),/identity conflict/)

    const registration=await hub.client.call(`${root}/sessions`,{session_id:assignment.worker.session_id,title:'Worker',runtime:'external'})
    const worker=hub.client.forSession(registration.owner_token)
    await assert.rejects(worker.call(preparePath,{...prepare,request_id:'intruder'}),/403/)
    await assert.rejects(worker.call(resources,resourceCommand),/403/)
    await assert.rejects(worker.call(`${root}/assignment-capacities`,{account_id:'account',expected_revision:1,max_active_assignments:2}),/403/)
    await assert.rejects(worker.call(`${root}/work-assignments/${assignment.id}`),/403/)
    await assert.rejects(worker.call(`${root}/operations/${op.id}`, {attempt:op.attempt,epoch:op.epoch,expected_revision:op.revision,
      selection_ack:op.selection_policy,action:{kind:'claim_resource',lease_ms:3000,resource:{profile:'profile',account_epoch:1,binding_revision:1}}}),/not admitted for dispatch/)
    assert.equal((await hub.client.call(`${root}/operations/${op.id}`)).state,'prepared')
    await assert.rejects(hub.client.call(`${root}/operation-bundles/${op.id}/abandon`,{request_id:'bypass',expected_revision:op.revision}),/assignment abandonment/)
    await assert.rejects(hub.client.call(preparePath,{...prepare,target_id:'other'}),/identity conflict/)
    await assert.rejects(hub.client.call(`${runs}/before/stages/followup/assignments`,{...prepare,request_id:'dependency',expected_revision:3}),/candidate unavailable/)
    await assert.rejects(hub.client.call(`${runs}/before`,{action:'cancel',request_id:'unsafe',expected_revision:3}),/undispatched cancellation/)
    for (const id of ['second','third']) await hub.client.call(runs,{...request,id,request_id:id})
    const race=await Promise.allSettled(['second','third'].map(id=>hub.client.call(`${runs}/${id}/stages/inspect/assignments`,{...prepare,expected_revision:1})))
    assert.equal(race.filter(r=>r.status==='fulfilled').length,1)
    assert.match(race.find(r=>r.status==='rejected').reason.message,/capacity exhausted/)
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved,20)
    const other=race.find(r=>r.status==='fulfilled').value.assignment
    const otherResources=`${root}/work-assignments/${other.id}/resources`
    await assert.rejects(hub.client.call(otherResources,resourceCommand),error=>error.status===409&&error.code==='assignment_account_capacity_exhausted'&&/account capacity exhausted/.test(error.message))
    await hub.client.call(`${root}/assignment-capacities`,{account_id:'account',expected_revision:1,max_active_assignments:2})
    await assert.rejects(hub.client.call(otherResources,resourceCommand),error=>error.status===409&&error.code==='assignment_workspace_busy'&&/workspace already reserved/.test(error.message))
    assert.equal((await hub.client.call(`${root}/work-assignments/${other.id}`)).revision,1,'failed holds do not mutate assignment')
    assert.equal((await hub.client.call(`${root}/assignment-capacities/account`)).held,1)

    const abandoned=await hub.client.call(`${root}/work-assignments/${assignment.id}/abandon`,{request_id:'abandon',expected_revision:3})
    assert.equal(abandoned.assignment.state,'abandoned'); assert.equal(abandoned.run_revision,4)
    assert.equal(abandoned.assignment.abandonment.reservation.held,0)
    assert.equal(abandoned.assignment.resources.state,'released')
    assert.equal((await hub.client.call(`${root}/assignment-capacities/account`)).held,0)
    await hub.client.call(otherResources,resourceCommand)
    assert.equal((await hub.client.call(`${root}/assignment-capacities/account`)).held,1)
    assert.deepEqual(await hub.client.call(resources,resourceCommand),hold,'historical hold receipt cannot reacquire released resources')
    assert.equal((await hub.client.call(`${root}/assignment-capacities/account`)).held,1)

    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved,10)
    assert.deepEqual(await hub.client.call(preparePath,prepare),first,'old prepare receipt cannot revive abandoned assignment')
    assert.deepEqual(await hub.client.call(`${root}/work-assignments/${assignment.id}/abandon`,{request_id:'abandon',expected_revision:3}),abandoned)
    const next=await hub.client.call(preparePath,{...prepare,request_id:'next',expected_revision:4})
    assert.equal(next.assignment.stage_attempt,2)
    assert.notEqual(next.assignment.worker.session_id,assignment.worker.session_id)
    await hub.client.call(`${root}/work-assignments/${next.assignment.id}/abandon`,{request_id:'abandon-next',expected_revision:5})
    const cancelled=await hub.client.call(`${runs}/before`,{action:'cancel',request_id:'cancel',expected_revision:6})
    assert.equal(cancelled.state,'cancelled')
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(preparePath,prepare),first)
    assert.equal((await hub.client.call(`${root}/work-assignments/${assignment.id}`)).state,'abandoned')
    assert.equal((await hub.client.call(`${root}/assignment-capacities/account`)).held,1,'resource hold survives Hub restart')
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved,10)
    const cancelRun = await hub.client.call(`${runs}/${other.run_id}`)
    const cancelRequest = { action: 'request_cancel', request_id: 'cancel-running', expected_revision: cancelRun.revision, reason: 'User stopped this request' }
    await assert.rejects(worker.call(`${runs}/${other.run_id}`, cancelRequest), /403/)
    const priorOperation = await hub.client.call(`${root}/operations/${other.bundle.operation.id}`)
    const cancelling = await hub.client.call(`${runs}/${other.run_id}`, cancelRequest)
    assert.equal(cancelling.state, 'cancelling'); assert.equal(cancelling.cancellation.stop_confirmed, false)
    assert.equal(cancelling.completion_authorized, false)
    assert.equal((await hub.client.call(`${runs}/active`)).items.find(row => row.id === other.run_id).state, 'cancelling')
    assert.deepEqual(cancelling.cancellation.assignment_ids, [other.id])
    const fenced = await hub.client.call(`${root}/operations/${other.bundle.operation.id}`)
    assert.equal(fenced.state, 'stopped'); assert.equal(fenced.epoch, priorOperation.epoch + 1)
    assert.equal(fenced.lease_until, null)
    assert.equal((await hub.client.call(`${root}/assignment-capacities/account`)).held, 1)
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved, 10)
    await assert.rejects(hub.client.call(`${runs}/${other.run_id}/schedule`, { request_id: 'after-cancel', expected_revision: cancelling.revision }), /no schedulable stage/)
    assert.deepEqual(await hub.client.call(`${runs}/${other.run_id}`, cancelRequest), cancelling)
    await assert.rejects(hub.client.call(`${runs}/${other.run_id}`, { ...cancelRequest, reason: 'Changed' }), /identity conflict/)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(`${runs}/${other.run_id}`, cancelRequest), cancelling)
    assert.deepEqual(await hub.client.call(`${root}/operations/${other.bundle.operation.id}`), fenced)
    const finalizeCancel = { action: 'finalize_cancel', request_id: 'confirm-cancel', expected_revision: cancelling.revision }
    await assert.rejects(worker.call(`${runs}/${other.run_id}`, finalizeCancel), /403/)
    const confirmed = await hub.client.call(`${runs}/${other.run_id}`, finalizeCancel)
    assert.equal(confirmed.state, 'cancelled'); assert.equal(confirmed.cancellation.stop_confirmed, true)
    assert.equal(confirmed.cancellation.resources_released, true); assert.equal(confirmed.completion_authorized, false)
    assert.equal(confirmed.cancellation.receipt.assignments[0].stop_basis, 'never_admitted')
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved, 0)
    assert.equal((await hub.client.call(`${root}/assignment-capacities/account`)).held, 0)
    assert.equal((await hub.client.call(`${root}/work-assignments/${other.id}`)).state, 'cancelled')
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(`${runs}/${other.run_id}`, finalizeCancel), confirmed)
    assert.deepEqual(await hub.client.call(`${runs}/${other.run_id}`, cancelRequest), cancelling)
    assert.equal((await hub.client.call(`${runs}/${other.run_id}`)).state, 'cancelled')
    const cancelAudit = await hub.client.call(`${runs}/${other.run_id}/events`)
    assert.equal(cancelAudit.events.filter(e => e.data.kind === 'work_run_cancel_requested').length, 1)
    const audit=await hub.client.call(`${runs}/before/events`)
    assert.equal(audit.events.filter(e=>e.data.kind==='work_assignment_prepared').length,2)
    assert.equal(audit.events.filter(e=>e.data.kind==='work_assignment_abandoned').length,2)
  } finally { await hub.close() }
})

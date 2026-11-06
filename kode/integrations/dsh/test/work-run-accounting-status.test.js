import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { registerWorkRunExecution } from '../src/work-run-execution-route.js'
import { readCoordinatorState } from '../src/coordinator-read-tools.js'
import { WorkRunService } from '../src/work-run-service.js'
import { CoordinatorUpdates } from '../src/coordinator-updates.js'
import { coordinatorInput } from '../src/coordinator-input.js'
import { isolatedHub } from './support/isolated-hub.js'
import { deliveryInputId } from '../src/delivery-tracker.js'

async function teamWithSchedulableCandidate(hub) {
  const root = '/api/v1/messaging', call = (path, body) => hub.client.call(`${root}/${path}`, body), now = Date.now()
  const workspace = { host_id: hub.node, workspace_id: 'workspace', root_ref: '/fixture' }
  const target = { host: hub.node, workspace: 'workspace', root: '/fixture' }
  const ref = row => ({ id: row.id, version: row.version, hash: row.hash })
  const policy = row => ({ id: row.id, revision: row.revision, hash: row.hash })
  const flow = await call('workflows', { id: 'flow', version: '1', inputs: ['request'], stages: [
    { id: 'inspect', role: 'coordinator', requires: ['request'], produces: ['artifact'], independent_from: [],
      execution: { task_tag: 'inspection', repository_binding: 'code', capabilities: ['read'], tools: ['kode_artifact_capture'], network: false } },
  ], completion_stages: ['inspect'], evidence_rules: { artifact: { kind: 'artifact', repository_binding: 'code' } } })
  const project = await call('project-configs', { id: 'project', version: '1', spec: { kind: 'project_bindings',
    repositories: { code: { repository_id: 'repo', workspace } }, environments: {}, commands: {}, connections: {} } })
  const delivery = await call('project-configs', { id: 'delivery', version: '1', spec: { kind: 'delivery_policy',
    workflow: ref(flow), project: ref(project), targets: [{ kind: 'local', repository_binding: 'code' }], required_outputs: ['artifact'] } })
  await call('resource-accounts', { id: 'account', expected_epoch: 0, enabled: true })
  await call('assignment-capacities', { account_id: 'account', expected_revision: 0, max_active_assignments: 2 })
  await call('resource-bindings', { host: hub.node, profile: 'profile', account_id: 'account', account_epoch: 1, expected_revision: 0 })
  await call('capability-profiles', { id: 'capability', expected_revision: 0, host: hub.node, profile: 'profile', model: 'model', assessments: {
    fit: { evaluation: { kind: 'task_fit', tag: 'inspection', score: 90 }, source: 'user', confidence: 1, evidence: [], pinned: false, updated_at: now, valid_until: now + 60000 },
  } })
  await call('budgets', { id: 'budget', scope: 'team', scope_id: 'team', unit: 'credits', limit: 100, starts_at: now - 1000, ends_at: now + 60000, expected_revision: 0 })
  const budget = await call('team-policies', { id: 'budget-policy', team_id: 'team', expected_revision: 0, policy: { kind: 'budget', budget_ids: ['budget'], unit: 'credits', max_assignment_charge: 10 } })
  const resource = { host: hub.node, profile: 'profile', account_id: 'account', account_epoch: 1, binding_revision: 1, limit_ids: ['daily'], unknown_quota: 'team_budget' }
  const scheduling = await call('team-policies', { id: 'schedule', team_id: 'team', expected_revision: 0,
    policy: { kind: 'scheduling', targets: { control: { resource, capability_id: 'capability', capability_revision: 1, preferred: true } },
      weights: { quality: 1, cost: 0, latency: 0 }, minimum_quality: 0, minimum_confidence: 0 } })
  const spec = { name: 'Team', purpose: 'Work', kind: 'coordinator', workspace_refs: [workspace],
    execution_targets: [{ id: 'control', host_id: hub.node, executor_profile_id: 'profile', executor_profile_revision: 'f'.repeat(64),
      provider_id: 'fixture', model_id: 'model', effort: null, account_binding_id: 'account', capability_profile_revision: '1' }],
    workers: [], coordinator_targets: ['control'], workflow_pack_refs: [ref(flow)],
    delivery_bindings: [{ id: 'local', workflow: ref(flow), project: ref(project), delivery_policy: ref(delivery) }],
    grant_id: 'grant', budget_policy_id: 'budget-policy', scheduling_policy_id: 'schedule',
    limits: { max_active_assignments: 2, max_active_runs: 2 }, proactive_mode: 'off' }
  const team = await call('teams', { id: 'team', request_id: 'create', expected_revision: 0, spec })
  const grant = (await call('team-grants', { expected_revision: 0, policy: { id: 'grant', team_id: 'team', enabled: true,
    expires_at: now + 60000, targets: [target], capabilities: ['read', 'delegate'],
    tools: ['kode_artifact_capture', 'kode_coordinator_publish_reply', 'kode_coordinator_workflow_start', 'kode_coordinator_configuration', 'kode_coordinator_workflow_status'],
    network: false, budget_ids: ['budget'] } })).grant
  await call('teams/team/activation', { action: 'activate', request_id: 'activate', expected_revision: 0, team_revision: team.revision,
    grant_revision: grant.revision, budget_policy: policy(budget), scheduling_policy: policy(scheduling) })
  return team
}

test('Home usage-unresolved WorkRun is owner/Superagent readable, durable, non-retryable and queues one scoped Coordinator update',
  { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 45000 }, async t => {
    let hub
    const profileRoot = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'kode-accounting-observation-'))
    try {
      hub = await isolatedHub('work-accounting-home')
      const root = '/api/v1/messaging', call = (path, body) => hub.client.call(`${root}/${path}`, body)
      const team = await teamWithSchedulableCandidate(hub)
      const registration = await call('sessions', { session_id: 'coordinator', title: 'Coordinator fixture', runtime: 'external' })
      const coordinatorClient = hub.client.forSession(registration.owner_token)
      const target = { host: hub.node, workspace: 'workspace', root: '/fixture' }
      const tools = ['kode_artifact_capture', 'kode_coordinator_publish_reply', 'kode_coordinator_workflow_start', 'kode_coordinator_configuration', 'kode_coordinator_workflow_status']
      const selection = { profile_revision: 'f'.repeat(64), model: 'model', effort: null, scope: 'executor_configuration' }
      const resource = { host: hub.node, profile: 'profile', account_id: 'account', account_epoch: 1, binding_revision: 1, limit_ids: ['daily'], unknown_quota: 'team_budget' }
      await call('price-versions', { id: 'accounting-price', model: 'model', model_policy: 'requested_model', unit: 'credits', input_per_million: 1, cached_per_million: 1, output_per_million: 1 })
      const bundle = await call('operation-bundles', {
        owner_session: 'owner', request_key: 'coordinator-accounting', worker: { node_id: hub.node, session_id: 'coordinator' },
        selection_policy: selection, funding: { budget_ids: ['budget'], amount: 10, unit: 'credits' }, resource,
        grant_id: 'grant', grant_scope: { team_id: team.id, revision: 1, target, capabilities: ['read', 'delegate'], tools, network: false, budget_ids: ['budget'] },
      })
      await call(`budget-reservations/${bundle.reservation.request.id}/pricing`, { price_id: 'accounting-price' })
      const control = await call('teams/team/coordinator-control', { request_id: 'bind-coordinator', expected_revision: 0, team_revision: 1,
        activation_revision: 1, operation_id: bundle.operation.id, operation_revision: bundle.operation.revision,
        attempt: 1, epoch: 1, target_id: 'control' })
      const active = (await call(`operations/${bundle.operation.id}`, { attempt: 1, epoch: 1, expected_revision: bundle.operation.revision,
        selection_ack: selection, action: { kind: 'claim_resource', lease_ms: 60000, resource: { profile: 'profile', account_epoch: 1, binding_revision: 1 } } })).operation

      const human = await call(`conversations/${team.conversation_id}/messages`, { request_id: 'human-request', content: 'Inspect the project and report.' })
      const input = await call(`conversations/${team.conversation_id}/messages/${human.id}/coordinator-input`, {
        operation_id: active.id, control_revision: control.revision, attempt: active.attempt, epoch: active.epoch,
      })
      const delivery = input.receipt.message_id
      const claimed = await coordinatorClient.call(`${root}/sessions/coordinator/claim`, {})
      assert.ok(claimed.messages.some(message => message.id === delivery), 'the Coordinator inbox claims the queued source message')
      const observe = async (phase, event_seq = null) => coordinatorClient.call(`${root}/messages/${delivery}/delivery`, {
        session_id: 'coordinator', input_id: deliveryInputId(delivery), phase, event_seq,
      })
      await observe('prepared')
      await observe('queued')
      await observe('consumed', 1)
      let run = await call(`conversations/${team.conversation_id}/work-runs`, {
        request_id: 'start-run', source_message_id: human.id, operation_id: active.id, control_revision: control.revision,
        attempt: active.attempt, epoch: active.epoch, binding_id: 'local', inputs: { request: 'Inspect the project and report.' },
      })
      assert.equal(run.coordinator.operation_id, active.id)

      await call('official-calls', { call_id: 'known-coordinator-call', operation_id: active.id, attempt: active.attempt, epoch: active.epoch,
        worker_session: 'coordinator', provider: 'fixture', model: 'model' })
      const coordinatorUsage = await call('official-calls/known-coordinator-call/events', { sequence: 1, kind: 'finished',
        usage: { input_tokens: 11, cached_input_tokens: 2, output_tokens: 3, cache_write_input_tokens: 0 }, reason: 'stop' })
      assert.equal(coordinatorUsage.call.accounting_status, 'estimated_pending_reconciliation')

      const scheduled = await call(`work-runs/${run.id}/schedule`, { request_id: 'schedule-stage', expected_revision: run.revision })
      const assignment = scheduled.assignment
      assert.ok(assignment?.id, 'real Home scheduled the current Worker assignment')
      const assignmentOperation = assignment.bundle.operation
      await call(`budget-reservations/${assignment.bundle.reservation.request.id}/pricing`, { price_id: 'accounting-price' })
      const held = await call(`work-assignments/${assignment.id}/resources`, { request_id: 'hold-stage', expected_revision: assignment.revision })
      assert.equal(held.resources.state, 'held')
      const heldAssignment = await call(`work-assignments/${assignment.id}`)
      await call(`work-assignments/${assignment.id}/admit`, { request_id: 'admit-worker', expected_revision: heldAssignment.revision,
        worker_session: assignment.worker.session_id, profile_revision: heldAssignment.dispatch.command.profile_revision,
        provider: heldAssignment.dispatch.command.provider, model: heldAssignment.dispatch.command.model,
        effort: heldAssignment.dispatch.command.effort, tools: heldAssignment.dispatch.command.tools, root: heldAssignment.dispatch.command.cwd })
      const admittedAssignment = await call(`work-assignments/${assignment.id}`)
      const assignmentActive = (await call(`operations/${assignmentOperation.id}`, {
        attempt: assignmentOperation.attempt, epoch: assignmentOperation.epoch, expected_revision: assignmentOperation.revision,
        selection_ack: assignmentOperation.selection_policy,
        action: { kind: 'claim_resource', lease_ms: 60000, resource: { profile: 'profile', account_epoch: 1, binding_revision: 1 } },
      })).operation
      assert.equal(assignmentActive.state, 'active')
      const created = await call(`work-assignments/${assignment.id}/creation`, {
        request_id: `${assignment.id}-created`, command: admittedAssignment.dispatch.command, state: 'created',
      })
      assert.equal(created.state, 'created')
      run = await call(`work-runs/${run.id}`)
      await call('official-calls', { call_id: 'missing-worker-usage-call', operation_id: assignmentActive.id,
        attempt: assignmentActive.attempt, epoch: assignmentActive.epoch, worker_session: assignment.worker.session_id, provider: 'fixture', model: 'model' })
      const unresolved = await call('official-calls/missing-worker-usage-call/events', { sequence: 1, kind: 'finished', usage: null, reason: 'missing_usage' })
      assert.equal(unresolved.call.accounting_status, 'usage_unresolved')
      await assert.rejects(call('official-calls', { call_id: 'must-not-begin', operation_id: assignmentActive.id,
        attempt: assignmentActive.attempt, epoch: assignmentActive.epoch, worker_session: assignment.worker.session_id, provider: 'fixture', model: 'model' }), /requires reconciliation/)
      await assert.rejects(call('official-calls/must-not-begin'), /404/)

      const homeStatus = await call(`work-runs/${run.id}/accounting-status`)
      assert.deepEqual({ state: homeStatus.state, reason: homeStatus.reason, authority: homeStatus.authority, read_only: homeStatus.read_only,
        retry_allowed: homeStatus.retry_allowed, blocked: homeStatus.blocked }, {
        state: 'waiting_accounting', reason: 'usage_reconciliation_required', authority: 'home_accounting_observation',
        read_only: true, retry_allowed: false, blocked: true,
      })
      assert.deepEqual(homeStatus.unresolved_calls, [{ operation_id: assignmentActive.id, attempt: assignmentActive.attempt, epoch: assignmentActive.epoch,
        assignment_id: assignment.id, stage_id: 'inspect', call_id: 'missing-worker-usage-call', state: 'finished', accounting_status: 'usage_unresolved',
        budget: { reservation_id: assignment.bundle.reservation.request.id, unit: 'credits', charged: 0, held: 10, finalized: false, frozen: true } }])
      assert.equal(JSON.stringify(homeStatus).includes('session_id'), false)
      assert.equal(JSON.stringify(homeStatus).includes('raw'), false)
      const ownerRegistration = await call('sessions', { session_id: 'owner-probe', title: 'Owner probe', runtime: 'external' })
      await assert.rejects(hub.client.forSession(ownerRegistration.owner_token).call(`${root}/work-runs/${run.id}/accounting-status`), /403/)

      const scope = { team_id: team.id, conversation_id: team.conversation_id, control_revision: control.revision }
      const operation = { id: active.id, attempt: active.attempt, epoch: active.epoch }
      const binding = { managedOperation: operation, managedCoordinator: scope }
      const runtime = { host: hub.node, profiles: { binding: id => id === 'coordinator' ? binding : undefined }, client: hub.client }
      const coordinatorStatus = await readCoordinatorState(runtime, { id: 'coordinator' }, scope, operation, 'status', { run_id: run.id })
      assert.equal(coordinatorStatus.execution_accounting.reason, 'usage_reconciliation_required')
      assert.equal(coordinatorStatus.execution_accounting.unresolved_calls[0].call_id, 'missing-worker-usage-call')

      const principal = { value: 'owner' }
      const serviceController = () => {
        const controller = { runtime: { ...runtime, profiles: { ...runtime.profiles, path: join(profileRoot, 'profiles.json') } }, watches: new Map(), starts: [],
          watch(id, options) { this.starts.push(id); this.watches.set(id, options) }, unwatch(id) { this.watches.delete(id) }, async close() { this.watches.clear() } }
        return controller
      }
      const firstController = serviceController()
      let service = await new WorkRunService(firstController, { intervalMs: 100, maxWatches: 1 }).open()
      await service.note(run.id, { state: 'progression_failed', error: new Error('official begin refused') })
      assert.deepEqual(service.rows[run.id], { revision: run.revision, state: 'waiting_accounting', blocked: true })
      await service.close()
      const restoredController = serviceController()
      service = await new WorkRunService(restoredController, { intervalMs: 100, maxWatches: 1 }).open()
      await assert.rejects(service.retry(run.id), /usage reconciliation required; retry is not authorized/)
      assert.deepEqual(restoredController.starts, [], 'restart preserves the fence and does not start another execution')

      let route
      registerWorkRunExecution({ webServer: { register: value => { route = value } },
        connection: { admit: () => ({ peer: { principal: { kind: principal.value } } }) },
        get: () => ({ officialExecution: { host: hub.node }, workRuns: service }) }, { backendClient: hub.client })
      const invoke = async (owner, url) => {
        principal.value = owner
        let status, body
        await route.handler({ method: 'GET', url }, { writeHead: code => { status = code }, end: value => { body = JSON.parse(value) } })
        return { status, body }
      }
      const ownerView = await invoke('owner', `/api/kode/work-run/execution?run_id=${run.id}&team_id=${team.id}`)
      assert.equal(ownerView.status, 200)
      assert.equal(ownerView.body.state, 'waiting_accounting')
      assert.equal(ownerView.body.accounting.unresolved_calls[0].call_id, 'missing-worker-usage-call')
      assert.equal((await invoke('agent', `/api/kode/work-run/execution?run_id=${run.id}&team_id=${team.id}`)).status, 403)
      assert.equal((await invoke('owner', `/api/kode/work-run/execution?run_id=${run.id}&team_id=foreign-team`)).status, 409)

      const updates = new CoordinatorUpdates(runtime, { intervalMs: 100 })
      const queued = await updates.scan()
      const own = queued.find(item => item.run_id === run.id)
      assert.equal(own?.state, 'queued')
      assert.equal(own.receipt.summary.waiting_reason, 'usage_reconciliation_required')
      assert.equal(own.receipt.summary.execution_accounting.unresolved_calls[0].call_id, 'missing-worker-usage-call')
      const updateMessage = await call(`messages/${own.receipt.receipt.message_id}`)
      const deliveredUpdate = await coordinatorInput(hub.client, binding, updateMessage, deliveryInputId(updateMessage.id))
      assert.match(deliveredUpdate.content.map(block => block.text).join('\n'), /usage_reconciliation_required/)
      assert.match(deliveredUpdate.content.map(block => block.text).join('\n'), /missing-worker-usage-call/)
      const repeated = await call(`work-runs/${run.id}/coordinator-updates`, { expected_revision: run.revision })
      assert.deepEqual(repeated, own.receipt, 'same revision returns original update receipt')
      assert.equal((await call('official-calls/missing-worker-usage-call')).accounting_status, 'usage_unresolved')
      assert.equal((await call('official-calls/known-coordinator-call')).accounting_status, 'estimated_pending_reconciliation', 'known Coordinator usage is not mislabeled as a blocker')
      await updates.close()
      await service.close()
    } finally {
      await hub?.close()
      await rm(profileRoot, { recursive: true, force: true })
    }
  })

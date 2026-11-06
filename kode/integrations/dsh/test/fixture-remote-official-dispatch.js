import { assignmentHomeCall } from '../src/assignment-home.js'
import { VerificationRunners, verificationExecutableHash } from '../src/verification-runners.js'
import { RemoteAssignmentDiscovery } from '../src/remote-assignment-discovery.js'
/** Real official AgentLoop, persistence and kernel locks on a remote execution Host; controlled model with no paid inference. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { createRequire } from 'node:module'
import { mkdir, realpath, writeFile, readFile, chmod, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isolatedHub, pairHubs } from './support/isolated-hub.js'
import { apply as applyHost } from '../src/host.js'
import { AgentProfiles, profileRevision, writePrivateJson } from '../src/agent-profiles.js'
import { OfficialExecution } from '../src/official-execution.js'
import { AssignmentDispatchHost } from '../src/assignment-dispatch-host.js'
import { OfficialLoopHost } from '../src/official-loop-host.js'
import { RemoteAssignmentService } from '../src/remote-assignment-service.js'
import { WorkRunController } from '../src/work-run-controller.js'
import { fetchArtifactArchive } from '../src/artifact-transfer.js'
import { verifyHomeTrace } from './support/home-trace.js'
import { OfficialToolPolicies } from '../src/official-grant-guard.js'
const loopRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { default: Tools } = await import(loopRequire.resolve('@deepseek-ai/dsh-tools'))
const scenario = process.env.KODE_TEST_REMOTE_SCENARIO ?? 'pipeline'
const takeover = scenario === 'takeover-tool'
const fixtureLifetime = takeover ? 3600000 : 1800000
if (!['pipeline', 'cancel-busy', 'cancel-tool', 'takeover-tool', 'question'].includes(scenario)) throw new Error('Unknown remote fixture scenario')
test('remote official Worker reads source and records artifact metadata and archives bytes on home across retry and restart', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: takeover ? 1800000 : 900000 }, async () => {
  const hub = await isolatedHub('official-home')
  const homeResource = () => ({ root: hub.root, url: hub.url, node: hub.node, hub_pid: hub.pid })
  if (process.env.KODE_TEST_CANCEL_CRASH && process.send) process.send({ type: 'fixture-resources', ...homeResource() })
  const remote = await isolatedHub('official-worker'), ctx = new Context()
  const resources = () => ({ ...homeResource(), execution: { root: remote.root, url: remote.url, node: remote.node, hub_pid: remote.pid }, hubs: [homeResource(), { root: remote.root, hub_pid: remote.pid }] })
  if (process.env.KODE_TEST_CANCEL_CRASH && process.send) process.send({ type: 'fixture-resources', ...resources() })
  let execution, host, dispatcher, controller, remoteService, discovery, consumerRoot
  try {
    await pairHubs(hub, remote)
    await mkdir(join(remote.root, 'repo'))
    const workspaceRoot = await realpath(join(remote.root, 'repo'))
    const git = args => promisify(execFile)('/usr/bin/git', ['-C', workspaceRoot, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' } })
    await git(['init', '-q']); await writeFile(join(workspaceRoot, 'source.txt'), 'remote source')
    await git(['add', '.']); await git(['commit', '-qm', 'fixture base'])
    const profiles = await new AgentProfiles(join(remote.root, 'profiles.json')).open([{ id: 'profile', name: 'Official', type: 'dsh' }])
    const root = '/api/v1/messaging', path = `${root}/teams/team/activation`, runs = `${root}/work-runs`
    const versionRef = r => ({ id: r.id, version: r.version, hash: r.hash })
    const policyRef = r => ({ id: r.id, revision: r.revision, hash: r.hash })
    const workspace = { host_id: remote.node, workspace_id: 'workspace', root_ref: workspaceRoot }
    const verificationExecutable = await realpath(process.execPath)
    const verificationDefinition = { runner_id: 'local-check', command_id: 'snapshot-check', revision: '1', executable: verificationExecutable,
      executable_hash: await verificationExecutableHash(verificationExecutable), args: ['-e', "const fs=require('node:fs');if(fs.readFileSync('source.txt','utf8')!=='remote source')process.exit(3);process.stdout.write('verified remote snapshot'+'x'.repeat(200000))"],
      env: {}, timeout_ms: 5000, max_output_bytes: 262144, scenario_ids: ['smoke'], capabilities: ['read'], network: false, tool_id: 'kode_verify_output',exclusive_resources:['fixture-remote-device'] }
    const toolMarker = join(remote.root, 'verification-process.json')
    if (scenario === 'cancel-tool' || takeover) {
      const successProgram = verificationDefinition.args[1]
      verificationDefinition.args = ['-e', `const fs=require('node:fs');const marker=${JSON.stringify(toolMarker)};fs.writeFileSync(marker,JSON.stringify({pid:process.pid,state:'running'}));process.on('SIGTERM',()=>{fs.writeFileSync(marker,JSON.stringify({pid:process.pid,state:'stopped'}));process.exit(0)});setInterval(()=>{},1000)`]
      if (takeover) verificationDefinition.args = ['-e', `const markerFs=require('node:fs');if(markerFs.existsSync(${JSON.stringify(toolMarker)})){${successProgram}}else{${verificationDefinition.args[1]}}`]
      verificationDefinition.timeout_ms = 60000
    }
    const verificationRegistry = new VerificationRunners(join(remote.root, 'verification-runs'))
    const verificationReference = verificationRegistry.register(verificationDefinition); await verificationRegistry.close()
    const workflow = await hub.client.call(`${root}/workflows`, { id: 'flow', version: '1', inputs: ['request'],
      stages: [{ id: 'inspect', role: 'coordinator', requires: ['request'], produces: ['artifact'], independent_from: [], execution: { task_tag: 'inspection', repository_binding: 'code', capabilities: ['read'], tools: ['kode_read_source', 'kode_capture_output', 'kode_publish_output'], network: false } },
        { id: 'followup', role: 'coordinator', requires: ['inspect'], produces: ['later'], independent_from: ['inspect'], execution: { task_tag: 'inspection', repository_binding: 'code', capabilities: ['read'], tools: ['kode_read_source', 'kode_review_output', 'kode_publish_output'], network: false } },
        { id: 'verify', role: 'coordinator', requires: ['followup'], produces: ['checked'], independent_from: ['inspect', 'followup'], execution: { task_tag: 'inspection', repository_binding: 'code', capabilities: ['read'], tools: ['kode_read_source', 'kode_verify_output', 'kode_publish_output'], network: false } }],
      completion_stages: ['verify'], evidence_rules: { checked: { kind: 'verification', artifact_output: 'artifact', command_binding: 'check', environment_binding: 'local', required_scenarios: ['smoke'] }, artifact: { kind: 'artifact', repository_binding: 'code' }, later: { kind: 'review', artifact_output: 'artifact' } } })
    const project = await hub.client.call(`${root}/project-configs`, { id: 'project', version: '1', spec: { kind: 'project_bindings',
      repositories: { code: { repository_id: 'repository', workspace } }, environments: { local: { host_id: remote.node, adapter_id: 'local_process_v1', configuration_hash: verificationReference.environment_hash } }, commands: { check: { id: verificationReference.id, revision: verificationReference.revision, definition_hash: verificationReference.definition_hash,exclusive_resources:verificationReference.exclusive_resources, repository_binding: 'code', environment_binding: 'local', runner_id: verificationReference.runner_id, scenario_ids: verificationReference.scenario_ids } }, connections: {} } })
    const delivery = await hub.client.call(`${root}/project-configs`, { id: 'delivery', version: '1', spec: { kind: 'delivery_policy',
      workflow: versionRef(workflow), project: versionRef(project), targets: [{ kind: 'local', repository_binding: 'code' }], required_outputs: ['checked'] } })
    await hub.client.call(`${root}/budgets`, { id: 'budget', scope: 'team', scope_id: 'team', unit: 'credits', limit: 100,
      starts_at: Date.now() - 1000, ends_at: Date.now() + fixtureLifetime, expected_revision: 0 })
    await hub.client.call(`${root}/price-versions`, { id: 'price', model: 'model', unit: 'credits', model_policy: 'requested_model', input_per_million: 1000000, cached_per_million: 1000000, output_per_million: 1000000 })
    const budgetCommand = { id: 'budget-policy', team_id: 'team', expected_revision: 0,
      policy: { kind: 'budget', budget_ids: ['budget'], unit: 'credits', max_assignment_charge: 10, settlement: 'internal_price' } }
    const budget = await hub.client.call(`${root}/team-policies`, budgetCommand)
    const schedule = await hub.client.call(`${root}/team-policies`, { id: 'schedule-policy', team_id: 'team', expected_revision: 0,
      policy: { kind: 'scheduling', targets: { target: { resource: { host: remote.node, profile: 'profile', account_id: 'account', account_epoch: 1,
        binding_revision: 1, limit_ids: ['daily'], unknown_quota: 'team_budget' }, capability_id: 'capability', capability_revision: 1, preferred: false, internal_price_id: 'price' } },
      weights: { quality: 100, cost: 50, latency: 20 }, minimum_quality: 60, minimum_confidence: 0.7 } })
    const spec = { name: 'Team', purpose: 'Fixture', kind: 'coordinator', workspace_refs: [workspace],
      execution_targets: [{ id: 'target', host_id: remote.node, executor_profile_id: 'profile', executor_profile_revision: profileRevision(profiles.get('profile')), provider_id: 'fixture', model_id: 'model', effort: null,
        account_binding_id: 'account', capability_profile_revision: '1' }], workers: [], coordinator_targets: ['target'], workflow_pack_refs: [versionRef(workflow)],
      delivery_bindings: [{ id: 'local', workflow: versionRef(workflow), project: versionRef(project), delivery_policy: versionRef(delivery) }],
      grant_id: 'grant', budget_policy_id: 'budget-policy', scheduling_policy_id: 'schedule-policy',
      limits: { max_active_assignments: 2, max_active_runs: 8 }, proactive_mode: 'off' }
    await hub.client.call(`${root}/teams`, { id: 'team', request_id: 'new', expected_revision: 0, spec })
    const grantCommand = { expected_revision: 0, policy: { id: 'grant', team_id: 'team', enabled: true, expires_at: Date.now() + fixtureLifetime,
      targets: [{ host: remote.node, workspace: 'workspace', root: workspaceRoot }], capabilities: ['read'], tools: ['kode_read_source', 'kode_capture_output', 'kode_review_output', 'kode_verify_output', 'kode_publish_output'], network: false, budget_ids: ['budget'] } }
    let grant = (await hub.client.call(`${root}/team-grants`, grantCommand)).grant
    const request = { id: 'before', request_id: 'before', team_id: 'team', team_revision: 1, binding_id: 'local', inputs: { request: 'Inspect' }, prior_run_id: null }
    const initial = await hub.client.call(runs, request)
    const command = { action: 'activate', request_id: 'activate', expected_revision: 0, team_revision: 1, grant_revision: grant.revision,
      budget_policy: policyRef(budget), scheduling_policy: policyRef(schedule) }

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
      fit: { evaluation: { kind: 'task_fit', tag: 'inspection', score: 80 }, source: 'user', confidence: 0.9, evidence: [], pinned: false, updated_at: at - 1000, valid_until: at + fixtureLifetime },
    } })
    const [first, retry] = await Promise.all([hub.client.call(preparePath,prepare),hub.client.call(preparePath,prepare)])
    assert.deepEqual(first,retry); assert.equal(first.run_revision,3)
    const assignment=first.assignment, op=assignment.bundle.operation
    assert.equal(assignment.dispatch.command.operation.home_node, hub.node)
    assert.equal(assignment.state,'prepared'); assert.equal(assignment.dispatch.state,'blocked')
    assert.equal(assignment.stage_attempt,1); assert.equal(assignment.context_hash,initial.context_hash)
    assert.equal(assignment.dispatch.command.session_id,assignment.worker.session_id)
    assert.deepEqual(assignment.dispatch.command.tools,['kode_read_source', 'kode_capture_output', 'kode_publish_output'])
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved,10)

    assert.deepEqual((await remote.client.call(`${root}/assignment-dispatches/remote/${hub.node}`)).items, [], 'unheld assignments cannot be discovered for creation')
    let lostAccounting = false
    const ownerClient = { call: async (...args) => {
      const result = await hub.client.call(...args)
      if (args[0].endsWith('/accounting') && !lostAccounting) { lostAccounting = true; throw new Error('fixture lost committed accounting reply') }
      return result
    } }
    const ownerHost = { execution: { host: hub.node, client: ownerClient }, stop: new AbortController(), handles: new Map() }
    controller = new WorkRunController({ host: ownerHost }, { prepare: async () => { throw new Error('Remote completion must not create a local Worker') } })
    assert.equal((await controller.advance('before')).state, 'remote_resources_held')
    await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(Projections)
    await ctx.plugin(await import('@deepseek-ai/dsh-session-persistence-jsonl'), { root: join(remote.root, 'sessions'), compression: 'zstd' })
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false }); await ctx.plugin(Tools); await ctx.plugin(LlmRuntime)
    ctx.provide('workspaceRegistry', { list: () => [{ id: 'workspace', path: workspaceRoot }] })
    ctx.provide('kodeOfficialToolPolicies', new OfficialToolPolicies())
    const errors = [], runtimeErrors = []
    ctx.on('agent/error', event => {
      errors.push(event.error.message)
      runtimeErrors.push({ session: event.agent.id, message: event.error.message })
    })
    let calls = 0, observedResults = [], relayTrace = [], busyStarted = false, busyAborted = false, resuming = false
    class Fixture extends LlmAdapter { async *stream(options) {
      try {
      const step = calls++ - (resuming ? 10 : 0)
      if (scenario === 'question') {
        const call = await execution.assertModelRequest(owned.agent)
        await assert.rejects(execution.clarifications.record(owned.agent, call,
          [{ id: 'scope', question: 'Which remote scope?' }]), /pending Home/)
        await execution.clarifications.tick()
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (scenario === 'cancel-busy') {
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
        busyStarted = true
        if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
        busyAborted = true
        throw options.signal.reason ?? new Error('Remote fixture model cancelled')
      }
      assert.ok(step < 12, 'four model calls for each of three independent Workers')
      const review = step >= 4 && step < 8, verify = step >= 8, phase = step % 4
      if (phase > 0) {
        const previous = options.messages.find(m => m.role === 'tool' && m.source?.callId === `remote-${step - 1}`)
        assert.ok(previous, 'actual remote tool result')
        const result = JSON.parse(previous.content.filter(b => b.type === 'text').map(b => b.text).join(''))
        observedResults.push(result)
        if (phase === 1) assert.equal(result.text, 'remote source')
        else if (phase === 2 && verify) { assert.equal(result.log_archive_status, 'home_archived'); assert.equal(result.verdict, 'passed') }
        else if (phase === 2) { assert.equal(result.home_reconciled, true); assert.equal(result.archive_status, review ? 'not_applicable' : 'home_archived'); if (review) assert.equal(result.verdict, 'passed') }
        else assert.equal(result.completion_authorized, false)
      }
      const users = options.messages.filter(m => m.role === 'user')
      assert.equal(users.length, 1)
      assert.match(JSON.stringify(users[0]), verify ? /verify/ : review ? /followup/ : /Inspect/)
      if (phase < 3) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `remote-${step}`, name: phase === 0 ? 'kode_read_source' : phase === 1 ? verify ? 'kode_verify_output' : review ? 'kode_review_output' : 'kode_capture_output' : 'kode_publish_output', arguments: JSON.stringify(phase === 0 ? { path: 'source.txt' } : phase === 1 ? verify ? { output: 'checked', request_id: 'verification' } : review ? { output: 'later', request_id: 'review', verdict: 'passed', findings: [] } : { output: 'artifact', request_id: 'capture' } : { output: verify ? 'checked' : review ? 'later' : 'artifact', evidence_id: verify ? observedResults[7].evidence_id : observedResults[review ? 4 : 1].evidence_id }) } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Remote mandate received.' } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      } catch (error) { errors.push(error.message); throw error }
    } }
    ctx.llm.registerAdapter(['fixture'], new Fixture())
    let lostQuestion = false
    let lost = false, lostStop = false, lostOutputs = false, lostWorkspace = false
    let crashAtStop = async () => {}
    const client = { call: async (path, body, signal) => {
      if (body?.accounting?.action.kind === 'assignment_stop') await crashAtStop('drained')
      const trace = { action: body?.accounting?.action?.kind ?? path, done: false }; relayTrace.push(trace)
      const result = await remote.client.call(path, body, signal).catch(error => { trace.error = error.message; throw error })
      trace.done = true
      if (body?.accounting?.action.kind === 'assignment_clarification' && !lostQuestion) { lostQuestion = true; throw new Error('fixture lost committed clarification reply') }
      if (body?.accounting?.action.kind === 'assignment_creation' && !lost) { lost = true; throw new Error('fixture lost committed creation reply') }
      if (body?.accounting?.action.kind === 'assignment_outputs' && !lostOutputs) { lostOutputs = true; throw new Error('fixture lost committed outputs reply') }
      if (body?.accounting?.action.kind === 'assignment_workspace_receipt' && !lostWorkspace) { lostWorkspace = true; throw new Error('fixture lost committed workspace reply') }
      if (body?.accounting?.action.kind === 'assignment_stop' && !lostStop) { lostStop = true; throw new Error('fixture lost committed stop reply') }
      return result
    } }
    execution = new OfficialExecution(ctx, profiles, client, { host: remote.node })
    execution.verificationRunners.register(verificationDefinition)
    host = new OfficialLoopHost(ctx, execution)
    ctx.provide('kodeAgents', { profiles, officialExecution: execution })
    const stateFile = join(remote.root, 'host-state.json'); await writePrivateJson(stateFile, {})
    await applyHost(ctx, { url: remote.url, tokenFile: join(remote.root, 'admin.token'), stateFile, agentRuntime: false, runtimeBridge: false, pollMs: 10 })
    dispatcher = new AssignmentDispatchHost(host)
    const deliver = dispatcher.deliver.bind(dispatcher)
    dispatcher.deliver = async (id, setup, homeScope) => {
      try { return await deliver(id, setup, homeScope) }
      catch (error) {
        if (homeScope && error.message === 'Remote Assignment requires home-owned resource holds') {
          let assignment = null, readError = null
          try { assignment = await hub.client.call(`${root}/work-assignments/${encodeURIComponent(id)}`) }
          catch (failure) { readError = { name: failure.name, status: failure.status ?? null } }
          console.error(JSON.stringify({ remote_assignment_hold_failure: {
            assignment_id: id, error: error.message, home_read_error: readError,
            assignment: assignment ? {
              state: assignment.state ?? null, revision: assignment.revision ?? null, stage_id: assignment.stage_id ?? null,
              resources_state: assignment.resources?.state ?? null, resource_receipt_present: Boolean(assignment.resources?.receipt),
              input_workspace_present: Boolean(assignment.input_workspace), execution_workspace_present: Boolean(assignment.execution_workspace),
              dispatch_state: assignment.dispatch?.state ?? null,
            } : null,
          } }))
        }
        throw error
      }
    }
    remoteService = new RemoteAssignmentService(dispatcher)
    const discovered = await dispatcher.discoverRemote(hub.node)
    assert.equal(discovered.items.length, 1)
    assert.equal(discovered.items[0].assignment_id, assignment.id)
    const options = { homeScope: { worker_session: discovered.items[0].worker_session, operation: discovered.items[0].operation } }
    assert.deepEqual(options.homeScope.operation, assignment.dispatch.command.operation)
    const observerForCatalog = await remote.client.call(`${root}/sessions`, { session_id: 'catalog-observer', title: 'Observer', runtime: 'external' })
    await assert.rejects(remote.client.forSession(observerForCatalog.owner_token).call(`${root}/assignment-dispatches/remote/${hub.node}`), /403/)
    await assert.rejects(remote.client.call(`${root}/assignment-dispatches/remote/${hub.node}?host=foreign`), /HTTP 400/)
    await assert.rejects(dispatcher.discoverRemote(remote.node), /catalog scope/)

    const discoveryResult = new Promise(resolve => {
      discovery = new RemoteAssignmentDiscovery(dispatcher, { onState: resolve })
    })
    discovery.start()
    assert.equal((await discoveryResult).state, 'remote_discovery_failed')
    await discovery.close()
    assert.equal(lost, true)
    const receipt = await dispatcher.dispatch(assignment.id, options)
    assert.equal(receipt.state, 'created')
    assert.deepEqual((await dispatcher.discoverRemote(hub.node)).items, [])
    const owned = host.handles.get(assignment.worker.session_id)
    assert.ok(owned); assert.equal(owned.agent.status, 'idle')
    assert.equal(ctx.agents.get(assignment.worker.session_id), owned.agent)
    await assert.rejects(execution.workspaceLocks.acquire(workspaceRoot, 'competitor'), { code: 'WORKSPACE_BUSY' })
    assert.equal(calls, 0)
    const events = owned.agent.session.snapshotEvents()
    assert.equal(events.filter(e => e.type === 'plugin:kode/official-creation').length, 1)
    assert.equal(events.filter(e => e.type === 'user/message').length, 0)
    const current = await hub.client.call(`${root}/work-assignments/${assignment.id}`)
    assert.equal(current.admission.kind, 'official_remote_host'); assert.equal(current.creation.state, 'created')
    assert.equal((await hub.client.call(`${root}/operations/${op.id}`)).state, 'active')
    await assert.rejects(remote.client.call(`${root}/work-assignments/${assignment.id}`), /404/)
    const waitFor = async (check, label) => {
      const deadline = Date.now() + (label.includes('intervention revalidation') ? 1200000 : (label.includes("verification and delivery") || label.includes("verification process")) ? 600000 : 80000)
      while (!(await check())) {
        assert.ok(Date.now() < deadline && !(label === 'remote model settlement' && calls > 0 && owned.agent.status === 'idle'), `${label}: ${JSON.stringify({ calls, status: owned.agent.status, errors, observedResults, relayTrace: relayTrace.slice(-12), budget: (await hub.client.call(`${root}/budgets/budget`)).budget })}`)
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    await waitFor(async () => (await hub.client.call(`${root}/sessions`)).sessions.some(s => s.address.node_id === remote.node && s.address.session_id === assignment.worker.session_id), 'remote Worker directory')
    const mandatePath = `${root}/work-assignments/${assignment.id}/mandate`
    const mandateCommand = { request_id: `mandate-${assignment.id}`, expected_revision: current.revision }
    const observer = await hub.client.call(`${root}/sessions`, { session_id: 'observer', title: 'Observer', runtime: 'external' })
    await assert.rejects(hub.client.forSession(observer.owner_token).call(mandatePath, mandateCommand), /403/)
    const homeCall = hub.client.call.bind(hub.client)
    let lostMandate = false
    hub.client.call = async (...args) => {
      const result = await homeCall(...args)
      if (args[0] === mandatePath && !lostMandate) { lostMandate = true; throw new Error('fixture lost committed mandate reply') }
      return result
    }
    await assert.rejects(controller.advance('before'), /lost committed mandate reply/)
    assert.equal((await controller.advance('before')).state, 'waiting_remote_host')
    const [mandate, mandateRetry] = await Promise.all([hub.client.call(mandatePath, mandateCommand), hub.client.call(mandatePath, mandateCommand)])
    assert.deepEqual(mandateRetry, mandate)
    assert.equal(mandate.completion_authorized, false)
    await assert.rejects(hub.client.call(mandatePath, { ...mandateCommand, request_id: 'different' }), /identity conflict/)

    await waitFor(async () => (await hub.client.call(`${root}/messages/${mandate.message_id}/delivery`)).delivery?.phase === 'consumed', 'remote consumption receipt')
    if (scenario === 'question') {
      await waitFor(() => calls === 1 && owned.agent.status === 'idle', 'remote question idle')
      const run = await hub.client.call(`${runs}/before`)
      const receipt = run.pending_clarification
      assert.equal(receipt.home_hub, hub.node)
      assert.equal(receipt.worker.node_id, remote.node)
      assert.equal(receipt.assignment_id, assignment.id)
      assert.equal(receipt.request.questions[0].question, 'Which remote scope?')
      assert.equal(lostQuestion, true)
      assert.equal(run.completion_authorized, false)
      assert.equal(profiles.binding(owned.agent.id).clarificationOutbox[receipt.request.call_id].acknowledged, true)
      const scope = { id: assignment.id, host: remote.node, worker: owned.agent.id, operation: assignment.dispatch.command.operation }
      assert.deepEqual((await assignmentHomeCall(remote.client, scope, 'clarification_read', { request_id: receipt.request.request_id })).clarification, receipt)
      await assert.rejects(assignmentHomeCall(remote.client, { ...scope, worker: 'foreign' }, 'clarification_read', { request_id: receipt.request.request_id }), /foreign remote operation/)
      const altered = structuredClone(receipt.request); altered.questions[0].question = 'Different?'
      await assert.rejects(assignmentHomeCall(remote.client, scope, 'clarification', altered), /identity conflict/)
      await hub.stop('SIGKILL'); await hub.start()
      assert.deepEqual(await assignmentHomeCall(remote.client, scope, 'clarification', receipt.request), receipt)
      assert.deepEqual((await assignmentHomeCall(remote.client, scope, 'clarification_read', { request_id: receipt.request.request_id })).clarification, receipt)
      assert.equal((await hub.client.call(`${runs}/before/events`)).events.filter(e => e.data.kind === 'assignment_clarification_requested').length, 1)
      assert.equal((await controller.advance('before')).state, 'waiting_clarification')
      assert.equal(calls, 1)
      return
    }
    if (scenario === 'cancel-busy') {
      await waitFor(() => busyStarted, 'remote busy model start')
      assert.notEqual(owned.agent.status, 'idle')
      let disposals = 0, lostCancel = false
      const dispose = owned.dispose, beforeCancel = hub.client.call.bind(hub.client)
      crashAtStop = async phase => {
        if (process.env.KODE_TEST_CANCEL_CRASH !== phase) return
        if (!process.send) throw new Error('Remote cancellation crash fixture requires IPC')
        process.send({ type: 'cancel-crash-ready', phase, ...resources(), assignment_id: assignment.id, worker_session: assignment.worker.session_id })
        await new Promise(() => {})
      }
      owned.dispose = async () => { disposals++; await crashAtStop('stopping'); return dispose() }
      hub.client.call = async (...args) => {
        const result = await beforeCancel(...args)
        if (args[0] === `${runs}/before` && args[1]?.action === 'request_cancel' && !lostCancel) { lostCancel = true; throw new Error('lost remote cancel request reply') }
        return result
      }
      const live = await hub.client.call(`${runs}/before`)
      const cancel = { action: 'request_cancel', request_id: 'cancel-remote-busy', expected_revision: live.revision, reason: 'Stop running remote model' }
      await assert.rejects(remote.client.call(`${runs}/before`, cancel), /unknown work run|404/)
      await assert.rejects(hub.client.call(`${runs}/before`, cancel), /lost remote cancel request reply/)
      const requested = await hub.client.call(`${runs}/before`, cancel)
      assert.equal(requested.state, 'cancelling'); assert.equal(requested.cancellation.stop_confirmed, false)
      await assert.rejects(remoteService.advance(assignment.worker.session_id), /lost committed stop reply/)
      assert.equal(busyAborted, true); assert.equal(lostStop, true)
      assert.equal(host.handles.has(assignment.worker.session_id), false)
      assert.equal(profiles.binding(assignment.worker.session_id).assignmentStop.state, 'drained')
      const reopened = await new AgentProfiles(profiles.path).open()
      assert.equal(reopened.binding(assignment.worker.session_id).assignmentStop.state, 'drained')
      await remoteService.close()
      remoteService = new RemoteAssignmentService(dispatcher, { intervalMs: 100 })
      remoteService.start()
      await waitFor(() => profiles.binding(assignment.worker.session_id).remoteLifecycle?.phase === 'acknowledged', 'remote cancellation acknowledgement recovery')
      await remoteService.close()
      const drained = await hub.client.call(`${root}/work-assignments/${assignment.id}`)
      assert.equal(drained.stop.receipt.state, 'execution_drained'); assert.equal(drained.stop.receipt.operation.state, 'stopped')
      assert.equal(drained.resources.state, 'held')
      assert.deepEqual(await dispatcher.stop(assignment.id, options), drained.stop.receipt)
      assert.equal(calls, 1); assert.equal(disposals, 1)
      assert.equal((await controller.advance('before')).state, 'waiting_cancellation_accounting')
      const budgetBefore = (await hub.client.call(`${root}/budgets/budget`)).budget
      assert.ok(budgetBefore.reserved > 0)
      await hub.stop('SIGKILL'); await remote.stop('SIGKILL'); await hub.start(); await remote.start()
      assert.deepEqual(await hub.client.call(`${runs}/before`, cancel), requested)
      assert.equal((await hub.client.call(`${runs}/before`)).state, 'cancelling')
      assert.deepEqual((await hub.client.call(`${root}/work-assignments/${assignment.id}`)).stop.receipt, drained.stop.receipt)
      assert.deepEqual((await hub.client.call(`${root}/budgets/budget`)).budget, budgetBefore)
      assert.equal((await controller.advance('before')).state, 'waiting_cancellation_accounting')
      assert.equal(calls, 1); assert.equal(disposals, 1)
      assert.equal(await readFile(join(workspaceRoot, 'source.txt'), 'utf8'), 'remote source')
      const cancelAudit = await hub.client.call(`${runs}/before/events`)
      assert.equal(cancelAudit.events.filter(row => row.data.kind === 'work_run_cancel_requested').length, 1)
      assert.equal(cancelAudit.events.filter(row => row.data.kind === 'assignment_execution_drained').length, 1)
      assert.equal(cancelAudit.events.filter(row => ['work_run_cancelled', 'work_run_delivered'].includes(row.data.kind)).length, 0)
      return
    }
    await waitFor(async () => calls === 4 && owned.agent.status === 'idle' && (await hub.client.call(`${root}/budgets/budget`)).budget.spent === 8, 'remote model settlement')
    assert.deepEqual(errors, [])
    const captured = Object.values(profiles.binding(assignment.worker.session_id).artifactOutbox).find(row => row.evidence.id === 'capture')
    assert.equal(captured.home_reconciled, true)
    assert.equal(captured.home_archive_reconciled, true)
    const bundle = await execution.artifacts.archive.read(captured.archive.snapshot_hash, captured.archive)
    const downloaded = await fetchArtifactArchive(hub.client, captured.home_sequence, captured.archive.snapshot_hash)
    assert.deepEqual(downloaded.bundle, bundle)
    const source = bundle.manifest.find(row => row[0] === 'source.txt')
    assert.equal(Buffer.from(bundle.contents[source[2]], 'base64').toString(), 'remote source')
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(mandatePath, mandateCommand), mandate)
    assert.deepEqual(await dispatcher.dispatch(assignment.id, options), receipt)
    assert.equal(host.handles.get(assignment.worker.session_id), owned)
    const audit = await hub.client.call(`${runs}/before/events`)
    assert.equal(audit.events.filter(e => e.data.kind === 'assignment_creation_receipt').length, 1)
    assert.equal(audit.events.filter(e => e.data.kind === 'assignment_host_admitted').length, 1)
    assert.equal(audit.events.filter(e => e.data.kind === 'assignment_mandate_queued').length, 1)
    assert.equal((await hub.client.call(`${root}/messages/${mandate.message_id}/delivery`)).delivery.phase, 'consumed')
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.spent, 8)
    assert.equal((await controller.advance('before')).state, 'waiting_remote_host')
    const invalidOutputs = { operation_id: op.id, worker_session: assignment.worker.session_id, command: null, accounting: { attempt: op.attempt, action: { kind: 'assignment_outputs', assignment_id: assignment.id, declaration: { request_id: 'invalid', command: assignment.dispatch.command, outputs: { undeclared: captured.home_sequence } } } } }
    await assert.rejects(remote.client.call(`${root}/operation-accounting-relay/${hub.node}`, invalidOutputs), /declaration must be exact/)
    assert.equal((await hub.client.call(`${root}/work-assignments/${assignment.id}`)).output_declaration, undefined)
    const watched = []
    controller.watch('before', { intervalMs: 100, onState: result => watched.push(result) })
    await assert.rejects(remoteService.advance(assignment.worker.session_id), /lost committed outputs reply/)
    const [declared, replayDeclaration] = await Promise.all([dispatcher.declareOutputs(assignment.id, options), dispatcher.declareOutputs(assignment.id, options)])
    assert.deepEqual(declared, replayDeclaration)
    assert.equal(declared.completion_authorized, false)
    assert.deepEqual(declared.outputs, { artifact: captured.home_sequence })
    const declaredAssignment = await hub.client.call(`${root}/work-assignments/${assignment.id}`)
    const declarationRequest = { operation_id: op.id, worker_session: assignment.worker.session_id, command: null, accounting: { attempt: op.attempt, action: { kind: 'assignment_outputs', assignment_id: assignment.id, declaration: declaredAssignment.output_declaration.request } } }
    const remoteObserver = await remote.client.call(`${root}/sessions`, { session_id: 'observer', title: 'Observer', runtime: 'external' })
    await assert.rejects(remote.client.forSession(remoteObserver.owner_token).call(`${root}/operation-accounting-relay/${hub.node}`, declarationRequest), /403/)
    await assert.rejects(remote.client.call(`${root}/operation-accounting-relay/${hub.node}`, { ...declarationRequest, worker_session: 'foreign' }), /foreign/)
    const changedDeclaration = structuredClone(declarationRequest); changedDeclaration.accounting.action.declaration.outputs.artifact++
    await assert.rejects(remote.client.call(`${root}/operation-accounting-relay/${hub.node}`, changedDeclaration), /declaration identity conflict/)
    await waitFor(async () => watched.some(row => row.state === 'evidence_selected'), 'automatic home selection')
    controller.unwatch('before')
    assert.equal(watched.some(row => row.state === 'progression_failed'), false)
    assert.equal((await controller.advance('before')).state, 'waiting_remote_report')
    await writeFile(join(workspaceRoot, 'source.txt'), 'changed after publication')
    await assert.rejects(owned.run.finish(), /Selected artifact no longer matches final workspace/)
    assert.notEqual(profiles.binding(assignment.worker.session_id).operationClosed, true)
    await writeFile(join(workspaceRoot, 'source.txt'), 'remote source')
    await assert.rejects(dispatcher.stop(assignment.id, { homeScope: { ...options.homeScope, operation: { ...options.homeScope.operation, epoch: 99 } } }), /frozen stop home scope mismatch/)
    assert.equal(host.handles.has(assignment.worker.session_id), true)
    await assert.rejects(hub.client.forSession(observer.owner_token).call(`${root}/work-assignments/${assignment.id}/stop-receipt`, { request_id: 'intruder', command: assignment.dispatch.command, kind: 'official_remote_drained' }), /403/)
    remoteService.start()
    await waitFor(async () => profiles.binding(assignment.worker.session_id).remoteLifecycle?.phase === 'acknowledged', 'automatic remote report and drain')
    assert.ok(profiles.binding(assignment.worker.session_id).finalArtifact)
    assert.equal(lostStop, true)
    assert.equal(host.handles.has(assignment.worker.session_id), false)
    const stopped = await dispatcher.stop(assignment.id, options)
    assert.equal(stopped.kind, 'official_remote_drained')
    assert.equal(stopped.state, 'execution_drained')
    assert.equal(stopped.completion_authorized, false)
    assert.equal(stopped.resources_released, false)
    assert.equal(stopped.operation.state, 'reported')
    await assert.rejects(hub.client.call(`${root}/work-assignments/${assignment.id}/stop-receipt`, profiles.binding(assignment.worker.session_id).assignmentStop.request), /stop receipt|Host mismatch/)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await dispatcher.stop(assignment.id, options), stopped)
    const stopAudit = await hub.client.call(`${runs}/before/events`)
    assert.equal(stopAudit.events.filter(e => e.data.kind === 'assignment_execution_drained').length, 1)
    assert.equal(stopAudit.events.find(e => e.data.kind === 'assignment_execution_drained').data.actor.id, remote.node)
    const beforeComplete = await hub.client.call(`${runs}/before`)
    await assert.rejects(controller.advance('before'), /lost committed accounting reply/)
    assert.equal(lostAccounting, true)
    const completed = await controller.advance('before')
    assert.equal(completed.state, 'stage_passed')
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await dispatcher.declareOutputs(assignment.id, options), declared)
    const declarations = (await hub.client.call(`${runs}/before/events`)).events.filter(e => e.data.kind === 'assignment_outputs_declared')
    assert.equal(declarations.length, 1); assert.equal(declarations[0].data.actor.id, remote.node)
    const finalRun = await hub.client.call(`${runs}/before`)
    assert.equal(finalRun.stages.find(stage => stage.stage_id === 'inspect').state, 'passed')
    assert.notEqual(finalRun.state, 'completed', 'configured followup is still required')
    const settledBudget = (await hub.client.call(`${root}/budgets/budget`)).budget
    assert.equal(settledBudget.reserved, 0); assert.equal(settledBudget.spent, 8)
    assert.deepEqual(await hub.client.call(`${runs}/before/stages/inspect/complete`, { request_id: `host-complete-${assignment.id}`, expected_revision: beforeComplete.revision, assignment_id: assignment.id }), completed.receipt)
    const next = await controller.advance('before')
    assert.equal(next.state, 'scheduled')
    const downstream = await hub.client.call(`${root}/work-assignments/${next.assignment_id}`)
    const inputArtifact = downstream.inputs.binding.sources.inspect.outputs.artifact
    const downloadScope = { home: hub.node, assignment_id: downstream.id, worker: downstream.worker.session_id, operation: downstream.dispatch.command.operation }
    const consumerDownload = await fetchArtifactArchive(remote.client, inputArtifact.sequence, inputArtifact.artifact.snapshot_hash, undefined, downloadScope)
    assert.equal(consumerDownload.receipt.archive_hash, inputArtifact.artifact.archive_hash)
    const consumerWorkspace = await execution.artifactWorkspaces.prepare({ request_id: 'remote-input', sequence: inputArtifact.sequence, snapshot_hash: inputArtifact.artifact.snapshot_hash }, { remote: downloadScope })
    consumerRoot = consumerWorkspace.source
    assert.equal(await readFile(join(consumerWorkspace.source, 'source.txt'), 'utf8'), 'remote source')
    assert.equal(consumerWorkspace.execution_authorized, false)
    assert.deepEqual(await execution.artifactWorkspaces.prepare({ request_id: 'remote-input', sequence: inputArtifact.sequence, snapshot_hash: inputArtifact.artifact.snapshot_hash }, { remote: downloadScope }), consumerWorkspace)
    await assert.rejects(fetchArtifactArchive(remote.client, inputArtifact.sequence + 1000000, inputArtifact.artifact.snapshot_hash, undefined, downloadScope), /frozen Assignment input/)
    await assert.rejects(fetchArtifactArchive(remote.client, inputArtifact.sequence, inputArtifact.artifact.snapshot_hash, undefined, { ...downloadScope, worker: 'foreign' }), /foreign/)
    assert.equal((await hub.client.call(`${root}/work-assignments/${downstream.id}`)).input_workspace, undefined, 'materialization alone does not authorize execution')
    assert.equal((await controller.advance('before')).state, 'waiting_remote_host')
    assert.equal((await hub.client.call(`${root}/work-assignments/${downstream.id}`)).resources, undefined)
    const candidates = await dispatcher.discoverRemote(hub.node)
    assert.ok(candidates.items.some(row => row.assignment_id === downstream.id), 'derived preparation discovered before holds')
    const downstreamOptions = { homeScope: { worker_session: downstream.worker.session_id, operation: downstream.dispatch.command.operation } }
    await assert.rejects(dispatcher.dispatch(downstream.id, downstreamOptions), /lost committed workspace reply/)
    assert.equal((await dispatcher.dispatch(downstream.id, downstreamOptions)).state, 'waiting_home_resources')
    assert.equal(host.handles.has(downstream.worker.session_id), false)
    let scopedAssignment = await hub.client.call(`${root}/work-assignments/${downstream.id}`)
    assert.equal(scopedAssignment.input_workspace.receipt.host, remote.node)
    assert.equal(scopedAssignment.input_workspace.receipt.kind, 'official_remote_materialized')
    await assert.rejects(hub.client.call(`${root}/work-assignments/${downstream.id}/workspace-receipt`, scopedAssignment.input_workspace.request), /foreign materialization executor/)
    assert.equal((await controller.advance('before')).state, 'remote_workspace_authorized')
    assert.equal((await controller.advance('before')).state, 'remote_resources_held')
    assert.equal((await dispatcher.dispatch(downstream.id, downstreamOptions)).state, 'created')
    scopedAssignment = await hub.client.call(`${root}/work-assignments/${downstream.id}`)
    assert.equal(scopedAssignment.dispatch.command.cwd, scopedAssignment.input_workspace.receipt.root)
    assert.equal(scopedAssignment.execution_workspace.receipt.scope_authorized, true)
    assert.equal((await hub.client.call(`${runs}/before/events`)).events.filter(row => row.data.kind === 'assignment_input_materialized').length, 1)
    assert.equal(calls, 4, 'derived creation does not execute without a home mandate')
    discovery = new RemoteAssignmentDiscovery(dispatcher, { intervalMs: 100 })
    discovery.start()
    const reviewStates = []
    controller.watch('before', { intervalMs: 100, onState: result => reviewStates.push(result) })
    if (scenario === 'cancel-tool' || takeover) {
      let marker
      await waitFor(async () => {
        assert.equal(reviewStates.some(row => ['progression_failed', 'recovery_required'].includes(row.state)), false, JSON.stringify(reviewStates))
        try { marker = JSON.parse(await readFile(toolMarker, 'utf8')); return marker.state === 'running' }
        catch (error) { if (error.code === 'ENOENT') return false; throw error }
      }, 'remote verification process start')
      const live = await hub.client.call(`${runs}/before`)
      const verifyStage = live.stages.find(row => row.stage_id === 'verify')
      const verifyAssignment = await hub.client.call(`${root}/work-assignments/${verifyStage.assignment_id}`)
      const verifyOwned = host.handles.get(verifyAssignment.worker.session_id)
      assert.ok(verifyOwned); assert.notEqual(verifyOwned.agent.status, 'idle')
      assert.deepEqual(verifyAssignment.resources.exclusive_resources,['fixture-remote-device'])
      assert.equal(verifyAssignment.resources.exclusive_resource_scope,'home')
      assert.equal(verifyAssignment.admission.request.exclusive_resource_scope,'home')
      await assert.rejects(execution.exclusiveResources.acquire(['fixture-remote-device'],'remote-premature-successor'),{code:'EXCLUSIVE_RESOURCE_BUSY'})
      const stopAction = takeover ? 'takeover' : 'request_cancel', stoppedState = takeover ? 'paused' : 'cancelled'
      let disposals = 0, lostCancel = false
      const dispose = verifyOwned.dispose, beforeCancel = hub.client.call.bind(hub.client)
      verifyOwned.dispose = async () => { disposals++; return dispose() }
      lostStop = false
      hub.client.call = async (...args) => {
        const result = await beforeCancel(...args)
        if (args[0] === `${runs}/before` && args[1]?.action === stopAction && !lostCancel) { lostCancel = true; throw new Error('lost remote tool cancel reply') }
        return result
      }
      const cancel = { action: stopAction, request_id: 'cancel-remote-tool', expected_revision: live.revision, reason: 'Stop running remote verification process' }
      await assert.rejects(hub.client.call(`${runs}/before`, cancel), /lost remote tool cancel reply/)
      const requested = await hub.client.call(`${runs}/before`, cancel)
      assert.equal(requested.state, takeover ? 'taking_over' : 'cancelling')
      await waitFor(async () => {
        assert.equal(reviewStates.some(row => ['progression_failed', 'recovery_required'].includes(row.state)), false, JSON.stringify(reviewStates))
        return (await hub.client.call(`${runs}/before`)).state === stoppedState
      }, 'remote verification process cancellation')
      controller.unwatch('before')
      const stoppedRun = await hub.client.call(`${runs}/before`)
      assert.equal(stoppedRun.completion_authorized, false)
      assert.deepEqual(stoppedRun.stages.map(row => row.state), ['passed', 'passed', takeover ? 'ready' : 'cancelled'])
      const stopRecord = takeover ? stoppedRun.intervention : stoppedRun.cancellation
      assert.equal(stopRecord.receipt.assignments.length, 3)
      const drained = await hub.client.call(`${root}/work-assignments/${verifyAssignment.id}`)
      assert.equal(drained.stop.receipt.state, 'execution_drained')
      assert.equal(drained.stop.receipt.operation.state, 'stopped')
      assert.equal(drained.resources.state, 'released'); assert.equal(drained.state, takeover ? 'interrupted' : 'cancelled')
      const successor=await execution.exclusiveResources.acquire(['fixture-remote-device'],'remote-confirmed-successor');await successor.release()
      assert.equal(host.handles.has(verifyAssignment.worker.session_id), false)
      const stopped = JSON.parse(await readFile(toolMarker, 'utf8'))
      assert.equal(stopped.pid, marker.pid); assert.equal(stopped.state, 'stopped')
      assert.throws(() => process.kill(stopped.pid, 0), { code: 'ESRCH' })
      const budgetBefore = (await hub.client.call(`${root}/budgets/budget`)).budget
      assert.equal(budgetBefore.spent, 20); assert.equal(budgetBefore.reserved, 0)
      assert.equal(lostStop, true); assert.equal(disposals, 1); assert.equal(calls, 10)
      await hub.stop('SIGKILL'); await remote.stop('SIGKILL'); await hub.start(); await remote.start()
      assert.deepEqual(await controller.advance('before'), { state: stoppedState, run_id: 'before', receipt: stopRecord.receipt })
      assert.deepEqual(await hub.client.call(`${runs}/before`, cancel), requested)
      assert.deepEqual((await hub.client.call(`${root}/budgets/budget`)).budget, budgetBefore)
      assert.deepEqual((await hub.client.call(`${root}/work-assignments/${verifyAssignment.id}`)).stop.receipt, drained.stop.receipt)
      assert.equal(calls, 10); assert.equal(disposals, 1)
      // A lease revocation can reach ToolRuntime before the Agent loop receives
      // cancellation. Its normalized error remains an uncertain historical tool
      // outcome. Require that exact stopped Worker and home-recorded evidence.
      assert.deepEqual(errors, runtimeErrors.map(row => row.message))
      assert.ok(runtimeErrors.length <= 1)
      for (const error of runtimeErrors) {
        assert.equal(error.session, verifyAssignment.worker.session_id)
        assert.equal(error.message, 'Official tool outcome requires reconciliation')
        const interruptedTool = Object.values(profiles.binding(error.session).officialTools ?? {}).find(row => row.tool === 'kode_verify_output' && row.status === 'uncertain')
        assert.ok(interruptedTool)
        assert.equal(interruptedTool.operation_id, verifyAssignment.dispatch.command.operation.id)
        assert.equal(interruptedTool.home_reconciled, true)
        assert.ok(Number.isSafeInteger(interruptedTool.home_sequence))
      }
      errors.length = 0; runtimeErrors.length = 0
      if (takeover) {
        const oldAssignments = stoppedRun.stages.map(stage => stage.assignment_id)
        await writeFile(join(workspaceRoot, 'owner-note.txt'), 'Owned remote workspace intervention')
        resuming = true; observedResults = []
        const resumed = await hub.client.call(`${runs}/before`, { action: 'resume', request_id: 'resume-remote', expected_revision: stoppedRun.revision, reason: 'Revalidate the remote workspace after manual intervention' })
        assert.equal(resumed.state, 'waiting_resource')
        assert.ok(resumed.stages.every(stage => stage.state === 'pending' && stage.assignment_id === null && stage.evidence === undefined))
        const resumedStates = []
        controller.watch('before', { intervalMs: 100, onState: result => resumedStates.push(result) })
        await waitFor(async () => {
          assert.ok(!resumedStates.some(row => ['progression_failed', 'recovery_required'].includes(row.state)), JSON.stringify(resumedStates))
          return (await hub.client.call(`${runs}/before`)).state === 'completed'
        }, 'remote intervention revalidation and delivery')
        const completed = await hub.client.call(`${runs}/before`)
        assert.equal(completed.id, stoppedRun.id); assert.equal(completed.completion_authorized, true)
        assert.deepEqual(completed.stages.map(stage => [stage.state, stage.attempt]), [['passed', 2], ['passed', 2], ['passed', 2]])
        assert.ok(completed.stages.every(stage => !oldAssignments.includes(stage.assignment_id)))
        const assignments = await Promise.all(completed.stages.map(stage => hub.client.call(`${root}/work-assignments/${stage.assignment_id}`)))
        assert.equal(new Set(assignments.map(assignment => assignment.worker.session_id)).size, 3)
        assert.ok(assignments.every(assignment => assignment.state === 'completed' && assignment.resources.state === 'released'))
        const review = assignments.find(assignment => assignment.stage_id === 'followup')
        assert.equal(await readFile(join(review.input_workspace.receipt.root, 'owner-note.txt'), 'utf8'), 'Owned remote workspace intervention')
        assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved, 0)
        assert.equal(calls, 22)
        const audit = await hub.client.call(`${runs}/before/events`)
        for (const kind of ['work_run_takeover_requested', 'work_run_paused', 'work_run_resumed', 'work_run_delivered']) assert.equal(audit.events.filter(row => row.data.kind === kind).length, 1)
        assert.deepEqual(errors, [])
        return
      }
      const audit = await hub.client.call(`${runs}/before/events`)
      assert.equal(audit.events.filter(row => row.data.kind === 'work_run_cancel_requested').length, 1)
      assert.equal(audit.events.filter(row => row.data.kind === 'work_run_cancelled').length, 1)
      assert.equal(audit.events.filter(row => row.data.kind === 'work_run_delivered').length, 0)
      return
    }
    await waitFor(async () => {
      assert.equal(errors.length, 0, JSON.stringify(errors))
      const uncertainTools = Object.values(profiles.bindings).flatMap(binding => Object.values(binding.officialTools ?? {})).filter(row => row.status === 'uncertain').map(row => ({ tool: row.tool, call_id: row.call_id, reason: row.reason }))
      assert.deepEqual(uncertainTools, [], 'unexpected uncertain tool execution')
      assert.equal(reviewStates.some(row => ['progression_failed', 'recovery_required'].includes(row.state)), false, JSON.stringify(reviewStates))
      return reviewStates.some(row => row.state === 'completed')
    }, 'remote independent review, verification and delivery')
    const deliveredRun = await hub.client.call(`${runs}/before`)
    assert.equal(deliveredRun.state, 'completed')
    assert.equal(deliveredRun.stages.find(row => row.stage_id === 'followup').state, 'passed')
    const reviewedAssignment = await hub.client.call(`${root}/work-assignments/${downstream.id}`)
    assert.equal(reviewedAssignment.state, 'completed'); assert.equal(reviewedAssignment.resources.state, 'released')
    assert.equal(reviewedAssignment.stop.receipt.final_input.source_sequence, inputArtifact.sequence)
    assert.notEqual(reviewedAssignment.worker.session_id, assignment.worker.session_id)
    const reviewBudget = (await hub.client.call(`${root}/budgets/budget`)).budget
    assert.equal(reviewBudget.spent, 24); assert.equal(reviewBudget.reserved, 0)
    const verificationStage = deliveredRun.stages.find(row => row.stage_id === 'verify')
    assert.equal(verificationStage.state, 'passed')
    const verificationAssignment = await hub.client.call(`${root}/work-assignments/${verificationStage.assignment_id}`)
    assert.notEqual(verificationAssignment.worker.session_id, reviewedAssignment.worker.session_id)
    assert.notEqual(verificationAssignment.worker.session_id, assignment.worker.session_id)
    const verificationArchive = await hub.client.call(`${root}/verification-records/${verificationStage.evidence.outputs.checked}`)
    assert.ok(verificationArchive.result_json.length > 200000)
    assert.equal(JSON.parse(verificationArchive.result_json).observed.passed, true)
    assert.equal(verificationAssignment.resources.state, 'released')
    assert.deepEqual(verificationAssignment.resources.exclusive_resources,['fixture-remote-device'])
    assert.equal(verificationAssignment.resources.exclusive_resource_scope,'home')
    assert.equal(verificationAssignment.admission.request.exclusive_resource_scope,'home')
    const resourceSuccessor=await execution.exclusiveResources.acquire(['fixture-remote-device'],'remote-completed-successor');await resourceSuccessor.release()
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual((await controller.advance('before')).receipt, deliveredRun.delivery)
    assert.deepEqual(await hub.client.call(`${root}/verification-records/${verificationStage.evidence.outputs.checked}`), verificationArchive)
    await host.close(); host = undefined
    const released = await execution.workspaceLocks.acquire(workspaceRoot, 'after-close'); await released.release()
    const persisted = await ctx.sessionPersistence.open(assignment.worker.session_id, 'read')
    try {
      const stored = await persisted.read()
      assert.equal(stored.events.filter(e => e.type === 'plugin:kode/official-creation').length, 1)
      assert.equal(stored.events.filter(e => e.type === 'user/message').length, 1)
    } finally { await persisted.close() }
    const disk = await new AgentProfiles(profiles.path).open()
    assert.equal(disk.binding(assignment.worker.session_id).managedOperation.home_node, hub.node)
    assert.equal(disk.binding(assignment.worker.session_id).officialDispatch[assignment.id].state, 'created')
    const afterClose = await hub.client.call(`${root}/work-assignments/${assignment.id}`)
    assert.deepEqual(afterClose.stop.receipt, stopped)
    assert.equal(afterClose.resources.state, 'released')
    assert.equal(afterClose.state, 'completed')

    assert.equal(calls, 12)
    // Close only this fixture's execution services and stop its remote Hub. All
    // following reads must be satisfied by the restarted Home's own records.
    await discovery?.close(); discovery = undefined
    await remoteService?.close(); remoteService = undefined
    await controller?.close(); controller = undefined
    await dispatcher?.close(); dispatcher = undefined
    await execution?.close(); execution = undefined
    await remote.stop('SIGKILL')
    await assert.rejects(fetch(remote.url, { signal: AbortSignal.timeout(1000) }))
    await verifyHomeTrace(hub,await hub.client.call(`${runs}/before`),undefined,{suffix:'remote-offline',searchTool:'kode_read_source'})
    assert.deepEqual((await fetchArtifactArchive(hub.client,captured.home_sequence,captured.archive.snapshot_hash)).bundle,bundle)
    assert.deepEqual(await hub.client.call(`${root}/verification-records/${verificationStage.evidence.outputs.checked}`),verificationArchive)
    assert.equal(calls,12,'offline trace must not invoke a model')
  } finally { await discovery?.close(); await remoteService?.close(); await controller?.close(); await dispatcher?.close(); await host?.close(); await execution?.close(); await ctx.fiber.dispose(); await hub.close(); for (const name of await readdir(join(remote.root, 'artifact-workspaces')).catch(error => { if (error.code === 'ENOENT') return []; throw error })) { await chmod(join(remote.root, 'artifact-workspaces', name, 'source'), 0o700).catch(error => { if (error.code !== 'ENOENT') throw error }) } await remote.close() }
})

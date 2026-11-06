import { inspectNativeEvidence } from './support/collab-evidence-browser.js'
import { readAssignmentOutputs } from '../src/assignment-outputs.js'
import { WorkRunService } from '../src/work-run-service.js'
import { WorkRunController } from '../src/work-run-controller.js'
import { VerificationRunners, verificationExecutableHash } from '../src/verification-runners.js'
import { prepareAssignmentArtifact } from '../src/assignment-artifact-workspace.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile, realpath, readFile, chmod, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { managedCodexRoute } from '../src/managed-codex-profile.js'
import { isolatedHub } from './support/isolated-hub.js'
import { apply as applyHost } from '../src/host.js'
import { AgentProfiles, profileRevision, writePrivateJson } from '../src/agent-profiles.js'
import { OfficialExecution } from '../src/official-execution.js'
import { AssignmentDispatchHost } from '../src/assignment-dispatch-host.js'
import { OfficialLoopHost } from '../src/official-loop-host.js'
import { OfficialToolPolicies, officialGrantGuard } from '../src/official-grant-guard.js'
import { acquireOperationLease } from '../src/operation-lease.js'
const loopRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { default: Tools } = await import(loopRequire.resolve('@deepseek-ai/dsh-tools'))

for (const pump of [false, 'lost-reply', 'uncertain', 'mandate', 'resource-off', 'final-artifact', 'stage-complete', 'downstream', 'verification', 'pipeline', 'pipeline-external', 'model-tools', 'rework']) for (const cliMode of (pump === 'model-tools' ? [false, true, ...(process.env.KODE_TEST_PROVIDER_FALLBACK ? [process.env.KODE_TEST_PROVIDER_FALLBACK] : [])] : [false])) test(`actual Host admits Assignment, delivers creation receipt and fences revocation (pump=${pump}, cli=${cliMode})`, { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 60000 }, async () => {
  const providerFallbackMode = typeof cliMode === 'string' && cliMode.startsWith('provider-fallback-')
  const providerFallbackInvalid = cliMode === 'provider-fallback-invalid'
  const providerFallbackDrainMode = ['provider-fallback-delayed', 'provider-fallback-tail-conflict', 'provider-fallback-stalled'].includes(cliMode)
  const providerFallbackTailConflict = cliMode === 'provider-fallback-tail-conflict'
  const providerFallbackStalled = cliMode === 'provider-fallback-stalled'
  const providerFallbackNoEffects = providerFallbackTailConflict || providerFallbackStalled
  const providerFallbackAlias = cliMode === 'provider-fallback-alias'
  const questionMode = cliMode && (providerFallbackMode || process.env.KODE_TEST_CLI_QUESTION === '1')
  const reworkMode = pump === 'rework'
  const modelToolMode = pump === 'model-tools'
  const externalDelivery = pump === 'pipeline-external'
  const pipelineMode = pump === 'pipeline' || externalDelivery || modelToolMode || reworkMode
  const independentMode = ['downstream', 'verification', 'pipeline', 'pipeline-external', 'model-tools', 'rework'].includes(pump)
  const completeMode = ['stage-complete', 'downstream', 'verification', 'pipeline', 'pipeline-external', 'model-tools', 'rework'].includes(pump)
  const finalArtifactMode = ['final-artifact', 'stage-complete', 'downstream', 'verification', 'pipeline', 'pipeline-external', 'model-tools', 'rework'].includes(pump)
  const mandateMode = ['mandate', 'resource-off', 'final-artifact', 'stage-complete', 'downstream', 'verification', 'pipeline', 'pipeline-external', 'model-tools', 'rework'].includes(pump)
  const hub = await isolatedHub('official-assignment'), ctx = new Context()
  const materializedSources = []
  const scheduled = []
  let nativeProvider, fixtureAdapter, execution, host, dispatcher, releaseHeldTool, downstreamWorkspace, reviewCompletion, verificationRecord, deliveryReceipt, controller, runService
  try {
    await mkdir(join(hub.root, 'repo'))
    const workspaceRoot = await realpath(join(hub.root, 'repo'))
    if (mandateMode) {
      const git = args => promisify(execFile)('/usr/bin/git', ['-C', workspaceRoot, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' } })
      await git(['init', '-q']); await writeFile(join(workspaceRoot, 'source.txt'), 'fixture source')
      await git(['add', '.']); await git(['commit', '-qm', 'fixture base'])
    }
    let heldToolFinished, enteredHeldTool
    const heldToolEntered = new Promise(resolve => { enteredHeldTool = resolve })
    let stageCompletion
    let accountingReceipt
    let stopReceipt
    let selectedEvidence
    const provider = cliMode ? managedCodexRoute('profile') : 'fixture'
    if (cliMode) {
      nativeProvider = createServer((request, response) => {
        void (async () => {
          const chunks = []
          for await (const bytes of request) chunks.push(bytes)
          const body = JSON.parse(Buffer.concat(chunks))
          if (questionMode) {
            inferenceCalls++
            if (!process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE && !providerFallbackMode) { response.end('fixture'); return }
            const item = { type: 'function_call', id: 'question-item', call_id: 'question-call', name: 'request_user_input', status: 'completed',
              arguments: JSON.stringify({ questions: [{ id: 'scope', header: 'Scope', question: 'Which scope?', options: [{ label: 'Current', description: 'Use the current scope' }, { label: 'Other', description: 'Owner must clarify' }] }] }) }
            const result = { id: 'question-response', object: 'response', created_at: 1, model: providerFallbackAlias ? 'provider-label' : body.model, status: 'completed', output: [item],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: providerFallbackInvalid ? 3 : 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
            response.writeHead(200, { 'content-type': 'text/event-stream' })
            for (const event of [{ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
              { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item },
              { type: 'response.completed', response: result }]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            if (providerFallbackTailConflict) {
              const tail = { ...result, id: 'question-response-tail', output: [],
                usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }
              setTimeout(() => {
                response.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: tail })}\n\n`)
                response.end()
              }, 25)
              return
            }
            if (providerFallbackStalled) return
            if (providerFallbackDrainMode && !providerFallbackStalled) setTimeout(() => response.end(), 80)
            else response.end()
            return
          }
          let messages = body.fixture_messages
          if (!messages) {
            for (const item of body.input ?? []) for (const part of item.content ?? []) {
              if (part.type !== 'input_text') continue
              try { const parsed = JSON.parse(part.text); if (Array.isArray(parsed)) messages = parsed } catch {}
            }
          }
          assert.ok(Array.isArray(messages), 'CLI provider receives original workflow history')
          const [sessionId] = execution.managedCodex.active.keys()
          const output = []
          for await (const chunk of fixtureAdapter.stream({ sessionId, provider, model: body.model,
            messages, tools: body.tools, signal: new AbortController().signal })) output.push(chunk)
          if (body.fixture_messages) {
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({ chunks: output }))
            return
          }
          const call = output.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')?.block
          const item = call ? { type: 'function_call', id: `fc_${inferenceCalls}`, call_id: call.id, name: call.name, arguments: call.arguments, status: 'completed' }
            : { type: 'message', id: `msg_${inferenceCalls}`, role: 'assistant', status: 'completed', content: output.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'text').map(chunk => ({ type: 'output_text', text: chunk.block.text, annotations: [] })) }
          const counters = output.find(chunk => chunk.type === 'usage').usage
          const result = { id: `response_${inferenceCalls}`, object: 'response', created_at: 1, model: body.model, status: 'completed', output: [item],
            usage: { input_tokens: counters.inputTokens, output_tokens: counters.outputTokens, total_tokens: counters.inputTokens + counters.outputTokens,
              input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          for (const event of [{ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
            { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item },
            { type: 'response.completed', response: result }]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          response.end()
        })().catch(error => {
          console.error('Managed CLI fixture provider failed', error.message)
          response.writeHead(500); response.end('{}')
        })
      })
      await new Promise(resolve => nativeProvider.listen(0, '127.0.0.1', resolve))
    }
    const useInstalledEngine = Boolean(cliMode) && !providerFallbackMode && Boolean(process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE)
    const profile = cliMode ? { id: 'profile', name: 'CLI Worker', type: 'codex', executable: useInstalledEngine ? process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE : process.execPath,
      args: useInstalledEngine ? [] : [fileURLToPath(new URL('./fixture-managed-codex-decision.js', import.meta.url))],
      env: { KODE_MANAGED_FIXTURE_MODE: questionMode ? 'question' : 'provider', ...(questionMode ? { KODE_MANAGED_FIXTURE_SMALL_USAGE: '1', ...((providerFallbackMode || process.env.KODE_TEST_QUESTION_NO_USAGE === '1') ? { KODE_MANAGED_FIXTURE_NO_USAGE: '1' } : {}), ...(providerFallbackDrainMode ? { KODE_MANAGED_FIXTURE_CLOSE_AFTER_TERMINAL: '1' } : {}) } : {}) }, defaultModel: 'model',
      managedInference: { endpoint: `http://127.0.0.1:${nativeProvider.address().port}/responses` } }
      : { id: 'profile', name: 'Official', type: 'dsh' }
    const profiles = await new AgentProfiles(join(hub.root, 'profiles.json')).open([profile])
    const root = '/api/v1/messaging', path = `${root}/teams/team/activation`, runs = `${root}/work-runs`
    const versionRef = r => ({ id: r.id, version: r.version, hash: r.hash })
    const policyRef = r => ({ id: r.id, revision: r.revision, hash: r.hash })
    const readRun = () => hub.client.call(`${runs}/before`)
    const readRunRevision = async () => (await readRun()).revision
    const workspace = { host_id: hub.node, workspace_id: 'workspace', root_ref: workspaceRoot }
    let verificationDefinition, verificationReference
    if (pump === 'verification' || pipelineMode) {
      const executable = await realpath(process.execPath)
      verificationDefinition = { runner_id: 'local-check', command_id: 'snapshot-check', revision: '1', executable,
        executable_hash: await verificationExecutableHash(executable), args: ['-e', `const fs=require('node:fs');if(fs.readFileSync('source.txt','utf8')!==${JSON.stringify(reworkMode ? 'repaired source' : 'fixture source')})process.exit(3);process.stdout.write('verified fixture source'+'x'.repeat(200000))`],
        env: {}, timeout_ms: 5000, max_output_bytes: 262144, scenario_ids: ['smoke'], capabilities: ['read'], network: false, tool_id: 'fixture_inspect' }
      const registry = new VerificationRunners(join(hub.root,'verification-runs'))
      verificationReference = registry.register(verificationDefinition); await registry.close()
    }
    if (reworkMode) await hub.client.call(`${root}/price-versions`, { id: 'price', model: 'model', unit: 'credits', model_policy: 'requested_model', input_per_million: 1000000, cached_per_million: 1000000, output_per_million: 1000000 })
    const workflow = await hub.client.call(`${root}/workflows`, { id: 'flow', version: '1', inputs: ['request'],
      stages: [{ id: 'inspect', role: 'coordinator', requires: ['request'], produces: ['artifact'], independent_from: [], execution: { task_tag: 'inspection', repository_binding: 'code', capabilities: modelToolMode || reworkMode ? ['read', 'workspace_write'] : ['read'], tools: reworkMode ? ['fixture_inspect', 'kode_capture_output', 'kode_write_source', 'kode_read_source', 'kode_publish_output'] : modelToolMode ? ['fixture_inspect', 'kode_capture_output', 'kode_write_source'] : ['fixture_inspect'], network: false } },
        { id: 'followup', ...(reworkMode ? { on_reject: { target: 'inspect', max_reworks: 1 } } : {}), role: 'coordinator', requires: ['inspect'], produces: ['later'], independent_from: independentMode ? ['inspect'] : [], execution: { task_tag: 'inspection', repository_binding: 'code', capabilities: ['read'], tools: reworkMode ? ['fixture_inspect', 'kode_review_output', 'kode_read_source', 'kode_publish_output'] : modelToolMode ? ['fixture_inspect', 'kode_review_output', 'kode_list_source', 'kode_read_source'] : ['fixture_inspect'], network: false } },
        ...(pipelineMode ? [{ id: 'verify', role: 'coordinator', requires: ['followup'], produces: ['checked'], independent_from: ['inspect', 'followup'], execution: { task_tag: 'inspection', repository_binding: 'code', capabilities: ['read'], tools: ['fixture_inspect', 'kode_verify_output', 'kode_publish_output'], network: false } }] : [])],
      completion_stages: [pipelineMode ? 'verify' : 'followup'], evidence_rules: { ...(pipelineMode ? { checked: { kind: 'verification', artifact_output: 'artifact', command_binding: 'check', environment_binding: 'local', required_scenarios: ['smoke'] } } : {}), artifact: { kind: 'artifact', repository_binding: 'code' }, later: pump === 'verification' ? { kind: 'verification', artifact_output: 'artifact', command_binding: 'check', environment_binding: 'local', required_scenarios: ['smoke'] } : independentMode ? { kind: 'review', artifact_output: 'artifact' } : { kind: 'artifact', repository_binding: 'code' } } })
    const project = await hub.client.call(`${root}/project-configs`, { id: 'project', version: '1', spec: { kind: 'project_bindings',
      repositories: { code: { repository_id: 'repository', workspace } }, environments: verificationReference ? { local: { host_id: hub.node, adapter_id: 'local_process_v1', configuration_hash: verificationReference.environment_hash } } : {},
      commands: verificationReference ? { check: { id: verificationReference.id, revision: verificationReference.revision, definition_hash: verificationReference.definition_hash,
        repository_binding: 'code', environment_binding: 'local', runner_id: verificationReference.runner_id, scenario_ids: verificationReference.scenario_ids } } : {}, connections: externalDelivery ? { forge: { adapter_id: 'fixture-forge', connection_id: 'fixture-connection', capabilities: ['create_change_request'] } } : {} } })
    const delivery = await hub.client.call(`${root}/project-configs`, { id: 'delivery', version: '1', spec: { kind: 'delivery_policy',
      workflow: versionRef(workflow), project: versionRef(project), targets: externalDelivery ? [{ kind: 'change_request', repository_binding: 'code', connection_binding: 'forge', target_branch: 'main' }] : [{ kind: 'local', repository_binding: 'code' }], required_outputs: pipelineMode ? ['checked'] : ['artifact'] } })
    await hub.client.call(`${root}/budgets`, { id: 'budget', scope: 'team', scope_id: 'team', unit: 'credits', limit: 100,
      starts_at: Date.now() - 1000, ends_at: Date.now() + 60000, expected_revision: 0 })
    const budgetCommand = { id: 'budget-policy', team_id: 'team', expected_revision: 0,
      policy: { kind: 'budget', budget_ids: ['budget'], unit: 'credits', max_assignment_charge: 10, ...(mandateMode ? { settlement: 'internal_price' } : {}) } }
    const budget = await hub.client.call(`${root}/team-policies`, budgetCommand)
    const scheduleCommand = { id: 'schedule-policy', team_id: 'team', expected_revision: 0,
      policy: { kind: 'scheduling', targets: { target: { resource: { host: hub.node, profile: 'profile', account_id: 'account', account_epoch: 1,
        binding_revision: 1, limit_ids: ['daily'], unknown_quota: 'team_budget' }, capability_id: 'capability', capability_revision: 1, preferred: false, ...(reworkMode ? { internal_price_id: 'price' } : {}) } },
      weights: { quality: 100, cost: 50, latency: 20 }, minimum_quality: 60, minimum_confidence: 0.7 } }
    if (pipelineMode) {
      scheduleCommand.policy.targets['aaa-alternate'] = structuredClone(scheduleCommand.policy.targets.target)
      scheduleCommand.policy.targets.target.preferred = true
    }
    const schedule = await hub.client.call(`${root}/team-policies`, scheduleCommand)
    const spec = { name: 'Team', purpose: 'Fixture', kind: 'coordinator', workspace_refs: [workspace],
      execution_targets: [{ id: 'target', host_id: hub.node, executor_profile_id: 'profile', executor_profile_revision: profileRevision(profiles.get('profile')), provider_id: provider, model_id: 'model', effort: null,
        account_binding_id: 'account', capability_profile_revision: '1' }], workers: [], coordinator_targets: ['target'], workflow_pack_refs: [versionRef(workflow)],
      delivery_bindings: [{ id: 'local', workflow: versionRef(workflow), project: versionRef(project), delivery_policy: versionRef(delivery) }],
      grant_id: 'grant', budget_policy_id: 'budget-policy', scheduling_policy_id: 'schedule-policy',
      limits: { max_active_assignments: completeMode ? 1 : 2, max_active_runs: 8 }, proactive_mode: 'off' }
    if (pipelineMode) {
      spec.execution_targets.push({ ...spec.execution_targets[0], id: 'aaa-alternate' })
      spec.coordinator_targets.unshift('aaa-alternate')
    }
    await hub.client.call(`${root}/teams`, { id: 'team', request_id: 'new', expected_revision: 0, spec })
    const grantCommand = { expected_revision: 0, policy: { id: 'grant', team_id: 'team', enabled: true, expires_at: Date.now() + 60000,
      targets: [{ host: hub.node, workspace: 'workspace', root: workspaceRoot }], capabilities: modelToolMode || reworkMode ? ['read', 'workspace_write'] : ['read'], tools: pipelineMode ? ['fixture_inspect', 'kode_verify_output', 'kode_publish_output', ...(modelToolMode || reworkMode ? ['kode_capture_output', 'kode_review_output', 'kode_list_source', 'kode_read_source', 'kode_write_source'] : [])] : ['fixture_inspect'], network: false, budget_ids: ['budget'] } }
    let grant = (await hub.client.call(`${root}/team-grants`, grantCommand)).grant
    const request = { id: 'before', request_id: 'before', team_id: 'team', team_revision: 1, binding_id: 'local', inputs: { request: mandateMode ? 'Inspect ' + 'context '.repeat(900) + 'FULL_INPUT_END' : 'Inspect' }, prior_run_id: null }
    const initial = await hub.client.call(runs, request)
    const command = { action: 'activate', request_id: 'activate', expected_revision: 0, team_revision: 1, grant_revision: grant.revision,
      budget_policy: policyRef(budget), scheduling_policy: policyRef(schedule) }

    await hub.client.call(`${root}/resource-accounts`, { id: 'account', expected_epoch: 0, enabled: true })
    await hub.client.call(`${root}/assignment-capacities`, { account_id: 'account', expected_revision: 0, max_active_assignments: 1 })
    await hub.client.call(path, command)
    const preparePath = `${runs}/before/stages/inspect/assignments`
    const beforePrepare = await readRun()
    const prepare = { request_id: 'prepare', expected_revision: beforePrepare.revision, target_id: 'target', worker_id: null }
    await assert.rejects(hub.client.call(preparePath, prepare), /not recommended/)
    assert.equal((await readRun()).revision, beforePrepare.revision, 'rejected preparation does not mutate the run')
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved, 0)
    await hub.client.call(`${root}/resource-bindings`, { host: hub.node, profile: 'profile', account_id: 'account', account_epoch: 1, expected_revision: 0 })
    const at = Date.now()
    await hub.client.call(`${root}/capability-profiles`, { id: 'capability', expected_revision: 0, host: hub.node, profile: 'profile', model: 'model', assessments: {
      fit: { evaluation: { kind: 'task_fit', tag: 'inspection', score: 80 }, source: 'user', confidence: 0.9, evidence: [], pinned: false, updated_at: at - 1000, valid_until: at + 60000 },
    } })

    const { assignment } = await hub.client.call(preparePath, prepare), op = assignment.bundle.operation
    assert.deepEqual(assignment.inputs.binding.sources, {})
    assert.deepEqual(assignment.inputs.binding.external, request.inputs)
    const assignmentPath = `${root}/work-assignments/${assignment.id}`
    let executionWorkspaceRoot = workspaceRoot
    const executionRootFor = async sessionId => {
      const managedAssignmentId = profiles.binding(sessionId)?.managedAssignment?.id
      if (!managedAssignmentId) return workspaceRoot
      const current = await hub.client.call(`${root}/work-assignments/${managedAssignmentId}`)
      return current.execution_workspace?.receipt?.root ?? current.dispatch?.command?.cwd ?? workspaceRoot
    }
    if (!pump) await hub.client.call(`${assignmentPath}/resources`, { request_id: 'resources', expected_revision: 1 })
    const registration = await hub.client.call(`${root}/sessions`, { session_id: assignment.worker.session_id, title: 'Worker', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const admissionRequest = { request_id: 'intruder', expected_revision: 2, worker_session: assignment.worker.session_id, profile_revision: profileRevision(profiles.get('profile')), provider, model: 'model', effort: null, tools: ['fixture_inspect'], root: workspaceRoot }
    await assert.rejects(worker.call(`${assignmentPath}/admit`, admissionRequest), /403/)
    await assert.rejects(hub.client.call(`${assignmentPath}/admit`, { ...admissionRequest, expected_revision: pump ? 1 : 2, model: 'wrong' }), /evidence mismatch/)
    if (!pump) {
    await profiles.bind(assignment.worker.session_id, 'profile')
    await profiles.patchBinding(assignment.worker.session_id, { managedOperation: { id: op.id, attempt: op.attempt, epoch: op.epoch }, managedAssignment: { id: assignment.id } })
    }
    await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(Projections)
    await ctx.plugin(await import('@deepseek-ai/dsh-session-persistence-jsonl'), { root: join(hub.root, 'sessions'), compression: 'zstd' })
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false }); await ctx.plugin(Tools); await ctx.plugin(LlmRuntime)
    ctx.provide('workspaceRegistry', { list: () => [{ id: 'workspace', path: workspaceRoot }] })
    ctx.provide('kodeOfficialToolPolicies', new OfficialToolPolicies())
    if (!mandateMode) ctx.provide('kodeOperationLeases', { acquire: (agent, binding, signal, admission) => acquireOperationLease(worker, binding,
      { node_id: hub.node, session_id: agent.id, profile_id: 'profile', grant_enforcement: true }, { signal, leaseMs: 10000, beforeClaim: admission.beforeClaim }) })
    let inferenceCalls = 0, inferenceMessages, modelVerification, modelPublication
    let autoRework = false
    const modelSteps = new Map()
    const errors = []
    ctx.on('agent/error', event => {
      errors.push(event.error.message)
      if (cliMode && event.error.toolDiagnostic) console.error('Managed CLI tool admission', event.error.toolDiagnostic)
    })
    class Fixture extends LlmAdapter { async *stream(options) {
      inferenceCalls++
      if (!mandateMode) throw new Error('unexpected inference')
      inferenceMessages = options.messages
      if (autoRework) {
        const names = options.tools.map(tool => tool.name)
        const role = names.includes('kode_capture_output') ? 'implementation' : names.includes('kode_review_output') ? 'review' : 'verification'
        const step = modelSteps.get(options.sessionId) ?? 0
        modelSteps.set(options.sessionId, step + 1)
        let previous
        if (step > 0) {
          const message = options.messages.find(m => m.role === 'tool' && m.source?.callId === `auto-${step - 1}`)
          assert.ok(message, `${role} consumes previous actual tool result`)
          previous = JSON.parse(message.content.filter(b => b.type === 'text').map(b => b.text).join(''))
        }
        let tool, args
        if (role === 'implementation') {
          if (step === 0) {
            assert.ok(JSON.stringify(options.messages).includes('rework'), 'new Worker receives immutable failure feedback')
            tool = 'kode_read_source'; args = { path: 'source.txt' }
          } else if (step === 1) {
            assert.equal(previous.text, 'fixture source')
            tool = 'kode_write_source'; args = { path: 'source.txt', expected_sha256: previous.sha256, content: 'repaired source' }
          } else if (step === 2) {
            assert.equal(previous.state, 'written')
            tool = 'kode_capture_output'; args = { output: 'artifact', request_id: 'repaired-artifact' }
          } else if (step === 3) {
            assert.equal(previous.archive_status, 'home_archived')
            tool = 'kode_publish_output'; args = { output: 'artifact', evidence_id: previous.evidence_id }
          } else { assert.equal(step, 4); assert.equal(previous.completion_authorized, false) }
        } else if (role === 'review') {
          if (step === 0) { tool = 'kode_read_source'; args = { path: 'source.txt' } }
          else if (step === 1) {
            assert.equal(previous.text, 'repaired source')
            tool = 'kode_review_output'; args = { output: 'later', request_id: 'repaired-review', verdict: 'passed', findings: [] }
          } else if (step === 2) {
            tool = 'kode_publish_output'; args = { output: 'later', evidence_id: previous.evidence_id }
          } else { assert.equal(step, 3); assert.equal(previous.completion_authorized, false) }
        } else {
          if (step === 0) { tool = 'kode_verify_output'; args = { output: 'checked', request_id: 'repaired-verify' } }
          else if (step === 1) {
            assert.equal(previous.verdict, 'passed'); assert.equal(previous.log_archive_status, 'home_archived')
            tool = 'kode_publish_output'; args = { output: 'checked', evidence_id: previous.evidence_id }
          } else { assert.equal(step, 2); assert.equal(previous.completion_authorized, false) }
        }
        if (tool) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `auto-${step}`, name: tool, arguments: JSON.stringify(args) } }
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
      }
      if (modelToolMode) {
        const names = options.tools.filter(tool => tool.name.startsWith('kode_')).map(tool => tool.name).sort()
        const expected = names.includes('kode_capture_output') ? ['kode_capture_output', 'kode_write_source']
          : names.includes('kode_review_output') ? ['kode_list_source', 'kode_read_source', 'kode_review_output'] : ['kode_publish_output', 'kode_verify_output']
        assert.deepEqual(names, expected, 'only the current stage workflow tools are advertised')
      }
      if (modelToolMode && options.tools?.some(tool => tool.name === 'kode_write_source')) {
        const step = modelSteps.get(options.sessionId) ?? 0
        modelSteps.set(options.sessionId, step + 1)
        if (step === 0) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'model-write-source', name: 'kode_write_source', arguments: JSON.stringify({ path: 'implemented.txt', content: 'initial implementation', expected_sha256: null }) } }
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        assert.equal(step, 1, 'implementation write is not replayed by inference')
        const message = options.messages.find(m => m.role === 'tool' && m.source?.callId === 'model-write-source')
        assert.ok(message, 'implementation model receives actual filesystem write result')
        const value = JSON.parse(message.content.filter(b => b.type === 'text').map(b => b.text).join(''))
        assert.equal(value.state, 'written'); assert.match(value.sha256, /^[a-f0-9]{64}$/)
      }
      if (modelToolMode && options.tools?.some(tool => tool.name === 'kode_read_source')) {
        const step = modelSteps.get(options.sessionId) ?? 0
        modelSteps.set(options.sessionId, step + 1)
        if (step > 0) {
          const message = options.messages.find(m => m.role === 'tool' && m.source?.callId === `source-${step - 1}`)
          assert.ok(message, 'review model receives actual source tool result')
          const value = JSON.parse(message.content.filter(b => b.type === 'text').map(b => b.text).join(''))
          if (step === 1) assert.ok(value.entries.some(entry => entry.name === 'source.txt' && entry.kind === 'file'))
          else { assert.equal(step, 2); assert.equal(value.text, 'fixture source'); assert.match(value.sha256, /^[a-f0-9]{64}$/) }
        }
        if (step < 2) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `source-${step}`, name: step === 0 ? 'kode_list_source' : 'kode_read_source', arguments: JSON.stringify({ path: step === 0 ? '.' : 'source.txt' }) } }
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
      }
      if (modelToolMode && options.tools?.some(tool => tool.name === 'kode_verify_output')) {
        const step = modelSteps.get(options.sessionId) ?? 0
        modelSteps.set(options.sessionId, step + 1)
        const result = callId => {
          const message = options.messages.find(m => m.role === 'tool' && m.source?.callId === callId)
          assert.ok(message, `model received result for ${callId}`)
          return JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
        }
        if (step < 2) {
          if (step === 1) {
            modelVerification = result('model-verify-stage')
            assert.equal(modelVerification.verdict, 'passed')
            assert.equal(modelVerification.log_archive_status, 'home_archived')
          }
          const name = step === 0 ? 'kode_verify_output' : 'kode_publish_output'
          const args = step === 0 ? { request_id: 'pipeline-check', output: 'checked' } : { output: 'checked', evidence_id: modelVerification.evidence_id }
          assert.ok(options.tools.some(tool => tool.name === name))
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: step === 0 ? 'model-verify-stage' : 'model-publish-stage', name, arguments: JSON.stringify(args) } }
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        assert.equal(step, 2, 'no unintended model retry')
        modelPublication = result('model-publish-stage')
        assert.equal(modelPublication.sequence, modelVerification.sequence)
        assert.equal(modelPublication.completion_authorized, false)
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture stage inspected; evidence validation remains pending.' } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
    fixtureAdapter = new Fixture()
    ctx.llm.registerAdapter(['fixture'], fixtureAdapter)
    execution = new OfficialExecution(ctx, profiles, hub.client, { host: hub.node }); if (verificationDefinition) execution.verificationRunners.register(verificationDefinition); host = new OfficialLoopHost(ctx, execution)
    if (mandateMode) {
      ctx.provide('kodeAgents', { profiles, officialExecution: execution })
      const stateFile = join(hub.root, 'host-state.json')
      await writePrivateJson(stateFile, { [assignment.worker.session_id]: registration.owner_token })
      await applyHost(ctx, { url: hub.url, tokenFile: join(hub.root, 'admin.token'), stateFile, agentRuntime: false, runtimeBridge: false, pollMs: 10 })
      if (!reworkMode) await hub.client.call(`${root}/price-versions`, { id: 'price', model: 'model', unit: 'credits', model_policy: 'requested_model', input_per_million: 1000000, cached_per_million: 1000000, output_per_million: 1000000 })
      if (!reworkMode) await hub.client.call(`${root}/budget-reservations/${assignment.bundle.reservation.request.id}/pricing`, { price_id: 'price' })
      else assert.equal(assignment.pricing.price_id, 'price')
      if (reworkMode) {
        await hub.client.call(`${root}/price-versions`, { id: 'other-price', model: 'model', unit: 'credits', input_per_million: 1, cached_per_million: 1, output_per_million: 1 })
        await assert.rejects(hub.client.call(`${root}/budget-reservations/${assignment.bundle.reservation.request.id}/pricing`, { price_id: 'other-price' }), /pricing is immutable/)
      }
    }
    let setups = 0
    const setup = (agentCtx, agent) => { setups++; agentCtx.effect(() => {
      const tools = agentCtx.get('tools').forScope(agentCtx)
      const remove = tools.register({ name: 'fixture_inspect', description: 'Read fixture', parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async (_args, request) => {
          const currentWorkspaceRoot = await executionRootFor(agent.id)
          await assert.rejects(execution.workspaceLocks.acquire(currentWorkspaceRoot, 'competitor'), { code: 'WORKSPACE_BUSY' })
          if (mandateMode && request.callId.startsWith('capture')) return JSON.stringify(await execution.artifacts.capture(agent.id,
            profiles.binding(agent.id).managedOperation, request.callId, { workspaceRoot: currentWorkspaceRoot, repositoryId: request.callId === 'capture-wrong' ? 'other' : 'repository' }))
          if (request.callId === 'held-read') await new Promise(resolve => { releaseHeldTool = resolve; enteredHeldTool() })
          return 'read'
        } })
      const unpolicy = agentCtx.get('kodeOfficialToolPolicies').register('fixture_inspect', { capabilities: ['read'], network: false, workspaceLock: true,
        implementation: tools.get('fixture_inspect', agent), authorize: async () => true }, agent)
      return () => { unpolicy(); remove() }
    })
    }
    if (!pump) {
    const blocker = await execution.workspaceLocks.acquire(workspaceRoot, 'external')
    try {
      await assert.rejects(host.create({ sessionId: assignment.worker.session_id, agentOptions: { provider, model: 'model' }, meta: { cwd: workspaceRoot }, setup }, { tools: ['fixture_inspect'] }), { code: 'WORKSPACE_BUSY' })
      assert.equal((await hub.client.call(`${root}/operations/${op.id}`)).state, 'prepared')
      assert.equal((await hub.client.call(assignmentPath)).dispatch.state, 'blocked')
      assert.equal(ctx.agents.get(assignment.worker.session_id), undefined)
    } finally { await blocker.release() }
    }
    if (pump) {
      dispatcher = new AssignmentDispatchHost(host)
      const queue = `${root}/assignment-dispatches?host=${hub.node}`
      assert.equal((await hub.client.call(queue)).items.length, 1)
      await assert.rejects(worker.call(queue), /403/)
      await assert.rejects(worker.call(`${assignmentPath}/creation`, { request_id: 'intruder', command: assignment.dispatch.command, state: 'created' }), /403/)
      await assert.rejects(hub.client.call(`${assignmentPath}/creation`, { request_id: 'premature', command: assignment.dispatch.command, state: 'created' }), /no Host admission/)
      // Drop the response after the Hub commits. Local creation must not run again.
      if (pump === 'uncertain') {
        const update = profiles.update.bind(profiles)
        let failCreated = true
        profiles.update = operation => update(async state => {
          const result = await operation(state)
          if (result?.state === 'created' && failCreated) { failCreated = false; throw new Error('fixture interrupted creation receipt write') }
          return result
        })
      }
      const call = hub.client.call.bind(hub.client)
      let dropped = false
      hub.client.call = async (...args) => {
        const result = await call(...args)
        if (pump === 'lost-reply' && args[0] === `${assignmentPath}/creation` && !dropped) { dropped = true; throw new Error('fixture lost creation receipt') }
        return result
      }
      const first = mandateMode ? [await dispatcher.dispatch(assignment.id, { setup })] : await dispatcher.drain({ prepare: async () => ({ setup }) })
      assert.equal(first[0].state, mandateMode ? 'created' : 'delivery_failed')
      assert.equal(dropped, pump === 'lost-reply')
      if (pump === 'uncertain') {
        assert.equal((await hub.client.call(assignmentPath)).creation.state, 'uncertain')
        assert.equal((await hub.client.call(queue)).items.length, 1)
      }
      const receipts = await Promise.all([dispatcher.dispatch(assignment.id, { setup }), dispatcher.dispatch(assignment.id, { setup })])
      assert.deepEqual(receipts[0], receipts[1]); assert.equal(receipts[0].state, 'created')
      assert.equal(setups, 1, 'lost receipt never creates another Agent')
      assert.equal((await hub.client.call(queue)).items.length, 0)
      const currentAssignment = await hub.client.call(assignmentPath)
      await assert.rejects(hub.client.call(`${assignmentPath}/creation`, { request_id: 'downgrade', command: currentAssignment.dispatch.command, state: 'uncertain' }), /cannot downgrade/)
    } else {
      const receipt = await host.dispatches.dispatch(assignment.dispatch.command, { setup })
      assert.equal(receipt.state, 'created')
    }
    const owned = host.handles.get(assignment.worker.session_id)
    if (cliMode) {
      const raw = { sessionId: owned.agent.id, provider, model: 'model', messages: [], tools: [] }
      await assert.rejects(async () => { for await (const _ of ctx.llm.stream(raw)) {} }, /requires controlled execution/)
      await assert.rejects(async () => { for await (const _ of execution.managedCodex.streamBound(profiles.get('profile'), raw)) {} }, /no admitted call/)
      assert.equal(inferenceCalls, 0)
    }
    const admitted = await hub.client.call(assignmentPath)
      executionWorkspaceRoot = admitted.execution_workspace?.receipt?.root ?? admitted.dispatch.command.cwd ?? workspaceRoot
    assert.equal(admitted.dispatch.state, 'ready')
    assert.equal(admitted.admission.request.profile_revision, profileRevision(profiles.get('profile')))
    assert.equal((await hub.client.call(`${root}/operations/${op.id}`)).state, 'active')
    await assert.rejects(execution.workspaceLocks.acquire(executionWorkspaceRoot, 'competitor'), { code: 'WORKSPACE_BUSY' })
    const result = await owned.run.execute({ agent: owned.agent, name: 'fixture_inspect', callId: 'inspect', arguments: {} })
    assert.equal(result.isError, false)
    assert.equal(inferenceCalls, 0)
    await assert.rejects(hub.client.call(`${root}/artifact-evidence`, { id: 'early', operation_id: op.id, attempt: op.attempt, epoch: op.epoch,
      payload: { kind: 'artifact', snapshot: { repository_id: 'repository', base_revision: 'a'.repeat(40), tree_hash: 'b'.repeat(64), patch_hash: 'c'.repeat(64), artifact_hashes: {} } } }), /consumed mandate/)
    const consume = async options => {
      const prepared = await owned.run.prepareCall({ provider, model: 'model' })
      for await (const _ of prepared.stream({ sessionId: owned.agent.id, provider, model: 'model', ...options })) {}
    }
    await assert.rejects(consume({ messages: [{ id: 'unbound', role: 'user', content: [{ type: 'text', text: 'Run before mandate' }] }] }), /model input has no mandate/)
    assert.equal(inferenceCalls, 0)
    if (mandateMode) {
      const observer = await hub.client.call(`${root}/sessions`, { session_id: 'observer', title: 'Observer', runtime: 'external' })
      await assert.rejects(hub.client.forSession(observer.owner_token).call(`${assignmentPath}/mandate`, { request_id: 'intruder', expected_revision: admitted.revision }), /403/)
      const call = hub.client.call.bind(hub.client)
      let droppedMandate = false
      hub.client.call = async (...args) => {
        const result = await call(...args)
        if (args[0] === `${assignmentPath}/mandate` && !droppedMandate) { droppedMandate = true; throw new Error('fixture lost mandate receipt') }
        return result
      }
      await assert.rejects(dispatcher.start(assignment.id, { setup }), /lost mandate receipt/)
      const replies = await Promise.all([dispatcher.start(assignment.id, { setup }), dispatcher.start(assignment.id, { setup })])
      assert.deepEqual(replies[0], replies[1])
      const messageId = replies[0].mandate.message_id
      const deadline = Date.now() + 10000
      let delivery
      do {
        delivery = (await hub.client.call(`${root}/messages/${messageId}/delivery`)).delivery
        if (delivery?.phase === 'consumed') break
        assert.ok(Date.now() < deadline, JSON.stringify(errors))
        await new Promise(resolve => setTimeout(resolve, 20))
      } while (true)
      await owned.agent.whenIdle()
      if (questionMode) {
        assert.equal(inferenceCalls, 1)
        assert.deepEqual(errors, providerFallbackNoEffects ? ['Managed CLI inference dispatch failed'] : [])
        const questionCall = Object.values(profiles.binding(owned.agent.id).officialCalls).at(-1)
        const callReceipt = await hub.client.call(`${root}/official-calls/${questionCall.request.call_id}`)
        assert.equal(callReceipt.state, 'finished')
        const missingQuestionUsage = providerFallbackInvalid || providerFallbackNoEffects
          || (process.env.KODE_TEST_QUESTION_NO_USAGE === '1' && !providerFallbackMode)
        assert.equal(callReceipt.accounting_status, missingQuestionUsage ? 'usage_unresolved' : 'estimated_pending_reconciliation')
        const persistence = await ctx.get('sessionPersistence').open(owned.agent.id, 'read')
        try {
          const records = (await persistence.read(0, 4096)).events.map(pluginRecordOf).filter(Boolean)
          const decision = records.find(record => record.type === 'plugin:kode/managed-cli-decision')?.data
          if (providerFallbackMode) {
            assert.equal(decision?.usage_evidence?.source ?? null, missingQuestionUsage ? null : 'codex_admitted_provider_response')
            assert.equal(decision?.stop?.process_group_empty, true, 'provider usage fallback is published only after process stop')
            if (!missingQuestionUsage) {
              const start = records.find(record => record.type === 'plugin:kode/managed-cli-start')?.data
              assert.equal(decision.usage_evidence.response_id, 'question-response')
              assert.equal(decision.usage_evidence.native_thread_id, start.configuration.native_thread_id)
              assert.equal(decision.usage_evidence.native_turn_id, 'managed-turn', 'provider usage is bound to the fixture process turn')
              assert.equal(decision.usage_evidence.requested_model, questionCall.request.model)
              assert.equal(decision.usage_evidence.reported_model, providerFallbackAlias ? 'provider-label' : questionCall.request.model)
              assert.equal(decision.usage_evidence.model_basis, 'requested_model_unverified')
              assert.equal(decision.configuration.inference_verified, false)
              assert.equal(decision.usage.input_tokens, 1)
              assert.equal(decision.usage.output_tokens, 1)
            } else if (providerFallbackNoEffects) {
              assert.equal(decision?.usage, null)
              assert.equal(decision?.usage_evidence, null)
              // Under load the observer may see the conflicting tail either before
              // or after peer-close handling; both paths fail closed without usage.
              const expectedFailureCodes = providerFallbackTailConflict
                ? ['managed_cli_upstream_tail_invalid', 'managed_cli_inference_failed']
                : ['managed_cli_upstream_drain_timeout']
              assert.ok(expectedFailureCodes.includes(decision?.failure_code), decision?.failure_code)
            } else {
              assert.equal(decision?.usage, null)
              assert.equal(decision?.failure_code, 'worker_clarification_required')
              assert.ok(decision?.owner_question?.length, 'invalid provider usage cannot erase an independently valid clarification')
            }
          }
        } finally { await persistence.close() }
        const callEventsPath = `${root}/official-calls/${questionCall.request.call_id}/events`
        const callEventsBeforeRestart = await hub.client.call(callEventsPath)
        assert.equal(callEventsBeforeRestart.events.filter(event => event.kind === 'usage').length, missingQuestionUsage ? 0 : 1)
        if (!missingQuestionUsage) assert.deepEqual(callEventsBeforeRestart.events.find(event => event.kind === 'usage').usage,
          { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 })
        const budgetAfterUsage = await hub.client.call(`${root}/budgets/budget`)
        assert.equal(budgetAfterUsage.budget.spent, missingQuestionUsage ? 0 : 2, 'only the valid provider receipt charges one metered 1+1-token call')
        assert.equal(budgetAfterUsage.budget.reserved, missingQuestionUsage ? 10 : 8,
          'invalid or absent usage leaves the assignment hold intact; valid usage consumes exactly two credits')
        const nextRequest = { ...questionCall.request, call_id: 'after-question-admission' }
        if (missingQuestionUsage) {
          await assert.rejects(hub.client.call(`${root}/official-calls`, nextRequest), /requires reconciliation/)
        } else {
          const next = await hub.client.call(`${root}/official-calls`, nextRequest)
          assert.equal(next.call.state, 'started')
          await hub.client.call(`${root}/official-calls/${nextRequest.call_id}/events`, {
            sequence: 1, kind: 'finished', reason: 'controlled_admission_check',
            usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 },
          })
        }
        if (providerFallbackNoEffects) {
          assert.equal((await hub.client.call(`${runs}/before`)).pending_clarification ?? null, null)
          assert.equal(callEventsBeforeRestart.events.filter(event => event.kind === 'usage').length, 0)
          const savedCall = await hub.client.call(`${root}/official-calls/${questionCall.request.call_id}`)
          const budgetBeforeRestart = await hub.client.call(`${root}/budgets/budget`)
          await hub.stop('SIGKILL'); await hub.start()
          assert.deepEqual(await hub.client.call(`${root}/official-calls/${questionCall.request.call_id}`), savedCall)
          assert.deepEqual((await hub.client.call(callEventsPath)).events, callEventsBeforeRestart.events)
          assert.deepEqual(await hub.client.call(`${root}/budgets/budget`), budgetBeforeRestart)
          assert.equal((await hub.client.call(`${runs}/before`)).pending_clarification ?? null, null)
          return
        }
        const run = await hub.client.call(`${runs}/before`)
        const receipt = run.pending_clarification
        assert.ok(receipt, JSON.stringify(profiles.binding(owned.agent.id).clarificationOutbox))
        assert.equal(receipt.worker.session_id, owned.agent.id)
        assert.equal(receipt.assignment_id, assignment.id)
        assert.equal(receipt.request.questions[0].question, 'Which scope?')
        assert.equal(receipt.completion_authorized, false)
        const endpoint = `${assignmentPath}/clarifications`
        assert.deepEqual(await hub.client.call(endpoint, receipt.request), receipt)
        await assert.rejects(hub.client.call(endpoint, { ...receipt.request, questions: [{ id: 'scope', question: 'Different question' }] }), /conflict/)
        await assert.rejects(hub.client.forSession(observer.owner_token).call(endpoint, receipt.request), /403/)
        await assert.rejects(hub.client.call(`${runs}/before/delivery`, { request_id: 'question-delivery', expected_revision: run.revision }))
        const budgetBeforeRestart = await hub.client.call(`${root}/budgets/budget`)
        await hub.stop('SIGKILL'); await hub.start()
        assert.deepEqual((await hub.client.call(`${endpoint}/${receipt.request.request_id}`)).clarification, receipt)
        assert.equal((await hub.client.call(`${runs}/before`)).completion_authorized, false)
        assert.equal((await hub.client.call(`${runs}/before/events`)).events.filter(event => event.data.kind === 'assignment_clarification_requested').length, 1)
        assert.deepEqual((await hub.client.call(callEventsPath)).events, callEventsBeforeRestart.events, 'restart does not duplicate provider usage events')
        assert.deepEqual(await hub.client.call(`${root}/budgets/budget`), budgetBeforeRestart, 'restart does not duplicate usage charges')
        return
      }
      assert.deepEqual(errors, [])
      assert.equal(inferenceCalls, modelToolMode ? 2 : 1)
      assert.ok(JSON.stringify(inferenceMessages).includes('FULL_INPUT_END'), 'complete mandate bypasses ordinary peer preview truncation')
      const message = await hub.client.call(`${root}/messages/${messageId}`)
      const payload = JSON.parse(message.content)
      const spoof = await hub.client.forSession(observer.owner_token).call(`${root}/messages`, { target: assignment.worker, content: message.content, idempotency_key: 'unbound-copy' })
      const spoofDeadline = Date.now() + 3000
      while ((await hub.client.call(`${root}/messages/${spoof.id}`)).status !== 'uncertain') {
        assert.ok(Date.now() < spoofDeadline, 'unbound copied mandate must not enter the Worker')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      await owned.agent.whenIdle()
      assert.equal(inferenceCalls, modelToolMode ? 2 : 1, 'copied content under a different message ID is not a mandate')
      assert.equal(payload.inputs.request, request.inputs.request)
      assert.equal(payload.repository.repository_id, 'repository')
      assert.equal(payload.worker_user_contact, false)
      assert.equal(payload.operation.id, op.id)
      assert.equal((await hub.client.call(`${runs}/before`)).completion_authorized, false)
      assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.spent, modelToolMode ? 4 : 2)
      assert.equal(owned.agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.id === delivery.input_id).length, 1)
      const evidencePath = `${runs}/before/stages/inspect/evidence`
      const capture = async callId => {
        if (modelToolMode && callId === 'capture-valid') {
          await assert.rejects(owned.run.execute({ agent: owned.agent, name: 'kode_capture_output', callId: 'capture-override', arguments: { output: 'artifact', request_id: callId, repository: 'foreign' } }), /arguments exceed grant/)
          const result = JSON.parse((await owned.run.execute({ agent: owned.agent, name: 'kode_capture_output', callId: 'capture-stage-tool', arguments: { output: 'artifact', request_id: callId } })).value)
          assert.equal(result.archive_status, 'home_archived')
          return Object.values(profiles.binding(owned.agent.id).artifactOutbox).find(row => row.evidence.id === result.evidence_id)
        }
        return JSON.parse((await owned.run.execute({ agent: owned.agent, name: 'fixture_inspect', callId, arguments: {} })).content[0].text)
      }
      if (modelToolMode) {
        const write = async (callId, args) => JSON.parse((await owned.run.execute({ agent: owned.agent, name: 'kode_write_source', callId, arguments: args })).value)
        const created = await write('write-source-create', { path: 'implemented.txt', content: 'initial implementation', expected_sha256: null })
        assert.equal(created.state, 'already_present', 'model already created these exact bytes')
        const args = { path: 'implemented.txt', content: 'revised implementation', expected_sha256: created.sha256 }
        const revised = await write('write-source-replace', args)
        assert.equal(revised.state, 'written')
        assert.equal((await write('write-source-observe', args)).state, 'already_present')
        assert.equal(await readFile(join(await executionRootFor(owned.agent.id), 'implemented.txt'), 'utf8'), args.content)
        assert.equal(await readFile(join(workspaceRoot, 'source.txt'), 'utf8'), 'fixture source')
        await assert.rejects(readFile(join(workspaceRoot, 'implemented.txt')), { code: 'ENOENT' })
      }
      const wrong = await capture('capture-wrong'), captured = await capture('capture-valid')
      assert.equal(captured.home_reconciled, true)
      assert.equal(captured.home_archive_reconciled, true)
      const restored = await execution.artifactWorkspaces.prepare({ request_id: 'downstream-source', sequence: captured.home_sequence, snapshot_hash: captured.snapshot_hash })
      if (modelToolMode) assert.equal(await readFile(join(restored.source, 'implemented.txt'), 'utf8'), 'revised implementation')
      materializedSources.push(restored.source)
      assert.notEqual(restored.source, workspaceRoot)
      assert.equal(restored.execution_authorized, false)
      assert.equal((await readFile(join(restored.source, 'source.txt'))).toString(), 'fixture source')
      const archived = await execution.artifacts.archive.read(captured.archive.snapshot_hash, captured.archive)
      assert.deepEqual(archived.snapshot, captured.evidence.payload.snapshot)
      const source = archived.manifest.find(row => row[0] === 'source.txt')
      assert.equal(Buffer.from(archived.contents[source[2]], 'base64').toString(), 'fixture source')
      const replayedCapture = await execution.artifacts.capture(owned.agent.id, profiles.binding(owned.agent.id).managedOperation, 'capture-valid', {
        workspaceRoot: '/nonexistent-fixture', repositoryId: 'repository',
      })
      assert.deepEqual(replayedCapture, captured, 'capture retry uses durable archived bytes without reopening the workspace')
      if (pump === 'resource-off') {
        await hub.client.call(`${root}/resource-accounts`, { id: 'account', expected_epoch: 1, enabled: false })
        assert.equal((await hub.client.call(`${root}/operations/${op.id}`)).resource_available, false)
        await owned.run.finish()
        assert.equal((await hub.client.call(`${root}/operations/${op.id}`)).state, 'reported')
        await assert.rejects(owned.run.prepareCall({ provider, model: 'model' }))
      }
      const beforeSelection = await hub.client.call(`${runs}/before`)
      const selection = { request_id: 'select', expected_revision: beforeSelection.revision, assignment_id: assignment.id, outputs: { artifact: captured.home_sequence } }
      await assert.rejects(hub.client.forSession(observer.owner_token).call(evidencePath, selection), /403/)
      await assert.rejects(hub.client.call(evidencePath, { ...selection, outputs: { artifact: wrong.home_sequence } }), /frozen bindings/)
      await assert.rejects(hub.client.call(evidencePath, { ...selection, outputs: { extra: captured.home_sequence } }), /must be exact/)
      assert.equal((await hub.client.call(`${runs}/before`)).revision, beforeSelection.revision)
      const selections = await Promise.all([hub.client.call(evidencePath, selection), hub.client.call(evidencePath, selection)])
      assert.deepEqual(selections[0], selections[1]); selectedEvidence = selections[0]
      const selectedOutput = await hub.client.call(`${runs}/before/stages/inspect/outputs/artifact`)
      assert.equal(selectedOutput.sequence, captured.home_sequence)
      assert.deepEqual(selectedOutput.evidence, captured.evidence)
      assert.equal(selectedOutput.assignment_id, assignment.id)
      assert.equal(selectedOutput.completion_authorized, false)
      if (pump === 'final-artifact' && process.env.KODE_TEST_BROWSER_BIN) await inspectNativeEvidence(hub, selectedOutput.evidence.payload)

      assert.equal(selectedEvidence.run_revision, beforeSelection.revision + 1, 'first selection advances exactly one WorkRun revision')
      assert.equal(selectedEvidence.binding_context, 'frozen_workrun')
      assert.equal(selectedEvidence.completion_authorized, false)
      await assert.rejects(hub.client.call(evidencePath, { ...selection, outputs: { artifact: wrong.home_sequence } }), /identity conflict/)
      await assert.rejects(hub.client.call(evidencePath, { ...selection, request_id: 'replace', expected_revision: await readRunRevision() }), /already selected/)
      const frozenRun = await readRun()
      assert.equal(frozenRun.revision, selectedEvidence.run_revision, 'negative selection replays do not advance WorkRun revision')
      assert.equal(frozenRun.stages.find(row => row.stage_id === 'inspect').state, 'ready', 'selection is not finalization')
      assert.equal((await hub.client.call(`${runs}/before/stages/followup/plan`)).candidates.length, 0)
      if (completeMode) await assert.rejects(hub.client.call(`${runs}/before/stages/inspect/complete`, {
        request_id: 'too-early', expected_revision: await readRunRevision(), assignment_id: assignment.id,
      }), /final artifact and reported stop required/)
      if (finalArtifactMode) {
        await writeFile(join(executionWorkspaceRoot, 'source.txt'), 'changed after selection')
        await assert.rejects(owned.run.finish(), /Selected artifact no longer matches/)
        assert.equal((await hub.client.call(`${root}/operations/${op.id}`)).state, 'active')
        assert.equal(profiles.binding(owned.agent.id).finalArtifact, undefined)
        await assert.rejects(execution.workspaceLocks.acquire(executionWorkspaceRoot, 'failed-final-check'), { code: 'WORKSPACE_BUSY' })
        await writeFile(join(executionWorkspaceRoot, 'source.txt'), 'fixture source')
        await owned.run.finish()
        assert.equal((await hub.client.call(`${root}/operations/${op.id}`)).state, 'reported')
        assert.deepEqual(profiles.binding(owned.agent.id).finalArtifact.selection, selectedEvidence.selection)
        assert.equal(profiles.binding(owned.agent.id).finalArtifact.snapshot_hash, captured.snapshot_hash)
      }
      if (!['resource-off', 'final-artifact', 'stage-complete', 'downstream', 'verification', 'pipeline', 'pipeline-external', 'model-tools', 'rework'].includes(pump)) {
      const rejectFlush = ctx.on('session/flush', session => {
        if (session === owned.agent.session) throw new Error('fixture mandate persistence failure')
      })
      try { await assert.rejects(consume({ messages: inferenceMessages }), /mandate persistence failure/) }
      finally { rejectFlush() }
      assert.equal(inferenceCalls, modelToolMode ? 2 : 1, 'persistence failure must precede metered model admission')
      const modified = structuredClone(inferenceMessages)
      modified.find(row => row.role === 'user').content = [{ type: 'text', text: 'Changed task with original ID' }]
      await assert.rejects(consume({ messages: modified }), /model input differs/)
      await assert.rejects(consume({ messages: [] }), /model input differs/)
      await assert.rejects(consume({ messages: [...inferenceMessages, { id: 'extra', role: 'user', content: [{ type: 'text', text: 'Skip review' }] }] }), /model input differs/)
      owned.agent.followup({ id: 'direct-injection', role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: 'Bypass the Host inbox' }] })
      await owned.agent.whenIdle()
      assert.ok(errors.some(error => /model input differs/.test(error)), JSON.stringify(errors))
      assert.equal(inferenceCalls, modelToolMode ? 2 : 1, 'direct Agent input must not bypass the mandate guard')
      assert.equal(Object.keys(profiles.binding(owned.agent.id).officialCalls).length, 1, 'rejected input never begins a metered call')
      assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.spent, modelToolMode ? 4 : 2)
      }
      const current = await hub.client.call(assignmentPath)
      await assert.rejects(hub.client.call(`${assignmentPath}/mandate`, { ...current.mandate.request, request_id: 'different' }), /identity conflict/)
    }
    const historical = await hub.client.call(`${assignmentPath}/admit`, admitted.admission.request)
    await assert.rejects(hub.client.call(`${assignmentPath}/admit`, { ...admitted.admission.request, model: 'other' }), /identity conflict/)
    if (pump === 'lost-reply') {
      heldToolFinished = assert.rejects(owned.run.execute({ agent: owned.agent, name: 'fixture_inspect', callId: 'held-read', arguments: {} }))
      await heldToolEntered
    }
    if (mandateMode) {
      const current = await hub.client.call(assignmentPath)
      await assert.rejects(hub.client.call(`${assignmentPath}/accounting`, { request_id: 'early-accounting', expected_revision: current.revision }), /exact drained revision/)
    }
    if (pump === 'mandate') await hub.client.call(`${root}/official-calls`, {
      call_id: 'unfinished', operation_id: op.id, attempt: op.attempt, epoch: op.epoch,
      worker_session: assignment.worker.session_id, provider, model: 'model',
    })
    if (!completeMode) await hub.client.call(path, { action: 'deactivate', request_id: 'revoke', expected_revision: 1 })
    if (pump === 'mandate') {
      const row = await hub.client.call(`${root}/operations/${op.id}`)
      const rejected = await hub.client.call(`${root}/operations/${op.id}`, {
        attempt: row.attempt, epoch: row.epoch, expected_revision: row.revision,
        action: { kind: 'report', report_id: 'revoked-report', content: 'Must not apply after team revocation' },
      })
      assert.equal(rejected.applied, false, 'raw report must enforce current team authority')
      assert.notEqual(rejected.operation.state, 'reported')
    }
    if (mandateMode) {
      const beforeRevokedSelection = await readRun()
      await assert.rejects(hub.client.call(`${runs}/before/stages/inspect/evidence`, {
        request_id: 'select-after-revoke', expected_revision: beforeRevokedSelection.revision, assignment_id: assignment.id, outputs: selectedEvidence.selection.outputs,
      }), completeMode ? /already selected/ : /assignment authority unavailable/)
      assert.equal((await readRun()).revision, beforeRevokedSelection.revision, 'revoked selection must not mutate the run')
    }
    assert.equal((await hub.client.call(`${root}/operations/${op.id}`)).grant_available, completeMode)
    await assert.rejects(owned.run.prepareCall({ provider, model: 'model' }))
    if (pump) {
      const currentAssignment = await hub.client.call(assignmentPath)
      const request = { request_id: `stop-${assignment.id}`, command: currentAssignment.dispatch.command, kind: 'official_local_drained' }
      const stopObserver = await hub.client.call(`${root}/sessions`, { session_id: 'stop-observer', title: 'Observer', runtime: 'external' })
      await assert.rejects(hub.client.forSession(stopObserver.owner_token).call(`${assignmentPath}/stop-receipt`, request), /403/)
      await assert.rejects(hub.client.call(`${assignmentPath}/stop-receipt`, { ...request, command: { ...request.command, session_id: 'wrong' } }), /identity or creation mismatch/)
      if (finalArtifactMode) {
        const proof = profiles.binding(owned.agent.id).finalArtifact
        await assert.rejects(hub.client.call(`${assignmentPath}/stop-receipt`, { ...request, final_artifact: { ...proof, snapshot_hash: '0'.repeat(64) } }), /snapshot or archive mismatch/)
        await assert.rejects(hub.client.call(`${assignmentPath}/stop-receipt`, { ...request, final_artifact: { ...proof, selection: { ...proof.selection, outputs: {} } } }), /selection mismatch/)
        assert.equal((await hub.client.call(assignmentPath)).stop, undefined)
      }
      const call = hub.client.call.bind(hub.client), dispose = owned.dispose
      let lost = false, disposals = 0
      owned.dispose = async () => { disposals++; return dispose() }
      hub.client.call = async (...args) => {
        const result = await call(...args)
        if (args[0] === `${assignmentPath}/stop-receipt` && !lost) { lost = true; throw new Error('fixture lost stop receipt') }
        return result
      }
      const stopped = assert.rejects(dispatcher.stop(assignment.id), /lost stop receipt/)
      if (pump === 'lost-reply') {
        if (!owned.run.signal.aborted) await new Promise(resolve => owned.run.signal.addEventListener('abort', resolve, { once: true }))
        await assert.rejects(execution.workspaceLocks.acquire(executionWorkspaceRoot, 'while-draining'), { code: 'WORKSPACE_BUSY' })
        assert.equal((await hub.client.call(assignmentPath)).stop, undefined, 'in-flight action prevents stop receipt')
        releaseHeldTool()
        await heldToolFinished
      }
      await stopped
      assert.equal(profiles.binding(owned.agent.id).assignmentStop.state, 'drained')
      assert.equal(host.handles.has(owned.agent.id), false)
      const receipts = await Promise.all([dispatcher.stop(assignment.id), dispatcher.stop(assignment.id)])
      assert.deepEqual(receipts[0], receipts[1]); stopReceipt = receipts[0]
      assert.equal(disposals, 1, 'lost receipt must not repeat disposal')
      assert.equal(stopReceipt.operation.state, ['resource-off', 'final-artifact', 'stage-complete', 'downstream', 'verification', 'pipeline', 'pipeline-external', 'model-tools', 'rework'].includes(pump) ? 'reported' : 'stopped')
      assert.equal(stopReceipt.completion_authorized, false)
      assert.equal(stopReceipt.resources_released, false)
      assert.equal(stopReceipt.external_effects, 'not_attested')
      assert.deepEqual(stopReceipt.final_artifact, finalArtifactMode ? profiles.binding(owned.agent.id).finalArtifact : null)
      if (completeMode) await assert.rejects(hub.client.call(`${runs}/before/stages/inspect/complete`, {
        request_id: 'unsettled', expected_revision: await readRunRevision(), assignment_id: assignment.id,
      }), /finalized Assignment accounting required/)
      const stoppedAssignment = await hub.client.call(assignmentPath)
      const accountingRequest = { request_id: 'settle-team-budget', expected_revision: stoppedAssignment.revision }
      await assert.rejects(hub.client.forSession(stopObserver.owner_token).call(`${assignmentPath}/accounting`, accountingRequest), /403/)
      if (['resource-off', 'final-artifact', 'stage-complete', 'downstream', 'verification', 'pipeline', 'pipeline-external', 'model-tools', 'rework'].includes(pump)) {
        await assert.rejects(hub.client.call(`${assignmentPath}/accounting`, { ...accountingRequest, expected_revision: stoppedAssignment.revision - 1 }), /exact drained revision/)
        await assert.rejects(hub.client.call(`${root}/budget-reservations/${assignment.bundle.reservation.request.id}/settle`, {
          event_id: 'bypass', expected_revision: 1, total_charge: 0, finalized: true, basis: 'internal_price',
        }), /invalid settlement evidence/)
        const results = await Promise.all([hub.client.call(`${assignmentPath}/accounting`, accountingRequest), hub.client.call(`${assignmentPath}/accounting`, accountingRequest)])
        assert.deepEqual(results[0], results[1]); accountingReceipt = results[0]
        assert.equal(accountingReceipt.reservation.finalized, true)
        assert.equal(accountingReceipt.reservation.held, 0)
        assert.equal(accountingReceipt.reservation.charged, modelToolMode ? 4 : 2)
        assert.equal(accountingReceipt.provider_cost_status, 'unconfirmed')
        assert.equal(accountingReceipt.basis, 'configured_internal_price')
        const budget = await hub.client.call(`${root}/budgets/budget`)
        assert.equal(budget.budget.spent, modelToolMode ? 4 : 2); assert.equal(budget.budget.reserved, 0)
        assert.equal(budget.estimated_charged, 0); assert.equal(budget.internal_price_charged, modelToolMode ? 4 : 2)
        await assert.rejects(hub.client.call(`${assignmentPath}/accounting`, { ...accountingRequest, request_id: 'changed-accounting' }), /identity conflict/)
      } else {
        await assert.rejects(hub.client.call(`${assignmentPath}/accounting`, accountingRequest), pump === 'mandate' ? /usage remains unresolved/ : /frozen internal-price settlement policy required/)
        assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved, pump === 'mandate' ? 8 : 10)
      }
      if (completeMode) {
        if (pipelineMode) await assert.rejects(hub.client.call(`${runs}/before/delivery`, { request_id: 'too-early', expected_revision: await readRunRevision() }), /completion stages have not passed|target adapter evidence unavailable/)
        const completePath = `${runs}/before/stages/inspect/complete`
        const complete = { request_id: 'complete-inspect', expected_revision: await readRunRevision(), assignment_id: assignment.id }
        await assert.rejects(hub.client.forSession(stopObserver.owner_token).call(completePath, complete), /403/)
        await assert.rejects(hub.client.call(completePath, { ...complete, expected_revision: complete.expected_revision - 1 }), /revision conflict/)
        const results = await Promise.all([hub.client.call(completePath, complete), hub.client.call(completePath, complete)])
        assert.deepEqual(results[0], results[1]); stageCompletion = results[0]
        assert.equal(stageCompletion.stage_passed, true); assert.equal(stageCompletion.completion_authorized, false)
        assert.equal((await hub.client.call(assignmentPath)).state, 'completed')
        assert.equal((await hub.client.call(`${root}/assignment-capacities/account`)).held, 0)
        const run = await hub.client.call(`${runs}/before`)
        assert.equal(run.revision, complete.expected_revision + 1, 'stage completion advances exactly one WorkRun revision'); assert.equal(run.stages[0].state, 'passed')
        assert.equal(run.completion_authorized, false)
        assert.ok((await hub.client.call(`${runs}/before/stages/followup/plan`)).candidates.length > 0)
        await assert.rejects(hub.client.call(completePath, { ...complete, assignment_id: 'other' }), /identity conflict/)
        const scheduleNext = async (expected_revision, request_id) => {
          const schedulePath = `${runs}/before/schedule`, command = { request_id, expected_revision }
          await assert.rejects(hub.client.forSession(stopObserver.owner_token).call(schedulePath, command), /403/)
          await assert.rejects(hub.client.call(schedulePath, { ...command, target_id: 'target' }), /422/)
          await assert.rejects(hub.client.call(schedulePath, { ...command, expected_revision: expected_revision - 1 }), /revision conflict/)
          await assert.rejects(async () => {
            await hub.client.call(schedulePath, command)
            throw new Error('fixture committed scheduling response lost')
          }, /committed scheduling response lost/)
          const results = await Promise.all([hub.client.call(schedulePath, command), hub.client.call(schedulePath, command)])
          assert.deepEqual(results[0], results[1])
          assert.equal((await readRun()).revision, expected_revision + 1, 'successful stage scheduling advances exactly one WorkRun revision')
          scheduled.push({ path: schedulePath, command, receipt: results[0] })
          assert.equal(results[0].assignment.scheduling.source, 'home_policy')
          assert.equal(results[0].assignment.candidate.target_id, 'target')
          await assert.rejects(hub.client.call(schedulePath, { ...command, expected_revision: expected_revision + 1 }), /identity conflict/)
          return results[0].assignment
        }
        const beforeNextSchedule = await readRun()
        const next = pipelineMode ? await scheduleNext(beforeNextSchedule.revision, 'next') :
          (await hub.client.call(`${runs}/before/stages/followup/assignments`, { request_id: 'next', expected_revision: beforeNextSchedule.revision, target_id: 'target' })).assignment
        if (pipelineMode) {
          assert.equal(next.stage_id, 'followup')
          const afterNextSchedule = await readRun()
          assert.equal(afterNextSchedule.revision, beforeNextSchedule.revision + 1, 'stage scheduling advances exactly one WorkRun revision')
          await assert.rejects(hub.client.call(`${runs}/before/schedule`, { request_id: 'dependency-blocked', expected_revision: afterNextSchedule.revision }), /no schedulable stage/)
        }
        assert.equal(next.inputs.execution_authorized, false)
        assert.equal(next.inputs.binding.run_revision, beforeNextSchedule.revision)
        assert.deepEqual(next.inputs.binding.external, run.inputs)
        const inputSource = next.inputs.binding.sources.inspect
        assert.equal(inputSource.assignment_id, assignment.id)
        assert.deepEqual(inputSource.worker, assignment.worker)
        assert.equal(inputSource.outputs.artifact.sequence, run.stages[0].evidence.outputs.artifact)
        const archive = await hub.client.call(`${root}/artifact-archives/${inputSource.outputs.artifact.sequence}`)
        assert.equal(inputSource.outputs.artifact.artifact.snapshot_hash, archive.snapshot_hash)
        assert.equal(inputSource.outputs.artifact.artifact.archive_hash, archive.archive_hash)
        assert.equal(inputSource.outputs.artifact.artifact.bytes, archive.bytes)
        assert.match(next.inputs.hash, /^[a-f0-9]{64}$/)
        if (!pipelineMode) assert.deepEqual((await hub.client.call(`${runs}/before/stages/followup/assignments`, { request_id: 'next', expected_revision: beforeNextSchedule.revision, target_id: 'target' })).assignment.inputs, next.inputs)
        const sourceRequest = { assignment_id: next.id, source_stage: 'inspect', output: 'artifact' }
        await assert.rejects(execution.prepareAssignmentInput({ ...sourceRequest, source_stage: 'foreign' }), /input unavailable/)
        await assert.rejects(execution.prepareAssignmentInput({ ...sourceRequest, root: workspaceRoot }), /Invalid Assignment artifact request/)
        const faultRuntime = { host: execution.host, artifactWorkspaces: execution.artifactWorkspaces, client: {
          async call(path, ...args) {
            const value = await hub.client.call(path, ...args)
            return path.includes('/artifact-archives/') ? { ...value, archive_hash: '0'.repeat(64) } : value
          },
        } }
        await assert.rejects(prepareAssignmentArtifact({ ...faultRuntime, host: 'foreign-host' }, sourceRequest), /input binding unavailable/)
        await assert.rejects(prepareAssignmentArtifact(faultRuntime, sourceRequest), /archive identity mismatch/)
        const preparedInput = await execution.prepareAssignmentInput(sourceRequest)
        materializedSources.push(preparedInput.workspace.source)
        assert.equal(preparedInput.input_hash, next.inputs.hash)
        assert.equal(preparedInput.source_assignment_id, assignment.id)
        assert.equal(preparedInput.execution_authorized, false)
        assert.notEqual(preparedInput.workspace.source, workspaceRoot)
        assert.equal(await readFile(join(preparedInput.workspace.source, 'source.txt'), 'utf8'), 'fixture source')
        assert.deepEqual(await execution.prepareAssignmentInput(sourceRequest), preparedInput)
        let assignmentReads = 0
        const racingRuntime = { host: execution.host, artifactWorkspaces: execution.artifactWorkspaces, client: {
          async call(path, ...args) {
            const value = await hub.client.call(path, ...args)
            if (path.includes('/work-assignments/') && ++assignmentReads === 2) return { ...value, revision: value.revision + 1 }
            return value
          },
        } }
        await assert.rejects(prepareAssignmentArtifact(racingRuntime, sourceRequest), /changed during artifact preparation/)

        const nextPath = `${root}/work-assignments/${next.id}`
        const workspaceInput = { request_id: `materialize-${preparedInput.input_hash}`, expected_revision: next.revision,
          input_hash: preparedInput.input_hash, source_stage: 'inspect', output: 'artifact', sequence: preparedInput.sequence,
          snapshot_hash: preparedInput.snapshot_hash, archive_hash: preparedInput.archive_hash, root: preparedInput.workspace.source }
        await assert.rejects(hub.client.forSession(stopObserver.owner_token).call(`${nextPath}/workspace-receipt`, workspaceInput), /403/)
        await assert.rejects(hub.client.call(`${nextPath}/workspace-receipt`, { ...workspaceInput, root: workspaceRoot }), /separate from original/)
        await assert.rejects(hub.client.call(`${nextPath}/workspace-receipt`, { ...workspaceInput, snapshot_hash: '0'.repeat(64) }), /source mismatch/)
        const workspaceReceipt = await execution.bindAssignmentInput(sourceRequest)
        downstreamWorkspace = { path: `${nextPath}/workspace-receipt`, request: workspaceInput, receipt: workspaceReceipt }
        assert.equal(workspaceReceipt.execution_authorized, false)
        assert.equal(workspaceReceipt.assignment_revision, next.revision + 1)
        assert.deepEqual(await execution.bindAssignmentInput(sourceRequest), workspaceReceipt)
        await assert.rejects(hub.client.call(`${nextPath}/workspace-receipt`, { ...workspaceInput, root: `${workspaceInput.root}-other` }), /identity conflict/)
        assert.equal((await hub.client.call(`${runs}/before/events`)).events.filter(e => e.data.kind === 'assignment_input_materialized').length, 1)
        const scopeRequest = { request_id: 'snapshot-scope', expected_revision: workspaceReceipt.assignment_revision }
        await assert.rejects(hub.client.forSession(stopObserver.owner_token).call(`${nextPath}/workspace-scope`, scopeRequest), /403/)
        await assert.rejects(hub.client.call(`${nextPath}/workspace-scope`, { ...scopeRequest, expected_revision: 1 }), /state conflict/)
        const scopeReceipt = await hub.client.call(`${nextPath}/workspace-scope`, scopeRequest)
        assert.equal(scopeReceipt.scope.target.root, preparedInput.workspace.source)
        assert.deepEqual(scopeReceipt.authority_scope, next.candidate.grant_scope)
        assert.deepEqual(scopeReceipt.scope.capabilities, ['read'])
        assert.equal(scopeReceipt.execution_authorized, false)
        assert.deepEqual(await hub.client.call(`${nextPath}/workspace-scope`, scopeRequest), scopeReceipt)
        downstreamWorkspace.scope = { path: `${nextPath}/workspace-scope`, request: scopeRequest, receipt: scopeReceipt }
        const grantContext = await hub.client.call(`${root}/operations/${next.bundle.operation.id}/grant`)
        assert.deepEqual(grantContext.binding.scope, next.candidate.grant_scope)
        assert.deepEqual(grantContext.execution_workspace, scopeReceipt)
        const derivedAgent = { id: next.worker.session_id, session: { header: { cwd: preparedInput.workspace.source } } }
        const derivedOperation = next.dispatch.command.operation
        await assert.rejects(officialGrantGuard(ctx, hub.client, derivedAgent, derivedOperation, [], hub.node), /derived workspace authority unavailable/)
        const checkDerived = async () => (await execution.prepareAssignmentInput(sourceRequest)).workspace.source
        const snapshotGuard = await officialGrantGuard(ctx, hub.client, derivedAgent, derivedOperation, [], hub.node, checkDerived)
        assert.equal(await snapshotGuard.check(), preparedInput.workspace.source)
        derivedAgent.session.header.cwd = workspaceRoot
        await assert.rejects(snapshotGuard.check(), /outside grant workspace/)
        derivedAgent.session.header.cwd = preparedInput.workspace.source
        const derivedFile = join(preparedInput.workspace.source, 'source.txt')
        await chmod(derivedFile, 0o600); await writeFile(derivedFile, 'tampered'); await chmod(derivedFile, 0o400)
        await assert.rejects(snapshotGuard.check(), /Materialized/)
        await chmod(derivedFile, 0o600); await writeFile(derivedFile, 'fixture source'); await chmod(derivedFile, 0o400)
        assert.equal(await snapshotGuard.check(), preparedInput.workspace.source)
        assert.equal((await hub.client.call(`${root}/operations/${next.bundle.operation.id}`)).state, 'prepared')
        const derivedAssignment = await hub.client.call(nextPath)
        assert.equal(derivedAssignment.dispatch.command.cwd, preparedInput.workspace.source)
        const held = await hub.client.call(`${nextPath}/resources`, { request_id: 'next-resources', expected_revision: scopeReceipt.assignment_revision })
        assert.equal(held.resources.root, preparedInput.workspace.source)
        assert.equal(held.resources.workspace_basis, 'derived_snapshot')
        assert.equal((await hub.client.call(`${root}/assignment-capacities/account`)).held, 1, 'completed predecessor frees the one-slot team and workspace')
        assert.deepEqual(await hub.client.call(completePath, complete), stageCompletion)
        assert.equal((await hub.client.call(`${root}/assignment-capacities/account`)).held, 1, 'historical completion cannot release the successor hold')
        if (independentMode) {
          if (!reworkMode) await hub.client.call(`${root}/budget-reservations/${next.bundle.reservation.request.id}/pricing`, { price_id: 'price' })
          else assert.equal(next.pricing.price_id, 'price')
          const setupDerived = (agentCtx, agent) => { agentCtx.effect(() => {
            const tools = agentCtx.get('tools').forScope(agentCtx)
            const remove = tools.register({ name: 'fixture_inspect', description: 'Read selected source', parameters: { type: 'object', properties: {} },
              output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
              execute: async (_args, request) => {
                const text = await readFile(join(agent.session.header.cwd, 'source.txt'), 'utf8')
                if (!request.callId.startsWith('review-')) return text
                const payload = { kind: 'review', artifact_sequence: preparedInput.sequence, snapshot_hash: preparedInput.snapshot_hash,
                  verdict: request.callId === 'review-failed' || text !== 'fixture source' ? 'failed' : 'passed',
                  findings: [] }
                return JSON.stringify(await execution.artifacts.record(agent.id, profiles.binding(agent.id).managedOperation, request.callId, payload))
              } })
            const unpolicy = agentCtx.get('kodeOfficialToolPolicies').register('fixture_inspect', { capabilities: ['read'], network: false,
              workspaceLock: true, implementation: tools.get('fixture_inspect', agent), authorize: async () => true }, agent)
            return () => { unpolicy(); remove() }
          }) }
          const started = await dispatcher.start(next.id, { setup: setupDerived })
          const child = host.handles.get(next.worker.session_id)
          assert.ok(child)
          assert.notEqual(child.agent.id, owned.agent.id)
          assert.equal(child.agent.session.header.cwd, preparedInput.workspace.source)
          const deadline = Date.now() + 5000
          while ((await hub.client.call(`${root}/messages/${started.mandate.message_id}/delivery`)).delivery?.phase !== 'consumed') {
            assert.ok(Date.now() < deadline, 'downstream mandate consumed')
            await new Promise(resolve => setTimeout(resolve, 20))
          }
          await child.agent.whenIdle()
          assert.equal(inferenceCalls, modelToolMode ? 5 : 2)
          const admitted = await hub.client.call(nextPath)
          assert.equal(admitted.admission.request.context.kind, 'official_fresh_empty')
          assert.equal(admitted.admission.request.context.event_count, 0)
          assert.equal(admitted.admission.request.context.input_hash, next.inputs.hash)
          const childMessage = await hub.client.call(`${root}/messages/${started.mandate.message_id}`)
          const childMandate = JSON.parse(childMessage.content)
          assert.equal(childMandate.inputs.inspect.outputs.artifact.sequence, preparedInput.sequence)
          assert.equal(childMandate.execution_workspace.scope.target.root, preparedInput.workspace.source)
          assert.equal(childMandate.repository.workspace.root_ref, preparedInput.workspace.source)
          assert.equal(childMandate.grant_scope.target.root, preparedInput.workspace.source)
          assert.equal(childMandate.authority_scope.target.root, workspaceRoot)
          assert.equal(childMandate.source_repository.workspace.root_ref, workspaceRoot)
          assert.equal((await child.run.execute({ agent: child.agent, name: 'fixture_inspect', callId: 'read-snapshot', arguments: {} })).value, 'fixture source')
          if (pump === 'downstream' || pipelineMode) {
          const reviewPath = `${runs}/before/stages/followup/evidence`
          const beforeReviewSelection = await readRun()
          const reviewSelection = { request_id: 'select-review', expected_revision: beforeReviewSelection.revision, assignment_id: next.id }
          const review = async callId => {
            if (modelToolMode) {
              await assert.rejects(child.run.execute({ agent: child.agent, name: 'kode_review_output', callId: 'review-invalid', arguments: { output: 'later', request_id: 'invalid', verdict: 'passed', findings: [{ id: 'blocker', blocking: true, evidence_ref: 'source' }] } }), /arguments exceed grant/)
              const result = JSON.parse((await child.run.execute({ agent: child.agent, name: 'kode_review_output', callId: `tool-${callId}`,
                arguments: { output: 'later', request_id: callId, verdict: callId === 'review-failed' ? 'failed' : 'passed', findings: [] } })).value)
              return Object.values(profiles.binding(child.agent.id).artifactOutbox).find(row => row.evidence.id === result.evidence_id)
            }
            return JSON.parse((await child.run.execute({ agent: child.agent, name: 'fixture_inspect', callId, arguments: {} })).value)
          }
          const failedReview = await review('review-failed')
          if (reworkMode) {
            const selected = await hub.client.call(reviewPath, { ...reviewSelection, outputs: { later: failedReview.home_sequence } })
            assert.equal(selected.selection.outcome, 'rejected')
            const completePath = `${runs}/before/stages/followup/complete`
            const command = { request_id: `host-complete-${next.id}`, expected_revision: await readRunRevision(), assignment_id: next.id }
            await assert.rejects(hub.client.call(completePath, command), /reported stop required/)
            await child.run.finish(); await dispatcher.stop(next.id)
            const stopped = await hub.client.call(nextPath)
            await hub.client.call(`${nextPath}/accounting`, { request_id: 'settle-rejected', expected_revision: stopped.revision })
            controller = new WorkRunController(dispatcher, { prepare: () => { throw new Error('rejection must not restart Worker') } })
            const advanced = await Promise.all([controller.advance('before'), controller.advance('before')])
            assert.ok(advanced.every(result => result.state === 'rework_scheduled'))
            const receipts = advanced.map(result => result.receipt)
            assert.deepEqual(receipts[0], receipts[1])
            const receipt = receipts[0]
            assert.deepEqual(await hub.client.call(completePath, command), receipt)
            assert.equal(receipt.stage_passed, false); assert.equal(receipt.stage_rejected, true)
            assert.equal(receipt.rework.scheduled, true); assert.equal(receipt.rework.target, 'inspect')
            assert.deepEqual(receipt.rework.evidence, selected.selection)
            assert.equal(receipt.rework.outputs.later.payload.verdict, 'failed')
            const rejectedRun = await hub.client.call(`${runs}/before`)
            assert.equal(rejectedRun.revision, command.expected_revision + 1); assert.equal(rejectedRun.waiting_reason, 'rework_dispatch_pending')
            assert.deepEqual(rejectedRun.stages.map(s => [s.stage_id, s.state, s.attempt, s.assignment_id]), [
              ['inspect', 'pending', 1, null], ['followup', 'pending', 1, null], ['verify', 'pending', 0, null],
            ])
            assert.equal(rejectedRun.reworks[0].superseded[0].state, 'passed')
            assert.equal((await hub.client.call(nextPath)).resources.state, 'released')
            const beforeReworkSchedule = await readRun()
            const scheduledAgain = await hub.client.call(`${runs}/before/schedule`, { request_id: 'schedule-rework', expected_revision: beforeReworkSchedule.revision })
            assert.equal((await readRun()).revision, beforeReworkSchedule.revision + 1, 'rework scheduling advances exactly one WorkRun revision')
            assert.equal(scheduledAgain.assignment.stage_id, 'inspect'); assert.equal(scheduledAgain.assignment.stage_attempt, 2)
            assert.notEqual(scheduledAgain.assignment.worker.session_id, assignment.worker.session_id)
            assert.deepEqual(scheduledAgain.assignment.inputs.binding.rework, rejectedRun.reworks[0])
            const beforeStaleRejectedAttempt = await readRun()
            await assert.rejects(hub.client.call(reviewPath, { ...reviewSelection, request_id: 'stale-rejected-attempt', expected_revision: beforeStaleRejectedAttempt.revision - 1, outputs: { later: failedReview.home_sequence } }), /revision conflict|assignment unavailable/i)
            assert.equal((await readRun()).revision, beforeStaleRejectedAttempt.revision, 'stale rejected-attempt selection does not mutate the run')
            await hub.stop('SIGKILL'); await hub.start()
            assert.deepEqual(await hub.client.call(completePath, command), receipt)
            assert.equal((await hub.client.call(`${runs}/before/events`)).events.filter(e => e.data.kind === 'stage_rejected').length, 1)
            assert.equal((await hub.client.call(`${runs}/before`)).reworks.length, 1)
            await controller.close()
            autoRework = true
            controller = new WorkRunController(dispatcher, { prepare: async assignment => {
              assert.equal(assignment.pricing.price_id, 'price', 'home policy binds price before Host preparation')
              return { setup: setupDerived }
            } })
            const states = []
            runService = await new WorkRunService(controller, { intervalMs: 100, onState: state => { states.push(state) } }).open()
            runService.start()
            const deadline = Date.now() + 20000
            let delivered
            while (true) {
              delivered = await hub.client.call(`${runs}/before`)
              if (delivered.state === 'completed') break
              assert.ok(!states.some(state => state.blocked), JSON.stringify({ states, errors }))
              assert.ok(Date.now() < deadline, JSON.stringify({ states, errors, stages: delivered.stages }))
              await new Promise(resolve => setTimeout(resolve, 50))
            }
            await runService.close()
            assert.deepEqual(errors, [])
            assert.equal(delivered.completion_authorized, true)
            assert.deepEqual(delivered.stages.map(stage => [stage.state, stage.attempt]), [['passed', 2], ['passed', 2], ['passed', 1]])
            const assignments = await Promise.all(delivered.stages.map(stage => hub.client.call(`${root}/work-assignments/${stage.assignment_id}`)))
            assert.equal(new Set(assignments.map(assignment => assignment.worker.session_id)).size, 3)
            assert.ok(assignments.every(assignment => assignment.state === 'completed' && assignment.resources.state === 'released'))
            assert.notEqual(delivered.stages[0].evidence.outputs.artifact, preparedInput.sequence)
            assert.equal(delivered.reworks[0].evidence.outputs.later, failedReview.home_sequence)
            const implementation = await hub.client.call(`${root}/work-assignments/${delivered.stages[0].assignment_id}`)
            const implementationRoot = implementation.execution_workspace?.receipt?.root ?? implementation.dispatch.command.cwd ?? workspaceRoot
            assert.equal(await readFile(join(implementationRoot, 'source.txt'), 'utf8'), 'repaired source')
            assert.equal(await readFile(join(workspaceRoot, 'source.txt'), 'utf8'), 'fixture source', 'implementation leaves the original repository unchanged')
            assert.equal(inferenceCalls, 14)
            const finalBudget = await hub.client.call(`${root}/budgets/budget`)
            assert.equal(finalBudget.budget.spent, 28); assert.equal(finalBudget.budget.reserved, 0)
            const finalReceipt = delivered.delivery
            await hub.stop('SIGKILL'); await hub.start()
            assert.deepEqual((await hub.client.call(`${runs}/before`)).delivery, finalReceipt)
            assert.deepEqual(await hub.client.call(completePath, command), receipt)
            assert.equal((await hub.client.call(`${runs}/before/events`)).events.filter(e => e.data.kind === 'work_run_delivered').length, 1)
            let budgetCursor = 0
            const priceBindings = []
            while (true) {
              const page = await hub.client.call(`${root}/budgets/budget/events?after=${budgetCursor}`)
              priceBindings.push(...page.events.filter(event => event.data.kind === 'price_bound'))
              if (!page.events.length) break
              assert.ok(page.cursor > budgetCursor); budgetCursor = page.cursor
            }
            assert.equal(priceBindings.length, 5, 'one immutable binding for each actual Assignment across retries/restart')
            assert.equal(new Set(priceBindings.map(event => event.data.reservation.request.id)).size, 5)
            assert.ok(priceBindings.every(event => event.data.price.id === 'price'))
            return
          }
          await assert.rejects(hub.client.call(reviewPath, { ...reviewSelection, outputs: { later: failedReview.home_sequence } }), /frozen bindings/)
          await assert.rejects(hub.client.call(`${root}/artifact-evidence`, { ...failedReview.evidence, id: 'review-blocked',
            payload: { ...failedReview.evidence.payload, verdict: 'passed', findings: [{ id: 'blocking', blocking: true, evidence_ref: 'fixture-review' }] } }), /invalid review evidence/)
          assert.equal((await readRun()).revision, beforeReviewSelection.revision, 'invalid review evidence does not mutate the run')
          const passedReview = await review('review-passed')
          assert.equal(passedReview.home_reconciled, true)
          const selectedReview = await hub.client.call(reviewPath, { ...reviewSelection, outputs: { later: passedReview.home_sequence } })
          assert.equal(selectedReview.run_revision, beforeReviewSelection.revision + 1, 'review selection advances exactly one WorkRun revision')
          const reviewCompletePath = `${runs}/before/stages/followup/complete`
          const reviewComplete = { request_id: 'complete-review', expected_revision: await readRunRevision(), assignment_id: next.id }
          await assert.rejects(hub.client.call(reviewCompletePath, reviewComplete), /reported stop required/)
          await child.run.finish()
          const finalInput = profiles.binding(child.agent.id).finalInput
          assert.deepEqual(finalInput.selection, selectedReview.selection)
          assert.equal(finalInput.snapshot_hash, preparedInput.snapshot_hash)
          await assert.rejects(hub.client.call(`${nextPath}/stop-receipt`, { request_id: `stop-${next.id}`, command: derivedAssignment.dispatch.command,
            kind: 'official_local_drained', final_input: { ...finalInput, snapshot_hash: '0'.repeat(64) } }), /final input identity/)
          await dispatcher.stop(next.id)
          const drained = await hub.client.call(nextPath)
          await assert.rejects(hub.client.call(reviewCompletePath, reviewComplete), /accounting required/)
          await hub.client.call(`${nextPath}/accounting`, { request_id: 'settle-child', expected_revision: drained.revision })
          reviewCompletion = { path: reviewCompletePath, request: reviewComplete, receipt: await hub.client.call(reviewCompletePath, reviewComplete) }
          assert.equal(reviewCompletion.receipt.stage_passed, true)
          assert.equal((await hub.client.call(`${runs}/before`)).waiting_reason, pipelineMode ? 'stage_dispatch_pending' : 'delivery_finalization_pending')
          assert.deepEqual(await hub.client.call(reviewCompletePath, reviewComplete), reviewCompletion.receipt)

          } else {
            await assert.rejects(child.run.verify({ request_id: 'verify', output: 'later', command: 'arbitrary' }), /Invalid Assignment verification/)
            await assert.rejects(child.run.verify({ request_id: 'wrong-output', output: 'artifact' }), /Frozen verification stage unavailable/)
            const archiveCall = hub.client.call.bind(hub.client)
            let offlineArchive = true, loseArchiveReply = true
            hub.client.call = async (path, body, ...args) => {
              if (path.includes('/verification-records/') && body) {
                if (offlineArchive) throw new Error('fixture archive offline')
                const value = await archiveCall(path, body, ...args)
                if (loseArchiveReply) { loseArchiveReply = false; throw new Error('fixture archive reply lost') }
                return value
              }
              return archiveCall(path, body, ...args)
            }
            const checked = await child.run.verify({ request_id: 'verify', output: 'later' })
            assert.equal(checked.result.observed.exit_code, 0)
            assert.equal(checked.result.observed.passed, true)
            assert.equal(checked.observation.home_reconciled, true)
            assert.equal(checked.log_archive_status, 'pending_home')
            assert.equal(checked.observation.evidence.payload.command_id, verificationReference.id)
            assert.equal(checked.observation.evidence.payload.environment_hash, verificationReference.environment_hash)
            const stdout = Buffer.concat(checked.result.observed.output.filter(c=>c.stream==='stdout').map(c=>Buffer.from(c.data,'base64'))).toString()
            assert.ok(stdout.startsWith('verified fixture source')); assert.equal(stdout.length,200023)
            await assert.rejects(child.run.verify({ request_id: 'verify', output: 'later' }), /already recorded/)
            const beforeVerifiedSelection = await readRun()
            const verifiedSelection = await hub.client.call(`${runs}/before/stages/followup/evidence`, { request_id: 'select-verified', expected_revision: beforeVerifiedSelection.revision, assignment_id: next.id, outputs: { later: checked.observation.home_sequence } })
            assert.equal(verifiedSelection.run_revision, beforeVerifiedSelection.revision + 1, 'verified output selection advances exactly one WorkRun revision')
            await assert.rejects(child.run.finish(), /requires home archival/)
            const recordPath = `${root}/verification-records/${checked.observation.home_sequence}`
            const upload = { result_json: JSON.stringify(checked.result) }
            await assert.rejects(hub.client.forSession(stopObserver.owner_token).call(recordPath, upload), /403/)
            const corrupt = structuredClone(checked.result); corrupt.observed.output[0].data = Buffer.from('wrong').toString('base64')
            await assert.rejects(archiveCall(recordPath, { result_json: JSON.stringify(corrupt) }), /log digest mismatch/)
            const undrained = structuredClone(checked.result); undrained.observed.process_group_empty = false
            await assert.rejects(archiveCall(recordPath, { result_json: JSON.stringify(undrained) }), /process outcome mismatch/)
            const foreign = structuredClone(checked.result); foreign.command.definition_hash = '0'.repeat(64)
            await assert.rejects(archiveCall(recordPath, { result_json: JSON.stringify(foreign) }), /frozen command mismatch/)
            offlineArchive = false
            await execution.verificationArchive.flush()
            assert.throws(()=>execution.verificationArchive.assertSettled(child.agent.id, profiles.binding(child.agent.id).managedOperation), /home archival/)
            await execution.verificationArchive.flush()
            execution.verificationArchive.assertSettled(child.agent.id, profiles.binding(child.agent.id).managedOperation)
            const storedRecord = await hub.client.call(recordPath)
            assert.equal(storedRecord.result_json,upload.result_json)
            verificationRecord = { path: recordPath, receipt: storedRecord, operation: next.bundle.operation.id, sequence: checked.observation.home_sequence }
            await assert.rejects(hub.client.call(recordPath, { result_json: JSON.stringify(foreign) }), /identity conflict/)
            assert.equal((await hub.client.call(`${root}/operations/${next.bundle.operation.id}/events`)).events.filter(e=>e.data.kind==='verification_record_archived').length,1)
            await child.run.finish(); await dispatcher.stop(next.id)
            const drained = await hub.client.call(nextPath)
            await hub.client.call(`${nextPath}/accounting`, { request_id: 'settle-child', expected_revision: drained.revision })
            const completePath = `${runs}/before/stages/followup/complete`, completeRequest = { request_id: 'complete-verification', expected_revision: await readRunRevision(), assignment_id: next.id }
            reviewCompletion = { path: completePath, request: completeRequest, receipt: await hub.client.call(completePath, completeRequest) }
            assert.equal(reviewCompletion.receipt.stage_passed,true)
            assert.equal((await readRun()).revision, completeRequest.expected_revision + 1, 'verified stage completion advances exactly one WorkRun revision')
            assert.equal((await hub.client.call(`${runs}/before`)).waiting_reason,'delivery_finalization_pending')
          }
          if (pipelineMode) {
            const beforeThirdSchedule = await readRun()
            const third = await scheduleNext(beforeThirdSchedule.revision, 'third')
            assert.equal(third.stage_id, 'verify')
            const thirdPath = `${root}/work-assignments/${third.id}`
            assert.deepEqual(Object.keys(third.inputs.binding.sources).sort(), ['followup', 'inspect'])
            assert.equal(third.inputs.binding.sources.inspect.outputs.artifact.sequence, preparedInput.sequence)
            assert.equal(third.inputs.binding.sources.followup.assignment_id, next.id)
            assert.equal(third.inputs.binding.sources.followup.outputs.later.sequence,
              (await hub.client.call(`${runs}/before`)).stages[1].evidence.outputs.later)
            assert.equal(new Set([assignment.worker.session_id, next.worker.session_id, third.worker.session_id]).size, 3)
            await hub.client.call(`${root}/budget-reservations/${third.bundle.reservation.request.id}/pricing`, { price_id: 'price' })
            controller = new WorkRunController(dispatcher, { prepare: () => ({ setup: setupDerived }) })
            const call = hub.client.call.bind(hub.client)
            let loseScopeReply = true
            hub.client.call = async (path, body, ...args) => {
              const result = await call(path, body, ...args)
              if (path === `${thirdPath}/workspace-scope` && body && loseScopeReply) {
                loseScopeReply = false
                throw new Error('fixture derived scope reply lost')
              }
              return result
            }
            await assert.rejects(controller.advance('before'), /derived scope reply lost/)
            assert.equal(host.handles.has(third.worker.session_id), false)
            assert.equal((await hub.client.call(`${root}/assignment-capacities/account`)).held, 0)
            assert.equal(inferenceCalls, modelToolMode ? 5 : 2)
            const pendingWorkspace = (await hub.client.call(thirdPath)).input_workspace.receipt.root
            const pendingFile = join(pendingWorkspace, 'source.txt')
            await chmod(pendingFile, 0o600); await writeFile(pendingFile, 'changed after scope receipt'); await chmod(pendingFile, 0o400)
            await assert.rejects(controller.advance('before'), /Materialized/)
            assert.equal(host.handles.has(third.worker.session_id), false)
            assert.equal((await hub.client.call(`${root}/assignment-capacities/account`)).held, 0)
            await chmod(pendingFile, 0o600); await writeFile(pendingFile, 'fixture source'); await chmod(pendingFile, 0o400)
            const progression = await controller.advance('before')
            assert.equal(progression.state, 'started')
            const started = progression.started
            hub.client.call = call
            const verifier = host.handles.get(third.worker.session_id)
            const restored = await hub.client.call(thirdPath)
            materializedSources.push(restored.input_workspace.receipt.root)
            assert.notEqual(restored.input_workspace.receipt.root, preparedInput.workspace.source)
            assert.equal(verifier.agent.session.header.cwd, restored.input_workspace.receipt.root)
            assert.equal(restored.execution_workspace.receipt.scope.target.root, restored.input_workspace.receipt.root)
            assert.equal(restored.resources.workspace_basis, 'derived_snapshot')
            assert.equal((await hub.client.call(`${root}/assignment-capacities/account`)).held, 1)
            const deadline = Date.now() + 5000
            while ((await hub.client.call(`${root}/messages/${started.mandate.message_id}/delivery`)).delivery?.phase !== 'consumed') {
              assert.ok(Date.now() < deadline, 'verification mandate consumed')
              await new Promise(resolve => setTimeout(resolve, 20))
            }
            await verifier.agent.whenIdle()
            assert.equal(inferenceCalls, modelToolMode ? 8 : 3, JSON.stringify({ errors, model_steps: [...modelSteps.values()], status: verifier.agent.status }))
            if (!modelToolMode) assert.equal((await controller.advance('before')).state, 'waiting_outputs')
            const verifyArguments = { request_id: 'pipeline-check', output: 'checked' }
            assert.throws(() => execution.executeAssignmentTool(verifier.agent, 'kode_verify_output', verifyArguments), /exact controlled tool body/)
            const verified = modelToolMode ? modelVerification : JSON.parse((await verifier.run.execute({ agent: verifier.agent, name: 'kode_verify_output', callId: 'verify-stage-tool', arguments: verifyArguments })).value)
            assert.equal(verified.verdict, 'passed')
            assert.equal(verified.log_archive_status, 'home_archived')
            const checked = { observation: Object.values(profiles.binding(verifier.agent.id).artifactOutbox).find(row => row.evidence.id === verified.evidence_id) }
            assert.equal(checked.observation.evidence.payload.artifact_sequence, preparedInput.sequence)
            const recordPath = `${root}/verification-records/${checked.observation.home_sequence}`
            verificationRecord = { path: recordPath, receipt: await hub.client.call(recordPath), operation: third.bundle.operation.id }
            const publication = { output: 'checked', evidence_id: checked.observation.evidence.id }
            await assert.rejects(verifier.run.publishOutput({ ...publication, sequence: checked.observation.home_sequence }), /Invalid named output/)
            await assert.rejects(verifier.run.publishOutput({ ...publication, output: 'artifact' }), /frozen stage/)
            await assert.rejects(verifier.run.publishOutput({ ...publication, evidence_id: 'foreign-observation' }), /not home-reconciled/)
            assert.throws(() => execution.executeAssignmentTool(verifier.agent, 'kode_publish_output', publication), /exact controlled tool body/)
            const published = modelToolMode ? modelPublication : JSON.parse((await verifier.run.execute({ agent: verifier.agent, name: 'kode_publish_output', callId: 'publish-stage-tool', arguments: publication })).value)
            assert.equal(published.sequence, checked.observation.home_sequence)
            assert.equal(published.completion_authorized, false)
            assert.deepEqual(await verifier.run.publishOutput(publication), published)
            const reopened = await new AgentProfiles(profiles.path).open()
            assert.deepEqual(readAssignmentOutputs({ profiles: reopened }, await hub.client.call(thirdPath)), { checked: checked.observation.home_sequence })
            let loseSelectionReply = true
            hub.client.call = async (path, body, ...args) => {
              const result = await call(path, body, ...args)
              if (path === `${runs}/before/stages/verify/evidence` && body && loseSelectionReply) {
                loseSelectionReply = false
                throw new Error('fixture selected output reply lost')
              }
              return result
            }
            const beforeLostSelection = await readRun()
            await assert.rejects(controller.advance('before'), /selected output reply lost/)
            assert.equal((await readRun()).revision, beforeLostSelection.revision + 1, 'lost selection reply still records exactly one WorkRun mutation')
            await controller.close()
            controller = new WorkRunController(dispatcher, {
              prepare: () => { throw new Error('must not recreate Worker') },
              outputs: () => { throw new Error('must not recollect selected output') },
            })
            let resolveAdvance, rejectAdvance
            const advancedPromise = new Promise((resolve, reject) => { resolveAdvance = resolve; rejectAdvance = reject })
            const beforeThirdComplete = await readRun()
            runService = await new WorkRunService(controller, { intervalMs: 100, onState: result => {
              controller.unwatch('before')
              if (result.state === 'progression_failed') rejectAdvance(new Error('Service progression failed'))
              else resolveAdvance(result)
            } }).open()
            const timer = setTimeout(() => rejectAdvance(new Error('Service progression timed out')), 5000)
            let advanced
            try { await runService.scan(); advanced = await advancedPromise } finally { clearTimeout(timer) }
            hub.client.call = call
            assert.equal(advanced.state, 'stage_passed')
            assert.equal(host.handles.has(third.worker.session_id), false)
            const completePath = `${runs}/before/stages/verify/complete`
            const completeRequest = { request_id: `host-complete-${third.id}`, expected_revision: beforeThirdComplete.revision, assignment_id: third.id }
            const afterThirdComplete = await readRun()
            const receipt = afterThirdComplete.stages.find(stage => stage.stage_id === 'verify').completion
            assert.equal(receipt.stage_passed, true)
            assert.equal(afterThirdComplete.revision, beforeThirdComplete.revision + 1, 'final stage completion advances exactly one WorkRun revision')
            assert.deepEqual(await hub.client.call(completePath, completeRequest), receipt, 'same-revision completion replay returns the original receipt')
            assert.deepEqual(await hub.client.call(reviewCompletion.path, reviewCompletion.request), reviewCompletion.receipt)
            reviewCompletion = { path: completePath, request: completeRequest, receipt }
            const finished = await hub.client.call(`${runs}/before`)
            assert.deepEqual(finished.stages.map(stage => stage.state), ['passed', 'passed', 'passed'])
            assert.equal(finished.revision, beforeThirdComplete.revision + 1)
            assert.equal(finished.waiting_reason, 'delivery_finalization_pending')
            const budget = await hub.client.call(`${root}/budgets/budget`)
            assert.equal(budget.budget.spent, modelToolMode ? 16 : 6); assert.equal(budget.budget.reserved, 0)
            const deliveryPath = `${runs}/before/delivery`
            const deliveryRevision = await readRunRevision()
            const deliveryRequest = { request_id: `host-deliver-${deliveryRevision}`, expected_revision: deliveryRevision }
            await assert.rejects(hub.client.forSession(stopObserver.owner_token).call(deliveryPath, deliveryRequest), /403/)
            await assert.rejects(hub.client.call(deliveryPath, { ...deliveryRequest, expected_revision: deliveryRequest.expected_revision - 1 }), /revision conflict/)
            await assert.rejects(hub.client.call(deliveryPath, { ...deliveryRequest, targets: [] }), /400|422/)
            if (externalDelivery) {
              await assert.rejects(controller.advance('before'), /target adapter evidence unavailable/)
              assert.equal((await hub.client.call(`${runs}/before`)).completion_authorized, false)
            } else {
            const progressed = await Promise.all([controller.advance('before'), controller.advance('before')])
            assert.ok(progressed.every(result => result.state === 'completed'))
            const receipts = progressed.map(result => result.receipt)
            assert.deepEqual(receipts[0], receipts[1])
            deliveryReceipt = { path: deliveryPath, request: deliveryRequest, receipt: receipts[0] }
            assert.equal(receipts[0].completion_authorized, true)
            assert.equal(receipts[0].artifacts.artifact.sequence, preparedInput.sequence)
            assert.deepEqual(Object.keys(receipts[0].outputs).sort(), ['artifact', 'checked', 'later'])
            assert.equal((await hub.client.call(`${runs}/before`)).state, 'completed')
            await assert.rejects(hub.client.call(deliveryPath, { ...deliveryRequest, expected_revision: deliveryRequest.expected_revision + 1 }), /identity conflict/)
            }
          }
          assert.equal((await hub.client.call(`${runs}/before`)).completion_authorized, Boolean(deliveryReceipt))
        } else {
          await hub.client.call(`${nextPath}/abandon`, { request_id: 'abandon-next', expected_revision: await readRunRevision() })
          await assert.rejects(execution.prepareAssignmentInput(sourceRequest), /input binding unavailable/)
        }
        assert.deepEqual(await hub.client.call(completePath, complete), stageCompletion)
        assert.equal((await hub.client.call(`${root}/assignment-capacities/account`)).held, 0)
        await hub.client.call(path, { action: 'deactivate', request_id: 'revoke', expected_revision: 1 })
        assert.deepEqual(await hub.client.call(completePath, complete), stageCompletion)
        assert.equal((await hub.client.call(`${runs}/before/events`)).events.filter(e => e.data.kind === 'stage_passed').length, pipelineMode ? 3 : independentMode ? 2 : 1)
      } else if (finalArtifactMode) {
        await assert.rejects(hub.client.call(`${runs}/before/stages/inspect/complete`, { request_id: 'revoked-complete', expected_revision: await readRunRevision(), assignment_id: assignment.id }), /authority unavailable/)
      }
      await assert.rejects(hub.client.call(`${assignmentPath}/stop-receipt`, { ...request, request_id: 'different-stop' }), /identity conflict/)
      assert.equal((await hub.client.call(`${runs}/before/events`)).events.filter(e => e.data.kind === 'assignment_execution_drained').length, pipelineMode ? 3 : independentMode ? 2 : 1)
    }
    await host.close(); await execution.close()
    const released = await execution.workspaceLocks.acquire(executionWorkspaceRoot, 'after-revoke'); await released.release()
    assert.equal((await hub.client.call(`${root}/assignment-capacities/account`)).held, completeMode ? 0 : 1, 'only completed stages release claimed resources')
    assert.equal(inferenceCalls, modelToolMode ? 8 : pipelineMode ? 3 : independentMode ? 2 : mandateMode ? 1 : 0)
    if (cliMode) {
      let starts = 0
      const nativeThreads = new Set()
      for (const [sessionId, binding] of Object.entries(profiles.bindings).filter(([, binding]) => binding.managedAssignment)) {
        const reader = await ctx.get('sessionPersistence').open(sessionId, 'read')
        try {
          const { events } = await reader.read(0, 4096)
          const records = events.map(pluginRecordOf).filter(Boolean)
          const begun = records.filter(record => record.type === 'plugin:kode/managed-cli-start')
          const ended = records.filter(record => record.type === 'plugin:kode/managed-cli-decision')
          assert.equal(begun.length, Object.keys(binding.officialCalls).length)
          assert.equal(ended.length, begun.length)
          for (const start of begun) {
            const call = await hub.client.call(`${root}/official-calls/${start.data.call_id}`)
            assert.equal(call.request.worker_session, sessionId)
            assert.equal(call.request.operation_id, start.data.operation.id)
            assert.equal(call.request.model, start.data.configuration.model)
            assert.equal(start.data.profile_revision, binding.revision)
            assert.equal(ended.find(end => end.data.call_id === start.data.call_id).data.stop.process_group_empty, true)
            nativeThreads.add(start.data.configuration.native_thread_id)
            starts++
          }
        } finally { await reader.close() }
      }
      assert.equal(starts, 8)
      assert.equal(nativeThreads.size, starts)
      assert.equal(inferenceCalls, 8, 'cold native provenance reads never activate another model')
    }
    assert.deepEqual(await hub.client.call(`${assignmentPath}/admit`, admitted.admission.request), historical, 'historical admission retry does not restore revoked authority')
    assert.equal((await hub.client.call(`${root}/operations/${op.id}`)).grant_available, false)
    const audit = await hub.client.call(`${runs}/before/events`)
    assert.equal(audit.events.filter(e => e.data.kind === 'assignment_host_admitted').length, pipelineMode ? 3 : independentMode ? 2 : 1)
    if (mandateMode) assert.equal(audit.events.filter(e => e.data.kind === 'assignment_mandate_queued').length, pipelineMode ? 3 : independentMode ? 2 : 1)
    if (pump) {
      assert.equal(audit.events.filter(e => e.data.kind === 'assignment_creation_receipt').length, pipelineMode ? 3 : ['uncertain', 'downstream', 'verification'].includes(pump) ? 2 : 1)
      if (verificationRecord) { await rm(join(hub.root,'verification-runs'),{recursive:true,force:true}); await rm(join(hub.root,'verification-archives'),{recursive:true,force:true}) }
      await hub.stop('SIGKILL'); await hub.start()
      if (verificationRecord) {
        assert.deepEqual(await hub.client.call(verificationRecord.path),verificationRecord.receipt)
        assert.equal((await hub.client.call(`${root}/operations/${verificationRecord.operation}/events`)).events.filter(e=>e.data.kind==='verification_record_archived').length,1)
      }
      const saved = await hub.client.call(assignmentPath)
      assert.equal(saved.creation.state, 'created')
      assert.equal(saved.creation.completion_authorized, false)
      if (downstreamWorkspace) {
        assert.deepEqual(await hub.client.call(downstreamWorkspace.path, downstreamWorkspace.request), downstreamWorkspace.receipt)
        assert.deepEqual(await hub.client.call(downstreamWorkspace.scope.path, downstreamWorkspace.scope.request), downstreamWorkspace.scope.receipt)
        assert.equal((await hub.client.call(`${runs}/before/events`)).events.filter(e => e.data.kind === 'assignment_input_materialized').length, pipelineMode ? 2 : 1)
      }
      if (pipelineMode) {
        for (const entry of scheduled) assert.deepEqual(await hub.client.call(entry.path, entry.command), entry.receipt)
        const events = (await hub.client.call(`${runs}/before/events`)).events
        const decisions = events.filter(e => e.data.kind === 'work_assignment_prepared' && e.data.actor.kind === 'scheduler')
        assert.equal(decisions.length, 2)
        assert.ok(decisions.every(e => e.data.actor.id === hub.node))
      }
      if (deliveryReceipt) {
        assert.deepEqual(await hub.client.call(deliveryReceipt.path, deliveryReceipt.request), deliveryReceipt.receipt)
        const run = await hub.client.call(`${runs}/before`)
        assert.equal(run.state, 'completed'); assert.equal(run.completion_authorized, true)
        assert.deepEqual(run.delivery, deliveryReceipt.receipt)
        assert.equal((await hub.client.call(`${runs}/before/events`)).events.filter(e => e.data.kind === 'work_run_delivered').length, 1)
      }
      if (reviewCompletion) assert.deepEqual(await hub.client.call(reviewCompletion.path, reviewCompletion.request), reviewCompletion.receipt)
      if (stageCompletion) {
        assert.deepEqual(await hub.client.call(`${runs}/before/stages/inspect/complete`, { request_id: 'complete-inspect', expected_revision: stageCompletion.run_revision - 1, assignment_id: assignment.id }), stageCompletion)
        assert.equal((await hub.client.call(`${root}/assignment-capacities/account`)).held, 0)
        assert.equal((await hub.client.call(`${runs}/before/events`)).events.filter(e => e.data.kind === 'stage_passed').length, pipelineMode ? 3 : independentMode ? 2 : 1)
      }
      if (accountingReceipt) {
        assert.deepEqual(await hub.client.call(`${assignmentPath}/accounting`, saved.accounting.request), accountingReceipt)
        assert.equal((await hub.client.call(`${runs}/before/events`)).events.filter(e => e.data.kind === 'assignment_team_budget_finalized').length, pipelineMode ? 3 : independentMode ? 2 : 1)
        assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.spent, modelToolMode ? 16 : pipelineMode ? 6 : independentMode ? 4 : 2)
      }
      assert.deepEqual(await dispatcher.stop(assignment.id), stopReceipt, 'durable stop replay after Hub restart needs no live handle')
      assert.equal((await hub.client.call(`${runs}/before/events`)).events.filter(e => e.data.kind === 'assignment_execution_drained').length, pipelineMode ? 3 : independentMode ? 2 : 1)
      if (mandateMode) {
        const reselected = await hub.client.call(`${runs}/before/stages/inspect/evidence`, { request_id: 'select', expected_revision: selectedEvidence.run_revision - 1, assignment_id: assignment.id, outputs: selectedEvidence.selection.outputs })
        assert.deepEqual(reselected, selectedEvidence)
        assert.equal((await hub.client.call(`${runs}/before/events`)).events.filter(row => row.data.kind === 'stage_evidence_selected').length, pipelineMode ? 3 : independentMode ? 2 : 1)
        const replay = await hub.client.call(`${assignmentPath}/mandate`, saved.mandate.request)
        assert.deepEqual(replay, saved.mandate.receipt)
        assert.equal((await hub.client.call(`${root}/messages/${replay.message_id}/delivery`)).delivery.phase, 'consumed')
        await assert.rejects(dispatcher.start(assignment.id, { setup }), /Host closed/)
        assert.equal(inferenceCalls, modelToolMode ? 8 : pipelineMode ? 3 : independentMode ? 2 : 1)
      }
      assert.equal((await hub.client.call(`${root}/assignment-dispatches?host=${hub.node}`)).items.length, 0)
    }
  } finally { await runService?.close(); await controller?.close(); releaseHeldTool?.(); for (const name of await readdir(join(hub.root, 'artifact-workspaces')).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
    await chmod(join(hub.root, 'artifact-workspaces', name, 'source'), 0o700).catch(error => { if (error.code !== 'ENOENT') throw error })
  } for (const source of materializedSources) await chmod(source, 0o700); await host?.close(); await dispatcher?.close(); await execution?.close(); await ctx.fiber.dispose(); if (nativeProvider) await new Promise(resolve => { nativeProvider.close(resolve); nativeProvider.closeAllConnections() }); await hub.close() }
})

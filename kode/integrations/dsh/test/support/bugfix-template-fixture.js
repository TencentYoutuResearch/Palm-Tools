/** Candidate-only owned Home/Host fixture for the bugfix workflow integration. */
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile, readdir, chmod, realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
let projectRoot = resolve(here)
while (projectRoot !== dirname(projectRoot)) {
  try { await access(join(projectRoot, 'Cargo.toml')); break } catch { projectRoot = dirname(projectRoot) }
}
if (!(await access(join(projectRoot, 'Cargo.toml')).then(() => true, () => false))) throw Error('Candidate could not locate the repository root')
const fromProject = path => import(pathToFileURL(join(projectRoot, path)).href)
const requireProject = createRequire(join(projectRoot, 'integrations/dsh/test/fixture-automatic-workflow.js'))
const loopRequire = createRequire(requireProject.resolve('@deepseek-ai/dsh-agent-loop'))
const packageModule = name => import(requireProject.resolve(name))
const packageNames = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session-persistence-jsonl']
const sourcePaths = ['integrations/dsh/test/support/isolated-hub.js', 'integrations/dsh/src/agent-profiles.js',
  'integrations/dsh/src/official-execution.js', 'integrations/dsh/src/assignment-dispatch-host.js',
  'integrations/dsh/src/official-loop-host.js', 'integrations/dsh/src/official-grant-guard.js',
  'integrations/dsh/src/work-run-service.js', 'integrations/dsh/src/work-run-controller.js',
  'integrations/dsh/src/work-run-preparation.js', 'integrations/dsh/src/verification-runners.js',
  'integrations/dsh/src/builder-workflow-templates.js', 'integrations/dsh/src/host.js']
const [cordis, sessions, agents, projections, prompts, llm, persistence,
  hubModule, profileModule, executionModule, dispatchModule, loopHostModule, policyModule,
  runModule, controllerModule, preparationModule, verificationModule, templatesModule, hostModule] =
  await Promise.all([...packageNames.map(packageModule), ...sourcePaths.map(fromProject)])
const toolsPackage = await import(loopRequire.resolve('@deepseek-ai/dsh-tools'))

const { Context } = cordis
const SessionStore = sessions.default
const AgentRegistry = agents.default
const Projections = projections.default
const SystemPrompt = prompts.default
const LlmRuntimeModule = llm
const LlmRuntime = LlmRuntimeModule.default
const LlmAdapter = LlmRuntimeModule.LlmAdapter
const Tools = toolsPackage.default
const { isolatedHub } = hubModule
const { AgentProfiles, profileRevision, writePrivateJson } = profileModule
const { OfficialExecution } = executionModule
const { AssignmentDispatchHost } = dispatchModule
const { OfficialLoopHost } = loopHostModule
const { OfficialToolPolicies } = policyModule
const { WorkRunService } = runModule
const { WorkRunController } = controllerModule
const { prepareWorkRunAssignment } = preparationModule
const { verificationExecutableHash } = verificationModule
const { builderWorkflowTemplates } = templatesModule
const { apply: applyHost } = hostModule

const runGit = async (cwd, args) => promisify(execFile)('/usr/bin/git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' },
})
const waitFor = async (predicate, label, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const ref = row => ({ id: row.id, version: row.version, hash: row.hash })
const policyRef = row => ({ id: row.id, revision: row.revision, hash: row.hash })
/**
 * mode: reproduced | unreproduced | rework.
 * The model adapter only emits declared tools. Reproduction and regression
 * checks run as real, immutable local child processes through VerificationRunners.
 */
export async function createBugfixFixture(mode) {
  assert.ok(['reproduced', 'unreproduced', 'rework'].includes(mode))
  const hub = await isolatedHub(`bugfix-${mode}`)
  const hubRoot = await realpath(hub.root)
  const ctx = new Context()
  let execution, host, dispatcher, service
  const records = { calls: [], error: null, implementationStarted: false, reviewReads: [], stageSnapshots: [], activeGate: null }
  const root = '/api/v1/messaging', runs = `${root}/work-runs`
  try {
    const workspaceRoot = await (async () => {
      const path = join(hubRoot, 'repository')
      await mkdir(path)
      const canonicalPath = await realpath(path)
      await runGit(canonicalPath, ['init', '-q'])
      await writeFile(join(canonicalPath, 'source.txt'), 'buggy source')
      await runGit(canonicalPath, ['add', '.']); await runGit(canonicalPath, ['commit', '-qm', 'bugfix baseline'])
      const base = (await runGit(canonicalPath, ['rev-parse', 'HEAD'])).stdout.trim()
      await writeFile(join(canonicalPath, 'owner-dirty.txt'), 'owner dirty bytes must stay here')
      return { path: canonicalPath, base, status: (await runGit(canonicalPath, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout,
        dirty: await readFile(join(canonicalPath, 'owner-dirty.txt')) }
    })()
    const profiles = await new AgentProfiles(join(hubRoot, 'profiles.json')).open([{ id: 'official', name: 'Official fixture', type: 'dsh' }])
    const template = builderWorkflowTemplates().find(row => row.id === 'software-bugfix')
    assert.ok(template?.workflow?.stages?.some(stage => stage.id === 'diagnose' && stage.waiver?.allow_delivery === true))
    const executable = await (await import('node:fs/promises')).realpath(process.execPath)
    const marker = join(hubRoot, 'reproduction.started')
    const gate = join(hubRoot, 'reproduction.release')
    const reproduceProgram = `const fs=require('node:fs');const source=fs.readFileSync('source.txt','utf8');if(source!=='buggy source')process.exit(7);fs.writeFileSync(${JSON.stringify(marker)},'started');${mode === 'reproduced' ? `const end=Date.now()+25000;while(!fs.existsSync(${JSON.stringify(gate)})){if(Date.now()>end)process.exit(8);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)}` : mode === 'unreproduced' ? `process.exit(9)` : ''}process.stdout.write(JSON.stringify({cwd:process.cwd(),source}));`
    const verifyProgram = `const fs=require('node:fs');const source=fs.readFileSync('source.txt','utf8');if(source!=='fixed source')process.exit(7);process.stdout.write(JSON.stringify({cwd:process.cwd(),source}));${mode === 'unreproduced' ? 'process.exit(9)' : ''}`
    const internalProgram = mode === 'rework'
      ? `const fs=require('node:fs');const source=fs.readFileSync('source.txt','utf8');if(source!=='fixed source')process.exit(7);process.stdout.write(JSON.stringify({cwd:process.cwd(),source}));`
      : verifyProgram
    const commandDefinitions = new Map()
    const addCommand = async (id, args, scenario) => {
      const reference = execution.verificationRunners.register({ runner_id: 'bugfix-fixture', command_id: id, revision: '1',
        executable, executable_hash: await verificationExecutableHash(executable), args: ['-e', args], env: {}, timeout_ms: 30000,
        max_output_bytes: 65536, scenario_ids: [scenario], capabilities: ['read'], network: false, tool_id: 'kode_verify_output' })
      commandDefinitions.set(id, reference)
      return reference
    }

    // Initialize the real Host plugins and OfficialExecution before registering
    // commands in this fixture's in-memory VerificationRunners registry.
    await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(Projections)
    await ctx.plugin(persistence, { root: join(hubRoot, 'sessions'), compression: 'zstd' })
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
    await ctx.plugin(Tools); await ctx.plugin(LlmRuntime)
    ctx.provide('workspaceRegistry', { list: () => [{ id: 'repository', path: workspaceRoot.path }] })
    ctx.provide('kodeOfficialToolPolicies', new OfficialToolPolicies())
    execution = new OfficialExecution(ctx, profiles, hub.client, { host: hub.node })
    await execution.ready
    await addCommand('reproduce', reproduceProgram, 'reproduction-confirmed')
    await addCommand('check', internalProgram, 'regression')
    const projectCommand = reference => ({ id: reference.id, revision: reference.revision, definition_hash: reference.definition_hash,
      repository_binding: 'code', environment_binding: 'local', runner_id: reference.runner_id, scenario_ids: reference.scenario_ids })

    class FixtureAdapter extends LlmAdapter {
      async *stream(options) {
        const binding = profiles.binding(options.sessionId), assignmentId = binding?.managedAssignment?.id
        assert.ok(assignmentId, 'every model turn belongs to a durable Assignment')
        const assignment = await hub.client.call(`${root}/work-assignments/${assignmentId}`)
        const stage = assignment.stage_id, attempt = assignment.stage_attempt, step = records.calls.filter(row => row.session_id === options.sessionId).length
        records.calls.push({ session_id: options.sessionId, stage, attempt, step })
        if (step === 0 && (assignment.execution_workspace?.receipt || assignment.task_workspace?.receipt)) {
          const receipt = assignment.execution_workspace?.receipt ?? assignment.task_workspace.receipt
          const taskRoot = receipt.scope?.target?.root ?? receipt.root
          records.stageSnapshots.push({ stage, attempt, basis: receipt.starting_snapshot?.basis,
            snapshot_hash: receipt.starting_snapshot?.snapshot_hash ?? receipt.snapshot_hash,
            sources: assignment.inputs?.binding?.sources, waivers: assignment.inputs?.binding?.waivers,
            source: await readFile(join(taskRoot, 'source.txt'), 'utf8') })
        }
        if (stage === 'implement') {
          assert.ok(assignment.inputs.binding.sources.baseline.outputs.baseline.sequence > 0,
            'implementation must retain the frozen baseline archive as an input source')
          if (mode === 'unreproduced') assert.ok(assignment.inputs.binding.waivers?.diagnose,
            'an owner waiver is recorded separately from artifact sources')
          if (attempt === 1 && mode === 'rework') records.implementationStarted = true
          if (attempt === 1 && stage === 'implement' && assignment.inputs.binding.rework) throw Error('First implementation cannot be labeled rework')
          if (attempt > 1 && step === 0) {
            const receipt = assignment.execution_workspace?.receipt ?? assignment.task_workspace?.receipt
            assert.equal(receipt?.starting_snapshot?.basis, 'rework_artifact')
            const taskRoot = receipt.scope?.target?.root ?? receipt.root
            records.reworkStart = await readFile(join(taskRoot, 'source.txt'), 'utf8')
            const previousAttemptSource = mode === 'rework' && attempt === 2 ? 'partial fix' : 'fixed source'
            assert.equal(records.reworkStart, previousAttemptSource, 'rework must start from the previous attempt artifact, not the original baseline')
          }
        }
        if (records.error) throw records.error
        assert.ok(options.tools.every(tool => tool.name.startsWith('kode_')))
        const tool = (name, args) => ({ type: 'block-end', index: 0,
          block: { type: 'tool-call', id: `bugfix-${step}`, name, arguments: JSON.stringify(args) } })
        const previousMessage = options.messages.find(row => row.role === 'tool' && row.source?.callId === `bugfix-${step - 1}`)
        const previous = step > 0 ? JSON.parse(previousMessage.content.filter(part => part.type === 'text').map(part => part.text).join('')) : null
        let name, args
        if (stage === 'baseline') {
          if (step === 0) { name = 'kode_capture_output'; args = { output: 'baseline', request_id: 'baseline-capture' } }
          else if (step === 1) { name = 'kode_publish_output'; args = { output: 'baseline', evidence_id: previous.evidence_id } }
        } else if (stage === 'diagnose') {
          if (step === 0) { name = 'kode_verify_output'; args = { output: 'reproduction', request_id: 'reproduce-baseline' } }
          else if (step === 1) { name = 'kode_publish_output'; args = { output: 'reproduction', evidence_id: previous.evidence_id } }
        } else if (stage === 'implement') {
          records.implementationStarted = true
          if (step === 0) { name = 'kode_read_source'; args = { path: 'source.txt' } }
          else if (step === 1) {
            const expected = attempt > 1 ? (mode === 'rework' && attempt === 2 ? 'partial fix' : 'fixed source') : 'buggy source'
            assert.equal(previous.text, expected)
            name = 'kode_write_source'; args = { path: 'source.txt', expected_sha256: previous.sha256,
              content: mode === 'rework' && attempt === 1 ? 'partial fix' : 'fixed source' }
          } else if (step === 2) { name = 'kode_capture_output'; args = { output: 'artifact', request_id: `implementation-${attempt}` } }
          else if (step === 3) { name = 'kode_publish_output'; args = { output: 'artifact', evidence_id: previous.evidence_id } }
        } else if (stage === 'review') {
          if (step === 0) { name = 'kode_read_source'; args = { path: 'source.txt' } }
          else if (step === 1) {
            assert.equal(previous.text, mode === 'rework' && attempt === 1 ? 'partial fix' : 'fixed source')
            name = 'kode_review_output'; args = { output: 'reviewed', request_id: `review-${attempt}`,
              verdict: mode === 'rework' && attempt === 1 ? 'failed' : 'passed',
              findings: mode === 'rework' && attempt === 1 ? [{ id: 'rework', blocking: true, evidence_ref: 'source.txt' }] : [] }
          } else if (step === 2) { name = 'kode_publish_output'; args = { output: 'reviewed', evidence_id: previous.evidence_id } }
        } else if (stage === 'verify') {
          if (step === 0) { name = 'kode_verify_output'; args = { output: 'checked', request_id: `check-${attempt}` } }
          else if (step === 1) { name = 'kode_publish_output'; args = { output: 'checked', evidence_id: previous.evidence_id } }
        } else throw Error(`Unexpected bugfix stage ${stage}`)

        if (stage === 'review' && step === 0) records.reviewReads.push(previous?.text ?? 'reading')
        if (!name) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Declared stage outputs published.' } }
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield tool(name, args)
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    }
    ctx.llm.registerAdapter(['fixture'], new FixtureAdapter())
    host = new OfficialLoopHost(ctx, execution)
    ctx.provide('kodeAgents', { profiles, officialExecution: execution })
    const hostState = join(hubRoot, 'host-state.json')
    await writePrivateJson(hostState, {})
    await applyHost(ctx, { url: hub.url, tokenFile: join(hubRoot, 'admin.token'), stateFile: hostState,
      agentRuntime: false, runtimeBridge: false, pollMs: 10 })
    dispatcher = new AssignmentDispatchHost(host)
    const controller = new WorkRunController(dispatcher, { prepare: (assignment, options) => prepareWorkRunAssignment(execution, assignment, options) })

    const workflow = await hub.client.call(`${root}/workflows`, { ...template.workflow })
    const local = await hub.client.call(`${root}/project-configs`, { id: 'bugfix-project', version: '1', spec: {
      kind: 'project_bindings', repositories: { code: { repository_id: 'fixture-repository', workspace: {
        host_id: hub.node, workspace_id: 'repository', root_ref: workspaceRoot.path,
      } } }, environments: { local: { host_id: hub.node, adapter_id: 'local_process_v1',
        configuration_hash: commandDefinitions.get('check').environment_hash } },
      commands: { reproduce: projectCommand(commandDefinitions.get('reproduce')), check: projectCommand(commandDefinitions.get('check')) }, connections: {},
    } })
    const delivery = await hub.client.call(`${root}/project-configs`, { id: 'bugfix-delivery', version: '1', spec: {
      kind: 'delivery_policy', workflow: ref(workflow), project: ref(local), targets: template.delivery.targets,
      required_outputs: template.delivery.required_outputs,
    } })
    await hub.client.call(`${root}/price-versions`, { id: 'fixture-price', model: 'fixture-model', unit: 'credits', model_policy: 'requested_model',
      input_per_million: 1000000, cached_per_million: 1000000, output_per_million: 1000000 })
    const budget = await hub.client.call(`${root}/budgets`, { id: 'team-budget', scope: 'team', scope_id: 'bugfix-team', unit: 'credits',
      limit: 100, starts_at: Date.now() - 1000, ends_at: Date.now() + 180000, expected_revision: 0 })
    const budgetPolicy = await hub.client.call(`${root}/team-policies`, { id: 'budget-policy', team_id: 'bugfix-team', expected_revision: 0,
      policy: { kind: 'budget', budget_ids: ['team-budget'], unit: 'credits', max_assignment_charge: 10, settlement: 'internal_price' } })
    await hub.client.call(`${root}/resource-accounts`, { id: 'account', expected_epoch: 0, enabled: true })
    await hub.client.call(`${root}/resource-bindings`, { host: hub.node, profile: 'official', account_id: 'account', account_epoch: 1, expected_revision: 0 })
    const now = Date.now()
    const taskTags = ['inspection', 'verification', 'implementation', 'review']
    const assessments = Object.fromEntries(taskTags.map(tag => [tag, { evaluation: { kind: 'task_fit', tag, score: 90 }, source: 'user', confidence: 0.9,
      evidence: [], pinned: false, updated_at: now - 1, valid_until: now + 180000 }]))
    await hub.client.call(`${root}/capability-profiles`, { id: 'capability', expected_revision: 0, host: hub.node, profile: 'official', model: 'fixture-model',
      assessments })
    const scheduling = await hub.client.call(`${root}/team-policies`, { id: 'scheduling-policy', team_id: 'bugfix-team', expected_revision: 0, policy: {
      kind: 'scheduling', targets: { target: { resource: { host: hub.node, profile: 'official', account_id: 'account', account_epoch: 1,
        binding_revision: 1, limit_ids: ['daily'], unknown_quota: 'team_budget' }, capability_id: 'capability', capability_revision: 1,
        preferred: true, internal_price_id: 'fixture-price' } }, weights: { quality: 100, cost: 50, latency: 20 }, minimum_quality: 60, minimum_confidence: 0.7,
    } })
    await hub.client.call(`${root}/assignment-capacities`, { account_id: 'account', expected_revision: 0, max_active_assignments: 1 })
    const workspaceRef = { host_id: hub.node, workspace_id: 'repository', root_ref: workspaceRoot.path }
    const spec = { name: 'Bugfix team', purpose: 'Controlled bugfix fixture', kind: 'coordinator', workspace_refs: [workspaceRef],
      execution_targets: [{ id: 'target', host_id: hub.node, executor_profile_id: 'official', executor_profile_revision: profileRevision(profiles.get('official')),
        provider_id: 'fixture', model_id: 'fixture-model', effort: null, account_binding_id: 'account', capability_profile_revision: '1' }],
      workers: ['implementer', 'reviewer', 'verifier'].map(role => ({ id: role, role,
        responsibilities: [`Execute ${role} stages in the controlled bugfix workflow.`], allowed_target_ids: ['target'],
        required_capabilities: role === 'implementer' ? ['read', 'workspace_write'] : ['read'],
        workspace_refs: [workspaceRef], max_parallel: 1 })),
      coordinator_targets: ['target'], workflow_pack_refs: [ref(workflow)],
      delivery_bindings: [{ id: 'local', workflow: ref(workflow), project: ref(local), delivery_policy: ref(delivery) }],
      grant_id: 'grant', budget_policy_id: 'budget-policy', scheduling_policy_id: 'scheduling-policy',
      limits: { max_active_assignments: 1, max_active_runs: 2 }, proactive_mode: 'off' }
    await hub.client.call(`${root}/teams`, { id: 'bugfix-team', request_id: 'team-create', expected_revision: 0, spec })
    const toolsAllowed = [...new Set(template.workflow.stages.flatMap(stage => stage.execution.tools))]
    const grant = await hub.client.call(`${root}/team-grants`, { expected_revision: 0, policy: {
      id: 'grant', team_id: 'bugfix-team', enabled: true, expires_at: Date.now() + 180000,
      targets: [{ host: hub.node, workspace: 'repository', root: workspaceRoot.path }], capabilities: ['read', 'workspace_write', 'delegate'],
      tools: toolsAllowed, network: false, budget_ids: ['team-budget'],
    } })
    const scheduleRef = policyRef(scheduling), budgetRef = policyRef(budgetPolicy)
    await hub.client.call(`${root}/teams/bugfix-team/activation`, { action: 'activate', request_id: 'activate', expected_revision: 0,
      team_revision: 1, grant_revision: grant.grant.revision, budget_policy: budgetRef, scheduling_policy: scheduleRef })
    const run = await hub.client.call(runs, { id: `bugfix-${mode}`, request_id: `bugfix-${mode}`, team_id: 'bugfix-team', team_revision: 1,
      binding_id: 'local', inputs: { request: 'Fix the controlled defect in source.txt' }, prior_run_id: null })
    service = await new WorkRunService(controller, { intervalMs: 100 }).open()
    service.start()
    return { hub, ctx, profiles, execution, host, dispatcher, service, runId: run.id, root, workspace: workspaceRoot, template, records, marker, gate,
      closeService: async () => { await service?.close(); service = undefined },
      close: async () => {
        await service?.close(); service = undefined; await host?.close(); host = undefined; await dispatcher?.close(); dispatcher = undefined
        await execution?.close(); execution = undefined; await ctx.fiber.dispose()
        for (const name of await readdir(join(hubRoot, 'artifact-workspaces')).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
          await chmod(join(hubRoot, 'artifact-workspaces', name, 'source'), 0o700).catch(error => { if (error.code !== 'ENOENT') throw error })
        }
        await hub.close()
      },
    }
  } catch (error) {
    await service?.close().catch(() => {}); await host?.close().catch(() => {}); await dispatcher?.close().catch(() => {})
    await execution?.close().catch(() => {}); await ctx.fiber.dispose().catch(() => {}); await hub.close().catch(() => {})
    throw error
  }
}

export async function waitForFile(path, timeoutMs = 20000) {
  await waitFor(() => access(path).then(() => true, () => false), path, timeoutMs)
}

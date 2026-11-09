import { waiveStageInBrowser } from './support/stage-waiver-browser.js'
import { acceptDeliveryInBrowser } from './support/human-delivery-browser.js'
import { prepareWorkRunAssignment } from '../src/work-run-preparation.js'
import { WorkRunService } from '../src/work-run-service.js'
import { WorkRunController } from '../src/work-run-controller.js'
import { VerificationRunners, verificationExecutableHash } from '../src/verification-runners.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile, realpath, readFile, chmod, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isolatedHub } from './support/isolated-hub.js'
import { apply as applyHost } from '../src/host.js'
import { AgentProfiles, profileRevision, writePrivateJson } from '../src/agent-profiles.js'
import { OfficialExecution } from '../src/official-execution.js'
import { AssignmentDispatchHost } from '../src/assignment-dispatch-host.js'
import { OfficialLoopHost } from '../src/official-loop-host.js'
import { OfficialToolPolicies } from '../src/official-grant-guard.js'
import { ASSIGNMENT_PROMPT_VERSION } from '../src/assignment-prompt.js'
const loopRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { default: Tools } = await import(loopRequire.resolve('@deepseek-ai/dsh-tools'))

const modes = ['success', 'verification-rework', 'verification-limit', 'verification-cancel', 'cancel-busy', 'cancel-tool', 'shared-teams', 'takeover-tool']
const waiverRework = process.env.KODE_TEST_WAIVER_REWORK === '1'
const waiverMiddle = process.env.KODE_TEST_WAIVER_MIDDLE === '1'
const waiverTarget = waiverMiddle ? 'followup' : 'verify'
const waiverDelivery = process.env.KODE_TEST_WAIVER_DELIVERY === '1'
const waiverDecision = process.env.KODE_TEST_WAIVER_DECISION === '1'
const waiverPreview = process.env.KODE_TEST_WAIVER_PREVIEW === '1'
const escalationBudgetBlocked = process.env.KODE_TEST_STAGE_ESCALATION_BUDGET === '1'
const exclusiveResources=process.env.KODE_TEST_EXCLUSIVE_RESOURCES==='1'
const sharedExpert = process.env.KODE_TEST_SHARED_EXPERT_PRESSURE === '1'
const parallelTaskWorkspace = process.env.KODE_TEST_TASK_WORKTREE_PARALLEL === '1'
const alternateExpert = process.env.KODE_TEST_STAGE_ESCALATION_ALTERNATE === '1'
const stageEscalation = process.env.KODE_TEST_STAGE_ESCALATION === '1'
const selected = process.env.KODE_TEST_AUTOMATIC_SCENARIO
const humanAcceptance = process.env.KODE_TEST_HUMAN_ACCEPTANCE === '1'
const humanReject = process.env.KODE_TEST_HUMAN_ACCEPTANCE_CHOICE === 'reject'
if (humanAcceptance && selected !== 'success') throw Error('Human acceptance fixture requires success scenario')
if (selected && !modes.includes(selected)) throw new Error('Unknown automatic fixture scenario')
if(sharedExpert&&(selected!=='shared-teams'||!stageEscalation||!alternateExpert||escalationBudgetBlocked))throw Error('Shared expert fixture requires two teams and alternate escalation')
if(parallelTaskWorkspace&&selected!=='shared-teams')throw Error('Parallel task worktree fixture requires two teams')
for (const mode of modes.filter(mode => selected ? selected === mode : !['shared-teams', 'takeover-tool'].includes(mode))) test(`default workflow preparation drives intake through real tools (mode=${mode})`, { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: mode === 'takeover-tool' ? 90000 : 60000 }, async t => {
  const sharedMode = mode === 'shared-teams'
  const interventionMode = mode === 'takeover-tool'
  // Positive observations must cover the 60s case plus its lease admission window.
  const fixtureLifetime = sharedMode ? 180000 : 120000
  const limitMode = ['verification-limit', 'verification-cancel'].includes(mode)
  const pump = 'automatic', reworkMode = true, modelToolMode = false, pipelineMode = true, independentMode = true, completeMode = true, mandateMode = true, externalDelivery = false
  const hub = await isolatedHub('automatic-workflow'), ctx = new Context()
  if (process.env.KODE_TEST_CANCEL_CRASH && process.send) process.send({ type: 'fixture-resources', root: hub.root, url: hub.url, node: hub.node, hub_pid: hub.pid })
  let execution, host, dispatcher, service
  try {
    await mkdir(join(hub.root, 'repo'))
    const workspaceRoot = await realpath(join(hub.root, 'repo'))
    let workspaceBaseCommit, originalDirtyTree, gitAt
    if (mandateMode) {
      const git = args => promisify(execFile)('/usr/bin/git', ['-C', workspaceRoot, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' } })
      gitAt = (cwd, args) => promisify(execFile)('/usr/bin/git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' } })
      // Keep the repo's base fixed while preserving pre-existing owner edits outside task worktrees.
      await git(['init', '-q']); await writeFile(join(workspaceRoot, 'source.txt'), 'fixture source')
      await git(['add', '.']); await git(['commit', '-qm', 'fixture base'])
      workspaceBaseCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim()
      if (sharedMode) {
        await writeFile(join(workspaceRoot, 'source.txt'), 'owner dirty source')
        await writeFile(join(workspaceRoot, 'owner-untracked.txt'), 'preserve this untracked owner file')
        originalDirtyTree = { status: (await git(['status', '--porcelain=v1', '--untracked-files=all'])).stdout,
          source: await readFile(join(workspaceRoot, 'source.txt'), 'utf8'),
          untracked: await readFile(join(workspaceRoot, 'owner-untracked.txt'), 'utf8'),
          base_commit: workspaceBaseCommit }
      }
    }
    const canonicalHubRoot = await realpath(hub.root)
    const profiles = await new AgentProfiles(join(canonicalHubRoot, 'profiles.json')).open([{ id: 'profile', name: 'Official', type: 'dsh' }])
    const root = '/api/v1/messaging', path = `${root}/teams/team/activation`, runs = `${root}/work-runs`
    const versionRef = r => ({ id: r.id, version: r.version, hash: r.hash })
    const policyRef = r => ({ id: r.id, revision: r.revision, hash: r.hash })
    const workspace = { host_id: hub.node, workspace_id: 'workspace', root_ref: workspaceRoot }
    const taskReceipt = assignment => assignment?.execution_workspace?.receipt
    const assertTaskSource = async (assignment, expected, { checkContent = true } = {}) => {
      const receipt = taskReceipt(assignment)
      assert.ok(receipt, 'workspace_write Assignment must carry its accepted task worktree receipt')
      assert.equal(receipt.kind, 'derived_task_worktree')
      assert.equal(receipt.repository, workspaceRoot)
      assert.equal(receipt.repository_binding, 'code')
      assert.equal(receipt.run_id, assignment.run_id)
      assert.equal(receipt.host, hub.node)
      assert.equal(receipt.base_commit, workspaceBaseCommit)
      assert.equal(receipt.scope_authorized, true)
      assert.equal(receipt.execution_authorized, false)
      assert.equal(receipt.scope.target.root, receipt.root)
      assert.ok(['git_base','frozen_artifact','rework_artifact','owner_resumed_task'].includes(receipt.starting_snapshot?.basis))
      assert.match(receipt.starting_snapshot.snapshot_hash, /^[a-f0-9]{64}$/)
      assert.deepEqual(receipt.authority_scope, assignment.candidate.grant_scope)
      assert.deepEqual(assignment.task_workspace.receipt, receipt)
      if (checkContent) assert.equal(await readFile(join(receipt.root, 'source.txt'), 'utf8'), expected)
      assert.equal((await gitAt(receipt.root, ['rev-parse', 'HEAD'])).stdout.trim(), workspaceBaseCommit)
      assert.equal((await gitAt(receipt.root, ['branch', '--show-current'])).stdout.trim(), receipt.branch)
      return receipt
    }
    const toolMarker = join(hub.root, 'verification-process.json')
    let verificationDefinition, verificationReference
    const exclusiveWaits=[],exclusiveAdmissions=new Set()
    if (pump === 'verification' || pipelineMode) {
      const executable = await realpath(process.execPath)
      verificationDefinition = { runner_id: 'local-check', command_id: 'snapshot-check', revision: '1', executable,
        executable_hash: await verificationExecutableHash(executable), args: ['-e', `const fs=require('node:fs');if(fs.readFileSync('source.txt','utf8')!==${JSON.stringify(sharedMode ? 'team-a source' : reworkMode ? 'repaired source' : 'fixture source')})process.exit(3);process.stdout.write('verified fixture source'+'x'.repeat(200000))`],
        env: {}, timeout_ms: 5000, max_output_bytes: 262144, scenario_ids: ['smoke'], capabilities: ['read'], network: false, tool_id: 'kode_verify_output' }
      if(exclusiveResources){
        verificationDefinition.exclusive_resources=['fixture-device']
        if(sharedMode){
          const program=verificationDefinition.args[1],device=JSON.stringify(join(hub.root,'shared-device.open'))
          verificationDefinition.args=['-e',`const deviceFs=require('node:fs'),devicePath=${device};const deviceFd=deviceFs.openSync(devicePath,'wx');setTimeout(()=>{deviceFs.closeSync(deviceFd);deviceFs.unlinkSync(devicePath);${program}},1500)`]
        }
      }
      if (mode === 'cancel-tool' || interventionMode) {
        const successProgram = verificationDefinition.args[1]
        verificationDefinition.args = ['-e', `const fs=require('node:fs');const marker=${JSON.stringify(toolMarker)};fs.writeFileSync(marker,JSON.stringify({pid:process.pid,state:'running'}));process.on('SIGTERM',()=>{fs.writeFileSync(marker,JSON.stringify({pid:process.pid,state:'stopped'}));process.exit(0)});setInterval(()=>{},1000)`]
        if (interventionMode) verificationDefinition.args = ['-e', `const markerFs=require('node:fs');if(markerFs.existsSync(${JSON.stringify(toolMarker)})){${successProgram}}else{${verificationDefinition.args[1]}}`]
        verificationDefinition.timeout_ms = 20000
      }
      const registry = new VerificationRunners(join(hub.root,'verification-runs'))
      verificationReference = registry.register(verificationDefinition); await registry.close()
    }
    if (reworkMode) await hub.client.call(`${root}/price-versions`, { id: 'price', model: 'model', unit: 'credits', model_policy: 'requested_model', input_per_million: 1000000, cached_per_million: 1000000, output_per_million: 1000000 })
    const workflow = await hub.client.call(`${root}/workflows`, { id: 'flow', version: '1', inputs: ['request'],
      stages: [{ id: 'inspect', role: 'coordinator', requires: ['request'], produces: ['artifact'], independent_from: [], execution: { task_tag: 'inspection', ...(stageEscalation ? { escalation: [{ after_reworks: 1, task_tag: 'specialist', minimum_quality: 90 }] } : {}), repository_binding: 'code', capabilities: modelToolMode || reworkMode ? ['read', 'workspace_write'] : ['read'], tools: reworkMode ? ['kode_capture_output', 'kode_write_source', 'kode_read_source', 'kode_publish_output'] : modelToolMode ? ['kode_capture_output', 'kode_write_source'] : ['fixture_inspect'], network: false } },
        { id: 'followup', ...(waiverMiddle ? { waiver: { allow_delivery: waiverDelivery } } : {}), ...(reworkMode ? { on_reject: { target: 'inspect', max_reworks: 1 } } : {}), role: 'coordinator', requires: ['inspect'], produces: ['later'], independent_from: independentMode ? ['inspect'] : [], execution: { task_tag: 'inspection', repository_binding: 'code', capabilities: ['read'], tools: reworkMode ? ['kode_review_output', 'kode_read_source', 'kode_publish_output'] : modelToolMode ? ['kode_review_output', 'kode_list_source', 'kode_read_source'] : ['fixture_inspect'], network: false } },
        ...(pipelineMode ? [{ id: 'verify', ...(waiverPreview && !waiverMiddle ? { waiver: { allow_delivery: waiverDelivery } } : {}), ...(mode !== 'success' ? { on_reject: { target: 'inspect', max_reworks: 1 } } : {}), role: 'coordinator', requires: ['followup'], produces: ['checked'], independent_from: ['inspect', 'followup'], execution: { task_tag: 'inspection', repository_binding: 'code', capabilities: ['read'], tools: ['kode_verify_output', 'kode_publish_output'], network: false } }] : [])],
      completion_stages: [pipelineMode ? 'verify' : 'followup'], evidence_rules: { ...(pipelineMode ? { checked: { kind: 'verification', artifact_output: 'artifact', command_binding: 'check', environment_binding: 'local', required_scenarios: ['smoke'] } } : {}), artifact: { kind: 'artifact', repository_binding: 'code' }, later: pump === 'verification' ? { kind: 'verification', artifact_output: 'artifact', command_binding: 'check', environment_binding: 'local', required_scenarios: ['smoke'] } : independentMode ? { kind: 'review', artifact_output: 'artifact' } : { kind: 'artifact', repository_binding: 'code' } } })
    const project = await hub.client.call(`${root}/project-configs`, { id: 'project', version: '1', spec: { kind: 'project_bindings',
      repositories: { code: { repository_id: 'repository', workspace } }, environments: verificationReference ? { local: { host_id: hub.node, adapter_id: 'local_process_v1', configuration_hash: verificationReference.environment_hash } } : {},
      commands: verificationReference ? { check: { id: verificationReference.id, revision: verificationReference.revision, definition_hash: verificationReference.definition_hash,...(verificationReference.exclusive_resources?{exclusive_resources:verificationReference.exclusive_resources}:{}),
        repository_binding: 'code', environment_binding: 'local', runner_id: verificationReference.runner_id, scenario_ids: verificationReference.scenario_ids } } : {}, connections: externalDelivery ? { forge: { adapter_id: 'fixture-forge', connection_id: 'fixture-connection', capabilities: ['create_change_request'] } } : {} } })
    const delivery = await hub.client.call(`${root}/project-configs`, { id: 'delivery', version: '1', spec: { kind: 'delivery_policy',
      workflow: versionRef(workflow), project: versionRef(project), targets: externalDelivery ? [{ kind: 'change_request', repository_binding: 'code', connection_binding: 'forge', target_branch: 'main' }] : [{ kind: 'local', repository_binding: 'code' }], required_outputs: pipelineMode ? ['checked'] : ['artifact'], ...(humanAcceptance ? { human_acceptance: true } : {}) } })
    await hub.client.call(`${root}/budgets`, { id: 'budget', scope: 'team', scope_id: 'team', unit: 'credits', limit: escalationBudgetBlocked ? 30 : 100,
      starts_at: Date.now() - 1000, ends_at: Date.now() + fixtureLifetime, expected_revision: 0 })
    if(sharedMode)await hub.client.call(`${root}/budgets`,{id:'shared-budget',scope:'shared',scope_id:'account',unit:'credits',limit:sharedExpert?62:100,starts_at:Date.now()-1000,ends_at:Date.now()+fixtureLifetime,expected_revision:0})
    const budgetCommand = { id: 'budget-policy', team_id: 'team', expected_revision: 0,
      policy: { kind: 'budget', budget_ids: sharedMode ? ['budget','shared-budget'] : ['budget'], unit: 'credits', max_assignment_charge: sharedExpert?20:10, ...(mandateMode ? { settlement: 'internal_price' } : {}) } }
    const budget = await hub.client.call(`${root}/team-policies`, budgetCommand)
    const scheduleCommand = { id: 'schedule-policy', team_id: 'team', expected_revision: 0,
      policy: { kind: 'scheduling', targets: { target: { resource: { host: hub.node, profile: 'profile', account_id: 'account', account_epoch: 1,
        binding_revision: 1, limit_ids: ['daily'], unknown_quota: 'team_budget' }, capability_id: 'capability', capability_revision: 1, preferred: false, ...(reworkMode ? { internal_price_id: 'price' } : {}) } },
      weights: { quality: 100, cost: 50, latency: 20 }, minimum_quality: 60, minimum_confidence: 0.7 } }
    if (pipelineMode) {
      scheduleCommand.policy.targets['aaa-alternate'] = structuredClone(scheduleCommand.policy.targets.target)
      scheduleCommand.policy.targets.target.preferred = true
    }
    if (alternateExpert) {
      scheduleCommand.policy.targets['aaa-alternate'].capability_id = 'expert-capability'
      scheduleCommand.policy.targets['aaa-alternate'].internal_price_id = 'expert-price'
      await hub.client.call(`${root}/price-versions`, { id: 'expert-price', model: 'expert-model', unit: 'credits', model_policy: 'requested_model', input_per_million: sharedExpert?2000000:1000000, cached_per_million: 1000000, output_per_million: sharedExpert?2000000:1000000 })
    }
    const schedule = await hub.client.call(`${root}/team-policies`, scheduleCommand)
    const spec = { name: 'Team', purpose: 'Fixture', kind: 'coordinator', workspace_refs: [workspace],
      execution_targets: [{ id: 'target', host_id: hub.node, executor_profile_id: 'profile', executor_profile_revision: profileRevision(profiles.get('profile')), provider_id: 'fixture', model_id: 'model', effort: null,
        account_binding_id: 'account', capability_profile_revision: '1' }], workers: [], coordinator_targets: ['target'], workflow_pack_refs: [versionRef(workflow)],
      delivery_bindings: [{ id: 'local', workflow: versionRef(workflow), project: versionRef(project), delivery_policy: versionRef(delivery) }],
      grant_id: 'grant', budget_policy_id: 'budget-policy', scheduling_policy_id: 'schedule-policy',
      limits: { max_active_assignments: parallelTaskWorkspace ? 2 : completeMode ? 1 : 2, max_active_runs: 8 }, proactive_mode: 'off' }
    if (pipelineMode) {
      spec.execution_targets.push({ ...spec.execution_targets[0], id: 'aaa-alternate', ...(alternateExpert ? { model_id: 'expert-model' } : {}) })
      spec.coordinator_targets.unshift('aaa-alternate')
    }
    await hub.client.call(`${root}/teams`, { id: 'team', request_id: 'new', expected_revision: 0, spec })
    const grantCommand = { expected_revision: 0, policy: { id: 'grant', team_id: 'team', enabled: true, expires_at: Date.now() + fixtureLifetime,
      targets: [{ host: hub.node, workspace: 'workspace', root: workspaceRoot }], capabilities: modelToolMode || reworkMode ? ['read', 'workspace_write'] : ['read'], tools: pipelineMode ? ['kode_verify_output', 'kode_publish_output', ...(modelToolMode || reworkMode ? ['kode_capture_output', 'kode_review_output', 'kode_list_source', 'kode_read_source', 'kode_write_source'] : [])] : ['fixture_inspect'], network: false, budget_ids: sharedMode ? ['budget','shared-budget'] : ['budget'] } }
    let grant = (await hub.client.call(`${root}/team-grants`, grantCommand)).grant
    const request = { id: 'before', request_id: 'before', team_id: 'team', team_revision: 1, binding_id: 'local', inputs: { request: sharedMode ? 'Change source.txt to team-a source.' : 'Change source.txt to repaired source.' }, prior_run_id: null }
    const initial = await hub.client.call(runs, request)
    const command = { action: 'activate', request_id: 'activate', expected_revision: 0, team_revision: 1, grant_revision: grant.revision,
      budget_policy: policyRef(budget), scheduling_policy: policyRef(schedule) }

    await hub.client.call(`${root}/resource-accounts`, { id: 'account', expected_epoch: 0, enabled: true })
    await hub.client.call(`${root}/resource-bindings`, { host: hub.node, profile: 'profile', account_id: 'account', account_epoch: 1, expected_revision: 0 })
    const at = Date.now()
    await hub.client.call(`${root}/capability-profiles`, { id: 'capability', expected_revision: 0, host: hub.node, profile: 'profile', model: 'model', assessments: {
      fit: { evaluation: { kind: 'task_fit', tag: 'inspection', score: 80 }, source: 'user', confidence: 0.9, evidence: [], pinned: false, updated_at: at - 1000, valid_until: at + fixtureLifetime },
      ...(stageEscalation && !alternateExpert ? { specialist: { evaluation: { kind: 'task_fit', tag: 'specialist', score: 95 }, source: 'user', confidence: 0.9, evidence: [], pinned: false, updated_at: at - 1000, valid_until: at + fixtureLifetime } } : {}),
    } })

    if (alternateExpert) await hub.client.call(`${root}/capability-profiles`, { id: 'expert-capability', expected_revision: 0, host: hub.node, profile: 'profile', model: 'expert-model', assessments: {
      specialist: { evaluation: { kind: 'task_fit', tag: 'specialist', score: 95 }, source: 'user', confidence: 0.9, evidence: [], pinned: false, updated_at: at - 1000, valid_until: at + fixtureLifetime },
    } })
    await hub.client.call(`${root}/assignment-capacities`, { account_id: 'account', expected_revision: 0, max_active_assignments: parallelTaskWorkspace || exclusiveResources&&sharedMode?2:1 })
    await hub.client.call(path, command)
    let verificationDefinitionB, sharedWorkspaceRoot
    if(sharedMode){
      // Both teams register the same Git workspace. Per-run worktrees provide write isolation.
      const workspaceB=workspace
      sharedWorkspaceRoot=workspaceB.root_ref
      assert.equal(workspaceB.root_ref,workspace.root_ref)
      verificationDefinitionB={...verificationDefinition,command_id:'snapshot-check-b',args:verificationDefinition.args.map(arg=>arg.replace('team-a source','team-b source'))}
      const registry=new VerificationRunners(join(hub.root,'shared-verification-definition'))
      const referenceB=registry.register(verificationDefinitionB);await registry.close()
      const projectB=await hub.client.call(`${root}/project-configs`,{id:'project-b',version:'1',spec:{...project.config.spec,environments:{local:{host_id:hub.node,adapter_id:"local_process_v1",configuration_hash:referenceB.environment_hash}},repositories:{code:{repository_id:'repository',workspace:workspaceB}},commands:{check:{id:referenceB.id,revision:referenceB.revision,definition_hash:referenceB.definition_hash,...(referenceB.exclusive_resources?{exclusive_resources:referenceB.exclusive_resources}:{}),repository_binding:'code',environment_binding:'local',runner_id:referenceB.runner_id,scenario_ids:referenceB.scenario_ids}}}})
      const deliveryB=await hub.client.call(`${root}/project-configs`,{id:'delivery-b',version:'1',spec:{...delivery.config.spec,project:versionRef(projectB)}})
      await hub.client.call(`${root}/budgets`,{id:'budget-b',scope:'team',scope_id:'team-b',unit:'credits',limit:100,starts_at:Date.now()-1000,ends_at:Date.now()+fixtureLifetime,expected_revision:0})
      const budgetB=await hub.client.call(`${root}/team-policies`,{...budgetCommand,id:'budget-policy-b',team_id:'team-b',policy:{...budgetCommand.policy,budget_ids:['budget-b','shared-budget']}})
      const scheduleB=await hub.client.call(`${root}/team-policies`,{...scheduleCommand,id:'schedule-policy-b',team_id:'team-b'})
      const specB={...spec,name:'Second team',workspace_refs:[workspaceB],delivery_bindings:[{id:'local',workflow:versionRef(workflow),project:versionRef(projectB),delivery_policy:versionRef(deliveryB)}],grant_id:'grant-b',budget_policy_id:'budget-policy-b',scheduling_policy_id:'schedule-policy-b'}
      await hub.client.call(`${root}/teams`,{id:'team-b',request_id:'new',expected_revision:0,spec:specB})
      const grantB=(await hub.client.call(`${root}/team-grants`,{expected_revision:0,policy:{...grantCommand.policy,id:'grant-b',team_id:'team-b',targets:[{host:hub.node,workspace:workspaceB.workspace_id,root:workspaceB.root_ref}],budget_ids:['budget-b','shared-budget']}})).grant
      await hub.client.call(`${root}/teams/team-b/activation`,{...command,grant_revision:grantB.revision,budget_policy:policyRef(budgetB),scheduling_policy:policyRef(scheduleB)})
      await hub.client.call(runs,{...request,id:'second',request_id:'second',team_id:'team-b',inputs:{request:'Change source.txt to team-b source.'}})
    }
    await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(Projections)
    await ctx.plugin(await import('@deepseek-ai/dsh-session-persistence-jsonl'), { root: join(hub.root, 'sessions'), compression: 'zstd' })
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false }); await ctx.plugin(Tools); await ctx.plugin(LlmRuntime)
    ctx.provide('workspaceRegistry', { list: () => [{ id: 'workspace', path: workspaceRoot }] })
    ctx.provide('kodeOfficialToolPolicies', new OfficialToolPolicies())
    let inferenceCalls = 0, implementationRound = 0, busyStarted = false, busyAborted = false
    const sessionTeams=new Map(),sessionAttempts=new Map()
    const desiredSource = sessionId => sharedMode ? sharedExpert&&sessionAttempts.get(sessionId)===1?'candidate source':sessionTeams.get(sessionId)==='team'?'team-a source':'team-b source' : mode === 'success' || mode === 'cancel-tool' || interventionMode || (mode === 'verification-rework' && implementationRound > 1) ? 'repaired source' : 'candidate source'
    const observedModels = new Map()
    const modelSteps = new Map(), modelProgress = new Map(), errors = [], states = []
    let parallelTaskWorkspaceProof, parallelTaskWorkspaceBarrier
    const waitForParallelTaskWorkspaces = () => parallelTaskWorkspaceBarrier ??= (async () => {
      const until = Date.now() + 30000
      while (true) {
        const held = []
        for (const runId of ['before', 'second']) {
          const run = await hub.client.call(`${runs}/${runId}`)
          const stage = run.stages.find(row => row.stage_id === 'inspect')
          if (!stage?.assignment_id) break
          const assignment = await hub.client.call(`${root}/work-assignments/${stage.assignment_id}`)
          if (assignment.resources?.state !== 'held' || !assignment.execution_workspace?.receipt) break
          held.push(assignment)
        }
        if (held.length === 2) {
          const [first, second] = held.map(row => row.execution_workspace.receipt)
          assert.ok(held.every(row => row.resources.state === 'held'))
          assert.equal(first.repository, workspaceRoot); assert.equal(second.repository, workspaceRoot)
          assert.equal(first.base_commit, workspaceBaseCommit); assert.equal(second.base_commit, workspaceBaseCommit)
          assert.notEqual(first.root, second.root); assert.notEqual(first.branch, second.branch)
          parallelTaskWorkspaceProof = held.map(row => ({ team_id: row.team_id, run_id: row.run_id,
            operation_id: row.operation_id, state: row.resources.state, root: row.execution_workspace.receipt.root,
            branch: row.execution_workspace.receipt.branch, base_commit: row.execution_workspace.receipt.base_commit }))
          return
        }
        assert.ok(Date.now() < until, 'both Home-held task workspaces must exist before either implementation writes')
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    })()
    ctx.on('agent/error', event => errors.push(event.error.message))
    class Fixture extends LlmAdapter { async *stream(options) {
      inferenceCalls++
      if (stageEscalation) {
        const assignment = await hub.client.call(`${root}/work-assignments/${profiles.binding(options.sessionId).managedAssignment.id}`)
        assert.equal(options.model, assignment.candidate.selection_policy.model, 'actual adapter model must match admitted assignment')
        observedModels.set(options.sessionId, options.model)
      }
      if(sharedMode&&!sessionTeams.has(options.sessionId)){const binding=profiles.binding(options.sessionId);const assignment=await hub.client.call(`${root}/work-assignments/${binding.managedAssignment.id}`);assert.ok(['team','team-b'].includes(assignment.team_id));sessionTeams.set(options.sessionId,assignment.team_id);sessionAttempts.set(options.sessionId,assignment.stage_attempt)}
      if (mode === 'cancel-busy') {
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
        busyStarted = true
        if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
        busyAborted = true
        throw options.signal.reason ?? new Error('Fixture model cancelled')
      }
      assert.ok(options.tools.every(tool => tool.name.startsWith('kode_')), 'no fixture/global helper tools are installed')
      assert.ok(JSON.stringify(options.messages.filter(message=>message.role==='system')).includes(ASSIGNMENT_PROMPT_VERSION))
      assert.ok(!JSON.stringify(await ctx.systemPrompt.assemble({})).includes(ASSIGNMENT_PROMPT_VERSION), 'active Worker procedure must remain outside the global prompt')
      {
        const names = options.tools.map(tool => tool.name)
        const role = names.includes('kode_capture_output') ? 'implementation' : names.includes('kode_review_output') ? 'review' : 'verification'
        const step = modelSteps.get(options.sessionId) ?? 0
        modelSteps.set(options.sessionId, step + 1)
        if (sharedMode) modelProgress.set(options.sessionId, { team: sessionTeams.get(options.sessionId), role, step, at: Date.now() })
        if (parallelTaskWorkspace && role === 'implementation' && step === 0) await waitForParallelTaskWorkspaces()
        if (role === 'implementation' && step === 0) implementationRound++
        let previous
        if (step > 0) {
          const message = options.messages.find(m => m.role === 'tool' && m.source?.callId === `auto-${step - 1}`)
          assert.ok(message, `${role} consumes previous actual tool result`)
          previous = JSON.parse(message.content.filter(b => b.type === 'text').map(b => b.text).join(''))
        }
        let tool, args
        if (role === 'implementation') {
          if (step === 0) {
            tool = 'kode_read_source'; args = { path: 'source.txt' }
          } else if (step === 1) {
            assert.equal(previous.text, sharedMode ? sharedExpert&&sessionAttempts.get(options.sessionId)>1?'candidate source':'fixture source' : interventionMode && implementationRound > 1 ? 'owner source' : implementationRound === 1 ? 'fixture source' : 'candidate source')
            tool = 'kode_write_source'; args = { path: 'source.txt', expected_sha256: previous.sha256, content: desiredSource(options.sessionId) }
          } else if (step === 2) {
            assert.equal(previous.state, limitMode && implementationRound === 2 ? 'already_present' : 'written')
            tool = 'kode_capture_output'; args = { output: 'artifact', request_id: 'repaired-artifact' }
          } else if (step === 3) {
            assert.equal(previous.archive_status, 'home_archived')
            tool = 'kode_publish_output'; args = { output: 'artifact', evidence_id: previous.evidence_id }
          } else { assert.equal(step, 4); assert.equal(previous.completion_authorized, false) }
        } else if (role === 'review') {
          if (step === 0) { tool = 'kode_read_source'; args = { path: 'source.txt' } }
          else if (step === 1) {
            assert.equal(previous.text, desiredSource(options.sessionId))
            tool = 'kode_review_output'; args = { output: 'later', request_id: 'repaired-review', verdict: 'passed', findings: [] }
          } else if (step === 2) {
            tool = 'kode_publish_output'; args = { output: 'later', evidence_id: previous.evidence_id }
          } else { assert.equal(step, 3); assert.equal(previous.completion_authorized, false) }
        } else {
          if (waiverMiddle && step === 0) {
            const assigned = await hub.client.call(`${root}/work-assignments/${profiles.binding(options.sessionId).managedAssignment.id}`)
            if (implementationRound === 1) {
              assert.equal(assigned.inputs.binding.sources.followup, undefined)
              assert.equal(assigned.inputs.binding.waivers.followup.decision.actor.kind, 'human')
            } else {
              assert.equal(assigned.inputs.binding.waivers?.followup, undefined, 'old waiver cannot become input for a repaired artifact')
              assert.ok(assigned.inputs.binding.sources.followup.outputs.later.sequence > 0)
            }
            assert.ok(assigned.inputs.binding.sources.inspect.outputs.artifact.sequence > 0)
          }
          if (step === 0) { tool = 'kode_verify_output'; args = { output: 'checked', request_id: 'repaired-verify' } }
          else if (step === 1) {
            assert.equal(previous.verdict, sharedMode ? sharedExpert&&sessionAttempts.get(options.sessionId)===1?'failed':'passed' : desiredSource(options.sessionId) === 'repaired source' ? 'passed' : 'failed'); assert.equal(previous.log_archive_status, 'home_archived')
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
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Declared stage outputs published.' } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
    ctx.llm.registerAdapter(['fixture'], new Fixture())
    const executionClient=exclusiveResources?{call:async(path,body,...rest)=>{
      if(path.endsWith('/admit')&&body?.exclusive_resources?.length&&!exclusiveAdmissions.has(path)){
        for(const names of [[],['foreign-device']])await assert.rejects(hub.client.call(path,{...body,exclusive_resources:names},...rest),/exclusive resource evidence mismatch/)
        for(const scope of [undefined,'host'])await assert.rejects(hub.client.call(path,{...body,exclusive_resource_scope:scope},...rest),/exclusive resource evidence mismatch/)
        exclusiveAdmissions.add(path)
      }
      return hub.client.call(path,body,...rest)
    }}:hub.client
    execution = new OfficialExecution(ctx, profiles, executionClient, { host: hub.node })
    host = new OfficialLoopHost(ctx, execution)
    ctx.provide('kodeAgents', { profiles, officialExecution: execution })
    const stateFile = join(hub.root, 'host-state.json')
    await writePrivateJson(stateFile, {})
    await applyHost(ctx, { url: hub.url, tokenFile: join(hub.root, 'admin.token'), stateFile, agentRuntime: false, runtimeBridge: false, pollMs: 10 })
    dispatcher = new AssignmentDispatchHost(host)
    const controller = new WorkRunController(dispatcher, { prepare: (assignment, options) => prepareWorkRunAssignment(execution, assignment, options) })
    const progression = []
    let waiverInspected = false, waiverCommand, waiverReceipt
    const expertBarrier=new Set(),exclusiveBarrier=new Set()
    const advance = controller.advance.bind(controller)
    controller.advance = async id => {
      try {
        if(exclusiveResources&&sharedMode){
          const before=await hub.client.call(`${runs}/${id}`),verify=before.stages.find(stage=>stage.stage_id==='verify')
          if(before.stages.find(stage=>stage.stage_id==='followup').state==='passed'&&verify.assignment_id===null){
            exclusiveBarrier.add(id)
            const until=Date.now()+30000
            while(exclusiveBarrier.size<2){assert.ok(Date.now()<until,'both workflows must reach concurrent resource demand');await new Promise(resolve=>setTimeout(resolve,25))}
          }
        }
        if(sharedExpert){
          const before=await hub.client.call(`${runs}/${id}`)
          if((before.reworks??[]).length===1&&before.stages[0].assignment_id===null){
            // Synchronize demand, not Hub outcomes: both real failed-verification
            // pipelines must request their expert reservation in the same window.
            expertBarrier.add(id)
            const until=Date.now()+30000
            while(expertBarrier.size<2){assert.ok(Date.now()<until,'both teams must reach real expert rework');await new Promise(resolve=>setTimeout(resolve,25))}
          }
        }
        if (waiverPreview && !waiverInspected) {
          const before = await hub.client.call(`${runs}/${id}`)
          if (before.stages.find(stage => stage.stage_id === (waiverMiddle ? 'inspect' : 'followup')).state === 'passed'
              && before.stages.find(stage => stage.stage_id === waiverTarget).assignment_id === null) {
            const previewPath = `${runs}/${id}/stages/${waiverTarget}/waiver-plan`
            const observer = await hub.client.call(`${root}/sessions`, { session_id: 'waiver-observer', title: 'Observer', runtime: 'external' })
            await assert.rejects(hub.client.forSession(observer.owner_token).call(previewPath), /403/)
            const preview = await hub.client.call(previewPath)
            assert.equal(preview.run_revision, before.revision)
            assert.equal(preview.scope.policy.allow_delivery, waiverDelivery)
            assert.equal(preview.scope.artifacts.artifact.sequence, before.stages[0].evidence.outputs.artifact)
            assert.equal(preview.scope_hash.length, 64)
            assert.equal(preview.completion_authorized, false)
            assert.deepEqual(await hub.client.call(`${runs}/${id}`), before, 'preview must not record a decision or alter execution')
            if (waiverDecision) {
              const decisionPath = `${runs}/${id}/stages/${waiverTarget}/waiver`
              waiverCommand = { request_id: 'owner-waiver', expected_revision: before.revision, scope_hash: preview.scope_hash, reason: 'Owner defers this exact verification; no claim of passing' }
              let receiptPath = `${runs}/${id}/stages/${waiverTarget}/waiver-requests/owner-waiver`
              assert.deepEqual(await hub.client.call(receiptPath), { receipt: null })
              await assert.rejects(hub.client.forSession(observer.owner_token).call(receiptPath), /403/)
              await assert.rejects(hub.client.forSession(observer.owner_token).call(decisionPath, waiverCommand), /403/)
              await assert.rejects(hub.client.call(decisionPath, { ...waiverCommand, scope_hash: '0'.repeat(64) }), /scope changed/)
              await assert.rejects(hub.client.call(decisionPath, { ...waiverCommand, expected_revision: before.revision - 1 }), /revision conflict/)
              await assert.rejects(hub.client.call(decisionPath, { ...waiverCommand, reason: ' ' }), /invalid/)
              assert.deepEqual(await hub.client.call(`${runs}/${id}`), before)
              let first
              if (process.env.KODE_TEST_WAIVER_BROWSER === '1') {
                const browserDecision = await waiveStageInBrowser(hub, before, waiverTarget)
                first = browserDecision.receipt; waiverCommand = browserDecision.command
                receiptPath = `${runs}/${id}/stages/${waiverTarget}/waiver-requests/${waiverCommand.request_id}`
              } else {
                const [receipt, duplicate] = await Promise.all([hub.client.call(decisionPath, waiverCommand), hub.client.call(decisionPath, waiverCommand)])
                assert.deepEqual(receipt, duplicate); first = receipt
              }
              waiverReceipt = first
              assert.deepEqual((await hub.client.call(receiptPath)).receipt.result, first)
              assert.deepEqual((await hub.client.call(receiptPath)).receipt.request, { action: 'waive_stage', stage_id: waiverTarget, input: waiverCommand })
              await assert.rejects(hub.client.call(decisionPath, { ...waiverCommand, reason: 'Changed reason' }), /identity conflict/)
            }
            waiverInspected = true
          }
        }
        const result = await advance(id)
        if(exclusiveResources&&result.state==='waiting_resource')exclusiveWaits.push({run_id:id,reason:result.reason})
        if (result.state === 'recovery_required') progression.push({ run_id: id, state: result.state, assignment_id: result.assignment_id })
        return result
      } catch (error) {
        if(exclusiveResources&&error.status===409&&error.code==='assignment_exclusive_resource_busy'&&/^\/api\/v1\/messaging\/work-assignments\/[A-Za-z0-9][A-Za-z0-9_.-]{0,159}\/resources$/.test(error.path??''))exclusiveWaits.push({run_id:id,reason:error.code})
        progression.push({ run_id: id, name: error.name, code: error.code ?? null, status: error.status ?? null,
          ...(process.env.KODE_TEST_WAIVER_BROWSER === '1' ? { browser_error: String(error.message).split('\n')[0].slice(0, 300) } : {}),
          path: typeof error.path === 'string' && error.path.startsWith('/api/v1/messaging/') ? error.path : null,
          stack_sites: String(error.stack ?? '').split('\n').slice(1, 5) })
        throw error
      }
    }
    service = await new WorkRunService(controller, { intervalMs: 100, onState: state => states.push(state) }).open()
    if (mode === 'cancel-tool' || interventionMode || sharedMode || escalationBudgetBlocked || waiverMiddle) execution.verificationRunners.register(verificationDefinition)
    if(sharedMode)execution.verificationRunners.register(verificationDefinitionB)
    service.start()
    if (waiverDecision) {
      const deadline = Date.now() + 45000
      while (!waiverInspected) {
        assert.ok(!states.some(state => state.state === 'progression_failed'), 'waiver progression failed: ' + JSON.stringify(progression.slice(-3)))
        assert.ok(Date.now() < deadline, 'waiver decision deadline: ' + JSON.stringify({ states: states.slice(-5), progression: progression.slice(-3) }))
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      let waiverAcceptanceConfirmed = false
      if (waiverDelivery) {
        while ((await hub.client.call(`${runs}/before`)).state !== 'completed') {
          const pending = await hub.client.call(`${runs}/before`)
          if (humanAcceptance && pending.waiting_reason === 'human_delivery_acceptance_required') {
            assert.equal(waiverAcceptanceConfirmed, false)
            assert.equal(pending.completion_authorized, false)
            assert.equal(pending.human_acceptance.evidence.waivers[waiverTarget].scope_hash, waiverCommand.scope_hash)
            assert.equal(pending.stages.find(stage => stage.stage_id === waiverTarget).state, 'waived')
            await acceptDeliveryInBrowser(hub, pending)
            waiverAcceptanceConfirmed = true
          }
          assert.ok(Date.now() < deadline, 'waiver delivery deadline: ' + JSON.stringify({ states: states.slice(-5), progression: progression.slice(-3) }))
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      }
      await service.close(); service = undefined
      const waived = await hub.client.call(`${runs}/before`)
      if (!waiverDelivery) assert.deepEqual(waived, waiverReceipt)
      assert.equal(waived.state, waiverDelivery ? 'completed' : 'waiting_user')
      assert.equal(waived.waiting_reason, waiverDelivery ? null : 'waiver_delivery_disallowed')
      assert.equal(waived.completion_authorized, waiverDelivery)
      if (humanAcceptance) { assert.equal(waiverAcceptanceConfirmed, true); assert.equal(waived.delivery.human_acceptance.state, 'accepted') }
      if (waiverRework) {
        assert.equal(waived.reworks.length, 1)
        assert.equal(waived.delivery.basis, 'frozen_policy_and_archived_evidence')
        assert.equal(waived.delivery.waivers, undefined)
        assert.ok(waived.delivery.outputs.later > 0)
        assert.ok(waived.delivery.outputs.checked > 0)
        assert.equal(waived.stages.find(stage => stage.stage_id === waiverTarget).state, 'passed')
        assert.equal(waived.stages.find(stage => stage.stage_id === waiverTarget).waiver, undefined)
        const failed = waived.reworks[0].outputs.checked
        const record = await hub.client.call(`${root}/verification-records/${failed.sequence}`)
        assert.equal(JSON.parse(record.result_json).observed.exit_code, 3)
        assert.notEqual(waived.delivery.outputs.checked, failed.sequence)
      } else if (waiverDelivery) {
        assert.equal(waived.delivery.basis, 'frozen_policy_archived_evidence_and_owner_waivers')
        assert.deepEqual(waived.delivery.waived_outputs, waiverMiddle ? { later: 'followup' } : { checked: 'verify' })
        assert.equal(waived.delivery.outputs[waiverMiddle ? 'later' : 'checked'], undefined, 'waiver cannot manufacture evidence')
        if (waiverMiddle) assert.ok(waived.delivery.outputs.checked > 0, 'downstream verifier produces actual evidence')
        assert.equal(waived.delivery.waivers[waiverTarget].scope_hash, waiverCommand.scope_hash)
        assert.ok(Object.keys(waived.delivery.artifacts).length > 0)
      }
      const waivedStage = (waiverRework ? waived.reworks[0].superseded : waived.stages).find(stage => stage.stage_id === waiverTarget)
      assert.equal(waivedStage.state, 'waived')
      assert.equal(waivedStage.assignment_id, null)
      assert.equal(waivedStage.evidence, undefined)
      assert.deepEqual(waivedStage.waiver.actor, { kind: 'human', id: 'local_owner' })
      assert.equal(inferenceCalls, waiverRework ? 20 : waiverMiddle ? 8 : 9)
      const budget = (await hub.client.call(`${root}/budgets/budget`)).budget
      assert.equal(budget.spent, waiverRework ? 40 : waiverMiddle ? 16 : 18); assert.equal(budget.reserved, 0)
      if (!waiverDelivery) await assert.rejects(hub.client.call(`${runs}/before/delivery`, { request_id: 'bypass-waiver-policy', expected_revision: waived.revision }), /unavailable/)
      await hub.stop('SIGKILL'); await hub.start()
      assert.deepEqual(await hub.client.call(`${runs}/before/stages/${waiverTarget}/waiver`, waiverCommand), waiverReceipt)
      assert.deepEqual((await hub.client.call(`${runs}/before/stages/${waiverTarget}/waiver-requests/${waiverCommand.request_id}`)).receipt.result, waiverReceipt)
      const events = (await hub.client.call(`${runs}/before/events`)).events
      assert.equal(events.filter(row => row.data.kind === 'stage_waived').length, 1)
      assert.equal(events.filter(row => row.data.kind === 'work_run_delivered').length, waiverDelivery ? 1 : 0)
      assert.deepEqual(await hub.client.call(`${runs}/before`), waived, 'historical waiver replay cannot undo finalization')
      assert.deepEqual(errors, [])
      return
    }
    if (escalationBudgetBlocked) {
      const until = Date.now() + 45000
      let pending
      while (true) {
        pending = await hub.client.call(`${runs}/before`)
        const budget = await hub.client.call(`${root}/budgets/budget`)
        if (pending.reworks?.length === 1 && budget.budget.spent === 24 && states.at(-1)?.state === 'waiting_resource') break
        assert.ok(Date.now() < until, 'expected budget wait: ' + JSON.stringify({ state: pending.state, states: states.slice(-8), progression: progression.slice(-3) }))
        await new Promise(resolve => setTimeout(resolve, 30))
      }
      assert.equal(pending.waiting_reason, 'team_budget_exhausted')
      const waitEvents = (await hub.client.call(`${runs}/before/events`)).events
      assert.equal(waitEvents.filter(row => row.data.kind === 'work_run_budget_wait').length, 1)
      await new Promise(resolve => setTimeout(resolve, 350))
      assert.equal((await hub.client.call(`${runs}/before`)).revision, pending.revision,
        'unchanged budget waits must not churn revisions or postpone coordinator notification')
      assert.equal(inferenceCalls, 12); assert.equal(observedModels.size, 3)
      assert.ok([...observedModels.values()].every(model => model === 'model'))
      assert.ok(pending.stages.every(stage => stage.assignment_id === null))
      assert.equal(pending.completion_authorized, false)
      const ledger = await hub.client.call(`${root}/budgets/budget`)
      assert.equal(ledger.budget.spent, 24); assert.equal(ledger.budget.reserved, 0)
      const plan = await hub.client.call(`${runs}/before/stages/inspect/plan`)
      assert.equal(plan.candidates.find(row => row.target_id === 'target').recommendation.recommended, false)
      await assert.rejects(hub.client.call(`${runs}/before/stages/inspect/assignments`, { request_id: 'unsafe-fallback', expected_revision: pending.revision, target_id: 'target', worker_id: null }), /not recommended/)
      await assert.rejects(hub.client.call(`${runs}/before/stages/inspect/assignments`, { request_id: 'unfunded-expert', expected_revision: pending.revision, target_id: 'aaa-alternate', worker_id: null }), /budget|fund|insufficient/)
      assert.equal((await hub.client.call(`${runs}/before`)).revision, pending.revision)
      assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved, 0)
      assert.deepEqual(errors, [])
      // An owner can raise the team allowance; the existing service must resume by itself.
      const team = await hub.client.call(`${root}/teams/team`)
      const allowance = ledger.budget
      const topup = { request_id: 'fund-expert-rework', team_revision: team.revision,
        budget: { id: allowance.id, scope: allowance.scope, scope_id: allowance.scope_id,
          unit: allowance.unit, limit: 100, starts_at: allowance.starts_at,
          ends_at: allowance.ends_at, expected_revision: allowance.revision } }
      const funded = await hub.client.call(`${root}/teams/team/budgets`, topup)
      assert.equal(funded.label, '团队预算')
      assert.deepEqual(await hub.client.call(`${root}/teams/team/budgets`, topup), funded,
        'replaying owner funding must not apply the allowance twice')
    }
    if(sharedExpert){
      const until=Date.now()+45000
      let pending,ledger
      while(true){
        pending=await Promise.all(['before','second'].map(id=>hub.client.call(`${runs}/${id}`)))
        ledger=(await hub.client.call(`${root}/budgets/shared-budget`)).budget
        assert.ok(ledger.spent+ledger.reserved<=ledger.limit,'shared allowance cannot be over-reserved')
        if(pending.every(run=>(run.reworks??[]).length===1&&run.stages.every(stage=>stage.assignment_id===null)
          &&run.state==='waiting_resource'&&run.waiting_reason==='team_budget_exhausted')&&ledger.spent===48&&ledger.reserved===0)break
        assert.ok(Date.now()<until,'both expert demands must wait for the actual shared budget: '+JSON.stringify({runs:pending.map(run=>({id:run.id,state:run.state,reworks:(run.reworks??[]).length})),states:states.slice(-8),errors}))
        await new Promise(resolve=>setTimeout(resolve,50))
      }
      assert.equal(inferenceCalls,24);assert.equal(ledger.limit,62)
      for(const run of pending){
        const plan=await hub.client.call(`${runs}/${run.id}/stages/inspect/plan`)
        assert.equal(plan.candidates.find(row=>row.target_id==='target').recommendation.recommended,false)
        const expert=plan.candidates.find(row=>row.target_id==='aaa-alternate')
        assert.equal(expert.recommendation.recommended,true);assert.equal(expert.selection_policy.model,'expert-model')
        await assert.rejects(hub.client.call(`${runs}/${run.id}/stages/inspect/assignments`,{request_id:'unfunded-'+run.id,expected_revision:run.revision,target_id:'aaa-alternate',worker_id:null}),/budget|fund|insufficient/)
      }
      await new Promise(resolve=>setTimeout(resolve,350))
      assert.equal(inferenceCalls,24,'unfunded expert retries must not call either model')
      assert.equal((await hub.client.call(`${root}/budgets/shared-budget`)).budget.reserved,0)
      await hub.client.call(`${root}/budgets`,{id:ledger.id,scope:ledger.scope,scope_id:ledger.scope_id,unit:ledger.unit,limit:130,starts_at:ledger.starts_at,ends_at:ledger.ends_at,expected_revision:ledger.revision})
    }
    if(sharedMode){
      const until=Date.now()+45000;let completed
      while(true){
        completed=await Promise.all(['before','second'].map(id=>hub.client.call(`${runs}/${id}`)))
        if(completed.every(r=>r.state==='completed'))break
        if (Date.now() >= until) {
          // Retain bounded evidence before finally removes this isolated Hub.
          const assignments = []
          for (const run of completed) for (const stage of run.stages) if (stage.assignment_id) {
            const assignment = await hub.client.call(`${root}/work-assignments/${stage.assignment_id}`)
            assignments.push({ id: assignment.id, run_id: run.id, stage: stage.stage_id, state: assignment.state,
              resource_state: assignment.resources?.state, worker: assignment.worker, operation_id: assignment.operation_id })
          }
          assert.fail('shared delivery deadline: ' + JSON.stringify({
            runs: completed.map(run => ({ id: run.id, revision: run.revision, state: run.state,
              stages: run.stages.map(({ stage_id, state, attempt, assignment_id }) => ({ stage_id, state, attempt, assignment_id })) })),
            assignments, capacity: await hub.client.call(`${root}/assignment-capacities/account`),
            model_progress: [...modelProgress].map(([session_id, row]) => ({ session_id, ...row, idle_ms: Date.now() - row.at })),
            states: states.slice(-12), errors, inferenceCalls,
          }))
        }
        assert.ok(!states.some(s=>s.blocked),'shared workflow must not require manual retry: '+JSON.stringify({states:states.slice(-12),progression:progression.slice(-4)}))
        assert.ok((await hub.client.call(`${root}/assignment-capacities/account`)).held<=(parallelTaskWorkspace||exclusiveResources?2:1))
        const allowance=(await hub.client.call(`${root}/budgets/shared-budget`)).budget
        assert.ok(allowance.spent+allowance.reserved<=allowance.limit)
        await new Promise(r=>setTimeout(r,50))
      }
      await service.close()
      assert.deepEqual(errors,[]);assert.equal(inferenceCalls,sharedExpert?48:24)
      if(parallelTaskWorkspace)assert.equal(parallelTaskWorkspaceProof?.length,2,'both Home-held worktrees must be observed before either write')
      if(!parallelTaskWorkspace)assert.ok(states.some(s=>s.state==='waiting_resource'),'both real workflows must observe actual resource contention')
      if(exclusiveResources)assert.equal(exclusiveAdmissions.size,2)
      const assignments=[]
      for(const run of completed){
        assert.equal(run.completion_authorized,true);assert.ok(run.stages.every(s=>s.state==='passed'&&s.attempt===(sharedExpert?2:1)))
        for(const stage of run.stages){const a=await hub.client.call(`${root}/work-assignments/${stage.assignment_id}`);assert.equal(a.team_id,run.team_id);assert.equal(a.run_id,run.id);assert.equal(a.resources.state,'released');assert.equal(a.accounting.receipt.reservation.finalized,true);assignments.push(a)}
        if(sharedExpert){
          assert.equal(run.reworks.length,1)
          assert.equal(run.reworks[0].outputs.checked.payload.verdict,'failed')
          const previous=await Promise.all(run.reworks[0].superseded.map(stage=>hub.client.call(`${root}/work-assignments/${stage.assignment_id}`)))
          assert.ok(previous.every(a=>a.resources.state==='released'&&a.accounting.receipt.reservation.finalized))
          const initial=previous.find(a=>a.stage_id==='inspect'),current=assignments.find(a=>a.run_id===run.id&&a.stage_id==='inspect')
          assert.equal(initial.candidate.selection_policy.model,'model');assert.equal(current.candidate.selection_policy.model,'expert-model')
          assert.equal(observedModels.get(current.worker.session_id),'expert-model');assert.equal(current.pricing.price_id,'expert-price')
          assert.deepEqual(current.candidate.grant_scope,initial.candidate.grant_scope)
          assignments.push(...previous)
        }
      }
      if(exclusiveResources){
        assert.ok(exclusiveWaits.some(row=>row.reason==='assignment_exclusive_resource_busy'),JSON.stringify({waits:exclusiveWaits,verify:assignments.filter(a=>a.stage_id==='verify').map(a=>({id:a.id,resources:a.resources}))}))
        for(const assignment of assignments.filter(a=>a.stage_id==='verify')){
          assert.deepEqual(assignment.resources.exclusive_resources,['fixture-device'])
          assert.deepEqual(assignment.admission.request.exclusive_resources,['fixture-device'])
        }
        const available=await execution.exclusiveResources.acquire(['fixture-device'],'post-delivery');await available.release()
        await writeFile('/tmp/superagent-shared-exclusive-resource.json',JSON.stringify({inferenceCalls,waits:exclusiveWaits,admissions:[...exclusiveAdmissions],assignments:assignments.map(a=>({id:a.id,team_id:a.team_id,stage:a.stage_id,state:a.state,resources:a.resources})),runs:completed.map(r=>({id:r.id,state:r.state,delivery:r.delivery}))}))
      }
      assert.equal(new Set(assignments.map(a=>a.worker.session_id)).size,sharedExpert?12:6)
      const reservations=assignments.map(a=>a.accounting.receipt.reservation)
      assert.equal(new Set(reservations.map(row=>row.request.id)).size,assignments.length,'each assignment has exactly one distinct settled reservation')
      assert.equal(reservations.reduce((total,row)=>total+row.charged,0),sharedExpert?116:48)
      assert.ok(reservations.every(row=>row.finalized&&row.held===0&&row.request.budget_ids.includes('shared-budget')))
      const writeAssignments=assignments.filter(a=>a.stage_id==='inspect'&&a.candidate.grant_scope.capabilities.includes('workspace_write'))
      assert.equal(writeAssignments.length,sharedExpert?4:2)
      const taskReceipts=[]
      for(const assignment of writeAssignments){
        const latestForRun=writeAssignments.filter(row=>row.run_id===assignment.run_id).reduce((latest,row)=>Math.max(latest,row.stage_attempt),0)===assignment.stage_attempt
        const expected=desiredSource(assignment.worker.session_id)
        const receipt=await assertTaskSource(assignment,expected,{checkContent:latestForRun})
        if(assignment.stage_attempt>1)assert.equal(receipt.starting_snapshot.basis,'rework_artifact')
        taskReceipts.push({assignment,receipt})
      }
      const rootsA=new Set(taskReceipts.filter(row=>row.assignment.team_id==='team').map(row=>row.receipt.root))
      const rootsB=new Set(taskReceipts.filter(row=>row.assignment.team_id==='team-b').map(row=>row.receipt.root))
      const branchesA=new Set(taskReceipts.filter(row=>row.assignment.team_id==='team').map(row=>row.receipt.branch))
      const branchesB=new Set(taskReceipts.filter(row=>row.assignment.team_id==='team-b').map(row=>row.receipt.branch))
      assert.equal(rootsA.size,1)
      assert.equal(rootsB.size,1)
      assert.equal(branchesA.size,1)
      assert.equal(branchesB.size,1)
      assert.ok([...rootsA].every(root=>!rootsB.has(root)),'two Teams using the same registered Git root must get separate task worktrees')
      assert.ok([...branchesA].every(branch=>!branchesB.has(branch)),'two Teams using the same registered Git root must get separate task branches')
      assert.equal(new Set(taskReceipts.map(row=>row.receipt.repository)).size,1)
      assert.ok(taskReceipts.every(row=>row.receipt.repository===workspaceRoot&&row.receipt.base_commit===workspaceBaseCommit))
      assert.equal(new Set(taskReceipts.map(row=>row.receipt.common_dir)).size,1)
      for(const {assignment,receipt} of taskReceipts){
        const run=completed.find(row=>row.id===assignment.run_id)
        const identity=Object.fromEntries(['key','repository','common_dir','root','branch','base_commit','home','run_id','host','repository_binding'].map(key=>[key,receipt[key]]))
        assert.deepEqual(run.task_workspaces.code,identity)
        assert.deepEqual(run.delivery.task_workspaces.code,identity)
        assert.equal(run.delivery.integration_state,'unintegrated')
        assert.equal(run.delivery.original_workspace_modified,false)
        assert.equal(receipt.scope.target.root,receipt.root)
      }
      for(const [id,spent] of [['budget',sharedExpert?58:24],['budget-b',sharedExpert?58:24],['shared-budget',sharedExpert?116:48]]){const b=(await hub.client.call(`${root}/budgets/${id}`)).budget;assert.equal(b.spent,spent);assert.equal(b.reserved,0)}
      assert.equal((await hub.client.call(`${root}/assignment-capacities/account`)).held,0)
      assert.equal(await readFile(join(workspaceRoot,'source.txt'),'utf8'),originalDirtyTree.source)
      assert.equal(await readFile(join(workspaceRoot,'owner-untracked.txt'),'utf8'),originalDirtyTree.untracked)
      assert.equal((await gitAt(workspaceRoot,['status','--porcelain=v1','--untracked-files=all'])).stdout,originalDirtyTree.status)
      assert.equal((await gitAt(workspaceRoot,['rev-parse','HEAD'])).stdout.trim(),originalDirtyTree.base_commit)
      t.diagnostic(JSON.stringify({ task_worktree_evidence: {
        registered_workspace_roots: [workspace.root_ref, sharedWorkspaceRoot],
        team_task_roots: [...new Set(taskReceipts.map(row => row.receipt.root))],
        team_task_branches: [...new Set(taskReceipts.map(row => row.receipt.branch))],
        fixed_base_commit: workspaceBaseCommit,
        owner_dirty_tree_preserved: true,
        parallel_holds_before_write: parallelTaskWorkspaceProof ?? null,
        delivery: completed.map(run => ({ run_id: run.id, integration_state: run.delivery.integration_state,
          original_workspace_modified: run.delivery.original_workspace_modified })),
      } }))
      await hub.stop('SIGKILL');await hub.start()
      for(const run of completed)assert.deepEqual((await hub.client.call(`${runs}/${run.id}`)).delivery,run.delivery)
      if(sharedExpert)await writeFile('/tmp/superagent-shared-expert-pressure.json',JSON.stringify({runs:completed,assignments:assignments.map(a=>({id:a.id,team_id:a.team_id,run_id:a.run_id,stage_id:a.stage_id,stage_attempt:a.stage_attempt,worker:a.worker,reservation:a.accounting.receipt.reservation,selection_policy:a.candidate.selection_policy,pricing_id:a.pricing.price_id,resource_state:a.resources.state})),states,inferenceCalls,models:[...observedModels],shared_budget:(await hub.client.call(`${root}/budgets/shared-budget`)).budget}))
      return
    }
    if (interventionMode) {
      const wait = async (check, label) => {
        const until = Date.now() + 30000
        while (!await check()) { assert.ok(Date.now() < until, label + JSON.stringify({ states: states.slice(-6), errors })); await new Promise(resolve => setTimeout(resolve, 25)) }
      }
      await wait(async () => {
        try { return JSON.parse(await readFile(toolMarker, 'utf8')).state === 'running' }
        catch (error) { if (error.code === 'ENOENT') return false; throw error }
      }, 'verification process did not start')
      const live = await hub.client.call(`${runs}/before`)
      assert.deepEqual(live.stages.map(stage => stage.state), ['passed', 'passed', 'ready'])
      const oldAssignments = await Promise.all(live.stages.map(stage => hub.client.call(`${root}/work-assignments/${stage.assignment_id}`)))
      const current = oldAssignments[2], assignmentPath = `${root}/work-assignments/${current.id}`
      const diagnostic = await hub.client.call(`${runs}/before/diagnostics?run_revision=${live.revision}`)
      assert.equal(diagnostic.items.length, 3); assert.equal(diagnostic.read_only, true)
      assert.deepEqual(await hub.client.call(`${runs}/before`), live)
      let lostTakeover = false, lostStop = false
      const call = hub.client.call.bind(hub.client)
      hub.client.call = async (...args) => {
        const result = await call(...args)
        if (args[0] === `${runs}/before` && args[1]?.action === 'takeover' && !lostTakeover) { lostTakeover = true; throw Error('lost takeover reply') }
        if (args[0] === `${assignmentPath}/stop-receipt` && !lostStop) { lostStop = true; throw Error('lost intervention stop reply') }
        return result
      }
      const command = { action: 'takeover', request_id: 'owner-takeover', expected_revision: live.revision, reason: 'Inspect the active verification and change the workspace' }
      await assert.rejects(hub.client.call(`${runs}/before`, command), /lost takeover reply/)
      const intent = await hub.client.call(`${runs}/before`, command)
      assert.equal(intent.state, 'taking_over'); assert.equal(intent.intervention.stop_confirmed, false)
      await wait(async () => (await hub.client.call(`${runs}/before`)).state === 'paused', 'takeover did not confirm pause')
      const paused = await hub.client.call(`${runs}/before`)
      assert.equal(paused.completion_authorized, false); assert.equal(paused.intervention.stop_confirmed, true)
      assert.equal(paused.intervention.accounting, 'finalized'); assert.equal(lostStop, true)
      const drained = await hub.client.call(assignmentPath)
      assert.equal(drained.state, 'interrupted'); assert.equal(drained.resources.state, 'released')
      assert.equal(drained.stop.receipt.state, 'execution_drained'); assert.equal(drained.accounting.receipt.reservation.finalized, true)
      const processState = JSON.parse(await readFile(toolMarker, 'utf8'))
      assert.equal(processState.state, 'stopped')
      assert.throws(() => process.kill(processState.pid, 0), { code: 'ESRCH' })
      assert.equal(inferenceCalls, 10)
      await service.close(); service = undefined
      const budgetPaused = (await hub.client.call(`${root}/budgets/budget`)).budget
      assert.equal(budgetPaused.reserved, 0)
      const ownerTaskRoot = oldAssignments.find(assignment => assignment.stage_id === 'inspect').execution_workspace.receipt.root
      await writeFile(join(ownerTaskRoot, 'source.txt'), 'owner source')
      hub.client.call = call
      await hub.stop('SIGKILL'); await hub.start()
      assert.deepEqual(await hub.client.call(`${runs}/before`), paused)
      const resume = { action: 'resume', request_id: 'owner-resume', expected_revision: paused.revision, reason: 'Revalidate the manually edited source' }
      const resumed = await hub.client.call(`${runs}/before`, resume)
      assert.equal(resumed.state, 'waiting_resource'); assert.equal(resumed.id, live.id)
      assert.ok(resumed.stages.every(stage => stage.state === 'pending' && stage.assignment_id === null && stage.evidence === undefined))
      assert.deepEqual(await hub.client.call(`${runs}/before`, command), intent)
      const nextController = new WorkRunController(dispatcher, { prepare: (assignment, options) => prepareWorkRunAssignment(execution, assignment, options) })
      const nextAdvance = nextController.advance.bind(nextController)
      nextController.advance = async id => {
        try { return await nextAdvance(id) }
        catch (error) { progression.push({ phase: 'intervention_resume', message: String(error.message).slice(0, 400), path: error.path ?? null }); throw error }
      }
      service = await new WorkRunService(nextController, { intervalMs: 100, onState: state => states.push(state) }).open()
      service.start()
      await wait(async () => {
        assert.ok(!service.rows.before?.blocked || service.rows.before.revision < resumed.revision, JSON.stringify(progression.slice(-3)))
        return (await hub.client.call(`${runs}/before`)).state === 'completed'
      }, 'resumed work did not finish revalidation')
      await service.close(); service = undefined
      const completed = await hub.client.call(`${runs}/before`)
      assert.deepEqual(completed.stages.map(stage => [stage.state, stage.attempt]), [['passed', 2], ['passed', 2], ['passed', 2]])
      assert.equal(completed.completion_authorized, true)
      const fresh = await Promise.all(completed.stages.map(stage => hub.client.call(`${root}/work-assignments/${stage.assignment_id}`)))
      assert.equal(new Set([...oldAssignments, ...fresh].map(assignment => assignment.worker.session_id)).size, 6)
      assert.ok(fresh.every(assignment => assignment.state === 'completed' && assignment.resources.state === 'released'))
      assert.ok(fresh.every(assignment => !oldAssignments.some(old => old.id === assignment.id)))
      assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved, 0)
      assert.equal(inferenceCalls, 22)
      assert.equal(await readFile(join(workspaceRoot, 'source.txt'), 'utf8'), 'fixture source')
      const freshInspect= fresh.find(assignment => assignment.stage_id === 'inspect')
      await assertTaskSource(freshInspect, 'repaired source')
      assert.equal(freshInspect.execution_workspace.receipt.starting_snapshot.basis,'owner_resumed_task')
      const events = (await hub.client.call(`${runs}/before/events`)).events
      for (const kind of ['work_run_takeover_requested', 'work_run_paused', 'work_run_resumed', 'work_run_delivered']) assert.equal(events.filter(event => event.data.kind === kind).length, 1)
      assert.deepEqual(events.find(event => event.data.kind === 'work_run_resumed').data.superseded, paused.stages)
      assert.deepEqual(errors, [])
      return
    }
    if (['cancel-busy', 'cancel-tool'].includes(mode)) {
      const wait = async (check, label) => {
        const until = Date.now() + 15000
        while (!await check()) { assert.ok(Date.now() < until, label + JSON.stringify({ states, errors })); await new Promise(resolve => setTimeout(resolve, 25)) }
      }
      const toolMode = mode === 'cancel-tool', expectedCalls = toolMode ? 10 : 1
      let processMarker
      // The cancellation marker belongs to verification, after two real predecessor stages.
      // Give each phase its own bounded readiness check instead of timing all three as one launch.
      if (toolMode) for (const stage of ['inspect','followup']) await wait(async () => {
        assert.ok(!states.some(s=>s.state==='progression_failed'),'workflow failed before tool cancellation')
        const run=await hub.client.call(`${runs}/before`)
        return run.stages.find(s=>s.stage_id===stage)?.state==='passed'
      }, `${stage} did not complete before cancellation setup`)
      await wait(async () => {
        if (!toolMode) return busyStarted
        try { processMarker = JSON.parse(await readFile(toolMarker, 'utf8')); return processMarker.state === 'running' }
        catch (error) { if (error.code === 'ENOENT') return false; throw error }
      }, 'execution did not start')
      const live = await hub.client.call(`${runs}/before`)
      const assignmentPath = `${root}/work-assignments/${live.stages[toolMode ? 2 : 0].assignment_id}`
      const assignment = await hub.client.call(assignmentPath)
      const owned = host.handles.get(assignment.worker.session_id)
      assert.ok(owned); assert.notEqual(owned.agent.status, 'idle')
      if(exclusiveResources){
        assert.deepEqual(assignment.resources.exclusive_resources,['fixture-device'])
        assert.equal(exclusiveAdmissions.size,1)
        await assert.rejects(execution.exclusiveResources.acquire(['fixture-device'],'no-premature-successor'),{code:'EXCLUSIVE_RESOURCE_BUSY'})
      }
      let disposals = 0, lostRequest = false, lostStop = false
      const dispose = owned.dispose, call = hub.client.call.bind(hub.client)
      const crash = async phase => {
        if (process.env.KODE_TEST_CANCEL_CRASH !== phase) return
        if (!process.send) throw new Error('Cancellation crash fixture requires IPC')
        process.send({ type: 'cancel-crash-ready', phase, root: hub.root, url: hub.url, node: hub.node, hub_pid: hub.pid, assignment_id: assignment.id, worker_session: assignment.worker.session_id })
        await new Promise(() => {})
      }
      owned.dispose = async () => { disposals++; await crash('stopping'); return dispose() }
      hub.client.call = async (...args) => {
        if (args[0] === `${assignmentPath}/stop-receipt`) await crash('drained')
        const result = await call(...args)
        if (args[0] === `${runs}/before` && args[1]?.action === 'request_cancel' && !lostRequest) { lostRequest = true; throw new Error('lost cancel request reply') }
        if (args[0] === `${assignmentPath}/stop-receipt` && !lostStop) { lostStop = true; throw new Error('lost cancel stop reply') }
        return result
      }
      const cancel = { action: 'request_cancel', request_id: 'cancel-busy', expected_revision: live.revision, reason: 'Stop while model is running' }
      await assert.rejects(hub.client.call(`${runs}/before`, cancel), /lost cancel request reply/)
      const requested = await hub.client.call(`${runs}/before`, cancel)
      assert.equal(requested.state, 'cancelling'); assert.equal(requested.cancellation.stop_confirmed, false)
      if(exclusiveResources){const unresolved=await hub.client.call(assignmentPath);if(!unresolved.stop?.receipt)assert.equal(unresolved.resources.state,'held')}
      await wait(async () => (toolMode || busyAborted) && Boolean((await hub.client.call(assignmentPath)).stop?.receipt), 'busy execution did not drain')
      if (toolMode) await wait(async () => (await hub.client.call(`${runs}/before`)).state === 'cancelled', 'known-cost cancellation did not finalize')
      await service.close()
      const drained = await hub.client.call(assignmentPath)
      assert.equal(drained.stop.receipt.state, 'execution_drained')
      assert.equal(drained.stop.receipt.operation.state, 'stopped')
      assert.equal(host.handles.has(assignment.worker.session_id), false)
      assert.equal(profiles.binding(assignment.worker.session_id).assignmentStop.state, 'drained')
      assert.equal(lostStop, true)
      assert.deepEqual(await dispatcher.stop(assignment.id), drained.stop.receipt)
      assert.equal(disposals, 1); assert.equal(inferenceCalls, expectedCalls)
      if (!toolMode) await assert.rejects(hub.client.call(`${assignmentPath}/accounting`, { request_id: 'check-unresolved', expected_revision: drained.revision }), /official usage remains unresolved/)
      const pending = await hub.client.call(`${runs}/before`)
      if (!toolMode) await assert.rejects(hub.client.call(`${runs}/before`, { action: 'finalize_cancel', request_id: 'no-false-final', expected_revision: pending.revision }), /cancellation pending: exact finalized accounting/)
      const budgetBefore = (await hub.client.call(`${root}/budgets/budget`)).budget
      if (toolMode) {
        assert.equal(budgetBefore.reserved, 0); assert.equal(budgetBefore.spent, 20)
        assert.equal(drained.resources.state, 'released'); assert.equal(pending.state, 'cancelled')
        const stopped = JSON.parse(await readFile(toolMarker, 'utf8'))
        assert.equal(stopped.state, 'stopped'); assert.equal(stopped.pid, processMarker.pid)
        if(exclusiveResources){
          assert.deepEqual(drained.resources.exclusive_resources,['fixture-device'])
          const successor=await execution.exclusiveResources.acquire(['fixture-device'],'confirmed-successor');await successor.release()
          await writeFile('/tmp/superagent-exclusive-cancel.json',JSON.stringify({run_id:pending.id,state:pending.state,requested_stop_confirmed:requested.cancellation.stop_confirmed,resources:drained.resources,process:stopped,inferenceCalls,budget:budgetBefore,stop_state:drained.stop.receipt.state,operation_state:drained.stop.receipt.operation.state}))
        }
        assert.throws(() => process.kill(stopped.pid, 0), { code: 'ESRCH' })
      } else {
        assert.ok(budgetBefore.reserved > 0); assert.equal(drained.resources.state, 'held'); assert.equal(pending.state, 'cancelling')
      }
      assert.equal(pending.completion_authorized, false)
      await hub.stop('SIGKILL'); await hub.start()
      assert.deepEqual(await hub.client.call(`${runs}/before`, cancel), requested)
      assert.deepEqual((await hub.client.call(assignmentPath)).stop.receipt, drained.stop.receipt)
      assert.deepEqual((await hub.client.call(`${root}/budgets/budget`)).budget, budgetBefore)
      const resumed = new WorkRunController(dispatcher, { prepare() { throw new Error('cancellation recovery must not start work') } })
      try {
        if (toolMode) assert.deepEqual(await resumed.advance('before'), { state: 'cancelled', run_id: 'before', receipt: pending.cancellation.receipt })
        else assert.equal((await resumed.advance('before')).state, 'waiting_cancellation_accounting')
      } finally { await resumed.close() }
      assert.equal(inferenceCalls, expectedCalls); assert.equal(disposals, 1)
      assert.equal(await readFile(join(workspaceRoot, 'source.txt'), 'utf8'), 'fixture source')
      if (toolMode) {
        const cancelledRun = await hub.client.call(`${runs}/before`)
        const inspectStage = cancelledRun.stages.find(stage => stage.stage_id === 'inspect')
        await assertTaskSource(await hub.client.call(`${root}/work-assignments/${inspectStage.assignment_id}`), 'repaired source')
      }
      const audit = await hub.client.call(`${runs}/before/events`)
      assert.equal(audit.events.filter(row => row.data.kind === 'work_run_cancel_requested').length, 1)
      assert.equal(audit.events.filter(row => row.data.kind === 'assignment_execution_drained').length, toolMode ? 3 : 1)
      assert.equal(audit.events.filter(row => row.data.kind === 'work_run_cancelled').length, toolMode ? 1 : 0)
      assert.equal(audit.events.filter(row => row.data.kind === 'work_run_delivered').length, 0)
      return
    }
    // Functional delivery includes two full attempts and durable 200 KiB log archival.
    // It runs alongside the entire integration suite; this is not a 20-second latency SLA.
    const deadline = Date.now() + 45000
    let delivered, registered = escalationBudgetBlocked, humanConfirmed = false
    while (true) {
      delivered = await hub.client.call(`${runs}/before`)
      if (delivered.state === 'completed' || (limitMode && delivered.state === 'waiting_user' && states.at(-1)?.state === 'waiting_user')) break
      if (humanAcceptance && delivered.waiting_reason === 'human_delivery_acceptance_required') {
        assert.equal(humanConfirmed, false)
        assert.equal(delivered.completion_authorized, false)
        assert.ok(delivered.stages.every(stage => stage.state === 'passed'))
        assert.equal(inferenceCalls, 12)
        const decisionPath = `${runs}/before/delivery-decision`
        const decision = { request_id: 'accept-delivery', expected_revision: delivered.revision,
          evidence_hash: delivered.human_acceptance.evidence_hash, choice: 'accept', reason: 'Owner inspected archived artifact and verification evidence' }
        const observer = await hub.client.call(`${root}/sessions`, { session_id: 'acceptance-observer', title: 'Observer', runtime: 'external' })
        await assert.rejects(hub.client.forSession(observer.owner_token).call(decisionPath, decision), /403/)
        await assert.rejects(hub.client.call(decisionPath, { ...decision, expected_revision: delivered.revision - 1 }), /revision conflict/)
        await assert.rejects(hub.client.call(decisionPath, { ...decision, evidence_hash: '0'.repeat(64) }), /evidence changed/)
        await assert.rejects(hub.client.call(`${runs}/before/delivery`, { request_id: 'skip-human', expected_revision: delivered.revision }), /unavailable/)
        let accepted
        if (process.env.KODE_TEST_HUMAN_ACCEPTANCE_BROWSER === '1') accepted = await acceptDeliveryInBrowser(hub, delivered, humanReject ? 'reject' : 'accept')
        else {
          const results = await Promise.all([hub.client.call(decisionPath, decision), hub.client.call(decisionPath, decision)])
          assert.deepEqual(results[0], results[1]); accepted = results[0]
        }
        assert.equal(accepted.state, humanReject ? 'waiting_user' : 'queued'); assert.equal(accepted.completion_authorized, false)
        assert.deepEqual(accepted.human_acceptance.decision.actor, { kind: 'human', id: 'local_owner' })
        humanConfirmed = true
        if (humanReject) {
          await service.close()
          const closed = await hub.client.call(`${runs}/before`)
          assert.equal(closed.state, 'cancelled'); assert.equal(closed.completion_authorized, false)
          assert.equal(closed.human_acceptance.state, 'rejected')
          assert.equal(closed.cancellation.stop_confirmed, true); assert.equal(closed.cancellation.resources_released, true)
          assert.deepEqual(closed.cancellation.actor, { kind: 'human', id: 'local_owner' })
          assert.equal(inferenceCalls, 12); assert.deepEqual(errors, [])
          const budget = (await hub.client.call(`${root}/budgets/budget`)).budget
          assert.equal(budget.spent, 24); assert.equal(budget.reserved, 0)
          const events = (await hub.client.call(`${runs}/before/events`)).events
          assert.equal(events.filter(row => row.data.kind === 'work_run_delivered').length, 0)
          assert.equal(events.filter(row => row.data.kind === 'delivery_acceptance_decided').length, 1)
          assert.deepEqual(events.find(row => row.data.kind === 'work_run_cancelled').data.actor, { kind: 'system', id: 'cancellation_reconciler' })
          return
        }
      }
      const latest = states.at(-1)
      if (!registered && latest?.state === 'waiting_adapter') {
        assert.equal(delivered.completion_authorized, false)
        assert.equal(inferenceCalls, 9, 'missing verification runner never starts its Worker or inference')
        assert.equal(delivered.stages[2].state, 'ready')
        await assert.rejects(hub.client.call(`${runs}/before`, { action: 'cancel_settled', request_id: 'premature-disposition', expected_revision: delivered.revision, reason: 'Must not replace stopping live work' }), /requires waiting_user/)
        assert.equal((await hub.client.call(`${runs}/before`)).revision, delivered.revision)
        execution.verificationRunners.register(verificationDefinition)
        registered = true
        await service.retry('before')
      }
      assert.ok(!states.some(state => state.blocked && state.state !== 'waiting_adapter' && !((limitMode || humanAcceptance) && state.state === 'waiting_user')), 'unexpected progression fence: ' + JSON.stringify({ recent_states: states.slice(-8), progression: progression.slice(-8), errors }))
      assert.ok(Date.now() < deadline, 'workflow delivery deadline: ' + JSON.stringify({ mode, inferenceCalls, recent_states: states.slice(-8), progression: progression.slice(-8), errors, stages: delivered.stages.map(({ stage_id, state, attempt, assignment_id }) => ({ stage_id, state, attempt, assignment_id })) }))
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    await service.close()
    assert.deepEqual(errors, [])
    assert.equal(registered, true, 'explicit retry recovers the durable missing-adapter fence')
    if (waiverPreview) assert.equal(waiverInspected, true)
    if (humanAcceptance) assert.equal(humanConfirmed, true)
    const limited = limitMode, attempts = mode === 'success' ? 1 : 2
    assert.equal(delivered.completion_authorized, !limited)
    assert.deepEqual(delivered.stages.map(stage => [stage.state, stage.attempt]), [['passed', attempts], ['passed', attempts], [limited ? 'rejected' : 'passed', attempts]])
    const assignments = await Promise.all(delivered.stages.map(stage => hub.client.call(`${root}/work-assignments/${stage.assignment_id}`)))
    assert.equal(new Set(assignments.map(assignment => assignment.worker.session_id)).size, 3)
    assert.ok(assignments.every(assignment => assignment.state === 'completed' && assignment.resources.state === 'released' && assignment.pricing.price_id === (alternateExpert && assignment.stage_id === 'inspect' ? 'expert-price' : 'price')))
    assert.equal(await readFile(join(workspaceRoot, 'source.txt'), 'utf8'), 'fixture source')
    const inspectAssignment=assignments.find(assignment => assignment.stage_id === 'inspect')
    await assertTaskSource(inspectAssignment, desiredSource())
    if(inspectAssignment.stage_attempt>1)assert.equal(inspectAssignment.execution_workspace.receipt.starting_snapshot.basis,'rework_artifact')
    assert.equal(inferenceCalls, 12 * attempts)
    const ledger = await hub.client.call(`${root}/budgets/budget`)
    assert.equal(ledger.budget.spent, 24 * attempts); assert.equal(ledger.budget.reserved, 0)
    if (attempts === 2) {
      assert.equal(delivered.reworks.length, 1)
      const failed = delivered.reworks[0].outputs.checked
      assert.equal(failed.payload.kind, 'verification'); assert.equal(failed.payload.verdict, 'failed')
      assert.equal(failed.payload.exit_code, 3)
      const archive = await hub.client.call(`${root}/verification-records/${failed.sequence}`)
      const failedCommand = JSON.parse(archive.result_json)
      assert.equal(failedCommand.observed.exit_code, 3)
      assert.equal(failedCommand.observed.passed, false)
      assert.equal(failedCommand.observed.process_group_empty, true)
      assert.equal(failedCommand.source_sequence, failed.payload.artifact_sequence)
      assert.equal(failedCommand.snapshot_hash, failed.payload.snapshot_hash)
      const superseded = await Promise.all(delivered.reworks[0].superseded.map(stage => hub.client.call(`${root}/work-assignments/${stage.assignment_id}`)))
      assert.equal(new Set([...superseded, ...assignments].map(assignment => assignment.worker.session_id)).size, 6)
      assert.ok(superseded.every(assignment => assignment.state === 'completed' && assignment.resources.state === 'released'))
      assert.notEqual(delivered.stages[2].evidence.outputs.checked, failed.sequence)
      if (stageEscalation) {
        const previous = superseded.find(a => a.stage_id === 'inspect'), current = assignments.find(a => a.stage_id === 'inspect')
        assert.equal(previous.candidate.recommendation.task_tag, 'inspection')
        assert.equal(previous.candidate.scheduling.minimum_quality, 60)
        assert.equal(current.candidate.recommendation.task_tag, 'specialist')
        assert.equal(current.candidate.scheduling.minimum_quality, 90)
        assert.equal(current.candidate.target_id, alternateExpert ? 'aaa-alternate' : 'target')
        assert.equal(current.candidate.selection_policy.model, alternateExpert ? 'expert-model' : 'model')
        assert.equal(previous.candidate.selection_policy.model, 'model')
        assert.equal(observedModels.get(current.worker.session_id), alternateExpert ? 'expert-model' : 'model')
        assert.equal(observedModels.get(previous.worker.session_id), 'model')
        assert.deepEqual(current.candidate.recommendation.escalation, { after_reworks: 1, observed_reworks: 1, task_tag: 'specialist', minimum_quality: 90 })
        assert.deepEqual(current.candidate.grant_scope, previous.candidate.grant_scope)
        assert.deepEqual(current.candidate.funding, previous.candidate.funding)
        assert.equal(assignments.find(a => a.stage_id === 'followup').candidate.recommendation.task_tag, 'inspection')
      }

    }
    if (limited) {
      assert.equal(delivered.waiting_reason, 'rework_limit_exhausted')
      assert.equal(delivered.stages[2].completion.rework.scheduled, false)
      assert.equal(delivered.stages[2].completion.stage_passed, false)
      assert.equal(states.at(-1).blocked, true)
      assert.equal(controller.watches.size, 0)
      assert.ok(!delivered.delivery)
      await assert.rejects(hub.client.call(`${runs}/before/schedule`, { request_id: 'bypass-limit', expected_revision: delivered.revision }), /no schedulable stage/)
    }
    const receipt = delivered.delivery ?? null
    await hub.stop('SIGKILL'); await hub.start()
    const restored = await hub.client.call(`${runs}/before`)
    assert.deepEqual(restored.delivery ?? null, receipt)
    assert.equal(restored.state, delivered.state)
    if (limited) {
      const restartedController = new WorkRunController(dispatcher, { prepare: () => { throw new Error('exhausted work must not restart') } })
      const restarted = await new WorkRunService(restartedController, { intervalMs: 100 }).open()
      try {
        assert.equal(restarted.rows.before.state, 'waiting_user')
        await assert.rejects(restarted.retry('before'), /Hub state transition/)
        assert.equal(restarted.rows.before.blocked, true, 'retry does not clear the durable human-decision fence')
        await restarted.scan()
        assert.equal(restartedController.watches.size, 0)
        assert.equal(inferenceCalls, 24)
      } finally { await restarted.close() }
    }
    const audit = await hub.client.call(`${runs}/before/events`)
    assert.equal(audit.events.filter(event => event.data.kind === 'work_run_delivered').length, limited ? 0 : 1)
    assert.equal(audit.events.filter(event => event.data.kind === 'stage_rejected').length, mode === 'success' ? 0 : limited ? 2 : 1)
    if (limited) {
      const decision = { action: mode === 'verification-cancel' ? 'request_cancel' : 'cancel_settled', request_id: 'owner-close', expected_revision: restored.revision, reason: 'Stop this unsuccessful request and reconsider the requirement' }
      const observer = await hub.client.call(`${root}/sessions`, { session_id: 'disposition-observer', title: 'Observer', runtime: 'external' })
      await assert.rejects(hub.client.forSession(observer.owner_token).call(`${runs}/before`, decision), /403/)
      await assert.rejects(hub.client.call(`${runs}/before`, { ...decision, reason: ' ' }), /invalid work run command/)
      await assert.rejects(hub.client.call(`${runs}/before`, { ...decision, expected_revision: restored.revision - 1 }), /revision conflict/)
      const followup = { ...request, id: 'followup-request', request_id: 'followup-request', prior_run_id: 'before', inputs: { request: 'Reconsider the failed change' } }
      await assert.rejects(hub.client.call(runs, followup), /prior run must be terminal/)
      await hub.client.call(path, { action: 'deactivate', request_id: 'owner-stop-team', expected_revision: 1 })
      const cancelled = await Promise.all([hub.client.call(`${runs}/before`, decision), hub.client.call(`${runs}/before`, decision)])
      assert.deepEqual(cancelled[0], cancelled[1])
      let closed = cancelled[0], finalDecision
      if (mode === 'verification-cancel') {
        assert.equal(closed.state, 'cancelling')
        finalDecision = { action: 'finalize_cancel', request_id: 'confirm-owner-close', expected_revision: closed.revision }
        closed = await hub.client.call(`${runs}/before`, finalDecision)
        assert.equal(closed.cancellation.stop_confirmed, true)
        assert.equal(closed.cancellation.receipt.assignments.length, 6)
        assert.ok(closed.cancellation.receipt.assignments.every(row => row.stop_basis === 'execution_drained' && row.reservation.finalized && row.reservation.held === 0))
      }
      assert.equal(closed.state, 'cancelled'); assert.equal(closed.completion_authorized, false)
      assert.deepEqual(closed.reworks, restored.reworks)
      if (mode !== 'verification-cancel') {
        assert.deepEqual(closed.stages, restored.stages)
        assert.equal(closed.resolution.reason, decision.reason)
        assert.equal(closed.resolution.stop_basis, 'settled_assignments')
        assert.equal(closed.resolution.assignment_ids.length, 6)
      } else assert.equal(closed.cancellation.reason, decision.reason)
      await assert.rejects(hub.client.call(`${runs}/before`, { ...decision, reason: 'Changed decision' }), /identity conflict/)
      const nextRequest = await hub.client.call(runs, followup)
      assert.equal(nextRequest.prior_run_id, 'before'); assert.equal(nextRequest.state, 'waiting_user')
      assert.ok(nextRequest.stages.every(stage => stage.attempt === 0 && stage.assignment_id === null))
      assert.equal(inferenceCalls, 24, 'disposition and linked intake do not revive old execution')
      assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.spent, 48)
      await hub.stop('SIGKILL'); await hub.start()
      assert.deepEqual(await hub.client.call(`${runs}/before`, decision), cancelled[0])
      if (finalDecision) assert.deepEqual(await hub.client.call(`${runs}/before`, finalDecision), closed)
      assert.deepEqual(await hub.client.call(`${runs}/before`), closed)
      assert.deepEqual(await hub.client.call(runs, followup), nextRequest)
      const after = await hub.client.call(`${runs}/before/events`)
      assert.equal(after.events.filter(event => event.data.kind === 'work_run_cancelled').length, 1)
      assert.equal(after.events.filter(event => event.data.kind === 'work_run_delivered').length, 0)
    }
  } finally {
    await service?.close(); await host?.close(); await dispatcher?.close(); await execution?.close(); await ctx.fiber.dispose()
    for (const name of await readdir(join(hub.root, 'artifact-workspaces')).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
      await chmod(join(hub.root, 'artifact-workspaces', name, 'source'), 0o700).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
    await hub.close()
  }
})

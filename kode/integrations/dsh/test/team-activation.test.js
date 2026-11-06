import { versionedProject } from './support/versioned-project.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { registerConversation } from '../src/conversation-route.js'
import { registerTeamActivation } from '../src/team-activation-route.js'
import { isolatedHub } from './support/isolated-hub.js'

for(const mode of ['direct','builder']) test(`owner activation freezes reviewed authority and atomically advances only compatible undispatched runs (${mode})`, { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('team-activation')
  let webServer,ownerHttp,runtime
  try {
    const root = '/api/v1/messaging', path = `${root}/teams/team/activation`, runs = `${root}/work-runs`
    if(mode==='builder'){
      const routes=new Map()
      registerTeamActivation({get:()=>({officialExecution:runtime}),webServer:{register:r=>{routes.set(r.path,r);return()=>routes.delete(r.path)}},connection:{admit:req=>req.headers['x-fixture-owner']==='yes'?{peer:{principal:{kind:'owner'}}}:{rejection:401}}},{backendClient:hub.client})
      registerConversation({webServer:{register:r=>{routes.set(r.path,r);return()=>routes.delete(r.path)}},connection:{admit:req=>req.headers['x-fixture-owner']==='yes'?{peer:{principal:{kind:'owner'}}}:{rejection:401}}},{backendClient:hub.client})
      webServer=createServer((req,res)=>routes.get(new URL(req.url,'http://localhost').pathname).handler(req,res))
      webServer.listen(0,'127.0.0.1');await once(webServer,'listening')
      ownerHttp=async(route,body)=>{
        const response=await fetch(`http://127.0.0.1:${webServer.address().port}/api/kode/${route.startsWith('conversation/')?route:`teams/${route}`}`,{method:'POST',headers:{'content-type':'application/json','x-fixture-owner':'yes'},body:JSON.stringify(body)})
        const value=await response.json();assert.equal(response.status,200);return value
      }
    }
    const reviewCall=input=>mode==='builder'?ownerHttp('activation-review',{team_id:'team',...input}):hub.client.call(`${root}/teams/team/activation-review`,input)
    const activationCall=command=>mode==='builder'?ownerHttp('activation',{team_id:'team',command}):hub.client.call(path,command)

    const versionRef = r => ({ id: r.id, version: r.version, hash: r.hash })
    const policyRef = r => ({ id: r.id, revision: r.revision, hash: r.hash })
    const projectRoot = await versionedProject(hub.root)
    const workspace = { host_id: 'host', workspace_id: 'workspace', root_ref: projectRoot }
    const workflow = await hub.client.call(`${root}/workflows`, { id: 'flow', version: '1', inputs: ['request'],
      stages: [{ id: 'inspect', role: 'coordinator', requires: ['request'], produces: ['artifact'], independent_from: [], execution: { task_tag: 'inspection', repository_binding: 'code', capabilities: ['read'], tools: ['kode_capture_output'], network: false } },
        { id: 'followup', role: 'coordinator', requires: ['inspect'], produces: ['later'], independent_from: [], execution: { task_tag: 'inspection', repository_binding: 'code', capabilities: ['read'], tools: ['kode_capture_output'], network: false } }],
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
      policy: { kind: 'scheduling', targets: { target: { resource: { host: 'host', profile: 'profile', account_id: 'account', account_epoch: 1,
        binding_revision: 1, limit_ids: ['daily'], unknown_quota: 'team_budget' }, capability_id: 'capability', capability_revision: 1, preferred: false } },
      weights: { quality: 100, cost: 50, latency: 20 }, minimum_quality: 60, minimum_confidence: 0.7 } })
    const spec = { name: 'Team', purpose: 'Fixture', kind: 'coordinator', workspace_refs: [workspace],
      execution_targets: [{ id: 'target', host_id: 'host', executor_profile_id: 'profile', executor_profile_revision: 'f'.repeat(64), provider_id: 'fixture', model_id: 'model', effort: null,
        account_binding_id: 'account', capability_profile_revision: '1' }], workers: [], coordinator_targets: ['target'], workflow_pack_refs: [versionRef(workflow)],
      delivery_bindings: [{ id: 'local', workflow: versionRef(workflow), project: versionRef(project), delivery_policy: versionRef(delivery) }],
      grant_id: 'grant', budget_policy_id: 'budget-policy', scheduling_policy_id: 'schedule-policy',
      limits: { max_active_assignments: 2, max_active_runs: 8 }, proactive_mode: 'off' }
    if(mode==='direct')await hub.client.call(`${root}/teams`, { id: 'team', request_id: 'new', expected_revision: 0, spec })
    else {
      await hub.client.call(`${root}/superagents/drafts`,{id:'draft',request_id:'new',expected_revision:0,revoked:false,interview:{purpose:'Configure team',workspace_refs:[workspace],answers:{},questions:[],proposed_team:spec}})
      const accepted=await hub.client.call(`${root}/superagents/drafts/draft/accept-proposal`,{request_id:'accept',expected_revision:1,team_id:'team',team_revision:0})
      assert.equal(accepted.activation_performed,false);assert.equal(accepted.team.status,'draft')
      assert.deepEqual(accepted.team.spec,spec)
    }
    const grantCommand = { expected_revision: 0, policy: { id: 'grant', team_id: 'team', enabled: true, expires_at: Date.now() + 60000,
      targets: [{ host: 'host', workspace: 'workspace', root: projectRoot }], capabilities: ['read'], tools: ['kode_capture_output'], network: false, budget_ids: ['budget'] } }
    let grant = (await hub.client.call(`${root}/team-grants`, grantCommand)).grant
    const request = { id: 'before', request_id: 'before', team_id: 'team', team_revision: 1, binding_id: 'local', inputs: { request: 'Inspect' }, prior_run_id: null }
    const initial = await hub.client.call(runs, request)
    assert.deepEqual(await hub.client.call(`${runs}/active`), { items: [], next_cursor: null })
    const command = { action: 'activate', request_id: 'activate', expected_revision: 0, team_revision: 1, grant_revision: grant.revision,
      budget_policy: policyRef(budget), scheduling_policy: policyRef(schedule) }
    const worker = await hub.client.call(`${root}/sessions`, { session_id: 'worker', title: 'Worker', runtime: 'external' })
    const fromWorker = hub.client.forSession(worker.owner_token)
    await assert.rejects(fromWorker.call(`${root}/teams/team/activation-review`,{team_revision:1,request_id:'activate'}),/403/)
    const missingCapacity = await reviewCall({team_revision:1,request_id:'missing-capacity'})
    assert.equal(missingCapacity.prepared_command, null)
    assert.ok(missingCapacity.issues.some(issue => issue.code === 'assignment_account_capacity_missing'))
    await assert.rejects(hub.client.call(path, command), /capacity not configured/)
    assert.deepEqual(await hub.client.call(`${root}/teams/team/activation-receipts/activate`), { receipt: null })
    await hub.client.call(`${root}/resource-accounts`, { id: 'account', expected_epoch: 0, enabled: true })
    await hub.client.call(`${root}/assignment-capacities`, { account_id: 'account', expected_revision: 0, max_active_assignments: 1 })
    const reviewed=await reviewCall({team_revision:1,request_id:'activate'})
    if(mode==='builder')assert.equal(reviewed.runtime_readiness.status,'runtime_unavailable')
    assert.deepEqual(reviewed.prepared_command,command)
    assert.equal(reviewed.activation_performed,false);assert.equal(reviewed.eligible_for_execution,false)
    assert.deepEqual(reviewed.grant,grant)
    assert.equal(reviewed.resources.team_budgets[0].snapshot.label,'团队预算')
    assert.equal(reviewed.resources.coordinator_startup.configuration_checks_complete,false)
    assert.ok(reviewed.resources.coordinator_startup.issues.some(i=>i.code==='coordinator_startup_required'))
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved,0)

    await assert.rejects(fromWorker.call(`${runs}/active`), /403/)
    await assert.rejects(hub.client.call(`${runs}/active?after=bad%2Fcursor`), /invalid active run cursor/)
    await assert.rejects(fromWorker.call(path, command), /403/)
    await assert.rejects(hub.client.call(path, { ...command, grant_revision: 99 }), /grant changed/)
    await assert.rejects(hub.client.call(path, { ...command, budget_policy: { ...command.budget_policy, hash: '0'.repeat(64) } }), /reviewed activation policy changed/)
    const missingBudget = (await hub.client.call(`${root}/team-grants`, { ...grantCommand, expected_revision: grant.revision, policy: { ...grantCommand.policy, budget_ids: [] } })).grant
    await assert.rejects(hub.client.call(path, { ...command, grant_revision: missingBudget.revision }), /budget is outside grant/)
    const missingTool = (await hub.client.call(`${root}/team-grants`, { ...grantCommand, expected_revision: missingBudget.revision, policy: { ...grantCommand.policy, tools: [] } })).grant
    await assert.rejects(hub.client.call(path, { ...command, grant_revision: missingTool.revision }), /stage execution scope exceeds/)
    const wrongWorkspace = (await hub.client.call(`${root}/team-grants`, { ...grantCommand, expected_revision: missingTool.revision,
      policy: { ...grantCommand.policy, targets: [{ host: 'host', workspace: 'workspace', root: '/srv/other' }] } })).grant
    await assert.rejects(hub.client.call(path, { ...command, grant_revision: wrongWorkspace.revision }), /workspace is outside grant/)
    grant = (await hub.client.call(`${root}/team-grants`, { ...grantCommand, expected_revision: wrongWorkspace.revision })).grant
    command.grant_revision = grant.revision
    await assert.rejects(hub.client.call(path,reviewed.prepared_command),/grant changed/)
    const refreshed=await reviewCall({team_revision:1,request_id:'activate'})
    assert.deepEqual(refreshed.prepared_command,command)
    if(mode==='builder'){
      const response=await fetch(`http://127.0.0.1:${webServer.address().port}/api/kode/teams/activation`,{method:'POST',headers:{'content-type':'application/json','x-fixture-owner':'yes'},body:JSON.stringify({team_id:'team',command})})
      assert.equal(response.status,409)
      assert.equal((await response.json()).runtime_readiness.status,'runtime_unavailable')
      assert.deepEqual(await hub.client.call(`${root}/teams/team/activation-receipts/activate`),{receipt:null})
      runtime={host:'host'}
    }
    const race = await Promise.all([activationCall(refreshed.prepared_command), activationCall(refreshed.prepared_command)])
    const activation = race[0]; assert.deepEqual(race[1], activation)
    assert.equal(activation.active, true); assert.equal(activation.eligible_for_execution, false)
    assert.deepEqual(activation.snapshot.grant, grant)
    assert.deepEqual(activation.snapshot.policies.budget, budget)
    const conversation=activation.snapshot.team.conversation_id,messagePath=`${root}/conversations/${conversation}/messages`
    const userMessage={request_id:'need',content:'帮我实现这个需求'}
    await assert.rejects(fromWorker.call(messagePath,userMessage),/403/)
    await assert.rejects(fromWorker.call(messagePath),/403/)
    await assert.rejects(hub.client.call(messagePath,{...userMessage,actor:{kind:'coordinator'}}),/422/)
    const sendMessage=body=>mode==='builder'?ownerHttp('conversation/messages',{conversation_id:conversation,...body}):hub.client.call(messagePath,body)
    const messages=await Promise.all([sendMessage(userMessage),sendMessage(userMessage)])
    assert.deepEqual(messages[0],messages[1]);const acceptedMessage=messages[0]
    assert.equal(acceptedMessage.superagent_id,activation.snapshot.team.superagent_id)
    assert.equal(acceptedMessage.state,'accepted');assert.equal(acceptedMessage.coordinator_delivery,'pending')
    assert.equal(acceptedMessage.team_revision,1);assert.equal(acceptedMessage.activation_revision,1)
    await assert.rejects(hub.client.call(messagePath,{...userMessage,content:'different'}),/identity conflict/)
    assert.deepEqual((await hub.client.call(`${root}/conversations/${conversation}/requests/need`)).message,acceptedMessage)
    const longText='😀'.repeat(16370)
    for(let i=0;i<4;i++)await hub.client.call(messagePath,{request_id:`long-${i}`,content:`${i}${longText}`})
    const firstPage=await hub.client.call(`${messagePath}?limit=50`)
    assert.equal(firstPage.has_more,true,'byte bound must paginate without truncating message content')
    const secondPage=await hub.client.call(`${messagePath}?limit=50&after=${firstPage.next_cursor}`)
    const history=[...firstPage.items,...secondPage.items]
    assert.equal(history.length,5);assert.equal(secondPage.has_more,false)
    assert.deepEqual(history.map(m=>m.content),[userMessage.content,...Array.from({length:4},(_,i)=>`${i}${longText}`)])
    assert.equal(new Set(history.map(m=>m.id)).size,5)
    await assert.rejects(hub.client.call(messagePath,{request_id:'oversized',content:'😀'.repeat(16385)}),/invalid conversation/)

    const authorized = await hub.client.call(`${runs}/before`)
    assert.equal(authorized.state, 'waiting_resource'); assert.equal(authorized.revision, 2)
    assert.deepEqual(await hub.client.call(`${runs}/active`), { items: [{ id: authorized.id, team_id: authorized.team_id, revision: 2, state: 'waiting_resource', home_hub: authorized.home_hub }], next_cursor: null })
    assert.deepEqual(await hub.client.call(`${runs}/active?after=before`), { items: [], next_cursor: null })
    assert.equal(authorized.context_hash, initial.context_hash)
    assert.deepEqual(authorized.authorization, activation)
    const stagePath = `${runs}/before/stages/inspect/plan`
    const planned = await hub.client.call(stagePath)
    assert.deepEqual(planned.issues, [])
    const pending = await hub.client.call(`${runs}/before/stages/followup/plan`)
    assert.deepEqual(pending.candidates, [])
    assert.ok(pending.issues.some(i => i.code === 'stage_dependency_pending' && i.dependency === 'inspect'))
    assert.equal(planned.eligible_for_dispatch, false)
    assert.equal(planned.candidates.length, 1)
    const candidate = planned.candidates[0]
    assert.equal(candidate.selection_policy.profile_revision, 'f'.repeat(64), 'executor hash is distinct from capability assessment revision')
    assert.equal(candidate.capability_profile.revision, 1)
    assert.deepEqual(candidate.scheduling, { weights: schedule.policy.weights, minimum_quality: 60, minimum_confidence: 0.7 })
    assert.deepEqual(candidate.team_limits, spec.limits)
    assert.equal(planned.run_revision, authorized.revision)
    assert.equal(planned.run_state, authorized.state)
    assert.equal(candidate.selection_policy.model, 'model')
    assert.deepEqual(candidate.grant_scope.tools, ['kode_capture_output'])
    assert.deepEqual(candidate.grant_scope.capabilities, ['read'])
    assert.deepEqual(candidate.grant_scope.target, { host: 'host', workspace: 'workspace', root: projectRoot })
    assert.deepEqual(candidate.funding, { budget_ids: ['budget'], unit: 'credits', amount: 10 })
    assert.equal(candidate.recommendation.recommended, false)
    assert.equal(candidate.recommendation.assessment.reason, 'capability_revision_missing')

    await hub.client.call(`${root}/resource-bindings`, { host: 'host', profile: 'profile', account_id: 'account', account_epoch: 1, expected_revision: 0 })
    const at = Date.now(), assessment = { evaluation: { kind: 'task_fit', tag: 'inspection', score: 80 },
      source: 'user', confidence: 0.9, evidence: [], pinned: false, updated_at: at - 1000, valid_until: at + 60000 }
    const capability = { id: 'capability', expected_revision: 0, host: 'host', profile: 'profile', model: 'model', assessments: { fit: assessment } }
    await hub.client.call(`${root}/capability-profiles`, capability)
    const recommended = (await hub.client.call(stagePath)).candidates[0].recommendation
    assert.equal(recommended.task_tag, 'inspection', 'task category is explicit, not inferred from coordinator role')
    assert.equal(recommended.recommended, true)
    assert.equal(recommended.assessment.components.quality, 80)
    assert.equal(recommended.assessment.quota.requires_team_budget, true)
    await hub.client.call(`${root}/capability-profiles`, { ...capability, expected_revision: 1,
      assessments: { fit: { ...assessment, evaluation: { kind: 'task_fit', tag: 'inspection', score: 10 } } } })
    assert.equal((await hub.client.call(stagePath)).candidates[0].recommendation.assessment.components.quality, 80, 'new capability revision cannot replace frozen policy reference')

    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved, 0, 'planning has no accounting effects')
    await assert.rejects(fromWorker.call(stagePath), /403/)

    assert.deepEqual(await hub.client.call(runs, request), initial, 'initial receipt stays immutable')
    const newRun = await hub.client.call(runs, { ...request, id: 'after', request_id: 'after' })
    assert.equal(newRun.state, 'waiting_resource'); assert.deepEqual(newRun.authorization, activation)
    assert.equal((await hub.client.call(path)).authority_valid, true)
    const stopped = await hub.client.call(path, { action: 'deactivate', request_id: 'off', expected_revision: 1 })
    await assert.rejects(hub.client.call(messagePath,{request_id:'after-off',content:'new'}),/authority unavailable/)
    assert.deepEqual(await hub.client.call(messagePath,userMessage),acceptedMessage,'retry retains receipt after deactivation')
    assert.equal(stopped.active, false)
    assert.equal((await hub.client.call(`${runs}/before`)).waiting_reason, 'team_deactivated')
    assert.equal((await hub.client.call(path)).authority_valid, false)
    assert.deepEqual((await hub.client.call(stagePath)).candidates, [])
    const resumed = await hub.client.call(path, { ...command, request_id: 'again', expected_revision: 2 })
    assert.equal(resumed.revision, 3)
    const resumedRun = await hub.client.call(`${runs}/before`)
    assert.equal(resumedRun.state, 'waiting_resource')
    assert.deepEqual(resumedRun.authorization, activation, 'identical reactivation preserves original authority snapshot')
    await hub.client.call(`${runs}/after`, { action: 'cancel', request_id: 'cancel', expected_revision: 3 })
    const cancelledPlan = await hub.client.call(`${runs}/after/stages/inspect/plan`)
    assert.equal(cancelledPlan.run_state, 'cancelled')
    assert.equal(cancelledPlan.run_revision, 4)
    assert.deepEqual(cancelledPlan.candidates, [])
    assert.ok(cancelledPlan.issues.some(i => i.code === 'run_not_schedulable'))
    const updatedBudget = await hub.client.call(`${root}/team-policies`, { ...budgetCommand, expected_revision: 1, policy: { ...budgetCommand.policy, max_assignment_charge: 20 } })
    await assert.rejects(hub.client.call(path, { ...command, request_id: 'stale-policy', expected_revision: 3 }), /reviewed activation policy changed/)
    assert.deepEqual((await hub.client.call(`${runs}/before`)).authorization.snapshot.policies.budget, budget)
    assert.deepEqual((await hub.client.call(stagePath)).candidates[0].funding, candidate.funding, 'new policy does not replace frozen run funding')
    const observed = Date.now()
    await hub.client.call(`${root}/quota-snapshots`, { host: 'host', profile: 'profile', account_id: 'account', account_epoch: 1, binding_revision: 1,
      observed_at_ms: observed, truncated: false, buckets: [{ limit_id: 'daily', observed_at_ms: observed, valid_until_ms: observed + 60000,
        windows: [{ window_id: 'day', used_percent: 100, resets_at_ms: observed + 60000, window_minutes: 1440 }] }] })
    const exhausted = (await hub.client.call(stagePath)).candidates[0].recommendation
    assert.equal(exhausted.recommended, false)
    assert.equal(exhausted.assessment.reason, 'provider_exhausted')
    await hub.client.call(`${root}/team-grants`, { ...grantCommand, expected_revision: grant.revision, policy: { ...grantCommand.policy, enabled: false } })
    assert.equal((await hub.client.call(path)).authority_valid, false)
    const denied = await hub.client.call(runs, { ...request, id: 'revoked', request_id: 'revoked' })
    assert.equal(denied.state, 'waiting_user'); assert.equal(denied.authorization, undefined)
    const rejectedPlan = await hub.client.call(stagePath)
    assert.deepEqual(rejectedPlan.candidates, [])
    assert.ok(rejectedPlan.issues.some(i => i.code === 'run_authority_unavailable'))
    await assert.rejects(hub.client.call(path, { ...command, request_id: 'revoked', expected_revision: 3, grant_revision: grant.revision + 1, budget_policy: policyRef(updatedBudget) }), /grant changed/)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(path, command), activation, 'retry returns historical consent, not renewed authority')
    runtime=undefined
    assert.deepEqual(await activationCall(command),activation,'historical receipt bypasses missing runtime after restart/revocation')
    const receiptPath=`${root}/teams/team/activation-receipts/activate`
    assert.deepEqual(await hub.client.call(receiptPath),{receipt:{request:command,result:activation}})
    await assert.rejects(fromWorker.call(receiptPath),/403/)
    assert.deepEqual(await hub.client.call(`${root}/teams/other/activation-receipts/activate`),{receipt:null})
    const recovered = await hub.client.call(path)
    assert.equal(recovered.revision, 3); assert.equal(recovered.authority_valid, false)
    assert.deepEqual(await hub.client.call(`${runs}/before`), resumedRun)
    assert.equal((await hub.client.call(`${runs}/after`)).state, 'cancelled')
    assert.deepEqual((await hub.client.call(`${root}/conversations/${conversation}/requests/need`)).message,acceptedMessage,'conversation survives Hub restart without runtime session')
    assert.deepEqual(await hub.client.call(messagePath,userMessage),acceptedMessage)
    const audit = await hub.client.call(`${root}/teams/team/events`)
    assert.equal(audit.events.filter(e=>e.data.kind==='conversation_message_accepted').length,5)
    assert.deepEqual(audit.events.map(e => e.data.kind).filter(kind=>kind!=='conversation_message_accepted'), ['team_draft_saved', ...(mode==='builder'?['builder_proposal_accepted']:[]), 'team_activated', 'team_deactivated', 'team_activated'])
    await assert.rejects(fromWorker.call(path), /403/)
    assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved, 0)
  } finally { if(webServer){webServer.closeAllConnections();await new Promise(resolve=>webServer.close(resolve))}await hub.close() }
})

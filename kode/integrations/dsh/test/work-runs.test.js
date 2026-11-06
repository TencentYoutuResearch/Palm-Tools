import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { registerWorkRun } from '../src/work-run-route.js'
import { createHash } from 'node:crypto'
import { isolatedHub } from './support/isolated-hub.js'

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value

test('home WorkRun intake freezes revisions, survives crash and cancels only never-dispatched work', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('work-runs-home')
  let route, loseReply=false
  registerWorkRun({webServer:{register:value=>{route=value}},connection:{admit:req=>({peer:{principal:{kind:req.headers['x-fixture-principal']??'owner'}}})}},
    {backendClient:{call:async(...args)=>{const result=await hub.client.call(...args);if(loseReply&&args[1]){loseReply=false;throw Error('committed reply lost')}return result}}})
  const server=createServer((req,res)=>route.handler(req,res))
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const base=`http://127.0.0.1:${server.address().port}/api/kode/work-run`
  const control=(body,principal='owner')=>fetch(base,{method:'POST',headers:{'content-type':'application/json','x-fixture-principal':principal},body:JSON.stringify(body)})
  try {
    const root = '/api/v1/messaging', path = `${root}/work-runs`
    const ref = row => ({ id: row.id, version: row.version, hash: row.hash })
    const workspace = { host_id: 'host', workspace_id: 'workspace', root_ref: 'registered-root' }
    const flow = await hub.client.call(`${root}/workflows`, { id: 'local', version: '1', inputs: ['request'],
      stages: [{ id: 'build', role: 'coordinator', requires: ['request'], produces: ['artifact'], independent_from: [] }],
      completion_stages: ['build'], evidence_rules: { artifact: { kind: 'artifact', repository_binding: 'code' } } })
    const project = await hub.client.call(`${root}/project-configs`, { id: 'project', version: '1', spec: { kind: 'project_bindings',
      repositories: { code: { repository_id: 'repository', workspace } }, environments: {}, commands: {}, connections: {} } })
    const delivery = await hub.client.call(`${root}/project-configs`, { id: 'delivery', version: '1', spec: { kind: 'delivery_policy',
      workflow: ref(flow), project: ref(project), targets: [{ kind: 'local', repository_binding: 'code' }], required_outputs: ['artifact'] } })
    const spec = { name: 'Team', purpose: 'Fixture', kind: 'coordinator', workspace_refs: [workspace],
      execution_targets: [{ id: 'target', host_id: 'host', executor_profile_id: 'profile', provider_id: 'fixture', model_id: 'model', effort: null, account_binding_id: 'account', capability_profile_revision: '1' }],
      workers: [], coordinator_targets: ['target'], workflow_pack_refs: [ref(flow)],
      delivery_bindings: [{ id: 'local', workflow: ref(flow), project: ref(project), delivery_policy: ref(delivery) }],
      grant_id: null, budget_policy_id: null, scheduling_policy_id: null,
      limits: { max_active_assignments: 2, max_active_runs: 1 }, proactive_mode: 'off' }
    const team = await hub.client.call(`${root}/teams`, { id: 'team', request_id: 'new', expected_revision: 0, spec })
    const registration = await hub.client.call(`${root}/sessions`, { session_id: 'worker', title: 'Worker', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const request = { id: 'run', request_id: 'request', team_id: 'team', team_revision: 1, binding_id: 'local', inputs: { request: 'Implement the requested change' }, prior_run_id: null }
    await assert.rejects(worker.call(path, request), /403/)
    await assert.rejects(hub.client.call(path, { ...request, inputs: { wrong: 'input' } }), /inputs do not match/)
    await assert.rejects(hub.client.call(path, { ...request, binding_id: 'missing' }), /unknown team delivery binding/)
    await assert.rejects(hub.client.call(path, { ...request, team_revision: 999 }), /unknown team revision/)
    await assert.rejects(hub.client.call(path, { ...request, state: 'running' }), /422/)
    const duplicate = await Promise.all([hub.client.call(path, request), hub.client.call(path, request)])
    assert.deepEqual(duplicate[0], duplicate[1])
    const initial = duplicate[0]
    await assert.rejects(hub.client.call(`${path}/run`, { action: 'cancel_settled', request_id: 'no-attempts', expected_revision: 1, reason: 'No work was started' }), /requires prior Assignments/)
    assert.equal(initial.state, 'waiting_user'); assert.equal(initial.waiting_reason, 'team_activation_required')
    assert.equal(initial.dispatch_state, 'not_dispatched'); assert.equal(initial.completion_authorized, false)
    assert.deepEqual(initial.context.team, team)
    assert.deepEqual(initial.context.binding.project, project)
    assert.equal(initial.context_hash, createHash('sha256').update(`kode.work.run.context.v1\n${JSON.stringify(canonical(initial.context))}`).digest('hex'))
    assert.deepEqual(initial.stages, [{ stage_id: 'build', state: 'pending', attempt: 0, assignment_id: null }])
    await assert.rejects(hub.client.call(path, { ...request, inputs: { request: 'Different request' } }), /identity conflict/)
    await assert.rejects(hub.client.call(path, { ...request, id: 'another', request_id: 'another' }), /capacity exhausted/)
    await hub.client.call(`${root}/teams`, { id: 'team', request_id: 'edit', expected_revision: 1, spec: { ...spec, name: 'New name', delivery_bindings: [] } })
    assert.deepEqual(await hub.client.call(`${path}/run`), initial, 'draft edits do not replace frozen context')
    await assert.rejects(hub.client.call(path, { ...request, id: 'invalid', request_id: 'invalid', team_revision: 2 }), /bindings are invalid/)
    const cancel = { action: 'cancel', request_id: 'cancel', expected_revision: 1 }
    await assert.rejects(worker.call(`${path}/run`, cancel), /403/)
    await assert.rejects(hub.client.call(`${path}/run`, { action: 'complete', request_id: 'false-completion', expected_revision: 1 }), /422/)
    const race = await Promise.allSettled([cancel, { ...cancel, request_id: 'other-cancel' }].map(command => hub.client.call(`${path}/run`, command)))
    assert.equal(race.filter(r => r.status === 'fulfilled').length, 1)
    assert.match(race.find(r => r.status === 'rejected').reason.message, /revision conflict/)
    const cancelled = race.find(r => r.status === 'fulfilled').value
    assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.revision, 2)
    assert.equal(cancelled.context_hash, initial.context_hash)
    assert.ok(cancelled.stages.every(s => s.state === 'cancelled' && s.assignment_id === null))
    const audit = await hub.client.call(`${path}/run/events`)
    assert.deepEqual(audit.events.map(e => e.data.kind), ['work_run_received', 'work_run_cancelled'])
    const acceptedCancel = { ...cancel, request_id: audit.events[1].data.request_id }
    assert.deepEqual(await hub.client.call(`${path}/run`, acceptedCancel), cancelled)
    await assert.rejects(hub.client.call(`${path}/run`, { ...acceptedCancel, expected_revision: 2 }), /identity conflict/)
    await assert.rejects(hub.client.call(`${path}/run`, { ...cancel, request_id: 'again', expected_revision: 2 }), /cannot use undispatched cancellation/)
    const next = { ...request, id: 'next', request_id: 'next', prior_run_id: 'run' }
    const createdNext = await hub.client.call(path, next)
    assert.equal(createdNext.prior_run_id, 'run')
    await assert.rejects(hub.client.call(path, { ...request, id: 'bad-prior', request_id: 'bad-prior', prior_run_id: 'next' }), /prior run must be terminal/)
    await hub.client.call(`${root}/teams`, { id: 'other', request_id: 'new', expected_revision: 0, spec })
    await assert.rejects(hub.client.call(path, { ...request, id: 'cross-team', request_id: 'cross-team', team_id: 'other', prior_run_id: 'run' }), /prior run must be terminal/)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(`${path}/run`), cancelled)
    assert.deepEqual(await hub.client.call(path, request), initial, 'creation retry returns original receipt without resurrecting terminal run')
    assert.deepEqual(await hub.client.call(`${path}/run`, acceptedCancel), cancelled)
    assert.deepEqual(await hub.client.call(`${path}/next`), createdNext)
    assert.equal((await hub.client.call(`${path}/run/events?after=${audit.events[0].seq}`)).events.length, 1)
    await assert.rejects(worker.call(`${path}/run`), /403/)
    await assert.rejects(worker.call(`${path}/run/events`), /403/)
    const decision={run_id:'next',action:'cancel',request_id:'owner-decision',expected_revision:1}
    assert.equal((await control(decision,'agent')).status,403)
    for(const extra of [{action:'complete'},{action:'finalize_cancel'},{expected_revision:0},{reason:'not permitted for intake cancel'},{state:'completed'}]) {
      assert.equal((await control({...decision,...extra})).status,400)
    }
    assert.equal((await fetch(`${base}?run_id=next&run_id=run`)).status,400)
    assert.deepEqual(await (await fetch(`${base}?run_id=next`)).json(),createdNext)
    loseReply=true
    const lost=await control(decision)
    assert.equal(lost.status,409);assert.equal((await lost.json()).retry,'same_request')
    const resolved=await (await control(decision)).json()
    assert.equal(resolved.state,'cancelled');assert.equal(resolved.revision,2)
    const events=await (await fetch(`${base}?run_id=next&view=events&after=0`)).json()
    assert.deepEqual(events.events.map(e=>e.data.kind),['work_run_received','work_run_cancelled'])
    await hub.stop('SIGKILL');await hub.start()
    assert.deepEqual(await (await control(decision)).json(),resolved)
    assert.equal((await control({...decision,expected_revision:2})).status,409)
    assert.equal((await hub.client.call(`${root}/teams/team`)).status, 'draft')
  } finally { await new Promise(resolve=>server.close(resolve)); await hub.close() }
})

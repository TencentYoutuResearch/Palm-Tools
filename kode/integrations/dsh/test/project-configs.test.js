import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'

test('project bindings and configurable delivery endpoints pin versions without executing adapters', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('project-configs')
  try {
    const path = '/api/v1/messaging/project-configs'
    const project = { id: 'project', version: '1', spec: { kind: 'project_bindings', repositories: {
      primary: { repository_id: 'repo-a', workspace: { host_id: 'host', workspace_id: 'work-a', root_ref: 'root-a' } },
      secondary: { repository_id: 'repo-b', workspace: { host_id: 'host', workspace_id: 'work-b', root_ref: 'root-b' } },
    }, environments: { local: { host_id: 'host', adapter_id: 'local-verifier', configuration_hash: 'a'.repeat(64) } },
    commands: { check: { id: 'regression', revision: '1', definition_hash: 'b'.repeat(64), repository_binding: 'primary', environment_binding: 'local', runner_id: 'controlled-runner', scenario_ids: ['smoke', 'acceptance'] } },
    connections: { git: { adapter_id: 'code-host', connection_id: 'git-account', capabilities: ['create_change_request', 'deploy'] }, tracker: { adapter_id: 'issues', connection_id: 'tracker-account', capabilities: ['read_issue'] } } } }
    const worker = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Worker', runtime: 'external' })
    await assert.rejects(hub.client.forSession(worker.owner_token).call(path, project), /403/)
    const stored = await hub.client.call(path, project)
    assert.equal(stored.eligible_for_execution, false)
    const retry = structuredClone(project); retry.spec.commands.check.scenario_ids.reverse()
    assert.deepEqual(await hub.client.call(path, retry), stored)
    const wrongHost = structuredClone(project); wrongHost.spec.environments.local.host_id = 'foreign'
    await assert.rejects(hub.client.call(path, wrongHost), /host differs/)
    const credentials = structuredClone(project); credentials.spec.connections.git.token = 'not-a-real-token'
    await assert.rejects(hub.client.call(path, credentials), /422/)
    const edited = structuredClone(project); edited.spec.commands.check.revision = '2'
    await assert.rejects(hub.client.call(path, edited), /immutable/)
    edited.version = '2'; const updated = await hub.client.call(path, edited)
    assert.notEqual(updated.hash, stored.hash)
    const workflow = await hub.client.call('/api/v1/messaging/workflows', { id: 'workflow', version: '1', inputs: ['request'], stages: [
      { id: 'build', role: 'author', requires: ['request'], produces: ['artifact'], independent_from: [] },
      { id: 'check', role: 'verifier', requires: ['build'], produces: ['verified'], independent_from: [] },
    ], completion_stages: ['check'], evidence_rules: { artifact: { kind: 'artifact', repository_binding: 'primary' }, verified: { kind: 'verification', artifact_output: 'artifact', command_binding: 'check', environment_binding: 'local', required_scenarios: ['acceptance'] } } })
    const ref = row => ({ id: row.id, version: row.version, hash: row.hash })
    const delivery = { id: 'delivery', version: 'local', spec: { kind: 'delivery_policy', project: ref(stored), workflow: ref(workflow), targets: [{ kind: 'local', repository_binding: 'primary' }], required_outputs: ['artifact', 'verified'] } }
    const local = await hub.client.call(path, delivery)
    assert.deepEqual(local.config.spec.project, ref(stored), 'new project version never changes old delivery binding')
    for (const [version, target] of [
      ['pr', { kind: 'change_request', repository_binding: 'primary', connection_binding: 'git', target_branch: 'main' }],
      ['deploy', { kind: 'deployed', repository_binding: 'secondary', connection_binding: 'git', environment_binding: 'local' }],
      ['custom', { kind: 'custom', capability: 'read_issue', connection_binding: 'tracker', target_ref: 'issue:fixture' }],
    ]) assert.equal((await hub.client.call(path, { ...delivery, version, spec: { ...delivery.spec, targets: [target] } })).eligible_for_execution, false)
    await assert.rejects(hub.client.call(path, { ...delivery, version: 'bad', spec: { ...delivery.spec, required_outputs: ['missing'] } }), /declared workflow evidence/)
    await assert.rejects(hub.client.call(path, { ...delivery, version: 'bad', spec: { ...delivery.spec, targets: [{ kind: 'change_request', repository_binding: 'primary', connection_binding: 'git', target_branch: '' }] } }), /invalid change/)
    const missing = structuredClone(project); missing.id = 'missing'; delete missing.spec.commands.check
    const incomplete = await hub.client.call(path, missing)
    await assert.rejects(hub.client.call(path, { ...delivery, version: 'missing-command', spec: { ...delivery.spec, project: ref(incomplete) } }), /workflow command binding/)
    for (const [id, mutate, error] of [
      ['scenario', p => { p.spec.commands.check.scenario_ids = ['smoke'] }, /scenario missing/],
      ['repository', p => { p.spec.commands.check.repository_binding = 'secondary' }, /repository mismatch/],
      ['environment', p => {
        p.spec.environments.other = { ...p.spec.environments.local }
        p.spec.commands.check.environment_binding = 'other'
      }, /environment mismatch/],
      ['artifact', p => {
        delete p.spec.repositories.primary
        p.spec.commands.check.repository_binding = 'secondary'
      }, /repository binding/],
    ]) {
      const candidate = structuredClone(project); candidate.id = id; mutate(candidate)
      const saved = await hub.client.call(path, candidate)
      await assert.rejects(hub.client.call(path, { ...delivery, version: id, spec: { ...delivery.spec, project: ref(saved) } }), error)
    }
    const binding = { id: 'default', workflow: ref(workflow), project: ref(stored), delivery_policy: ref(local) }
    const teamSpec = { name: 'Bound team', purpose: 'Local delivery', kind: 'coordinator',
      workspace_refs: Object.values(project.spec.repositories).map(r => r.workspace),
      execution_targets: [{ id: 'target', host_id: 'host', executor_profile_id: 'profile', provider_id: 'fixture', model_id: 'model', effort: null, account_binding_id: 'account', capability_profile_revision: '1' }],
      workers: ['author', 'verifier'].map(role => ({ id: role, role, responsibilities: [role], allowed_target_ids: ['target'], required_capabilities: [], workspace_refs: [project.spec.repositories.primary.workspace], max_parallel: 1 })),
      coordinator_targets: ['target'], workflow_pack_refs: [ref(workflow)], delivery_bindings: [binding],
      grant_id: null, budget_policy_id: null, scheduling_policy_id: null,
      limits: { max_active_assignments: 2, max_active_runs: 1 }, proactive_mode: 'off' }
    const teams = '/api/v1/messaging/teams'
    let revision = 0
    const saveTeam = async spec => {
      const row = await hub.client.call(teams, { id: 'bound', request_id: `edit-${revision}`, expected_revision: revision, spec })
      revision = row.revision; return row
    }
    const preflight = rev => hub.client.call(`${teams}/bound/revisions/${rev}/workflow-preflight`)
    const firstTeam = await saveTeam(teamSpec)
    const checked = await preflight(revision)
    assert.equal(checked.workflow_bindings_valid, true)
    assert.equal(checked.project_delivery_bindings_valid, true)
    assert.equal(checked.eligible_for_execution, false)
    assert.deepEqual(checked.bindings[0].project, stored, 'team pins old project version despite newer version existing')
    assert.deepEqual(checked.bindings[0].delivery_policy, local)
    assert.deepEqual(checked.bindings[0].workflow, workflow)
    for (const [mutate, expected] of [
      [s => { s.workspace_refs = []; s.workers.forEach(w => { w.workspace_refs = [] }) }, 'project_workspace_outside_team'],
      [s => { s.delivery_bindings[0].project = ref(updated) }, 'delivery_binding_reference_mismatch'],
      [s => { s.delivery_bindings[0].project.hash = '0'.repeat(64) }, 'binding_hash_mismatch'],
      [s => { s.delivery_bindings[0].delivery_policy.version = 'absent' }, 'binding_version_missing'],
      [s => { s.delivery_bindings[0].delivery_policy = ref(stored) }, 'binding_kind_mismatch'],
      [s => { delete s.delivery_bindings }, 'delivery_binding_required'],
    ]) {
      const invalid = structuredClone(teamSpec); mutate(invalid)
      await saveTeam(invalid)
      const result = await preflight(revision)
      assert.equal(result.project_delivery_bindings_valid, false)
      assert.ok(result.binding_issues.some(i => i.code === expected), JSON.stringify(result.binding_issues))
      assert.deepEqual(result.bindings, [])
    }
    for (const mutate of [
      s => { s.delivery_bindings.push(structuredClone(binding)) },
      s => { s.delivery_bindings[0].workflow.hash = '0'.repeat(64) },
      s => { s.delivery_bindings[0].project.hash = 'bad' },
    ]) {
      const invalid = structuredClone(teamSpec); mutate(invalid)
      await assert.rejects(saveTeam(invalid), /delivery/)
    }
    const secondTeam = await hub.client.call(teams, { id: 'other', request_id: 'new', expected_revision: 0, spec: teamSpec })
    assert.notEqual(firstTeam.superagent_id, secondTeam.superagent_id)
    assert.equal((await preflight(1)).project_delivery_bindings_valid, true, 'later draft cannot change historical scope')
    assert.equal((await hub.client.call(`${teams}/bound/events`)).events.length, revision, 'preflight does not create state or audit effects')
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(`${path}/delivery/versions/local`), local)
    const recovered = await preflight(1)
    assert.deepEqual(recovered.bindings, checked.bindings)
    assert.equal(recovered.project_delivery_bindings_valid, true)
    assert.deepEqual(await hub.client.call(path, project), stored)
    const audit = await hub.client.call(`${path}/project/events`)
    assert.deepEqual(audit.events.map(e => e.data.version), ['1', '2'])
    assert.deepEqual((await hub.client.call(`${path}/project/events?after=${audit.events[0].seq}`)).events.map(e => e.data.version), ['2'])
    await assert.rejects(hub.client.forSession(worker.owner_token).call(`${path}/project/versions/1`), /403/)
  } finally { await hub.close() }
})

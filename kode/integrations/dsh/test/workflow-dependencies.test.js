import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { isolatedHub } from './support/isolated-hub.js'
import { assignmentDependencies } from '../src/assignment-dependencies.js'
import { conversationTeam } from './support/conversation-team.js'
const sha256 = value => createHash('sha256').update(value).digest('hex')
test('owner instruction artifacts are immutable and the Worker independently validates Rust hashes and scope', {
  skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000,
}, async () => {
  const hub = await isolatedHub('dependencies')
  try {
    const call = (path, body) => hub.client.call('/api/v1/messaging/' + path, body)
    const instructions = 'Use reviewed procedure.\n保留独立评审与验证。'
    const config = { id: 'method', version: '1', spec: { kind: 'workflow_dependency', artifact: {
      kind: 'plugin', source: 'fixture://workflow/project', source_version: '0.3.0', content_hash: sha256(instructions), instructions,
      hosts: [hub.node], tools: ['read_source'], capabilities: ['read'], network: false,
    } } }
    const peer = await call('sessions', { session_id: 'worker', title: 'Worker', runtime: 'external' })
    await assert.rejects(hub.client.forSession(peer.owner_token).call('/api/v1/messaging/project-configs', config), /403/)
    const row = await call('project-configs', config)
    assert.deepEqual(await call('project-configs', config), row)
    assert.equal(row.hash, sha256('kode.project.config.v1\n' + JSON.stringify(config)))
    const reference = { id: row.id, version: row.version, hash: row.hash }
    const scope = { repository_binding: 'code', dependencies: [reference], tools: ['read_source'], capabilities: ['read'], network: false }
    const mandate = { stage: { execution: scope }, worker: { node_id: hub.node }, grant_scope: scope, dependencies: [row] }
    const manifest = assignmentDependencies(mandate)
    assert.deepEqual(manifest, [{ ...reference, kind: 'plugin', source: config.spec.artifact.source, source_version: '0.3.0', content_hash: sha256(instructions) }])
    assert.deepEqual(assignmentDependencies({ stage: { execution: { tools: [] } } }), [])
    for (const mutate of [
      value => { value.dependencies = [] },
      value => { value.dependencies[0].config.spec.artifact.instructions += ' injected' },
      value => { value.dependencies[0].config.spec.artifact.extra_instruction = 'unbound' },
      value => { value.worker.node_id = 'foreign' },
      value => { value.grant_scope.tools = [] },
      value => { value.stage.execution.dependencies.push(reference) },
      value => { value.stage.execution.dependencies = [] },
    ]) {
      const changed = structuredClone(mandate); mutate(changed)
      assert.throws(() => assignmentDependencies(changed), /binding mismatch/)
    }
    const changed = structuredClone(config); changed.spec.artifact.instructions += ' revised'
    await assert.rejects(call('project-configs', changed), /invalid/)
    changed.spec.artifact.content_hash = sha256(changed.spec.artifact.instructions)
    await assert.rejects(call('project-configs', changed), /immutable/)
    changed.version = '2'; await call('project-configs', changed)
    const stage = { id: 'inspect', role: 'inspector', requires: ['request'], produces: ['report'], independent_from: [], execution: scope }
    const pack = { id: 'workflow', version: '1', inputs: ['request'], stages: [stage], completion_stages: ['inspect'], evidence_rules: { report: { kind: 'report', schema_id: 'report', schema_hash: 'a'.repeat(64) } } }
    assert.equal((await call('workflows', pack)).hash_format, 'kode.workflow.dependencies.v7')
    const plain = structuredClone(pack); plain.id = 'legacy'; delete plain.stages[0].execution.dependencies
    const legacy = await call('workflows', plain); plain.stages[0].execution.dependencies = []
    assert.deepEqual(await call('workflows', plain), legacy)
    assert.equal(legacy.hash_format, 'kode.workflow.execution.v3')
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await call('project-configs/method/versions/1'), row)
    assert.deepEqual(assignmentDependencies(mandate), manifest)
  } finally { await hub.close() }
})
test('dependency gaps block team activation and WorkRun creation without reserving budget', {
  skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000,
}, async () => {
  const hub = await isolatedHub('dependency-preflight')
  try {
    const call = (path, body) => hub.client.call('/api/v1/messaging/' + path, body)
    let team = await conversationTeam(hub)
    const ref = row => ({ id: row.id, version: row.version, hash: row.hash })
    const originalFlow = await call('workflows/flow/versions/1')
    const originalDelivery = await call('project-configs/delivery/versions/1')
    const budget = await call('budgets/budget'), activation = await call('teams/team/activation')
    const policy = row => ({ id: row.id, revision: row.revision, hash: row.hash })
    const instructions = 'Use only the scoped artifact capture tool.'
    for (const problem of ['missing', 'hash', 'host', 'tool', 'capability', 'network', 'valid']) {
      let reference = { id: 'missing-method', version: '1', hash: '0'.repeat(64) }
      if (problem !== 'missing') {
        const artifact = { kind: 'skill', source: 'fixture://method', source_version: '1', instructions, content_hash: sha256(instructions),
          hosts: [problem === 'host' ? 'foreign' : hub.node], tools: [problem === 'tool' ? 'ungranted_tool' : 'kode_artifact_capture'],
          capabilities: [problem === 'capability' ? 'workspace_write' : 'read'], network: problem === 'network' }
        reference = ref(await call('project-configs', { id: 'stage-method', version: problem, spec: { kind: 'workflow_dependency', artifact } }))
        if (problem === 'hash') reference.hash = '0'.repeat(64)
      }
      const pack = structuredClone(originalFlow.pack); pack.version = problem
      pack.stages[0].execution.dependencies = [reference]
      const workflow = await call('workflows', pack)
      const config = structuredClone(originalDelivery.config); config.version = problem; config.spec.workflow = ref(workflow)
      const delivery = await call('project-configs', config)
      const spec = structuredClone(team.spec); spec.workflow_pack_refs = [ref(workflow)]; spec.delivery_bindings[0].workflow = ref(workflow); spec.delivery_bindings[0].delivery_policy = ref(delivery)
      team = await call('teams', { id: 'team', request_id: problem, expected_revision: team.revision, spec })
      const check = await call(`teams/team/revisions/${team.revision}/workflow-preflight`)
      assert.equal(check.project_delivery_bindings_valid, problem === 'valid', JSON.stringify(check.binding_issues))
      if (problem !== 'valid') {
        assert.ok(check.binding_issues.some(issue => issue.code.startsWith('workflow_dependency_')))
        await assert.rejects(call('teams/team/activation', { action: 'activate', request_id: problem, expected_revision: activation.revision,
          team_revision: team.revision, grant_revision: 1, budget_policy: policy(activation.snapshot.policies.budget), scheduling_policy: policy(activation.snapshot.policies.scheduling) }), /incomplete/)
        await assert.rejects(call('work-runs', { id: 'run-' + problem, request_id: problem, team_id: 'team', team_revision: team.revision, binding_id: 'local', inputs: { request: 'Inspect' } }), /bindings are invalid/)
      }
    }
    assert.deepEqual(await call('budgets/budget'), budget)
    assert.deepEqual(await call('teams/team/activation'), activation)
  } finally { await hub.close() }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { OfficialToolPolicies } from '../src/official-grant-guard.js'
import { mountOfficialCoordinatorTools, OFFICIAL_COORDINATOR_TOOLS, OPTIONAL_COORDINATOR_TOOLS } from '../src/official-coordinator-tools.js'

test('Coordinator argument validators reject malformed input without relaxing agent authorization', async () => {
  const agent = { id: 'coordinator' }, scope = { team_id: 'team', conversation_id: 'conversation', control_revision: 1 }
  const binding = { managedOperation: { id: 'operation', attempt: 1, epoch: 1 }, managedCoordinator: scope }
  const entries = new Map(), policies = new OfficialToolPolicies()
  const tools = {
    register(value) { entries.set(value.name, value); return () => entries.delete(value.name) },
    get(name) { return entries.get(name) },
  }
  const ctx = { get: name => name === 'tools' ? { forScope: () => tools } : policies }
  let bodyCalls = 0, backendCalls = 0
  const runtime = { profiles: { binding: () => binding }, entry: { assertToolBody() { bodyCalls++ } },
    client: { call() { backendCalls++; throw Error('Malformed arguments must not reach the backend') } } }
  const allNames = [...OFFICIAL_COORDINATOR_TOOLS, ...OPTIONAL_COORDINATOR_TOOLS]
  const dispose = mountOfficialCoordinatorTools(ctx, agent, runtime, scope, allNames)
  const cases = [
    ['kode_coordinator_publish_reply', { request_id: 'reply', source_message_id: 'message', content: 'Reply' },
      [{ request_id: 'reply', source_message_id: 'message', content: null }]],
    ['kode_coordinator_workflow_start', { request_id: 'start', source_message_id: 'message', binding_id: 'local', inputs: { request: 'Implement' } },
      [{ prior_run_id: null }, { prior_run_id: '../outside' }, { inputs: { request: null } }]],
    ['kode_coordinator_configuration', { binding_id: '' }, [{ resource_after: null }, { resource_after: '../outside' }]],
    ['kode_coordinator_workflow_status', { run_id: 'run' }, [{ omit_inputs: 'yes' }, { clarification_after: null }]],
    ['kode_coordinator_answer_clarification', { request_id: 'answer', assignment_id: 'assignment', question_request_id: 'question', source_message_id: 'message' },
      [{ source_message_id: null }]],
  ]
  try {
    assert.equal(entries.size, allNames.length)
    for (const [name, valid, mutations] of cases) {
      const policy = policies.get(name, agent)
      assert.equal(typeof policy.validateArguments, 'function', name)
      assert.equal(Boolean(policy.validateArguments(valid)), true, name)
      assert.equal(Boolean(await policy.authorize({ agent, arguments: valid })), true, name)
      assert.equal(Boolean(await policy.authorize({ agent: { id: agent.id }, arguments: valid })), false,
        `${name}: a different Agent object cannot borrow this policy`)
      for (const invalid of [null, [], { ...valid, undeclared: true }, ...mutations.map(delta => ({ ...valid, ...delta }))]) {
        assert.equal(Boolean(policy.validateArguments(invalid)), false, name)
        assert.equal(Boolean(await policy.authorize({ agent, arguments: invalid })), false, name)
      }
    }
    await assert.rejects(entries.get('kode_coordinator_workflow_start').execute({ ...cases[1][1], prior_run_id: null }),
      /Invalid Coordinator workflow arguments/)
    assert.equal(bodyCalls, 1, 'the tool body still has its independent entry and argument guards')
    assert.equal(backendCalls, 0, 'invalid input never reaches a backend operation')
  } finally { dispose() }
  assert.equal(entries.size, 0)
  for (const name of allNames) assert.equal(policies.get(name, agent), undefined)
})

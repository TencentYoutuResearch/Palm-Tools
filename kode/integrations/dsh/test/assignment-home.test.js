import test from 'node:test'
import assert from 'node:assert/strict'
import { assignmentHomeCall, readAssignmentRun } from '../src/assignment-home.js'
import { admitOfficialAssignment } from '../src/official-assignment-admission.js'
const operation = { id: 'operation', attempt: 1, epoch: 1, home_node: 'home' }
const scope = { id: 'assignment', host: 'remote', worker: 'worker', operation }
const assignment = { id: scope.id, revision: 1, state: 'prepared', worker: { node_id: scope.host, session_id: scope.worker }, bundle: { operation } }
test('Assignment home routing preserves exact remote identity and never falls back after failure', async () => {
  const calls = [], signal = new AbortController().signal
  const client = { call: async (...args) => { calls.push(args); return structuredClone(assignment) } }
  assert.deepEqual(await assignmentHomeCall(client, scope, 'context', undefined, signal), assignment)
  assert.deepEqual(calls[0], ['/api/v1/messaging/operation-accounting-relay/home', {
    operation_id: 'operation', worker_session: 'worker', command: null,
    accounting: { attempt: 1, action: { kind: 'assignment_context', assignment_id: 'assignment' } },
  }, signal])
  const failed = { call: async (...args) => { calls.push(args); throw new Error('home unavailable') } }
  await assert.rejects(assignmentHomeCall(failed, scope, 'context', undefined, signal), /home unavailable/)
  assert.equal(calls.length, 2)
  for (const altered of [{ ...assignment, id: 'other' }, { ...assignment, worker: { node_id: 'home', session_id: 'worker' } }, { ...assignment, bundle: { operation: { ...operation, attempt: 2 } } }]) {
    await assert.rejects(assignmentHomeCall({ call: async () => altered }, scope, 'context'), /identity mismatch/)
  }
  await assert.rejects(assignmentHomeCall(client, { ...scope, host: undefined }, 'context'), /home scope/)
  await assert.rejects(assignmentHomeCall(client, scope, 'unknown'), /home scope/)
  assert.equal(calls.length, 2)
})
for (const mode of ['success', 'lost-response', 'wrong-receipt']) test(`remote official admission retains concrete lock ownership (${mode})`, async () => {
  let held = false, released = 0, admissions = 0
  const runtime = { host: 'remote', workspaceLocks: { acquire: async (root, owner) => {
    assert.equal(root, '/fixture'); assert.equal(owner, operation.id); held = true
    return { release: async () => { held = false; released++ } }
  } }, client: { call: async (path, body) => {
    assert.equal(path, '/api/v1/messaging/operation-accounting-relay/home')
    assert.equal(body.worker_session, 'worker')
    if (body.accounting.action.kind === 'assignment_context') return structuredClone(assignment)
    assert.equal(body.accounting.action.kind, 'assignment_admission'); assert.equal(held, true)
    admissions++
    assert.equal(body.accounting.action.admission.root, '/fixture')
    if (mode === 'lost-response') throw new Error('lost response')
    return { assignment_id: mode === 'wrong-receipt' ? 'other' : scope.id, operation_id: operation.id, worker: assignment.worker, state: 'ready' }
  } } }
  const call = () => admitOfficialAssignment(runtime, { id: 'worker' }, { managedAssignment: { id: scope.id } }, operation, ['read'],
    { profile_revision: 'revision', provider: 'fixture', model: 'model', reasoning_effort: null }, { check: async () => '/fixture' }, new AbortController().signal)
  if (mode === 'success') {
    const lease = await call(); assert.equal(held, true); assert.equal(released, 0); await lease.release()
  } else await assert.rejects(call(), /lost response|receipt mismatch/)
  assert.equal(admissions, 1); assert.equal(held, false); assert.equal(released, 1)
})

test('remote WorkRun reader rejects another run or frozen context and never falls back locally', async () => {
  const binding = { managedAssignment: { id: 'assignment' }, managedOperation: operation }
  const bound = { ...assignment, run_id: 'run', context_hash: 'context', authorization_hash: 'authority' }
  const good = { id: 'run', context_hash: 'context', authorization: { snapshot_hash: 'authority' } }
  for (const result of [good, { ...good, id: 'other' }, { ...good, context_hash: 'other' }, { ...good, authorization: {} }]) {
    let calls = 0
    const runtime = { host: 'remote', client: { call: async (path, body) => {
      calls++; assert.equal(path, '/api/v1/messaging/operation-accounting-relay/home')
      assert.deepEqual(body.accounting.action, { kind: 'assignment_run_context', assignment_id: 'assignment' })
      return result
    } } }
    const read = () => readAssignmentRun(runtime, { id: 'worker' }, binding, bound)
    if (result === good) assert.deepEqual(await read(), good)
    else await assert.rejects(read(), /WorkRun identity mismatch/)
    assert.equal(calls, 1)
  }
})

test('clarification reads and observations retain exact home relay scope', async () => {
  const calls = []
  const client = { call: async (...args) => { calls.push(args); return { clarification: null } } }
  await assignmentHomeCall(client, scope, 'clarification_read', { request_id: 'question' })
  const observation = { request_id: 'question', call_id: 'call', command: { operation }, questions: [{ id: 'scope', question: 'Scope?' }] }
  await assignmentHomeCall(client, scope, 'clarification', observation)
  assert.deepEqual(calls.map(row => row[1].accounting.action), [
    { kind: 'assignment_clarification_read', assignment_id: 'assignment', request_id: 'question' },
    { kind: 'assignment_clarification', assignment_id: 'assignment', observation },
  ])
  assert.ok(calls.every(row => row[0] === '/api/v1/messaging/operation-accounting-relay/home' && row[1].worker_session === 'worker'))
  await assert.rejects(assignmentHomeCall(client, scope, 'clarification_read', { request_id: '../foreign' }), /clarification identity/)
  const local = { ...scope, host: 'home' }
  await assignmentHomeCall(client, local, 'clarification_read', { request_id: 'question' })
  assert.equal(calls[2][0], '/api/v1/messaging/work-assignments/assignment/clarifications/question')
  assert.equal(calls[2][1], undefined)
})

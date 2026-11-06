import test from 'node:test'
import assert from 'node:assert/strict'
import { publishAssignmentOutput, readAssignmentOutputs, recordAssignmentOutputCandidate } from '../src/assignment-outputs.js'
function fixture(kind = 'review') {
  const operation = { id: 'operation', attempt: 1, epoch: 1 }
  const assignment = { id: 'assignment', run_id: 'run', stage_id: 'review', stage_attempt: 1, state: 'prepared',
    worker: { node_id: 'home', session_id: 'worker' }, context_hash: 'context', authorization_hash: 'authority', dispatch: { command: { operation, tools: ['kode_publish_output'] } } }
  let state = { bindings: { worker: { managedAssignment: { id: 'assignment' }, managedOperation: operation,
    artifactOutbox: Object.fromEntries(['one', 'two'].map((id, i) => [id, { operation, evidence: { id, payload: { kind } }, home_reconciled: true, home_sequence: i + 1 }])) } } }
  const run = { context_hash: 'context', authorization: { snapshot_hash: 'authority' }, stages: [{ stage_id: 'review', assignment_id: 'assignment', attempt: 1 }],
    context: { binding: { workflow: { pack: { stages: [{ id: 'review', produces: ['verdict'] }], evidence_rules: { verdict: { kind } } } } } } }
  const runtime = { host: 'home', tools: { assertSettled() {} }, profiles: { binding: id => state.bindings[id], update: async fn => {
    const next = structuredClone(state); fn(next); state = next
  } }, client: { call: async path => structuredClone(path.includes('work-runs') ? run : assignment) } }
  const publish = request => publishAssignmentOutput(runtime, { id: 'worker' }, runtime.profiles.binding('worker'), request, new AbortController().signal, async () => {})
  return { runtime, assignment, operation, publish }
}
test('named output publication cannot replace a published observation or cross an attempt', async () => {
  const f = fixture()
  assert.equal(readAssignmentOutputs(f.runtime, f.assignment), null)
  await f.publish({ output: 'verdict', evidence_id: 'one' })
  await assert.rejects(f.publish({ output: 'verdict', evidence_id: 'two' }), /already published/)
  assert.deepEqual(readAssignmentOutputs(f.runtime, f.assignment), { verdict: 1 })
  assert.throws(() => readAssignmentOutputs(f.runtime, { ...f.assignment, stage_attempt: 2 }), /ledger binding mismatch/)
  await f.runtime.profiles.update(state => { state.bindings.worker.artifactOutbox.one.home_reconciled = false })
  assert.throws(() => readAssignmentOutputs(f.runtime, f.assignment), /not home-reconciled/)
})
test('verification publication requires its exact archived command record, not only an observation', async () => {
  const f = fixture('verification')
  await assert.rejects(f.publish({ output: 'verdict', evidence_id: 'one' }), /verification archive unavailable/)
  await f.runtime.profiles.update(state => { state.bindings.worker.verificationRecords = { one: {
    operation: f.operation, evidence_id: 'one', home_reconciled: true, sequence: 2,
  } } })
  await assert.rejects(f.publish({ output: 'verdict', evidence_id: 'one' }), /verification archive unavailable/)
  await f.runtime.profiles.update(state => { state.bindings.worker.verificationRecords.one.sequence = 1 })
  assert.equal((await f.publish({ output: 'verdict', evidence_id: 'one' })).sequence, 1)
})

test('Host recovers only the unique output explicitly named by its trusted evidence tool', async () => {
  const f = fixture()
  await recordAssignmentOutputCandidate(f.runtime, f.assignment, ['verdict'], 'verdict', 'one')
  await recordAssignmentOutputCandidate(f.runtime, f.assignment, ['verdict'], 'verdict', 'one')
  assert.deepEqual(readAssignmentOutputs(f.runtime, f.assignment), { verdict: 1 })
  assert.equal(f.runtime.profiles.binding('worker').assignmentOutputs, undefined)
  assert.throws(() => readAssignmentOutputs(f.runtime, { ...f.assignment, stage_attempt: 2 }), /ledger binding mismatch/)
  f.runtime.tools.assertSettled = () => { throw new Error('uncertain tool outcome') }
  assert.throws(() => readAssignmentOutputs(f.runtime, f.assignment), /uncertain tool/)
})

test('competing candidates require explicit publication and never select by observation order', async () => {
  const f = fixture()
  for (const id of ['one', 'two']) await recordAssignmentOutputCandidate(f.runtime, f.assignment, ['verdict'], 'verdict', id)
  assert.equal(readAssignmentOutputs(f.runtime, f.assignment), null)
  await f.publish({ output: 'verdict', evidence_id: 'two' })
  assert.deepEqual(readAssignmentOutputs(f.runtime, f.assignment), { verdict: 2 })
})

test('candidate recovery waits for Home archival and requires output publication permission', async () => {
  const f = fixture()
  await recordAssignmentOutputCandidate(f.runtime, f.assignment, ['verdict'], 'verdict', 'one')
  await f.runtime.profiles.update(state => { state.bindings.worker.artifactOutbox.one.home_reconciled = false })
  assert.equal(readAssignmentOutputs(f.runtime, f.assignment), null)
  await f.runtime.profiles.update(state => { state.bindings.worker.artifactOutbox.one.home_reconciled = true })
  const forbidden = structuredClone(f.assignment)
  forbidden.dispatch.command.tools = []
  assert.equal(readAssignmentOutputs(f.runtime, forbidden), null)
  assert.deepEqual(readAssignmentOutputs(f.runtime, f.assignment), { verdict: 1 })
})

test('candidate recovery preserves exact verification archive checks', async () => {
  const f = fixture('verification')
  await recordAssignmentOutputCandidate(f.runtime, f.assignment, ['verdict'], 'verdict', 'one')
  assert.equal(readAssignmentOutputs(f.runtime, f.assignment), null)
  await f.runtime.profiles.update(state => { state.bindings.worker.verificationRecords = { one: {
    operation: f.operation, evidence_id: 'one', home_reconciled: true, sequence: 1,
  } } })
  assert.deepEqual(readAssignmentOutputs(f.runtime, f.assignment), { verdict: 1 })
})

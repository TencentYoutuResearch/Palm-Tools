import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProfiles } from '../src/agent-profiles.js'
import { AssignmentDispatchHost } from '../src/assignment-dispatch-host.js'
import { RemoteAssignmentService } from '../src/remote-assignment-service.js'
const operation = { id: 'op', attempt: 1, epoch: 1, home_node: 'home' }
test('remote report ambiguity persists across service reconstruction and never repeats execution', async t => {
  const root = await mkdtemp(join(tmpdir(), 'remote-lifecycle-')); t.after(() => rm(root, { recursive: true, force: true }))
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'profile', name: 'Fixture', type: 'dsh' }])
  await profiles.bind('worker', 'profile'); await profiles.patchBinding('worker', { managedAssignment: { id: 'assignment' }, managedOperation: operation })
  let reports = 0, stops = 0
  const assignment = { id: 'assignment', state: 'prepared', run_id: 'run', stage_id: 'stage', stage_attempt: 1, context_hash: 'context', authorization_hash: 'authority',
    worker: { node_id: 'remote', session_id: 'worker' }, bundle: { operation }, dispatch: { command: { operation } }, creation: { state: 'created' }, mandate: { receipt: { message_id: 'message' } } }
  const client = { async call(path, body) {
    if (path.endsWith('/delivery')) return { delivery: { phase: 'consumed', session_id: 'worker' } }
    if (body.accounting.action.kind === 'assignment_context') return structuredClone(assignment)
    assert.equal(body.accounting.action.kind, 'assignment_run_context')
    return { id: 'run', context_hash: 'context', authorization: { snapshot_hash: 'authority' }, stages: [{ stage_id: 'stage', assignment_id: 'assignment', attempt: 1, evidence: { outputs: {} } }] }
  } }
  const owned = { agent: { id: 'worker', status: 'idle' }, run: { signal: new AbortController().signal, async finish() { reports++; throw new Error('report reply lost') } } }
  const host = { execution: { host: 'remote', profiles, client }, stop: new AbortController(), handles: new Map([['worker', owned]]) }
  const dispatcher = { host, async stop() { stops++; throw new Error('unexpected stop') } }
  let service = new RemoteAssignmentService(dispatcher)
  const first = service.advance('worker'); assert.equal(service.advance('worker'), first)
  await assert.rejects(first, /report reply lost/)
  assert.equal(profiles.binding('worker').remoteLifecycle.phase, 'reporting')
  await service.close()
  host.execution.profiles = await new AgentProfiles(profiles.path).open()
  service = new RemoteAssignmentService(dispatcher); t.after(() => service.close())
  assert.equal((await service.advance('worker')).state, 'recovery_required')
  assert.equal(reports, 1); assert.equal(stops, 0)
  // A locally drained record without home acknowledgement must remain discoverable.
  await host.execution.profiles.patchBinding('worker', { operationClosed: true, assignmentStop: { state: 'drained' } })
  assignment.stop = { receipt: { state: 'execution_drained' } }
  assert.equal((await service.scan())[0].state, 'execution_drained')
  assert.equal(host.execution.profiles.binding('worker').remoteLifecycle.phase, 'acknowledged')
  assert.deepEqual(await service.scan(), [])
})

for (const runState of ['cancelling', 'taking_over']) test(`home ${runState} drains a busy fenced Worker and replays a lost stop acknowledgement after reopen`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'remote-cancellation-')); t.after(() => rm(root, { recursive: true, force: true }))
  let profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'profile', name: 'Fixture', type: 'dsh' }])
  await profiles.bind('worker', 'profile'); await profiles.patchBinding('worker', { managedAssignment: { id: 'assignment' }, managedOperation: operation })
  const command = { operation, session_id: 'worker' }
  const assignment = { id: 'assignment', run_id: 'run', context_hash: 'context', authorization_hash: 'authority', state: 'prepared',
    worker: { node_id: 'remote', session_id: 'worker' }, bundle: { operation }, dispatch: { command }, creation: { state: 'created' } }
  let drains = 0, acknowledgements = 0
  const client = { async call(path, body) {
    assert.equal(path, '/api/v1/messaging/operation-accounting-relay/home')
    const action = body.accounting.action
    if (action.kind === 'assignment_context') return structuredClone(assignment)
    if (action.kind === 'assignment_run_context') return { id: 'run', state: runState, context_hash: 'context', authorization: { snapshot_hash: 'authority' } }
    assert.equal(action.kind, 'assignment_stop')
    assert.deepEqual(action.receipt.command, command)
    assert.equal(action.receipt.final_input, undefined)
    assert.equal(action.receipt.final_artifact, undefined)
    assert.equal(profiles.binding('worker').assignmentStop.state, 'drained')
    assert.equal(host.handles.has('worker'), false)
    acknowledgements++
    if (acknowledgements === 1) throw new Error('stop acknowledgement lost')
    return { assignment_id: 'assignment', session_id: 'worker', state: 'execution_drained' }
  } }
  const fenced = new AbortController(); fenced.abort()
  const owned = { agent: { id: 'worker', status: 'running' }, run: { signal: fenced.signal, finish() { throw new Error('must not report cancelled work') } },
    async dispose() { drains++; host.handles.delete('worker') } }
  const host = { execution: { host: 'remote', profiles, client }, stop: new AbortController(), handles: new Map([['worker', owned]]) }
  const dispatcher = new AssignmentDispatchHost(host)
  let service = new RemoteAssignmentService(dispatcher)
  host.handles.delete('worker')
  assert.equal((await service.advance('worker')).state, 'cancel_unconfirmed')
  assert.equal(acknowledgements, 0)
  host.handles.set('worker', owned)
  await profiles.patchBinding('worker', { finalInput: { epoch: 1 }, finalArtifact: { epoch: 1 } })
  await assert.rejects(service.advance('worker'), /stop acknowledgement lost/)
  assert.equal(drains, 1)
  await service.close()
  profiles = await new AgentProfiles(profiles.path).open(); host.execution.profiles = profiles
  service = new RemoteAssignmentService(dispatcher)
  t.after(async () => { await service.close(); await dispatcher.close() })
  assert.equal((await service.advance('worker')).state, 'execution_drained')
  assert.equal(drains, 1); assert.equal(acknowledgements, 2)
  assert.equal(profiles.binding('worker').remoteLifecycle.phase, 'acknowledged')
  assert.deepEqual(await service.scan(), [])
})

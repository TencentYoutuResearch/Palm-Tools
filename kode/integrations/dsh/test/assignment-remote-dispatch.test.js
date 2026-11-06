import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProfiles, profileRevision } from '../src/agent-profiles.js'
import { OfficialDispatch } from '../src/official-dispatch.js'
import { AssignmentDispatchHost } from '../src/assignment-dispatch-host.js'

test('remote dispatch binds its frozen home and replays uncertain creation without a new Worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-remote-dispatch-'))
  let dispatcher
  try {
    const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'official', type: 'dsh', name: 'Official' }])
    const profile = profiles.get('official'), operation = { id: 'operation', attempt: 1, epoch: 1, home_node: 'home' }
    const command = { command_id: 'assignment', session_id: 'worker', operation, profile_revision: profileRevision(profile), provider: 'fixture', model: 'model', effort: null, cwd: root, tools: [] }
    let assignment = { id: 'assignment', run_id: 'run', stage_id: 'stage', stage_attempt: 1, context_hash: 'context', authorization_hash: 'authority', state: 'prepared', worker: { node_id: 'remote', session_id: 'worker' }, bundle: { operation },
      dispatch: { command }, candidate: { resource: { profile: 'official' } }, resources: { state: 'held' }, inputs: { binding: { sources: {} } } }
    let creates = 0, acknowledgements = 0
    const host = { ctx: { get: () => null }, execution: { host: 'remote', profiles, client: { call: async (path, body) => {
      assert.equal(path, '/api/v1/messaging/operation-accounting-relay/home')
      assert.equal(body.operation_id, operation.id); assert.equal(body.worker_session, 'worker')
      if (body.accounting.action.kind === 'assignment_context') return structuredClone(assignment)
      if (body.accounting.action.kind === 'assignment_run_context') return { id: 'run', context_hash: 'context', authorization: { snapshot_hash: 'authority' }, stages: [{ stage_id: 'stage', assignment_id: 'assignment', attempt: 1 }], context: { binding: { workflow: { pack: { stages: [{ id: 'stage', execution: { network: true } }] } } } } }
      assert.equal(body.accounting.action.kind, 'assignment_creation')
      assert.deepEqual(body.accounting.action.receipt.command, command)
      acknowledgements++
      return { state: 'uncertain', session_id: 'worker', assignment_id: 'assignment' }
    } } }, stop: new AbortController(), create: async () => { creates++; throw new Error('creation outcome unavailable') } }
    host.dispatches = new OfficialDispatch(host)
    dispatcher = new AssignmentDispatchHost(host)
    const options = { homeScope: { worker_session: 'worker', operation } }
    await assert.rejects(dispatcher.start('assignment', options), /mandate delivery adapter required/)
    for (const mode of ['no-hold', 'derived', 'wrong-home']) {
      assignment.resources.state = mode === 'no-hold' ? 'released' : 'held'
      assignment.inputs.binding.sources = mode === 'derived' ? { prior: {} } : {}
      const input = mode === 'wrong-home' ? { homeScope: { worker_session: 'worker', operation: { ...operation, epoch: 2 } } } : options
      await assert.rejects(dispatcher.dispatch('assignment', input), /resource holds|read-only offline scope|frozen home scope/)
      assert.equal(profiles.binding('worker'), undefined)
      assert.equal(creates, 0)
    }
    assignment.inputs.binding.sources = {}
    const first = dispatcher.dispatch('assignment', options)
    assert.equal(dispatcher.dispatch('assignment', options), first)
    await assert.rejects(dispatcher.dispatch('assignment', { homeScope: { worker_session: 'worker', operation: { ...operation, home_node: 'other' } } }), /pending home scope conflict/)
    await assert.rejects(first, /creation outcome unavailable/)
    assert.deepEqual(profiles.binding('worker').managedOperation, operation)
    assert.equal((await dispatcher.dispatch('assignment', options)).state, 'uncertain')
    assert.equal(creates, 1); assert.equal(acknowledgements, 2)
    const disk = await new AgentProfiles(profiles.path).open()
    assert.equal(disk.binding('worker').officialDispatch.assignment.request.operation.home_node, 'home')
  } finally { await dispatcher?.close(); await rm(root, { recursive: true, force: true }) }
})

test('remote catalog rejects foreign homes, routing identities and unordered cursors before dispatch', async () => {
  const row = { assignment_id: 'assignment', worker_session: 'worker', operation: { id: 'op', attempt: 1, epoch: 1, home_node: 'home' } }
  const good = { home_hub: 'home', execution_host: 'remote', items: [row], next_cursor: null }
  for (const page of [good, { ...good, home_hub: 'other' }, { ...good, execution_host: 'other' },
    { ...good, items: [row, row] }, { ...good, next_cursor: 'foreign' },
    { ...good, items: [{ ...row, operation: { ...row.operation, home_node: 'other' } }] }]) {
    let calls = 0
    const dispatcher = new AssignmentDispatchHost({ stop: new AbortController(), execution: { host: 'remote', client: { call: async path => {
      calls++; assert.equal(path, '/api/v1/messaging/assignment-dispatches/remote/home'); return page
    } } } })
    try {
      if (page === good) assert.deepEqual(await dispatcher.discoverRemote('home'), good)
      else await assert.rejects(dispatcher.discoverRemote('home'), /catalog.*mismatch/)
      assert.equal(calls, 1)
    } finally { await dispatcher.close() }
  }
})

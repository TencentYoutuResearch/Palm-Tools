import test from 'node:test'
import assert from 'node:assert/strict'
import { AssignmentDispatchHost } from '../src/assignment-dispatch-host.js'

function fixture(resources) {
  const operation = { id: 'operation', attempt: 1, epoch: 1, home_node: 'home' }
  const assignment = { id: 'assignment', worker: { node_id: 'remote', session_id: 'worker' }, state: 'prepared',
    bundle: { operation }, dispatch: { state: 'blocked', command: { command_id: 'assignment', session_id: 'worker', operation } },
    ...(resources === undefined ? {} : { resources }) }
  const calls = []
  const host = { execution: { host: 'remote', client: { async call(path) { calls.push(path); return assignment } } },
    stop: new AbortController(), dispatches: { get() { return undefined } }, handles: new Map() }
  return { dispatcher: new AssignmentDispatchHost(host), calls,
    options: { homeScope: { worker_session: 'worker', operation } } }
}

test('remote prepared assignment without Home resource receipt waits without creating a Worker', async () => {
  const { dispatcher, calls, options } = fixture(undefined)
  assert.deepEqual(await dispatcher.dispatch('assignment', options), { state: 'waiting_home_resources', assignment_id: 'assignment' })
  assert.equal(calls.length, 1)
})

test('remote assignment with a released Home resource receipt is rejected', async () => {
  const { dispatcher, calls, options } = fixture({ state: 'released', receipt: { state: 'released' } })
  await assert.rejects(dispatcher.dispatch('assignment', options), /Remote Assignment requires home-owned resource holds/)
  assert.equal(calls.length, 1)
})

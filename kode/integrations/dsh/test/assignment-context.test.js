import test from 'node:test'
import assert from 'node:assert/strict'
import { admitOfficialAssignment } from '../src/official-assignment-admission.js'

test('derived admission refuses resumed, seeded, populated or non-durable context before lock or Hub admission', async () => {
  for (const mode of ['resume', 'seed', 'history', 'flush-failed', 'flush-race']) {
    const operation = { id: 'operation', attempt: 1, epoch: 1 }
    const assignment = { id: 'assignment', state: 'prepared', worker: { node_id: 'host', session_id: 'worker' },
      bundle: { operation }, execution_workspace: { receipt: { snapshot_hash: 'a'.repeat(64) } }, inputs: { hash: 'b'.repeat(64) } }
    let events = mode === 'history' ? [{ type: 'user/message', data: {} }] : [], calls = 0
    const runtime = { host: 'host', client: { call: async () => { calls++; return assignment } },
      workspaceLocks: { acquire: async () => assert.fail('unclean context must not lock') },
      ctx: { get: () => ({ flush: async () => { if (mode === 'flush-race') events = [{ type: 'model/message', data: {} }]; return mode !== 'flush-failed' } }) } }
    const agent = { id: 'worker', session: { header: { id: 'worker', isSeeded: mode === 'seed' }, snapshotEvents: () => events } }
    await assert.rejects(admitOfficialAssignment(runtime, agent, { managedAssignment: { id: 'assignment' } }, operation, [], {},
      { check: async () => assert.fail('unclean context must not reach grant/lock') }, new AbortController().signal, mode !== 'resume'), /fresh empty official context|context persistence unavailable/)
    assert.equal(calls, 1, 'no Hub admission is attempted')
  }
})

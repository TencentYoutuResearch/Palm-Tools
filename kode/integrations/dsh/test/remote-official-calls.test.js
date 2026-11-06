/** Two real Hub processes; deterministic stream, no provider inference. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { isolatedHub, pairHubs } from './support/isolated-hub.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { OfficialCallOutbox } from '../src/official-call-outbox.js'
import { meterOfficialCall } from '../src/official-call-meter.js'

test('remote official evidence recovers on home and rejects foreign attempt and Worker collectors', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 40000 }, async () => {
  let home, remote
  try {
    home = await isolatedHub('official-home'); remote = await isolatedHub('official-remote'); await pairHubs(home, remote)
    const registration = await remote.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = remote.client.forSession(registration.owner_token)
    const op = await home.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'official', worker: { node_id: remote.node, session_id: 'worker' } })
    const active = (await worker.call(`/api/v1/messaging/operation-relay/${home.node}`, { operation_id: op.id, worker_session: 'worker', command: { attempt: 1, epoch: 1, expected_revision: 1, action: { kind: 'claim', lease_ms: 60000 } } })).operation
    const operation = { id: op.id, attempt: 1, epoch: active.epoch, home_node: home.node }
    const route = `/api/v1/messaging/operation-accounting-relay/${home.node}`
    const envelope = action => ({ operation_id: op.id, worker_session: 'worker', command: null, accounting: { attempt: 1, action } })
    const file = join(remote.root, 'official-profiles.json')
    const profiles = await new AgentProfiles(file).open([{ id: 'official', name: 'Fixture', type: 'dsh' }])
    await profiles.bind('worker', 'official'); await profiles.patchBinding('worker', { managedOperation: operation })
    let offline = false, dispatches = 0
    const outbox = new OfficialCallOutbox({ call: async (path, body) => {
      if (offline) throw new Error('collector offline')
      const result = await remote.client.call(path, body)
      if (body?.accounting?.action.kind === 'official_event') { offline = true; throw new Error('lost committed response') }
      return result
    } }, profiles)
    const policy = outbox.policy('worker', operation, async () => {})
    await assert.rejects(async () => {
      for await (const _ of meterOfficialCall({ sessionId: 'worker', provider: 'fixture', model: 'model' }, async function* () {
        dispatches++
        yield { type: 'usage', usage: { inputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0, outputTokens: 2 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }, policy)) {}
    }, /offline/)
    const action = { kind: 'official_read', call_id: policy.callId }
    await assert.rejects(worker.call(route, envelope(action)), /403/)
    await assert.rejects(worker.call(`/api/v1/messaging/operation-relay/${home.node}`, envelope(action)), /403/)
    await assert.rejects(remote.client.call(route, { ...envelope(action), worker_session: 'stranger' }), /foreign remote operation/)
    await assert.rejects(remote.client.call(route, { ...envelope(action), accounting: { attempt: 2, action } }), /foreign official call/)
    const other = await home.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'other', worker: { node_id: remote.node, session_id: 'worker' } })
    await assert.rejects(remote.client.call(route, { ...envelope(action), operation_id: other.id }), /foreign official call/)
    const row = profiles.binding('worker').officialCalls[policy.callId]
    await assert.rejects(remote.client.call(route, envelope({ kind: 'official_begin', request: { ...row.request, operation_id: other.id } })), /foreign official call begin/)
    await assert.rejects(home.client.call('/api/v1/messaging/official-calls', row.request), /remote/)
    await assert.rejects(remote.client.call(`/api/v1/messaging/official-calls/${policy.callId}`), /404/)
    await home.stop('SIGKILL'); await home.start()
    const reopened = await new AgentProfiles(file).open()
    await new OfficialCallOutbox(remote.client, reopened).recover()
    const saved = reopened.binding('worker').officialCalls[policy.callId]
    assert.equal(saved.home_node, home.node); assert.equal(saved.done, true); assert.equal(saved.acknowledged, 2)
    assert.equal(dispatches, 1)
    const call = await remote.client.call(route, envelope(action))
    assert.equal(call.state, 'uncertain'); assert.equal(call.sequence, 2)
    const history = await home.client.call(`/api/v1/messaging/official-calls/${policy.callId}/events?after=0`)
    assert.equal(history.events.length, 2); assert.equal(history.events[0].usage.input_tokens, 10)
  } finally { await home?.close(); await remote?.close() }
})

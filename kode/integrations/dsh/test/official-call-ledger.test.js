import { join } from 'node:path'
import { AgentProfiles } from '../src/agent-profiles.js'
import { OfficialCallOutbox } from '../src/official-call-outbox.js'
import { meterOfficialCall } from '../src/official-call-meter.js'
/** Real isolated collector API and crash recovery, without model inference. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'

test('official call API rejects Workers and preserves evidence through home restart', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let hub
  try {
    hub = await isolatedHub('official-calls')
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const op = await hub.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'call', worker: { node_id: hub.node, session_id: 'worker' } })
    const active = (await worker.call(`/api/v1/messaging/operations/${op.id}`, { attempt: 1, epoch: 1, expected_revision: 1, action: { kind: 'claim', lease_ms: 60000 } })).operation
    const request = { call_id: 'call', operation_id: op.id, attempt: 1, epoch: active.epoch, worker_session: 'worker', provider: 'fixture', model: 'model' }
    const path = '/api/v1/messaging/official-calls'
    await assert.rejects(worker.call(path, request), /403/)
    assert.equal((await hub.client.call(path, request)).duplicate, false)
    assert.equal((await hub.client.call(path, request)).duplicate, true)
    await assert.rejects(hub.client.call(path, { ...request, model: 'other' }), /identity conflict/)
    const event = { sequence: 1, kind: 'usage', usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 2, cache_write_input_tokens: 0 }, reason: 'model_not_verified' }
    for (const route of [`${path}/call`, `${path}/call/events`]) await assert.rejects(worker.call(route), /403/)
    await assert.rejects(worker.call(`${path}/call/events`, event), /403/)
    await hub.client.call(`${path}/call/events`, event)
    await hub.stop('SIGKILL'); await hub.start()
    assert.equal((await hub.client.call(`${path}/call`)).sequence, 1)
    assert.equal((await hub.client.call(`${path}/call/events`, event)).duplicate, true)
    const page = await hub.client.call(`${path}/call/events?after=0`)
    assert.equal(page.events.length, 1); assert.equal(page.cursor, 1)
    assert.equal((await hub.client.call(`${path}/call/events?after=1`)).events.length, 0)
    await hub.client.call(`${path}/call/events`, { ...event, sequence: 2, kind: 'interrupted', reason: 'collector_restarted' })
    assert.equal((await hub.client.call(`${path}/call`)).state, 'uncertain')
    await assert.rejects(hub.client.call(`${path}/call/events`, { ...event, sequence: 3 }), /terminal/)
    await assert.rejects(hub.client.call(`${path}/missing`), /404/)
    const file = join(hub.root, 'official-profiles.json')
    const profiles = await new AgentProfiles(file).open([{ id: 'official', name: 'Official fixture', type: 'dsh' }])
    await profiles.bind('worker', 'official')
    const operation = { id: op.id, attempt: 1, epoch: active.epoch }
    await profiles.patchBinding('worker', { managedOperation: operation })
    let offline = false, dispatches = 0
    const lossy = { call: async (route, body) => {
      if (offline) throw new Error('collector offline')
      const response = await hub.client.call(route, body)
      if (route.endsWith('/events')) { offline = true; throw new Error('lost committed usage response') }
      return response
    } }
    const outbox = new OfficialCallOutbox(lossy, profiles)
    const policy = outbox.policy('worker', operation, async () => {})
    const options = { sessionId: 'worker', provider: 'fixture', model: 'model' }
    await assert.rejects(async () => {
      for await (const _ of meterOfficialCall(options, async function* () {
        dispatches++
        yield { type: 'usage', usage: { inputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0, outputTokens: 2 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }, policy)) {}
    }, /offline/)
    const reopened = await new AgentProfiles(file).open()
    const recovered = new OfficialCallOutbox(hub.client, reopened)
    await recovered.recover()
    const saved = reopened.binding('worker').officialCalls[policy.callId]
    assert.equal(saved.done, true)
    assert.equal(saved.acknowledged, 2)
    assert.equal(dispatches, 1)
    const history = await hub.client.call(`${path}/${policy.callId}/events?after=0`)
    assert.equal(history.events.length, 2)
    assert.equal(history.events[0].usage.input_tokens, 10)
    assert.equal(history.events[1].kind, 'interrupted')
    assert.equal((await hub.client.call(`${path}/${policy.callId}`)).state, 'uncertain')
    const lostBegin = new OfficialCallOutbox({ call: async (route, body) => {
      await hub.client.call(route, body)
      throw new Error('lost begin response')
    } }, reopened)
    const beginPolicy = lostBegin.policy('worker', operation, async () => {})
    await assert.rejects(async () => {
      for await (const _ of meterOfficialCall(options, async function* () { dispatches++ }, beginPolicy)) {}
    }, /lost begin/)
    assert.equal(dispatches, 1, 'ambiguous begin must never dispatch')
    const restarted = new OfficialCallOutbox(hub.client, await new AgentProfiles(file).open())
    await restarted.recover()
    assert.equal((await hub.client.call(`${path}/${beginPolicy.callId}`)).state, 'uncertain')

  } finally { await hub?.close() }
})

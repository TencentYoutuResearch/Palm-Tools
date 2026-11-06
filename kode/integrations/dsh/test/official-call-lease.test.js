/** Real lease authority + official runtime; fixture waits on the exact propagated abort signal. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'
import { AgentProfiles } from '../src/agent-profiles.js'
import { OfficialCallOutbox } from '../src/official-call-outbox.js'
import { streamLeasedOfficialCall } from '../src/official-call-lease.js'
import { acquireOperationLease } from '../src/operation-lease.js'
import { isolatedHub } from './support/isolated-hub.js'

test('official call observes home cancellation while provider is blocked and does not report completion', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let hub, fiber, lease, unregister
  try {
    hub = await isolatedHub('official-lease')
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const op = await hub.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'lease', worker: { node_id: hub.node, session_id: 'worker' } })
    const operation = { id: op.id, attempt: 1, epoch: 1 }
    const profiles = await new AgentProfiles(join(hub.root, 'profiles.json')).open([{ id: 'official', name: 'Official', type: 'dsh' }])
    await profiles.bind('worker', 'official'); await profiles.patchBinding('worker', { managedOperation: operation })
    lease = await acquireOperationLease(worker, operation, { node_id: hub.node, session_id: 'worker' }, { leaseMs: 1500 })
    const outbox = new OfficialCallOutbox(hub.client, profiles)
    const policy = outbox.policy('worker', operation, async () => {})
    const ctx = new Context(); fiber = await ctx.plugin(LlmRuntime)
    let dispatches = 0, observedSignal, cancelled
    class Fixture extends LlmAdapter {
      async *stream(options) {
        dispatches++; observedSignal = options.signal
        yield { type: 'usage', usage: { inputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 } }
        cancelled = (async () => {
          const current = await hub.client.call(`/api/v1/messaging/operations/${op.id}`)
          await hub.client.call(`/api/v1/messaging/operations/${op.id}`, { attempt: current.attempt, epoch: current.epoch, expected_revision: current.revision, action: { kind: 'cancel' } })
        })()
        await cancelled
        await new Promise((_, reject) => {
          if (options.signal.aborted) return reject(options.signal.reason)
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
        })
      }
    }
    unregister = ctx.llm.registerAdapter(['fixture'], new Fixture())
    const options = Object.freeze({ sessionId: 'worker', provider: 'fixture', model: 'model', messages: [], tools: [], signal: AbortSignal.timeout(10000) })
    await assert.rejects(async () => { for await (const _ of streamLeasedOfficialCall(ctx.llm, options, lease, policy)) {} }, /lease|state changed/)
    await cancelled
    assert.equal(observedSignal.aborted, true)
    assert.equal(options.signal.aborted, false, 'caller signal is not mutated or aborted by the wrapper')
    assert.equal(dispatches, 1)
    const call = await hub.client.call(`/api/v1/messaging/official-calls/${policy.callId}`)
    assert.equal(call.state, 'uncertain')
    assert.equal(call.last.usage.input_tokens, 4)
    assert.equal((await hub.client.call(`/api/v1/messaging/operations/${op.id}`)).state, 'cancelling')
    await assert.rejects(async () => { for await (const _ of streamLeasedOfficialCall(ctx.llm, options, lease, outbox.policy('worker', operation, async () => {}))) {} }, /lease|state changed/)
    assert.equal(dispatches, 1)
  } finally { lease?.dispose(); unregister?.(); await fiber?.dispose(); await hub?.close() }
})


test('lease loss after begin is recorded as uncertain without provider dispatch', async () => {
  const events = [], signal = new AbortController().signal
  let checks = 0, dispatches = 0
  const lease = { signal, assertActive: async () => { if (++checks === 2) throw new Error('lease lost') } }
  const llm = { async *stream() { dispatches++ } }
  const policy = { callId: 'fixture', admit: async () => {}, record: async event => events.push(event) }
  await assert.rejects(async () => {
    for await (const _ of streamLeasedOfficialCall(llm, { sessionId: 'worker', provider: 'fixture', model: 'model' }, lease, policy)) {}
  }, /lease lost/)
  assert.equal(dispatches, 0)
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'interrupted')
  assert.equal(events[0].usage.reason, 'lease_lost_before_dispatch')
})

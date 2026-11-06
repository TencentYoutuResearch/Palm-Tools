import test from 'node:test'
import assert from 'node:assert/strict'
import { officialUsage, meterOfficialCall } from '../src/official-call-meter.js'
const options = { sessionId: 'session', provider: 'provider', model: 'model' }
const raw = { inputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0, outputTokens: 2, totalTokens: 12 }
const consume = async stream => { const result = []; for await (const row of stream) result.push(row); return result }

test('official usage converts disjoint counters and never treats missing cache fields as zero', () => {
  assert.deepEqual(officialUsage(raw).counters, { input_tokens: 10, cached_input_tokens: 3, output_tokens: 2 })
  assert.equal(officialUsage({ inputTokens: 7, outputTokens: 2 }).reason, 'cache_counters_unknown')
  assert.equal(officialUsage({ ...raw, totalTokens: 99 }).reason, 'inconsistent_total')
  assert.equal(officialUsage({ ...raw, cacheWriteTokens: 1, totalTokens: 13 }).reason, 'cache_write_pricing_unresolved')
})

test('admission and durable start precede provider dispatch; source and payload remain unchanged', async () => {
  const events = [], order = []
  const chunks = [{ type: 'usage', usage: raw }, { type: 'finish', reason: { kind: 'error', failure: { message: 'private' } }, replayState: { private: true } }]
  const result = await consume(meterOfficialCall({ ...options, purpose: 'compaction' }, async function* () { order.push('dispatch'); yield* chunks }, {
    callId: 'call', admit: async () => { order.push('admit') }, record: async event => { events.push(event); order.push(event.kind) },
  }))
  assert.deepEqual(order, ['admit', 'started', 'dispatch', 'usage', 'finished'])
  assert.deepEqual(result, chunks)
  assert.equal(events.at(-1).usage.counters.input_tokens, 10, 'failed calls retain usage')
  assert.equal(events.at(-1).purpose, 'compaction')
  assert.ok(!JSON.stringify(events).includes('private'))
  assert.ok(events.every(row => row.billing_eligible === false))
})

test('denied admission or failed start persistence never invokes provider', async () => {
  for (const stage of ['admit', 'record']) {
    let dispatched = false
    const reject = async () => { throw new Error('denied') }
    await assert.rejects(consume(meterOfficialCall(options, async function* () { dispatched = true }, { admit: stage === 'admit' ? reject : async () => {}, record: stage === 'record' ? reject : async () => {} })), /denied/)
    assert.equal(dispatched, false)
  }
})

test('multiple usage snapshots replace rather than add and regression remains unverifiable', async () => {
  const events = []
  await consume(meterOfficialCall(options, async function* () {
    yield { type: 'usage', usage: raw }
    yield { type: 'usage', usage: { ...raw, inputTokens: 8, totalTokens: 13 } }
    yield { type: 'usage', usage: raw }
    yield { type: 'usage', usage: { ...raw, inputTokens: 9, totalTokens: 14 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }, { admit: async () => {}, record: async event => events.push(event) }))
  assert.equal(events[2].usage.counters.input_tokens, 11)
  assert.equal(events.at(-1).usage.reason, 'counter_regression')
})

test('consumer cancellation and source failure preserve uncertain usage without replay', async () => {
  const events = []
  let calls = 0
  const stream = meterOfficialCall(options, async function* () { calls++; yield { type: 'usage', usage: raw }; throw new Error('provider failed') }, { admit: async () => {}, record: async event => events.push(event) })
  await assert.rejects(consume(stream), /provider failed/)
  assert.equal(calls, 1)
  assert.equal(events.at(-1).kind, 'interrupted')
  assert.equal(events.at(-1).usage.counters.output_tokens, 2)
  const stopped = []
  for await (const _ of meterOfficialCall(options, async function* () { yield { type: 'text-delta', text: 'private' } }, { admit: async () => {}, record: async row => stopped.push(row) })) break
  assert.equal(stopped.at(-1).outcome, 'uncertain')
})

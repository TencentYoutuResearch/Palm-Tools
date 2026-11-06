/** Actual Cordis waterfall and dsh LlmRuntime with an isolated no-network adapter. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { registerOfficialCallMeter } from '../src/official-call-meter.js'
const consume = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }

test('actual official runtime intercepts managed calls before model resolution and retains failed-call usage', async () => {
  const ctx = new Context(), fiber = await ctx.plugin(LlmRuntime)
  const events = [], trace = []
  let deny = false
  class Fixture extends LlmAdapter {
    async resolveModel(...args) { trace.push('resolve'); return super.resolveModel(...args) }
    async *stream() {
      trace.push('dispatch')
      yield { type: 'usage', usage: { inputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 1, totalTokens: 7 } }
      throw new Error('fixture provider failure')
    }
  }
  const unregister = ctx.llm.registerAdapter(['fixture'], new Fixture())
  const detach = registerOfficialCallMeter(ctx, async identity => identity.session_id === 'ordinary' ? null : {
    admit: async () => { trace.push('admit'); if (deny) throw new Error('budget refused') },
    record: async event => { events.push(event); trace.push(event.kind) },
  })
  try {
    const options = { sessionId: 'managed', provider: 'fixture', model: 'model', messages: [], tools: [] }
    const output = await consume(ctx.llm.stream(options))
    assert.deepEqual(trace.slice(0, 4), ['admit', 'started', 'resolve', 'dispatch'])
    assert.equal(output.at(-1).reason.kind, 'error')
    assert.equal(events.at(-1).finish_reason, 'error')
    assert.equal(events.at(-1).usage.counters.input_tokens, 6)
    const firstCall = events[0].call_id
    trace.length = 0
    await consume(ctx.llm.stream({ ...options, purpose: 'session-title' }))
    assert.notEqual(events.at(-1).call_id, firstCall)
    assert.equal(events.at(-1).purpose, 'session-title')
    deny = true; trace.length = 0
    await assert.rejects(consume(ctx.llm.stream(options)), /budget refused/)
    assert.deepEqual(trace, ['admit'])
    const count = events.length
    await consume(ctx.llm.stream({ ...options, sessionId: 'ordinary' }))
    assert.equal(events.length, count)
  } finally { detach(); unregister(); await fiber.dispose() }
})

test('missing managed policy fails closed and detached middleware restores ordinary behavior', async () => {
  const ctx = new Context(), fiber = await ctx.plugin(LlmRuntime)
  let calls = 0
  class Fixture extends LlmAdapter { async *stream() { calls++; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const unregister = ctx.llm.registerAdapter(['fixture'], new Fixture())
  const detach = registerOfficialCallMeter(ctx, async () => undefined)
  try {
    const options = { sessionId: 'managed', provider: 'fixture', model: 'model', messages: [], tools: [] }
    await assert.rejects(consume(ctx.llm.stream(options)), /policy unavailable/)
    assert.equal(calls, 0)
    detach()
    await consume(ctx.llm.stream(options))
    assert.equal(calls, 1)
  } finally { unregister(); await fiber.dispose() }
})

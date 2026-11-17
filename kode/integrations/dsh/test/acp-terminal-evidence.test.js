import test from 'node:test'
import assert from 'node:assert/strict'
import { AcpSession, acpTerminalUsage } from '../src/acp-session.js'
const usage = { inputTokens: 10, outputTokens: 5, cachedReadTokens: 3, cachedWriteTokens: 2, totalTokens: 20 }
const result = { stopReason: 'end_turn', usage, _meta: { quota: { model_usage: [{ model: 'fixture-model', token_count: { inputTokens: 20, outputTokens: 5, cachedInputTokens: 3, cachedWriteTokens: 2, totalTokens: 30 } }] } } }
test('terminal counters retain distinct cumulative main/model scopes without billing upgrade', () => {
  const out = acpTerminalUsage(result, { threadId: 'a', turnId: 'b', promptId: 'p' })
  assert.equal(out.main_loop_total.input_tokens, 15)
  assert.equal(out.model_totals[0].counters.input_tokens, 25)
  assert.equal(out.billing_eligible, false)
  assert.equal(out.status, 'unresolved')
  assert.equal(acpTerminalUsage({ usage: { ...usage, cachedWriteTokens: undefined } }, {}).main_loop_total, null)
  assert.equal(acpTerminalUsage({ usage: { ...usage, totalTokens: 99 } }, {}).main_loop_total, null)
})
test('prompt-owned cancellation evidence survives; replaced or late prompt cannot enter another turn', async () => {
  for (const mode of ['cancel', 'replaced', 'late', 'steer']) {
    const s = new AcpSession({ type: 'claude' }, '/fixture'), d = Promise.withResolvers(), events = []
    s.threadId = 'owned'; s.request = () => d.promise
    const active = { turnId: 'turn', signal: new AbortController().signal, push: e => events.push(e), end: e => { active.done = true; active.error = e } }
    s.active = active; s.startPrompt(active, [])
    if (mode === 'replaced') active.prompt = {}
    if (mode === 'late') s.active = { turnId: 'other' }
    if (mode === 'steer') active.restarting = true
    d.resolve({ ...result, stopReason: 'cancelled' }); await Promise.all([...s.requests])
    assert.equal(events.length, ['cancel', 'steer'].includes(mode) ? 1 : 0)
    if (events.length) { assert.equal(events[0].params.turnId, 'turn'); assert.equal(events[0].params.stop_reason, 'cancelled') }
  }
})

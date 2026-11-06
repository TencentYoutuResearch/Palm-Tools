import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { CodexSession } from '../src/codex-session.js'
import { usageCounters, turnUsage, zeroUsage } from '../src/native-usage.js'
const raw = { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, cacheWriteInputTokens: 0 }
test('usage deltas preserve missing baselines, invalid counts and unresolved cost components', () => {
  const total = usageCounters(raw)
  assert.equal(usageCounters({ ...raw, inputTokens: -1 }), null)
  assert.equal(usageCounters({ ...raw, cachedInputTokens: 11 }), null)
  assert.equal(turnUsage(null, total).reason, 'missing_pre_turn_baseline')
  assert.equal(turnUsage(total, zeroUsage()).reason, 'counter_reset_or_regression')
  assert.deepEqual(turnUsage(zeroUsage(), total).counters, { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 })
  assert.equal(turnUsage(zeroUsage(), total).billing_eligible, false)
  assert.equal(turnUsage(zeroUsage(), total).event_id, turnUsage(zeroUsage(), total).event_id)
  assert.equal(turnUsage(zeroUsage(), usageCounters({ ...raw, cacheWriteInputTokens: undefined })).reason, 'cache_write_pricing_unresolved')
  assert.equal(turnUsage(zeroUsage(), total, { rerouted: true }).reason, 'model_rerouted_during_turn')
})

test('spawned Codex fixture reports per-turn deltas without foreign/history double counting', async () => {
  const profile = { executable: process.execPath, args: [fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))], env: { KODE_FIXTURE_USAGE: '1', KODE_FIXTURE_SELECTION_REROUTE: '1' } }
  const session = new CodexSession(profile, process.cwd())
  const run = async (runtime, text) => { const events = []; for await (const e of runtime.turn([{ type: 'text', text }], { model: 'fixture', signal: AbortSignal.timeout(3000) })) events.push(e); return events.filter(e => e.method === 'kode/usage_observation') }
  let resumed
  try {
    await session.open({}, [], AbortSignal.timeout(3000))
    const first = await run(session, 'first'), second = await run(session, 'REROUTE')
    assert.equal(first.at(-1).params.counters.input_tokens, 10)
    assert.equal(first.at(-1).params.reason, 'model_not_verified')
    assert.equal(second.at(-1).params.counters.input_tokens, 10)
    assert.equal(second.at(-1).params.reason, 'model_rerouted_during_turn')
    assert.equal(second.at(-1).params.turn_ended, true)
    resumed = new CodexSession(profile, process.cwd())
    await resumed.open({ threadId: session.threadId }, [], AbortSignal.timeout(3000))
    const existing = await run(resumed, 'existing history')
    assert.equal(existing.at(-1).params.reason, 'missing_pre_turn_baseline')
    assert.equal(existing.at(-1).params.counters, undefined)
  } finally { await session.close(); await resumed?.close() }
})

test('internal requested-model policy never upgrades provider evidence or admits reroutes', async () => {
  const { requestedModelAccounting } = await import('../src/native-usage.js')
  const observation = turnUsage(zeroUsage(), usageCounters(raw), { model: 'fixture' })
  const price = { model: 'fixture', model_policy: 'requested_model' }
  assert.equal(requestedModelAccounting(observation, {}).eligible, false)
  const result = requestedModelAccounting(observation, price)
  assert.equal(result.eligible, true)
  assert.equal(result.estimated, true)
  assert.equal(result.attribution.kind, 'requested_model')
  assert.equal(observation.model_verification, 'unverifiable')
  assert.equal(observation.billing_eligible, false)
  for (const invalid of [
    { ...observation, reason: 'model_rerouted_during_turn' },
    { ...observation, cache_write_input_tokens: null },
    { ...observation, cache_write_input_tokens: 1 },
    { ...observation, requested_model: 'other' },
    { ...observation, status: 'unverifiable' },
    { ...observation, counters: { ...observation.counters, input_tokens: NaN } },
  ]) assert.equal(requestedModelAccounting(invalid, price).eligible, false)
})

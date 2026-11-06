import { createHash } from 'node:crypto'
/** Cumulative thread counters are evidence; only differences from an owned baseline belong to a turn. */
export function usageCounters(raw) {
  const fields = { input_tokens: 'inputTokens', cached_input_tokens: 'cachedInputTokens', output_tokens: 'outputTokens' }
  const value = {}
  for (const [key, field] of Object.entries(fields)) {
    if (!Number.isSafeInteger(raw?.[field]) || raw[field] < 0 || raw[field] > 1_000_000_000_000) return null
    value[key] = raw[field]
  }
  if (value.cached_input_tokens > value.input_tokens) return null
  value.cache_write_input_tokens = Number.isSafeInteger(raw.cacheWriteInputTokens) && raw.cacheWriteInputTokens >= 0 ? raw.cacheWriteInputTokens : null
  return value
}
export function turnUsage(baseline, total, { threadId, turnId, model, rerouted = false } = {}) {
  const event_id = `usage-${createHash('sha256').update(JSON.stringify({ threadId, turnId, model, baseline, total, rerouted })).digest('hex')}`
  const base = { event_id, source: 'codex_thread_token_usage', thread_id: threadId, turn_id: turnId, requested_model: model ?? null, model_verification: 'unverifiable', observed_at_ms: Date.now(), billing_eligible: false }
  if (!total) return { ...base, status: 'unverifiable', reason: 'invalid_or_missing_counters' }
  if (!baseline) return { ...base, status: 'unverifiable', reason: 'missing_pre_turn_baseline', thread_total: total }
  const counters = {}
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens']) {
    counters[key] = total[key] - baseline[key]
    if (counters[key] < 0) return { ...base, status: 'unverifiable', reason: 'counter_reset_or_regression', thread_total: total }
  }
  if (counters.cached_input_tokens > counters.input_tokens) return { ...base, status: 'unverifiable', reason: 'inconsistent_cache_counters', thread_total: total }
  const cacheWrite = total.cache_write_input_tokens !== null && baseline.cache_write_input_tokens !== null ? total.cache_write_input_tokens - baseline.cache_write_input_tokens : null
  return { ...base, status: 'reported', counters, cache_write_input_tokens: cacheWrite, thread_total: total,
    reason: rerouted ? 'model_rerouted_during_turn' : cacheWrite === null || cacheWrite !== 0 ? 'cache_write_pricing_unresolved' : 'model_not_verified' }
}
export const zeroUsage = () => ({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, cache_write_input_tokens: 0 })

/** Apply only an owner-frozen internal price policy; never upgrade model verification. */
export function requestedModelAccounting(observation, price) {
  if (price?.model_policy !== 'requested_model') return { eligible: false, reason: 'requested_model_policy_required' }
  if (observation?.status !== 'reported' || observation.reason !== 'model_not_verified' ||
      observation.cache_write_input_tokens !== 0 || !observation.requested_model ||
      observation.requested_model !== price.model) return { eligible: false, reason: 'usage_attribution_unresolved' }
  const counters = observation.counters
  if (!counters || !['input_tokens', 'cached_input_tokens', 'output_tokens'].every(key =>
    Number.isSafeInteger(counters[key]) && counters[key] >= 0 && counters[key] <= 1_000_000_000_000) ||
    counters.cached_input_tokens > counters.input_tokens) return { eligible: false, reason: 'invalid_counters' }
  return { eligible: true, estimated: true, model: observation.requested_model,
    attribution: { kind: 'requested_model', rerouted: false, cache_write_input_tokens: 0 },
    counters: { input_tokens: counters.input_tokens, cached_input_tokens: counters.cached_input_tokens, output_tokens: counters.output_tokens } }
}

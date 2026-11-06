/** llm/stream boundary. Hooks must supply durable records and authoritative admission. */
import { randomUUID } from 'node:crypto'
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000
export function officialUsage(raw) {
  if (!count(raw?.inputTokens) || !count(raw?.outputTokens)) return { status: 'unverifiable', reason: 'invalid_or_missing_counters' }
  if (!count(raw.cacheReadTokens) || !count(raw.cacheWriteTokens)) return { status: 'unverifiable', reason: 'cache_counters_unknown' }
  const totalInput = raw.inputTokens + raw.cacheReadTokens + raw.cacheWriteTokens
  if (!count(totalInput) || (raw.totalTokens !== undefined && (!count(raw.totalTokens) || raw.totalTokens !== totalInput + raw.outputTokens))) return { status: 'unverifiable', reason: 'inconsistent_total' }
  return { status: 'reported', counters: { input_tokens: totalInput, cached_input_tokens: raw.cacheReadTokens, output_tokens: raw.outputTokens },
    cache_write_input_tokens: raw.cacheWriteTokens, reason: raw.cacheWriteTokens ? 'cache_write_pricing_unresolved' : 'model_not_verified' }
}

export async function* meterOfficialCall(options, next, { admit, record, callId = randomUUID() }) {
  if (!options.sessionId || !options.provider || !options.model || typeof admit !== 'function' || typeof record !== 'function') throw new Error('Managed official call requires identity, admission and durable recording')
  const identity = { call_id: callId, session_id: options.sessionId, provider: options.provider, requested_model: options.model,
    purpose: ['compaction', 'session-title'].includes(options.purpose) ? options.purpose : 'conversation', source: 'dsh_llm_stream', model_verification: 'unverifiable', billing_eligible: false }
  let sequence = 0, started = false, terminal = false, usage = { status: 'unverifiable', reason: 'missing_usage' }, previous
  const persist = (kind, details = {}) => record({ ...identity, event_id: `${callId}:${++sequence}`, kind, ...details })
  options.signal?.throwIfAborted()
  await admit(identity)
  options.signal?.throwIfAborted()
  await persist('started')
  started = true
  try {
    for await (const chunk of next()) {
      options.signal?.throwIfAborted()
      if (chunk.type === 'usage') {
        const incoming = officialUsage(chunk.usage)
        if (incoming.status === 'reported' && previous && ['input_tokens', 'cached_input_tokens', 'output_tokens'].some(key => incoming.counters[key] < previous[key])) {
          usage = { status: 'unverifiable', reason: 'counter_regression' }
        } else if (usage.reason !== 'counter_regression') {
          usage = incoming
          if (incoming.status === 'reported') previous = incoming.counters
        }
        await persist('usage', { usage })
      }
      if (chunk.type === 'finish') {
        const reason = ['stop', 'tool-calls', 'max-tokens', 'aborted', 'error'].includes(chunk.reason?.kind) ? chunk.reason.kind : 'unknown'
        await persist('finished', { finish_reason: reason, usage })
        terminal = true
        yield chunk
        return
      }
      yield chunk
    }
  } finally {
    if (started && !terminal) await persist('interrupted', { usage, outcome: 'uncertain' })
  }
}

/** Resolve policy at iteration time; null explicitly denotes an unmanaged call. */
export function registerOfficialCallMeter(ctx, resolvePolicy) {
  return ctx.on('llm/stream', (options, next) => (async function* () {
    const policy = await resolvePolicy({ session_id: options.sessionId ?? null, provider: options.provider, model: options.model, purpose: options.purpose ?? 'conversation' })
    if (policy === null) { yield* next(); return }
    if (!policy || typeof policy.admit !== 'function' || typeof policy.record !== 'function') throw new Error('Official call policy unavailable')
    yield* meterOfficialCall(options, next, policy)
  })())
}

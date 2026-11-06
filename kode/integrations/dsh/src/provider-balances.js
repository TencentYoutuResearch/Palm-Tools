/** Read-only provider facts, separate from percentage windows and team budgets.
 * The Host supplies an authorized transport; this module never loads credentials.
 */
import { createHash } from 'node:crypto'

export const BALANCE_ENDPOINTS = Object.freeze({
  deepseek_balance: 'https://api.deepseek.com/user/balance',
  openrouter_key: 'https://openrouter.ai/api/v1/key',
  openrouter_credits: 'https://openrouter.ai/api/v1/credits',
})
const fail = () => { throw new Error('invalid_provider_balance') }
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : fail()
// Keep decimal money in strings. Do not round it through binary arithmetic.
function money(value, nullable = false) {
  if (value === null && nullable) return null
  if (!['string', 'number'].includes(typeof value)) return fail()
  const text = String(value)
  if (!/^-?\d{1,18}(\.\d{1,12})?$/.test(text)) return fail()
  return text
}
function subtract(a, b) {
  const parts = value => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole + fraction.padEnd(12, '0')) }
  const result = parts(a) - parts(b), negative = result < 0n, digits = (negative ? -result : result).toString().padStart(13, '0')
  return `${negative ? '-' : ''}${digits.slice(0, -12)}.${digits.slice(-12)}`
}
const nonpositive = value => value !== null && (value.startsWith('-') || /^0+(\.0+)?$/.test(value))
function time(value) {
  if (value == null) return null
  if (typeof value !== 'string' || !/Z$/.test(value)) return fail()
  const parsed = Date.parse(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fail()
}
function windowReset(interval, at) {
  if (interval == null) return null
  const date = new Date(at)
  date.setUTCHours(0, 0, 0, 0)
  if (interval === 'daily') date.setUTCDate(date.getUTCDate() + 1)
  else if (interval === 'weekly') date.setUTCDate(date.getUTCDate() + (8 - (date.getUTCDay() || 7)))
  else if (interval === 'monthly') date.setUTCMonth(date.getUTCMonth() + 1, 1)
  else return fail()
  return date.getTime()
}
function budget(input, effective = false) {
  const row = object(input)
  if (!['member', 'organization', 'workspace', 'key', 'guardrail'].includes(row.scope) || typeof row.include_byok !== 'boolean') return fail()
  const identity = row.budget_id ?? row.guardrail_id
  if (typeof identity !== 'string' || !identity || identity.length > 256) return fail()
  const remaining = money(row.remaining_usd, true)
  return { limit_id: `${effective ? 'effective' : 'budget'}:${createHash('sha256').update(`${row.scope}:${identity}`).digest('hex')}`,
    kind: 'organization_budget', scope: row.scope, unit: 'usd', remaining, limit: money(row.limit_usd, true),
    used: money(row.spend_usd, true), include_byok: row.include_byok, resets_at_ms: time(row.resets_at),
    reached: remaining === null ? null : nonpositive(remaining), quality: 'reported' }
}

export function parseProviderBalance(source, body, observedAt, ttlMs = 60000) {
  if (!Object.hasOwn(BALANCE_ENDPOINTS, source) || !Number.isSafeInteger(observedAt) || observedAt < 0
      || !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 900000 || !Number.isSafeInteger(observedAt + ttlMs)) return fail()
  const root = object(body), limits = []
  let providerAvailable = null, completeness = 'partial', expiresAt = null
  if (source === 'deepseek_balance') {
    if (typeof root.is_available !== 'boolean' || !Array.isArray(root.balance_infos) || !root.balance_infos.length || root.balance_infos.length > 2) return fail()
    providerAvailable = root.is_available
    for (const info of root.balance_infos) {
      if (!['USD', 'CNY'].includes(info.currency)) return fail()
      limits.push({ limit_id: `balance:${info.currency}`, kind: 'balance', scope: 'account', unit: info.currency.toLowerCase(),
        remaining: money(info.total_balance), granted: money(info.granted_balance), topped_up: money(info.topped_up_balance),
        limit: null, used: null, reached: nonpositive(money(info.total_balance)), resets_at_ms: null, quality: 'reported' })
    }
    completeness = 'complete_for_endpoint'
  } else if (source === 'openrouter_credits') {
    const data = object(root.data), total = money(data.total_credits), used = money(data.total_usage)
    const remaining = subtract(total, used)
    limits.push({ limit_id: 'account_credits', kind: 'balance', scope: 'account', unit: 'usd', remaining,
      purchased: total, used, limit: null, reached: nonpositive(remaining), resets_at_ms: null, quality: 'derived' })
    completeness = 'complete_for_endpoint'
  } else {
    const data = object(root.data), remaining = money(data.limit_remaining, true), cap = money(data.limit, true)
    if (typeof data.include_byok_in_limit !== 'boolean') return fail()
    limits.push({ limit_id: 'key_cap', kind: 'key_cap', scope: 'key', unit: 'usd', remaining, limit: cap,
      unlimited: cap === null, used: money(data.usage), usage_scope: 'all_time', include_byok: data.include_byok_in_limit,
      reached: remaining === null ? null : nonpositive(remaining), resets_at_ms: windowReset(data.limit_reset, observedAt),
      reset_quality: data.limit_reset == null ? 'not_applicable' : 'derived_from_provider_utc_schedule', quality: 'reported' })
    if (data.budgets !== undefined) {
      if (!Array.isArray(data.budgets) || data.budgets.length > 64) return fail()
      limits.push(...data.budgets.map(item => budget(item)))
      completeness = 'complete_for_endpoint'
    }
    if (data.effective_budget != null) limits.push(budget(data.effective_budget, true))
    if (data.free_model_daily_requests != null) {
      const free = object(data.free_model_daily_requests)
      if (![free.limit, free.remaining, free.used].every(value => Number.isSafeInteger(value) && value >= 0)) return fail()
      limits.push({ limit_id: 'free_model_daily_requests', kind: 'usage_window', scope: 'free_models', unit: 'requests',
        remaining: free.remaining, limit: free.limit, used: free.used, reached: free.remaining === 0,
        resets_at_ms: null, quality: 'reported' })
    } else completeness = 'partial'
    expiresAt = time(data.expires_at)
    if (expiresAt !== null && expiresAt <= observedAt) providerAvailable = false
  }
  if (new Set(limits.map(row => row.limit_id)).size !== limits.length) return fail()
  return { source, source_version: '2026-11-02', observed_at_ms: observedAt, valid_until_ms: expiresAt !== null && expiresAt > observedAt ? Math.min(expiresAt, observedAt + ttlMs) : observedAt + ttlMs,
    provider_available: providerAvailable, completeness, limits, account_identity: 'requires_host_binding',
    limitations: ['not_team_budget', 'endpoint_scope_is_not_all_provider_limits', 'independent_currencies_not_summed'] }
}

async function readJson(response) {
  const reader = response.body?.getReader()
  if (!reader) return fail()
  const chunks = []; let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > 65536) return fail()
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Explicit polling only. Host must bind identity/epoch before publishing returned facts. */
export class ProviderBalanceCollector {
  constructor({ source, authorizedFetch, ttlMs = 60000, clock = Date.now }) {
    if (!Object.hasOwn(BALANCE_ENDPOINTS, source) || typeof authorizedFetch !== 'function' || !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 900000) throw new Error('invalid balance collector configuration')
    this.source = source; this.fetch = authorizedFetch; this.ttlMs = ttlMs; this.clock = clock
    this.nextAt = 0; this.failures = 0; this.running = null
  }
  poll(signal) {
    if (this.running) return this.running
    if (this.clock() < this.nextAt) return Promise.resolve({ status: 'backoff', retry_at_ms: this.nextAt })
    this.running = this.collect(signal).finally(() => { this.running = null })
    return this.running
  }
  async collect(signal) {
    const at = this.clock(), url = BALANCE_ENDPOINTS[this.source]
    const abort = AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])])
    let status = 'unavailable', retryMs = 0
    try {
      abort.throwIfAborted()
      const response = await this.fetch(url, { method: 'GET', redirect: 'error', signal: abort })
      if (response.redirected || (response.url && response.url !== url)) throw new Error('unexpected_response_origin')
      if (response.status === 200) {
        const sample = parseProviderBalance(this.source, await readJson(response), at, this.ttlMs)
        this.failures = 0; this.nextAt = this.clock() + this.ttlMs
        return { status: 'reported', sample }
      }
      status = response.status === 401 || response.status === 403 ? 'authentication_unavailable'
        : response.status === 429 ? 'rate_limited' : response.status === 402 ? 'provider_payment_required' : 'unavailable'
      const retry = response.headers.get('retry-after')
      if (retry && /^\d+$/.test(retry)) retryMs = Math.min(Number(retry) * 1000, 3600000)
      // Never parse or return provider error bodies: they may contain credential material.
      await response.body?.cancel()
    } catch { status = abort.aborted ? 'cancelled_or_timed_out' : 'unavailable' }
    this.failures++
    this.nextAt = this.clock() + Math.max(retryMs, Math.min(300000, 1000 * 2 ** Math.min(this.failures, 9)))
    return { status, source: this.source, observed_at_ms: at, retry_at_ms: this.nextAt }
  }
}

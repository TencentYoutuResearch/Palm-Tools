/** Allowlisted executor observations, not account identity or a spendable team budget. */
const finite = value => typeof value === 'number' && Number.isFinite(value)
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null
export function quotaObservation(payload, now = Date.now()) {
  const map = payload?.rateLimitsByLimitId
  const entries = map && typeof map === 'object' && !Array.isArray(map) ? Object.entries(map) : [[payload?.rateLimits?.limitId ?? 'unspecified', payload?.rateLimits]]
  const buckets = []
  for (const [key, value] of entries.slice(0, 128)) {
    if (!value || typeof value !== 'object' || !id(key)) continue
    const windows = ['primary', 'secondary'].map(window_id => {
      const row = value[window_id]
      const used_percent = finite(row?.usedPercent) && row.usedPercent >= 0 && row.usedPercent <= 100 ? row.usedPercent : null
      const resets_at_ms = Number.isSafeInteger(row?.resetsAt) && row.resetsAt >= 0 && Number.isSafeInteger(row.resetsAt * 1000) ? row.resetsAt * 1000 : null
      const window_minutes = Number.isSafeInteger(row?.windowDurationMins) && row.windowDurationMins > 0 ? row.windowDurationMins : null
      return { window_id, used_percent, resets_at_ms, window_minutes, reached: used_percent === null ? null : used_percent >= 100, completeness: used_percent !== null && resets_at_ms !== null && window_minutes !== null ? 'complete' : 'partial' }
    })
    buckets.push({ limit_id: id(value.limitId) ?? key, windows, observed_at_ms: now, valid_until_ms: now + 900000 })
  }
  return { source: 'codex_app_server', source_version: 1, account_binding: 'unbound', observed_at_ms: now, status: buckets.length ? 'reported' : 'unavailable', truncated: entries.length > 128, buckets }
}
export function quotaWindowState(window, bucket, now = Date.now()) {
  if (window.resets_at_ms !== null && now >= window.resets_at_ms) return 'reset_passed'
  if (now >= bucket.valid_until_ms) return 'stale'
  return window.completeness === 'complete' ? 'reported' : 'unknown'
}

/** Updates are bucket snapshots. Retained buckets keep their original expiry. */
export function mergeQuotaObservation(previous, incoming) {
  if (!previous || incoming.status !== 'reported') return incoming
  const buckets = new Map(previous.buckets.map(bucket => [bucket.limit_id, bucket]))
  for (const bucket of incoming.buckets) {
    const prior = buckets.get(bucket.limit_id)
    if (!prior || bucket.observed_at_ms >= prior.observed_at_ms) buckets.set(bucket.limit_id, bucket)
  }
  const rows = [...buckets.values()].sort((a, b) => b.observed_at_ms - a.observed_at_ms)
  return { ...incoming, observed_at_ms: Math.max(previous.observed_at_ms, incoming.observed_at_ms), buckets: rows.slice(0, 128), truncated: rows.length > 128 || previous.truncated === true || incoming.truncated === true }
}
export function quotaView(observation, now = Date.now()) {
  if (!observation) return { status: 'unavailable', account_binding: 'unbound', eligible_for_dispatch: false, buckets: [] }
  const buckets = observation.buckets.map(bucket => ({ ...bucket, windows: bucket.windows.map(window => ({ ...window, freshness: quotaWindowState(window, bucket, now) })) }))
  return { ...observation, buckets, eligible_for_dispatch: false, eligibility_reason: 'Account binding and admission policy are not established' }
}

/** Home-scoped durable invalidations. Frozen operation attempts make replay idempotent. */
function compactAcknowledged(rows) {
  const watermarks = new Map()
  for (const row of rows) {
    if (!row.reconciled) continue
    const key = JSON.stringify([row.home, row.profile])
    if (!watermarks.has(key) || watermarks.get(key).revision < row.revision) watermarks.set(key, row)
  }
  // Pending attempts must retain their original authority and may never be evicted.
  return [...rows.filter(row => !row.reconciled), ...watermarks.values()]
}
export class RemoteQuotaInvalidations {
  constructor(client, profiles) {
    this.client = client; this.profiles = profiles
    this.stop = new AbortController(); this.cursor = 0
  }
  pending() {
    return Object.entries(this.profiles.bindings).flatMap(([session, binding]) =>
      (binding.remoteQuotaFences ?? []).filter(row => !row.reconciled).map(row => ({ session, ...row })))
  }
  async record(session, profile, home, operation, revision) {
    if (!home || !operation?.id || !Number.isSafeInteger(operation.attempt) || operation.attempt < 1 || !Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid remote quota fence')
    await this.profiles.update(state => {
      const binding = state.bindings[session]
      if (!binding || binding.profile.id !== profile) throw new Error('Remote quota fence profile mismatch')
      const rows = binding.remoteQuotaFences = compactAcknowledged(binding.remoteQuotaFences ?? [])
      if (!rows.some(row => row.home === home && row.operation_id === operation.id && row.attempt === operation.attempt && row.revision === revision)) {
        rows.push({ home, profile, operation_id: operation.id, attempt: operation.attempt, revision, reconciled: false })
      }
    })
  }
  fence(home, profile) {
    return Math.max(0, ...Object.values(this.profiles.bindings).flatMap(binding =>
      (binding.remoteQuotaFences ?? []).filter(row => row.home === home && row.profile === profile).map(row => row.revision)))
  }
  tick() {
    if (this.running) return this.running
    if (this.stop.signal.aborted || !this.client) return Promise.resolve()
    this.running = this.replay().finally(() => { this.running = undefined })
    return this.running
  }
  async replay() {
    const rows = this.pending()
    if (!rows.length) return
    const start = this.cursor % rows.length, count = Math.min(16, rows.length)
    this.cursor = (start + count) % rows.length
    for (let i = 0; i < count && !this.stop.signal.aborted; i++) {
      const row = rows[(start + i) % rows.length]
      try {
        const call = kind => this.client.call(`/api/v1/messaging/operation-accounting-relay/${encodeURIComponent(row.home)}`, {
          operation_id: row.operation_id, worker_session: row.session, command: null,
          accounting: { attempt: row.attempt, action: { kind } },
        }, this.stop.signal)
        try {
          const receipt = await call('invalidate_quota')
          if (receipt?.invalidated !== true) throw new Error('Missing invalidation receipt')
        } catch {
          this.stop.signal.throwIfAborted()
          // A newer owner binding supersedes this frozen attempt. Never invalidate it.
          const { policy, binding } = await call('resource_context')
          if (policy?.profile !== row.profile || policy?.binding_revision !== row.revision ||
              binding?.host !== policy.host || binding?.profile !== row.profile ||
              !Number.isSafeInteger(binding.revision) || binding.revision < row.revision ||
              (binding.revision === row.revision && binding.binding_current !== false)) continue
        }
        this.stop.signal.throwIfAborted()
        await this.profiles.update(state => {
          const saved = state.bindings[row.session]?.remoteQuotaFences?.find(item => item.home === row.home && item.operation_id === row.operation_id && item.attempt === row.attempt && item.revision === row.revision)
          if (saved) {
            saved.reconciled = true
            state.bindings[row.session].remoteQuotaFences = compactAcknowledged(state.bindings[row.session].remoteQuotaFences)
          }
        })
      } catch { /* Keep the durable fence, including after ambiguous transport failure. */ }
    }
  }
  start(intervalMs = 5000) {
    if (this.timer || this.stop.signal.aborted || !this.client) return
    this.timer = setInterval(() => { void this.tick().catch(() => {}) }, intervalMs)
    this.timer.unref?.()
    void this.tick().catch(() => {})
  }
  async close() {
    this.stop.abort(new Error('Remote quota invalidation replay stopped'))
    clearInterval(this.timer); this.timer = undefined
    await this.running
  }
}

/** Durable work is the profile binding's fence; timers only drive replay, never own it. */
export class QuotaInvalidations {
  constructor(client, host, profiles) {
    this.client = client; this.host = host; this.profiles = profiles
    this.stop = new AbortController(); this.cursor = 0
  }
  pending() {
    const rows = new Map()
    for (const binding of Object.values(this.profiles.bindings)) {
      const revision = binding.quotaFenceRevision
      if (!Number.isSafeInteger(revision) || revision <= 0 || (binding.quotaFenceReconciledRevision ?? 0) >= revision) continue
      const key = `${binding.profile.id}:${revision}`
      rows.set(key, { profile: binding.profile.id, revision })
    }
    return [...rows.values()].sort((a, b) => a.profile.localeCompare(b.profile) || a.revision - b.revision)
  }
  tick() {
    if (this.running) return this.running
    if (this.stop.signal.aborted || !this.client || !this.host) return Promise.resolve()
    this.running = this.replay().finally(() => { this.running = undefined })
    return this.running
  }
  async replay() {
    const pending = this.pending()
    if (!pending.length) return
    const count = Math.min(16, pending.length), start = this.cursor % pending.length
    this.cursor = (start + count) % pending.length
    for (let index = 0; index < count && !this.stop.signal.aborted; index++) {
      const { profile, revision } = pending[(start + index) % pending.length]
      try {
        const current = await this.client.call(`/api/v1/messaging/resource-binding?host=${encodeURIComponent(this.host)}&profile=${encodeURIComponent(profile)}`, undefined, this.stop.signal)
        if (current.revision === revision && current.binding_current) {
          await this.client.call('/api/v1/messaging/resource-binding/invalidate', { host: this.host, profile, expected_revision: revision }, this.stop.signal)
        } else if (current.revision !== undefined && current.revision < revision) {
          continue // Authority rollback/identity mismatch: never acknowledge an older registry.
        }
        this.stop.signal.throwIfAborted()
        await this.profiles.update(state => {
          for (const binding of Object.values(state.bindings)) {
            if (binding.profile.id === profile && binding.quotaFenceRevision === revision) binding.quotaFenceReconciledRevision = revision
          }
        })
      } catch {
        // Remains durable and fenced; transport errors must not print provider/config details.
      }
    }
  }
  start(intervalMs = 5000) {
    if (this.timer || this.stop.signal.aborted || !this.client || !this.host) return
    this.timer = setInterval(() => { void this.tick().catch(() => {}) }, intervalMs)
    this.timer.unref?.()
    void this.tick().catch(() => {})
  }
  async close() {
    this.stop.abort(new Error('Quota invalidation replay stopped'))
    clearInterval(this.timer); this.timer = undefined
    await this.running
  }
}

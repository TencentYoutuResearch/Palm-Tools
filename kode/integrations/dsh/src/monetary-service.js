/** Host-only opt-in collection registry. Never resolve credentials or discover providers. */
import { ProviderBalanceCollector } from './provider-balances.js'
import { prepareMonetaryCollector, prepareRemoteMonetaryCollector } from './monetary-collector.js'

const pause = (ms, signal) => new Promise(resolve => {
  if (signal.aborted) return resolve()
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
  const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true })
})
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)

export class MonetaryCollectors {
  constructor(client, host, { intervalMs = 1000 } = {}) {
    if (!client || !identity(host) || !Number.isInteger(intervalMs) || intervalMs < 10 || intervalMs > 60000) throw new Error('Invalid monetary service configuration')
    this.client = client; this.host = host; this.intervalMs = intervalMs; this.jobs = new Map(); this.closed = false
  }
  register({ profile, source, authorizedFetch, ttlMs = 60000, remote = null }) {
    if (this.closed || !identity(profile) || this.jobs.size >= 64) throw new Error('Monetary collector registration unavailable')
    if (remote && (!identity(remote.home_node) || !identity(remote.id) || !identity(remote.session) || !Number.isSafeInteger(remote.attempt) || remote.attempt < 1)) throw new Error('Invalid remote monetary assignment')
    const target = remote ? { ...remote } : null
    const key = JSON.stringify([target?.home_node ?? this.host, profile, source])
    if (this.jobs.has(key)) throw new Error('Monetary collector already registered')
    const collector = new ProviderBalanceCollector({ source, authorizedFetch, ttlMs })
    const stop = new AbortController()
    const row = { key, profile, source, home_node: target?.home_node ?? this.host, remote: target,
      status: 'binding_pending', last_poll_at: null, last_reported_at: null, stop, task: null }
    this.jobs.set(key, row)
    row.task = this.run(row, collector)
    return async () => {
      stop.abort(); await row.task
      if (this.jobs.get(key) === row) this.jobs.delete(key)
    }
  }
  list() {
    return [...this.jobs.values()].map(row => ({ host: this.host, profile: row.profile, source: row.source, home_node: row.home_node,
      operation_id: row.remote?.id ?? null, attempt: row.remote?.attempt ?? null,
      status: row.status, last_poll_at: row.last_poll_at, last_reported_at: row.last_reported_at }))
  }
  async run(row, collector) {
    const signal = row.stop.signal
    const client = { call: (path, body) => this.client.call(path, body, signal) }
    let bound
    try {
      bound = row.remote
        ? await prepareRemoteMonetaryCollector(client, this.host, row.profile, row.remote.session, row.remote, collector)
        : await prepareMonetaryCollector(client, this.host, row.profile, collector)
    } catch {
      row.status = signal.aborted ? 'stopped' : 'binding_unavailable'
      // Explicit re-registration is required; never silently adopt an account that appears later.
      return
    }
    while (!signal.aborted) {
      try {
        // This check is only a local transport fence; home still verifies the pinned identity.
        row.last_poll_at = Date.now()
        const result = await bound.poll(signal)
        if (signal.aborted) break
        if (result.status !== 'backoff') row.status = result.status
        if (result.status === 'reported') row.last_reported_at = result.sample.observed_at_ms
      } catch {
        if (signal.aborted) break
        // Same-payload pending publication is retried; no rebind and no raw error details.
        row.status = 'publication_unavailable'
      }
      await pause(this.intervalMs, signal)
    }
    row.status = 'stopped'
  }
  async close() {
    this.closed = true
    for (const row of this.jobs.values()) row.stop.abort()
    await Promise.allSettled([...this.jobs.values()].map(row => row.task))
    this.jobs.clear()
  }
}

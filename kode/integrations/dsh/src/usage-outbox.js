import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { requestedModelAccounting } from './native-usage.js'

/** Host-owned, attempt-scoped estimates. Persist command before sending; replay exact receipts. */
export class UsageOutbox {
  constructor(client, profiles) { this.client = client; this.profiles = profiles; this.stop = new AbortController(); this.cursor = 0 }
  key(operation) { return `${operation.home_node ? `${operation.home_node}:` : ''}${operation.id}:${operation.attempt}` }
  relay(session, operation, action) {
    return this.client.call(`/api/v1/messaging/operation-accounting-relay/${encodeURIComponent(operation.home_node)}`, {
      operation_id: operation.id, worker_session: session, command: null,
      accounting: { attempt: operation.attempt, action },
    }, this.stop.signal)
  }
  assertPrice(context, model) {
    if (!context.price || context.price.model_policy !== 'requested_model') throw Object.assign(new Error('Automatic accounting requires explicit requested-model pricing'), { code: 'automatic_pricing_unavailable' })
    if (!model || context.price.model !== model) throw Object.assign(new Error('Selected model does not match frozen accounting price'), { code: 'price_model_mismatch' })
  }
  assertObserved(session, key) {
    const row = this.profiles.binding(session)?.usageOutbox?.[key]
    if (!row?.latest?.turn_ended || !requestedModelAccounting(row.latest, row.context.price).eligible) throw Object.assign(new Error('Native turn ended without attributable usage; reconciliation required'), { code: 'usage_unresolved' })
  }
  async prepare(session, operation, model) {
    if (!this.client) return null
    const key = this.key(operation)
    const prior = this.profiles.binding(session)?.usageOutbox?.[key]
    if (prior) { this.assertPrice(prior.context, model); return key }
    const context = operation.home_node
      ? await this.relay(session, operation, { kind: 'context' })
      : await this.client.call(`/api/v1/messaging/operations/${encodeURIComponent(operation.id)}/budget?attempt=${operation.attempt}`, undefined, this.stop.signal)
    if (context.operation_id !== operation.id || context.attempt !== operation.attempt || context.reservation?.request?.operation_id !== operation.id) throw new Error('Accounting context identity mismatch')
    this.assertPrice(context, model)
    if (context.reservation.revision !== 1 || context.reservation.finalized) throw new Error('Accounting reservation already used; reconciliation required')
    await this.profiles.update(state => {
      const binding = state.bindings[session]
      if (binding.managedOperation?.id !== operation.id || binding.managedOperation?.attempt !== operation.attempt || binding.managedOperation?.home_node !== operation.home_node) throw new Error('Accounting operation changed')
      const rows = binding.usageOutbox ??= {}
      if (rows[key]) return
      // Completed receipts live in Hub audit; retain a small local tail. Never evict unresolved work.
      const complete = Object.keys(rows).filter(k => rows[k].done)
      for (const old of complete.slice(0, Math.max(0, complete.length - 15))) delete rows[old]
      if (Object.keys(rows).length >= 128) throw new Error('Unresolved accounting backlog requires reconciliation')
      rows[key] = { context, selected_model: model, ...(operation.home_node ? { home_node: operation.home_node } : {}), revision: 1, status: 'awaiting_usage' }
    })
    return key
  }
  async observe(session, key, observation) {
    await this.profiles.update(state => {
      const row = state.bindings[session]?.usageOutbox?.[key]
      if (!row) throw new Error('Missing durable accounting context')
      const identity = `${observation.thread_id}:${observation.turn_id}`
      if (row.turn && row.turn !== identity) throw new Error('Accounting attempt cannot span multiple native turns')
      row.turn = identity
      row.latest = structuredClone(observation)
      row.done = !row.command && row.acknowledged === observation.event_id && observation.turn_ended === true
      row.status = row.done ? 'estimated_pending_reconciliation' : 'pending'
    })
    void this.tick().catch(() => {})
  }
  tick() {
    if (this.running) return this.running
    if (!this.client || this.stop.signal.aborted) return Promise.resolve()
    this.running = this.replay().finally(() => { this.running = undefined })
    return this.running
  }
  async replay() {
    const pending = Object.entries(this.profiles.bindings).flatMap(([session, b]) => Object.entries(b.usageOutbox ?? {}).filter(([, row]) => !row.done && (row.command || row.latest && row.latest.event_id !== row.acknowledged)).map(([key]) => ({ session, key })))
    if (!pending.length) return
    const start = this.cursor % pending.length, count = Math.min(16, pending.length)
    this.cursor = (start + count) % pending.length
    for (let i = 0; i < count && !this.stop.signal.aborted; i++) {
      const { session, key } = pending[(start + i) % pending.length]
      try { await this.send(session, key) }
      catch { await this.patch(session, key, row => { row.status = 'pending_reconciliation' }).catch(() => {}) }
    }
  }
  patch(session, key, edit) { return this.profiles.update(state => { const row = state.bindings[session]?.usageOutbox?.[key]; if (row) return edit(row) }) }
  async send(session, key) {
    let row = this.profiles.binding(session)?.usageOutbox?.[key]
    if (!row.command) {
      const usage = requestedModelAccounting(row.latest, row.context.price)
      if (!usage.eligible) { await this.patch(session, key, r => { r.status = usage.reason }); return }
      const event = row.latest.event_id
      const event_id = `meter-${createHash('sha256').update(JSON.stringify([key, row.context.reservation.request.id, event])).digest('hex')}`
      const command = { event_id, reservation_id: row.context.reservation.request.id, expected_revision: row.revision,
        model: usage.model, ...usage.counters, attribution: usage.attribution }
      await this.patch(session, key, r => {
        if (!r.command) { r.command = command; r.commandObservation = event }
      })
      row = this.profiles.binding(session).usageOutbox[key]
    }
    const command = row.command
    const origin = { id: row.context.operation_id, attempt: row.context.attempt, home_node: row.home_node }
    let receipt
    if (row.home_node) receipt = (await this.relay(session, origin, { kind: 'receipt', event_id: command.event_id })).receipt
    else try { receipt = await this.client.call(`/api/v1/messaging/metered-usage/${encodeURIComponent(command.event_id)}`, undefined, this.stop.signal) }
    catch (error) { if (error.status !== 404) throw error }
    let result
    if (receipt) {
      if (!isDeepStrictEqual(receipt.usage, command)) throw new Error('Accounting receipt identity conflict')
      result = receipt.result
    } else result = row.home_node
      ? await this.relay(session, origin, { kind: 'usage', usage: command })
      : await this.client.call('/api/v1/messaging/metered-usage', command, this.stop.signal)
    if (result.price_id !== row.context.price.id || result.reservation?.request?.id !== command.reservation_id || result.reservation.revision !== command.expected_revision + 1 || result.estimated !== true) throw new Error('Invalid accounting receipt')
    await this.patch(session, key, r => {
      if (!isDeepStrictEqual(r.command, command)) throw new Error('Accounting command changed')
      r.revision = result.reservation.revision
      r.acknowledged = r.commandObservation
      r.receipt = result
      delete r.command; delete r.commandObservation
      r.done = r.latest.event_id === r.acknowledged && r.latest.turn_ended === true
      r.status = r.done ? 'estimated_pending_reconciliation' : 'pending'
    })
  }
  start(intervalMs = 5000) {
    if (this.timer || !this.client || this.stop.signal.aborted) return
    this.timer = setInterval(() => { void this.tick().catch(() => {}) }, intervalMs); this.timer.unref?.()
    void this.tick().catch(() => {})
  }
  async close() { this.stop.abort(new Error('Usage replay stopped')); clearInterval(this.timer); await this.running }
}

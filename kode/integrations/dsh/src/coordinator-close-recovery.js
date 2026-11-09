/** Close idle owned Coordinators and replay durable intents; never starts inference. */
import { createHash } from 'node:crypto'
export class CoordinatorCloseRecovery {
  constructor(host, { intervalMs = 2000 } = {}) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000) throw Error('Invalid close recovery interval')
    this.host = host; this.intervalMs = intervalMs; this.stop = new AbortController(); this.after = ''
  }
  scan() {
    if (this.pending) return this.pending
    if (this.stop.signal.aborted || this.host.stop.signal.aborted) return Promise.reject(Error('Coordinator close recovery stopped'))
    const task = this.discover(); this.pending = task
    task.finally(() => { if (this.pending === task) this.pending = undefined }).catch(() => {})
    return task
  }
  async discover() {
    const runtime = this.host.execution, signal = AbortSignal.any([this.stop.signal, this.host.stop.signal])
    const page = await runtime.client.call('/api/v1/messaging/coordinator-closes/pending' + (this.after ? '?' + new URLSearchParams({ after: this.after }) : ''), undefined, signal)
    if (page.home_hub !== runtime.host || !Array.isArray(page.items) || page.items.length > 32
      || page.next_cursor != null && (typeof page.next_cursor !== 'string' || page.next_cursor.length > 512 || !page.next_cursor.startsWith('coordinator-close:') || page.next_cursor <= this.after)) throw Error('Invalid Coordinator close page')
    const results = []
    for (const input of page.items) {
      signal.throwIfAborted()
      try { results.push({ operation_id: input.operation_id, ...await this.host.closeCoordinator(input) }) }
      catch (error) { if (signal.aborted) throw error; results.push({ operation_id: input.operation_id, state: 'recovery_required', error }) }
    }
    this.after = page.next_cursor ?? '';
    results.push(...await this.closeIdle(signal)); this.results = results; return results
  }
  async closeIdle(signal) {
    // Releasing an idle operation requires a live service that can wake its
    // next durable human request. Manually embedded Hosts can omit that service.
    if (this.host.coordinatorBootstrap?.running !== true) return []
    const runtime = this.host.execution, results = []
    const call = path => runtime.client.call('/api/v1/messaging/' + path, undefined, signal)
    for (const [id, owned] of this.host.handles ?? []) {
      signal.throwIfAborted()
      const binding = runtime.profiles.binding(id), scope = binding?.managedCoordinator, op = binding?.managedOperation
      if (!scope || !op || binding.operationClosed || owned.run.signal.aborted) continue
      try {
        const state = await call(`operations/${encodeURIComponent(op.id)}/coordinator-close`)
        if (state.intent || state.idle_close_ready !== true) continue
        const active = await call(`teams/${encodeURIComponent(scope.team_id)}/activation`)
        const { control } = await call(`teams/${encodeURIComponent(scope.team_id)}/coordinator-control`)
        if (!active?.active || active.authority_valid !== true
          || !active.snapshot?.team?.spec?.coordinator_startup
          || active.snapshot?.team?.home_hub !== runtime.host || active.snapshot.team.id !== scope.team_id
          || active.snapshot.policies?.budget?.policy?.settlement !== 'internal_price'
          || control?.revision !== scope.control_revision || control.request.activation_revision !== active.revision
          || control.request.operation_id !== op.id || control.request.attempt !== op.attempt || control.request.epoch !== op.epoch
          || control.worker.node_id !== runtime.host || control.worker.session_id !== id) continue
        const price = active.snapshot.policies.scheduling.policy.targets[control.request.target_id]?.internal_price_id
        if (!price) continue
        const key = createHash('sha256').update(JSON.stringify([runtime.host, op.id, op.attempt, op.epoch])).digest('hex')
        const input = { operation_id: op.id, command: { request_id: `idle-${key}`, attempt: op.attempt,
          epoch: op.epoch, price_id: price, settlement: 'internal_price', idle_only: true } }
        results.push({ operation_id: op.id, ...await this.host.closeCoordinator(input) })
      } catch (error) {
        if (signal.aborted) throw error
        results.push({ operation_id: op.id, state: 'idle_close_pending', error })
      }
    }
    return results
  }
  start() {
    if (this.timer || this.stop.signal.aborted) return
    const tick = () => { void this.scan().catch(error => { this.error = error }) }
    this.timer = setInterval(tick, this.intervalMs); this.timer.unref?.(); tick()
  }
  async close() { clearInterval(this.timer); this.stop.abort(Error('Coordinator close recovery stopped')); await this.pending?.catch(() => {}) }
}

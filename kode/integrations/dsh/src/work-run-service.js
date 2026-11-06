/** Discover activated home Runs and retain explicit recovery fences across Host restarts. */
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { writePrivateJson } from './agent-profiles.js'
import { CoordinatorUpdates } from './coordinator-updates.js'
import { readWorkRunAccounting } from './work-run-accounting-status.js'
const terminal = new Set(['completed', 'failed', 'cancelled'])
const blocked = new Set(['recovery_required', 'progression_failed', 'waiting_adapter', 'waiting_clarification', 'waiting_user', 'paused', 'waiting_accounting'])
const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(id)
export class WorkRunService {
  constructor(controller, { intervalMs = 2000, maxWatches = 32, onState = () => {} } = {}) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000 || !Number.isSafeInteger(maxWatches) || maxWatches < 1 || maxWatches > 128
        || typeof onState !== 'function' || !controller.runtime.profiles.path) throw new Error('Invalid WorkRun service configuration')
    this.controller = controller; this.runtime = controller.runtime; this.intervalMs = intervalMs; this.maxWatches = maxWatches; this.onState = onState
    this.path = join(dirname(this.runtime.profiles.path), 'work-run-service.json')
    this.rows = {}; this.observing = new Map(); this.chain = Promise.resolve(); this.stop = new AbortController(); this.after = undefined
    this.coordinatorUpdates = new CoordinatorUpdates(this.runtime,{intervalMs})
  }
  async open() {
    let file
    try {
      file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('WorkRun service ledger bounds')
      const stored = JSON.parse(await file.readFile('utf8'))
      if (stored.version !== 1 || stored.home_hub !== this.runtime.host || !stored.runs || Array.isArray(stored.runs)
          || Object.keys(stored.runs).length > 4096 || Object.entries(stored.runs).some(([id,row]) => !validId(id)
            || !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.state !== 'string' || typeof row.blocked !== 'boolean')) throw new Error('WorkRun service ledger invalid')
      this.rows = stored.runs
    } catch (error) { if (error.code !== 'ENOENT') throw error } finally { await file?.close() }
    return this
  }
  record(id, row) {
    const task = this.chain.then(async () => {
      const next = { ...this.rows, [id]: row }
      if (Object.keys(next).length > 4096) {
        const finished = Object.keys(next).find(key => key !== id && terminal.has(next[key].state))
        if (!finished) throw new Error('WorkRun service ledger requires archival')
        delete next[finished]
      }
      await writePrivateJson(this.path, { version: 1, home_hub: this.runtime.host, runs: next })
      this.rows = next
    })
    this.chain = task.catch(() => {})
    return task
  }
  scan() {
    if (this.scanning) return this.scanning
    if (this.stop.signal.aborted) return Promise.reject(new Error('WorkRun service closed'))
    const task = this.discover()
    this.scanning = task
    task.finally(() => { if (this.scanning === task) this.scanning = undefined }).catch(() => {})
    return task
  }
  async discover() {
    const query = this.after ? `?after=${encodeURIComponent(this.after)}` : ''
    const page = await this.runtime.client.call(`/api/v1/messaging/work-runs/active${query}`, undefined, this.stop.signal)
    if (!Array.isArray(page.items) || page.items.length > 64 || (page.next_cursor && (!validId(page.next_cursor) || page.next_cursor === this.after))) throw new Error('Invalid active WorkRun page')
    for (const row of page.items) {
      this.stop.signal.throwIfAborted()
      if (!validId(row.id) || row.home_hub !== this.runtime.host || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('Active WorkRun identity mismatch')
      const saved = this.rows[row.id]
      if (this.observing.has(row.id) || this.controller.watches.has(row.id) || (saved?.blocked && !['cancelling', 'cancel_unconfirmed', 'taking_over'].includes(row.state) && saved.state !== 'waiting_remote_host' && saved.revision === row.revision)) { this.after = row.id; continue }
      if (this.controller.watches.size >= this.maxWatches) return
      // Rotation is transient; unchanged waiting state already has a durable record.
      // Rewriting it on every lease would add two fsyncs per poll without new evidence.
      if (!saved || saved.revision !== row.revision || saved.blocked) {
        await this.record(row.id, { revision: row.revision, state: 'watching', blocked: false })
      }
      this.stop.signal.throwIfAborted()
      this.controller.watch(row.id, { once: true, intervalMs: this.intervalMs, onState: result => this.note(row.id, result) })
      this.after = row.id
    }
    this.after = page.next_cursor ?? undefined
  }
  note(id, result) {
    const task = this.observe(id, result)
    this.observing.set(id, task)
    task.finally(() => { if (this.observing.get(id) === task) this.observing.delete(id) }).catch(() => {})
    return task
  }
  async observe(id, result) {
    try {
      const run = await this.runtime.client.call(`/api/v1/messaging/work-runs/${encodeURIComponent(id)}`, undefined, this.stop.signal)
      if (['waiting_outputs', 'progression_failed'].includes(result.state) && !terminal.has(run.state)) {
        try {
          if ((await readWorkRunAccounting(this.runtime, run, this.stop.signal)).blocked) result = { ...result, state: 'waiting_accounting' }
        } catch (error) {
          this.stop.signal.throwIfAborted()
          // A failed read is not proof of missing usage. Preserve a generic per-run
          // recovery fence, without taking unrelated teams down or retrying inference.
          result = { ...result, state: 'progression_failed', error:result.error ?? error }
        }
      }
      const fenced = blocked.has(result.state)
      if (fenced) this.controller.unwatch(id)
      const next = { revision: run.revision, state: result.state, blocked: fenced }
      const saved = this.rows[id]
      if (!saved || saved.revision !== next.revision || saved.state !== next.state || saved.blocked !== next.blocked) await this.record(id, next)
      await this.onState({ run_id: id, ...next })
    } catch (error) {
      this.controller.unwatch(id)
      // Failure to persist a recovery fence must never silently reattach a watch.
      this.stop.abort(error); clearInterval(this.timer)
      this.failureClosing ??= this.controller.close()
      throw error
    }
  }
  async retry(id) {
    if (!validId(id) || this.stop.signal.aborted) throw new Error('Invalid WorkRun retry')
    const run = await this.runtime.client.call(`/api/v1/messaging/work-runs/${encodeURIComponent(id)}`, undefined, this.stop.signal)
    if (run.home_hub !== this.runtime.host) throw new Error('WorkRun retry belongs to another Hub')
    if (['waiting_user', 'paused'].includes(run.state) || terminal.has(run.state)) throw new Error('WorkRun requires a Hub state transition before retry')
    if (this.rows[id]?.state === 'waiting_accounting' && (await readWorkRunAccounting(this.runtime, run, this.stop.signal)).blocked) throw Error('WorkRun usage reconciliation required; retry is not authorized')
    await this.record(id, { revision: run.revision, state: 'retry_requested', blocked: false })
    this.after = undefined
    await this.scan()
  }
  start() {
    if (this.timer || this.stop.signal.aborted) return
    this.coordinatorUpdates.start()
    const tick = () => { void this.scan().catch(() => {}) }
    this.timer = setInterval(tick, this.intervalMs); this.timer.unref?.(); tick()
  }
  async close() {
    clearInterval(this.timer); this.stop.abort(new Error('WorkRun service closed'))
    await this.coordinatorUpdates.close()
    await this.scanning?.catch(() => {})
    await this.controller.close(); await Promise.allSettled([...this.observing.values()]); await this.failureClosing; await this.chain
  }
}

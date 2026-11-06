/** Discover only paired homes; frozen home authority and the existing creation ledger gate execution. */
import { isDeepStrictEqual } from 'node:util'
import { assignmentHomeCall } from './assignment-home.js'
import { prepareWorkRunAssignment } from './work-run-preparation.js'
const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
export class RemoteAssignmentDiscovery {
  constructor(dispatcher, { intervalMs = 2000, batchSize = 4, prepare, onState = () => {} } = {}) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000 || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 32
        || (prepare !== undefined && typeof prepare !== 'function') || typeof onState !== 'function') throw new Error('Invalid remote discovery configuration')
    this.dispatcher = dispatcher; this.runtime = dispatcher.host.execution
    this.prepare = prepare ?? ((assignment, options) => prepareWorkRunAssignment(this.runtime, assignment, options))
    this.intervalMs = intervalMs; this.batchSize = batchSize; this.onState = onState
    this.stop = new AbortController(); this.cursors = new Map(); this.hostCursor = 0
  }
  scan() {
    if (this.running) return this.running
    if (this.stop.signal.aborted) return Promise.reject(new Error('Remote discovery closed'))
    const task = this.discover(); this.running = task
    task.finally(() => { if (this.running === task) this.running = undefined }).catch(() => {})
    return task
  }
  async discover() {
    const signal = AbortSignal.any([this.stop.signal, this.dispatcher.host.stop.signal])
    const directory = await this.runtime.client.call('/api/v1/messaging/workbench/workspaces/hosts', undefined, signal)
    if (directory.local_node_id !== this.runtime.host || !Array.isArray(directory.hosts) || directory.hosts.length > 1024
        || directory.hosts.some(row => !valid(row.node_id) || row.node_id === this.runtime.host)
        || new Set(directory.hosts.map(row => row.node_id)).size !== directory.hosts.length) throw new Error('Invalid paired home directory')
    const homes = directory.hosts.map(row => row.node_id).sort()
    for (const home of this.cursors.keys()) if (!homes.includes(home)) this.cursors.delete(home)
    if (!homes.length) { this.hostCursor = 0; return [] }
    const home = homes[this.hostCursor++ % homes.length], after = this.cursors.get(home)
    const page = await this.dispatcher.discoverRemote(home, { after })
    const batch = page.items.slice(0, this.batchSize), results = []
    for (const row of batch) {
      signal.throwIfAborted()
      let state
      try {
        const scope = { id: row.assignment_id, host: this.runtime.host, worker: row.worker_session, operation: row.operation }
        const assignment = await assignmentHomeCall(this.runtime.client, scope, 'context', undefined, signal)
        if (!isDeepStrictEqual(assignment.dispatch.command.operation, row.operation)) throw new Error('Frozen remote discovery scope changed')
        const options = await this.prepare(assignment, { signal })
        signal.throwIfAborted()
        if (!options) state = 'waiting_adapter'
        else {
          const receipt = await this.dispatcher.dispatch(row.assignment_id, { ...options, homeScope: { worker_session: row.worker_session, operation: row.operation } })
          state = ['created', 'waiting_home_resources'].includes(receipt.state) ? receipt.state : 'recovery_required'
        }
      } catch { state = 'remote_discovery_failed' }
      signal.throwIfAborted()
      const result = { state, home_hub: home, assignment_id: row.assignment_id, worker_session: row.worker_session }
      results.push(result); await this.onState(result)
      this.cursors.set(home, row.assignment_id)
    }
    if (batch.length === page.items.length && !page.next_cursor) this.cursors.delete(home)
    return results
  }
  start() {
    if (this.timer || this.stop.signal.aborted) return
    const tick = () => { void this.scan().catch(() => {}) }
    this.timer = setInterval(tick, this.intervalMs); this.timer.unref?.(); tick()
  }
  async close() {
    clearInterval(this.timer); this.stop.abort(new Error('Remote discovery closed'))
    await Promise.allSettled([this.running].filter(Boolean))
  }
}

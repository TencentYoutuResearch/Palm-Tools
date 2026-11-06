/** Advance only already-owned remote Assignments. Discovery/creation and home completion stay separate. */
import { isDeepStrictEqual } from 'node:util'
import { assignmentHomeCall, readAssignmentRun } from './assignment-home.js'
const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
export class RemoteAssignmentService {
  constructor(dispatcher, { intervalMs = 2000, batchSize = 4, onState = () => {} } = {}) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000 || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 32 || typeof onState !== 'function') throw new Error('Invalid remote Assignment service configuration')
    this.dispatcher = dispatcher; this.host = dispatcher.host; this.runtime = this.host.execution
    this.intervalMs = intervalMs; this.batchSize = batchSize; this.onState = onState
    this.stop = new AbortController(); this.pending = new Map(); this.cursor = 0
  }
  advance(session) {
    if (this.stop.signal.aborted || !valid(session)) return Promise.reject(new Error('Remote Assignment service closed or invalid session'))
    if (this.pending.has(session)) return this.pending.get(session)
    const task = this.step(session)
    this.pending.set(session, task)
    task.finally(() => { if (this.pending.get(session) === task) this.pending.delete(session) }).catch(() => {})
    return task
  }
  async step(session) {
    const signal = AbortSignal.any([this.stop.signal, this.host.stop.signal])
    const binding = this.runtime.profiles.binding(session), operation = binding?.managedOperation, id = binding?.managedAssignment?.id
    if (!valid(id) || !valid(operation?.home_node) || operation.home_node === this.runtime.host) throw new Error('Owned remote Assignment binding required')
    const identity = { assignment_id: id, operation: structuredClone(operation) }
    const scope = { id, host: this.runtime.host, worker: session, operation }
    const options = { homeScope: { worker_session: session, operation } }
    const result = state => ({ state, assignment_id: id, worker_session: session, home_hub: operation.home_node })
    const check = () => {
      signal.throwIfAborted()
      const current = this.runtime.profiles.binding(session)
      if (!isDeepStrictEqual(current?.managedOperation, operation) || current?.managedAssignment?.id !== id) throw new Error('Remote Assignment binding changed')
      return current
    }
    const assignment = await assignmentHomeCall(this.runtime.client, scope, 'context', undefined, signal)
    check()
    if (!isDeepStrictEqual(assignment.dispatch.command.operation, operation)) throw new Error('Remote Assignment frozen operation changed')
    const acknowledgeDrain = async () => {
      check()
      await this.runtime.profiles.update(state => {
        const saved = state.bindings[session]
        if (!isDeepStrictEqual(saved?.managedOperation, operation) || saved?.managedAssignment?.id !== id) throw new Error('Remote drain binding changed')
        saved.remoteLifecycle = { identity, phase: 'acknowledged' }
      })
      return result('execution_drained')
    }
    if (assignment.stop?.receipt) return acknowledgeDrain()
    if (assignment.state !== 'prepared' || assignment.creation?.state !== 'created') return result('waiting_creation')
    let current = check()
    if (current.remoteLifecycle && !isDeepStrictEqual(current.remoteLifecycle.identity, identity)) return result('recovery_required')
    const owned = this.host.handles.get(session)
    // Read home control state before waiting for idle/consumption: cancellation
    // must drain even a busy or already-fenced loop, without a model response.
    const run = await readAssignmentRun(this.runtime, { id: session }, current, assignment, signal)
    check()
    if (['cancelling', 'cancel_unconfirmed', 'taking_over'].includes(run.state)) {
      if (!owned && current.assignmentStop?.state !== 'drained') return result('cancel_unconfirmed')
      await this.dispatcher.stop(id, options)
      return acknowledgeDrain()
    }
    if (current.remoteLifecycle?.phase === 'reporting' && !current.operationClosed) return result('recovery_required')
    if (!current.operationClosed) {
      if (!owned || owned.run.signal.aborted) return result('recovery_required')
      const message = assignment.mandate?.receipt?.message_id
      if (!message) return result('waiting_mandate')
      const delivery = await this.runtime.client.call(`/api/v1/messaging/messages/${encodeURIComponent(message)}/delivery`, undefined, signal)
      check()
      if (delivery.delivery?.phase !== 'consumed' || delivery.delivery.session_id !== session) return result('waiting_consumption')
      if (owned.agent.status !== 'idle') return result('waiting_execution')
      if (assignment.clarification_progress?.ready_to_report === false) return result('waiting_answer_execution')
      const stage = run.stages.find(row => row.stage_id === assignment.stage_id)
      if (stage?.assignment_id !== id || stage.attempt !== assignment.stage_attempt) throw new Error('Remote Assignment stage changed')
      check()
      if (!stage.evidence) {
        const declared = await this.dispatcher.declareOutputs(id, options)
        return result(declared ? 'waiting_home_selection' : 'waiting_outputs')
      }
      // Persist before the report can reach home. A crash or ambiguous failure is
      // never permission to repeat a report or recreate execution automatically.
      await this.runtime.profiles.update(state => {
        const saved = state.bindings[session]
        if (!isDeepStrictEqual(saved?.managedOperation, operation) || saved?.managedAssignment?.id !== id || saved.operationClosed) throw new Error('Remote report binding changed')
        saved.remoteLifecycle = { identity, phase: 'reporting' }
      })
      check()
      await owned.run.finish()
      current = check()
      if (!current.operationClosed) throw new Error('Remote report closure not persisted')
    }
    if (!owned && current.assignmentStop?.state !== 'drained') return result('recovery_required')
    check()
    await this.dispatcher.stop(id, options)
    return acknowledgeDrain()
  }
  scan() {
    if (this.scanning) return this.scanning
    if (this.stop.signal.aborted) return Promise.reject(new Error('Remote Assignment service closed'))
    const task = this.discover()
    this.scanning = task
    task.finally(() => { if (this.scanning === task) this.scanning = undefined }).catch(() => {})
    return task
  }
  async discover() {
    const sessions = Object.entries(this.runtime.profiles.bindings).filter(([, binding]) => binding.managedAssignment?.id && binding.managedOperation?.home_node
      && binding.managedOperation.home_node !== this.runtime.host && binding.remoteLifecycle?.phase !== 'acknowledged').map(([session]) => session).sort()
    if (!sessions.length) { this.cursor = 0; return [] }
    const start = this.cursor % sessions.length
    const batch = Array.from({ length: Math.min(this.batchSize, sessions.length) }, (_, index) => sessions[(start + index) % sessions.length])
    this.cursor = (start + batch.length) % sessions.length
    return Promise.all(batch.map(async session => {
      let result
      try { result = await this.advance(session) } catch { result = { state: 'remote_progression_failed', worker_session: session } }
      if (!this.stop.signal.aborted) await this.onState(result)
      return result
    }))
  }
  start() {
    if (this.timer || this.stop.signal.aborted) return
    const tick = () => { void this.scan().catch(() => {}) }
    this.timer = setInterval(tick, this.intervalMs); this.timer.unref?.(); tick()
  }
  async close() {
    clearInterval(this.timer); this.stop.abort(new Error('Remote Assignment service closed'))
    await Promise.allSettled([this.scanning, ...this.pending.values()].filter(Boolean))
  }
}

/** Persist native question delivery before Home I/O. Recovery only replays the exact observation. */
import { isDeepStrictEqual } from 'node:util'
import { assignmentHomeCall, readAssignmentContext } from './assignment-home.js'
import { workerQuestions } from './worker-questions.js'
export class AssignmentClarificationOutbox {
  constructor(runtime) { this.runtime = runtime; this.stop = new AbortController() }
  async record(agent, call, questions) {
    const runtime = this.runtime, binding = runtime.profiles.binding(agent.id)
    const assignment = await readAssignmentContext(runtime, agent, binding, this.stop.signal)
    if (assignment.worker.node_id !== runtime.host || assignment.worker.session_id !== agent.id
        || binding.managedAssignment?.id !== assignment.id
        || !isDeepStrictEqual(call.operation, binding.managedOperation)
        || !isDeepStrictEqual(assignment.dispatch.command.operation, binding.managedOperation)) throw Error('Worker clarification binding changed')
    const request = { request_id: call.call_id, call_id: call.call_id, command: assignment.dispatch.command, questions: workerQuestions(questions) }
    const scope = { assignment_id: assignment.id, run_id: assignment.run_id, team_id: assignment.team_id,
      stage_id: assignment.stage_id, stage_attempt: assignment.stage_attempt, context_hash: assignment.context_hash }
    if (Object.entries(scope).some(([key, value]) => key === 'stage_attempt'
      ? !Number.isSafeInteger(value) || value < 1 : typeof value !== 'string' || !value)) throw Error('Worker clarification context unavailable')
    const entry = { ...scope, home: call.operation.home_node ?? runtime.host, request }
    await runtime.profiles.update(state => {
      const saved = state.bindings[agent.id]
      if (saved?.operationClosed || !isDeepStrictEqual(saved?.managedOperation, call.operation)) throw Error('Worker clarification operation closed')
      const rows = saved.clarificationOutbox ??= {}
      if (rows[call.call_id]) {
        if (!isDeepStrictEqual(rows[call.call_id].entry, entry)) throw Error('Worker clarification identity conflict')
        return
      }
      if (Object.keys(rows).length >= 128) throw Error('Worker clarification outbox requires archival')
      rows[call.call_id] = { entry, acknowledged: false }
    })
    await this.pending?.catch(() => {})
    await this.tick()
    const saved = runtime.profiles.binding(agent.id)?.clarificationOutbox?.[call.call_id]
    if (!saved?.acknowledged) throw Error('Worker clarification retained pending Home receipt')
    return saved.receipt
  }
  tick() {
    if (this.pending) return this.pending
    if (this.stop.signal.aborted) return Promise.resolve()
    const task = this.flush(); this.pending = task
    task.finally(() => { if (this.pending === task) this.pending = undefined }).catch(() => {})
    return task
  }
  async flush() {
    const runtime = this.runtime
    for (const [session, binding] of Object.entries(runtime.profiles.bindings)) {
      for (const [id, row] of Object.entries(binding.clarificationOutbox ?? {})) {
        if (row.acknowledged) continue
        this.stop.signal.throwIfAborted()
        try {
          const scope = { id: row.entry.assignment_id, host: runtime.host, worker: session, operation: row.entry.request.command.operation }
          const read = await assignmentHomeCall(runtime.client, scope, 'clarification_read', { request_id: id }, this.stop.signal)
          const receipt = read.clarification ?? await assignmentHomeCall(runtime.client, scope, 'clarification', row.entry.request, this.stop.signal)
          if (receipt.snapshot !== 'assignment_clarification_receipt.v1' || ['assignment_id', 'run_id', 'team_id', 'stage_id', 'stage_attempt', 'context_hash'].some(key => receipt[key] !== row.entry[key])
              || !Number.isSafeInteger(receipt.run_revision) || receipt.run_revision < 1 || receipt.home_hub !== row.entry.home
              || receipt.worker?.session_id !== session || receipt.worker?.node_id !== runtime.host
              || receipt.state !== 'pending' || receipt.completion_authorized !== false
              || !isDeepStrictEqual(receipt.request, row.entry.request)) throw Error('Worker clarification receipt mismatch')
          await runtime.profiles.update(state => {
            const current = state.bindings[session]?.clarificationOutbox?.[id]
            if (!isDeepStrictEqual(current?.entry, row.entry)) throw Error('Worker clarification changed during delivery')
            current.receipt = receipt; current.acknowledged = true
          })
        } catch (error) {
          if (this.stop.signal.aborted) throw error
          this.error = error
        }
      }
    }
  }
  start() {
    if (this.timer || this.stop.signal.aborted) return
    this.timer = setInterval(() => { void this.tick().catch(error => { this.error = error }) }, 2000)
    this.timer.unref?.()
  }
  async close() { clearInterval(this.timer); this.stop.abort(Error('Worker clarification outbox closed')); await this.pending?.catch(() => {}) }
}

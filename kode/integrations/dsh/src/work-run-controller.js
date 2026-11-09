import { advanceWorkRunCancellation } from './work-run-cancellation.js'
import { readAssignmentOutputs } from './assignment-outputs.js'
/** Bounded Host progression. Hub receipts, never local Agent text, decide workflow state. */
const prefix = '/api/v1/messaging/'
const resourceWait = error => error?.status === 409 && (['assignment_account_capacity_exhausted','assignment_workspace_busy','assignment_exclusive_resource_busy'].includes(error.code) && /^\/api\/v1\/messaging\/work-assignments\/[A-Za-z0-9][A-Za-z0-9_.-]{0,159}\/resources$/.test(error.path ?? '') || error.code === 'team_budget_exhausted' && /^\/api\/v1\/messaging\/work-runs\/[A-Za-z0-9][A-Za-z0-9_.-]{0,159}\/schedule$/.test(error.path ?? ''))
const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(id)
export class WorkRunController {
  constructor(dispatcher, { prepare, outputs } = {}) {
    if (typeof prepare !== 'function' || (outputs !== undefined && typeof outputs !== 'function')) throw new Error('Trusted workflow adapters required')
    this.dispatcher = dispatcher; this.host = dispatcher.host; this.runtime = this.host.execution
    this.prepare = prepare; this.outputs = outputs ?? (assignment => readAssignmentOutputs(this.runtime, assignment))
    this.pending = new Map(); this.watches = new Map(); this.cursor = new Map(); this.stop = new AbortController()
  }
  advance(id) {
    if (!validId(id)) return Promise.reject(new Error('Invalid WorkRun identity'))
    if (this.stop.signal.aborted) return Promise.reject(new Error('WorkRun controller closed'))
    if (this.pending.has(id)) return this.pending.get(id)
    const task = this.step(id)
    this.pending.set(id, task)
    task.finally(() => { if (this.pending.get(id) === task) this.pending.delete(id) }).catch(() => {})
    return task
  }
  async step(id) {
    const signal = AbortSignal.any([this.stop.signal, this.host.stop.signal])
    const call = (path, body) => { signal.throwIfAborted(); return this.runtime.client.call(path, body, signal) }
    const path = `${prefix}work-runs/${encodeURIComponent(id)}`
    let run = await call(path)
    if (['completed', 'failed', 'cancelled'].includes(run.state)) return { state: run.state, run_id: id, receipt: run.state === 'cancelled' ? run.cancellation?.receipt ?? run.resolution ?? null : run.delivery ?? null }
    if (['cancelling', 'cancel_unconfirmed', 'taking_over'].includes(run.state)) return advanceWorkRunCancellation(this, run, call)
    if (run.state === 'paused') return { state: 'paused', run_id: id, receipt: run.intervention?.receipt ?? null }
    if (run.pending_clarification) return { state: 'waiting_clarification', run_id: id, reason: 'worker_clarification_required', receipt: run.pending_clarification }
    if (run.state === 'waiting_user') return { state: 'waiting_user', run_id: id, reason: run.waiting_reason }
    if (run.home_hub !== this.runtime.host) throw new Error('WorkRun progression requires its home Host')
    const pack = run.context.binding.workflow.pack
    const active = run.stages.filter(s => s.assignment_id && !['passed', 'waived'].includes(s.state))
    if (!active.length) {
      if (pack.completion_stages.every(id => run.stages.some(s => s.stage_id === id && ['passed', 'waived'].includes(s.state)))) {
        const receipt = await call(`${path}/delivery`, { request_id: `host-deliver-${run.revision}`, expected_revision: run.revision })
        if (receipt.completion_authorized === false && receipt.state === 'waiting_user' && receipt.reason === 'human_delivery_acceptance_required') return { state: 'waiting_user', run_id: id, reason: receipt.reason, receipt }
        if (receipt.completion_authorized !== true) throw Error('Delivery completion was not authorized')
        return { state: 'completed', run_id: id, receipt }
      }
      const scheduled = await call(`${path}/schedule`, { request_id: `host-schedule-${run.revision}`, expected_revision: run.revision })
      return { state: 'scheduled', run_id: id, assignment_id: scheduled.assignment.id }
    }
    // A running branch must not starve other ready branches on subsequent ticks.
    const index = (this.cursor.get(id) ?? 0) % active.length
    this.cursor.set(id, index + 1)
    const stage = active[index], assignmentPath = `${prefix}work-assignments/${encodeURIComponent(stage.assignment_id)}`
    let assignment = await call(assignmentPath)
    if (assignment.clarification_progress?.ready_to_report === false) return { state: 'waiting_answer_execution', run_id: id, assignment_id: assignment.id }
    // Remote execution is driven by its Host. Once home has its authenticated drain
    // receipt, final accounting and stage validation are the same home-owned gates.
    if (assignment.worker.node_id !== this.runtime.host && !assignment.stop?.receipt) {
      if (assignment.state !== 'prepared') throw new Error('WorkRun Assignment requires reconciliation')
      if (assignment.candidate?.grant_scope?.capabilities?.includes('workspace_write') && !assignment.execution_workspace) return { state: 'waiting_remote_host', run_id: id, assignment_id: assignment.id }
      if (Object.keys(assignment.inputs?.binding?.sources ?? {}).length && !assignment.execution_workspace) {
        if (!assignment.input_workspace) return { state: 'waiting_remote_host', run_id: id, assignment_id: assignment.id }
        const receipt = await call(`${assignmentPath}/workspace-scope`, { request_id: `host-scope-${assignment.id}`, expected_revision: assignment.revision })
        return { state: 'remote_workspace_authorized', run_id: id, assignment_id: assignment.id, receipt }
      }
      if (!assignment.resources) {
        const receipt = await call(`${assignmentPath}/resources`, { request_id: `host-${assignment.id}`, expected_revision: assignment.revision })
        return { state: 'remote_resources_held', run_id: id, assignment_id: assignment.id, receipt }
      }
      if (assignment.resources.state !== 'held' || (assignment.creation && assignment.creation.state !== 'created')) {
        return { state: 'recovery_required', run_id: id, assignment_id: assignment.id }
      }
      if (assignment.creation?.state !== 'created') return { state: 'waiting_remote_host', run_id: id, assignment_id: assignment.id }
      if (!assignment.mandate) {
        const directory = await call(`${prefix}sessions`)
        if (!directory.sessions.some(row => row.address.node_id === assignment.worker.node_id && row.address.session_id === assignment.worker.session_id)) {
          return { state: 'waiting_remote_host', run_id: id, assignment_id: assignment.id }
        }
        const receipt = await call(`${assignmentPath}/mandate`, { request_id: `mandate-${assignment.id}`, expected_revision: assignment.revision })
        return { state: 'started', run_id: id, assignment_id: assignment.id, receipt }
      }
      if (stage.evidence) return { state: 'waiting_remote_report', run_id: id, assignment_id: assignment.id }
      const declaration = assignment.output_declaration?.receipt
      if (!declaration) return { state: 'waiting_remote_host', run_id: id, assignment_id: assignment.id }
      const selected = await call(`${path}/stages/${encodeURIComponent(stage.stage_id)}/evidence`, {
        request_id: `host-select-${assignment.id}`, expected_revision: run.revision, assignment_id: assignment.id, outputs: declaration.outputs,
      })
      return { state: 'evidence_selected', run_id: id, assignment_id: assignment.id, receipt: selected }
    }
    if (assignment.state !== 'prepared') throw new Error('WorkRun Assignment requires reconciliation')
    const session = assignment.worker.session_id
    let owned = this.host.handles.get(session)
    if (!assignment.creation || assignment.creation.state !== 'created' || (!assignment.mandate && owned)) {
      const options = await this.prepare(structuredClone(assignment), { signal })
      signal.throwIfAborted()
      if (!options) return { state: 'waiting_adapter', run_id: id, assignment_id: assignment.id }
      const started = await this.dispatcher.start(assignment.id, options)
      return { state: started.mandate ? 'started' : 'recovery_required', run_id: id, assignment_id: assignment.id, started }
    }
    if (!assignment.stop?.receipt) {
      const binding = this.runtime.profiles.binding(session)
      if (!binding?.operationClosed) {
        if (!owned || owned.run.signal.aborted) return { state: 'recovery_required', run_id: id, assignment_id: assignment.id }
        const message = assignment.mandate?.receipt?.message_id
        if (!message || (await call(`${prefix}messages/${encodeURIComponent(message)}/delivery`)).delivery?.phase !== 'consumed') {
          return { state: 'waiting_consumption', run_id: id, assignment_id: assignment.id }
        }
        if (owned.agent.status !== 'idle') return { state: 'waiting_execution', run_id: id, assignment_id: assignment.id }
        if (!stage.evidence) {
          // Adapter reads durable output identities; it must not launch work here.
          await this.runtime.verificationArchive?.flush()
          const outputs = await this.outputs(structuredClone(assignment), { signal })
          signal.throwIfAborted()
          if (!outputs) return { state: 'waiting_outputs', run_id: id, assignment_id: assignment.id }
          await call(`${path}/stages/${encodeURIComponent(stage.stage_id)}/evidence`, {
            request_id: `host-select-${assignment.id}`, expected_revision: run.revision, assignment_id: assignment.id, outputs,
          })
        }
        signal.throwIfAborted()
        await owned.run.finish()
      }
      signal.throwIfAborted()
      await this.dispatcher.stop(assignment.id)
      assignment = await call(assignmentPath)
    }
    if (!assignment.accounting?.receipt) {
      await call(`${assignmentPath}/accounting`, assignment.accounting?.request ?? {
        request_id: `host-account-${assignment.id}`, expected_revision: assignment.revision,
      })
    }
    run = await call(path)
    const current = run.stages.find(s => s.stage_id === stage.stage_id)
    if (current.assignment_id !== assignment.id || current.attempt !== assignment.stage_attempt) throw new Error('WorkRun stage changed during progression')
    if (current.state === 'passed') return { state: 'stage_passed', run_id: id, receipt: current.completion }
    const receipt = await call(`${path}/stages/${encodeURIComponent(stage.stage_id)}/complete`, {
      request_id: `host-complete-${assignment.id}`, expected_revision: run.revision, assignment_id: assignment.id,
    })
    return { state: receipt.stage_rejected ? receipt.rework?.scheduled ? 'rework_scheduled' : 'waiting_user' : 'stage_passed', run_id: id, receipt }
  }
  watch(id, { intervalMs = 2000, onState, once = false } = {}) {
    if (!validId(id) || !Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000
        || typeof onState !== 'function' || typeof once !== 'boolean' || this.stop.signal.aborted) throw new Error('Invalid WorkRun watch')
    if (this.watches.has(id)) throw new Error('WorkRun already watched')
    let busy = false
    const tick = async () => {
      if (busy || !this.watches.has(id) || this.stop.signal.aborted) return
      busy = true
      let result
      try {
        result = await this.advance(id)
        if (['completed', 'failed', 'cancelled', 'recovery_required'].includes(result.state)) this.unwatch(id)
      } catch (error) {
        if (resourceWait(error)) {
          result = { state: 'waiting_resource', run_id: id, reason: error.code }
        } else {
          // Transport ambiguity, creation uncertainty and authorization failures retain their fence.
          this.unwatch(id)
          result = { state: 'progression_failed', run_id: id, error }
        }
      }
      try { await onState(result) } finally {
        busy = false
        // A service lease yields only after progression and its durable callback settle.
        // Preserve parallel-stage rotation between leases, without touching Workers.
        if (once && this.watches.get(id) === timer) this.unwatch(id, { preserveCursor: true })
      }
    }
    const timer = setInterval(() => { void tick().catch(() => {}) }, intervalMs)
    timer.unref?.(); this.watches.set(id, timer)
    void tick().catch(() => {})
    return () => this.unwatch(id)
  }
  unwatch(id, { preserveCursor = false } = {}) { clearInterval(this.watches.get(id)); this.watches.delete(id); if (!preserveCursor) this.cursor.delete(id) }
  async close() {
    for (const id of this.watches.keys()) this.unwatch(id)
    this.cursor.clear()
    this.stop.abort(new Error('WorkRun controller closed'))
    await Promise.allSettled([...this.pending.values()])
  }
}

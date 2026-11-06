import { readAssignmentOutputs } from './assignment-outputs.js'
import { assignmentHomeCall, readAssignmentRun } from './assignment-home.js'
/** Owner-side delivery pump. Durable creation replay never resumes or re-creates a Worker. */
import { isDeepStrictEqual } from 'node:util'
import { prepareDispatchWorkspace } from './assignment-dispatch-workspace.js'
import { profileRevision } from './agent-profiles.js'
import { managedCodexEnabled } from './managed-codex-profile.js'
const prefix = '/api/v1/messaging/'
export class AssignmentDispatchHost {
  constructor(host) { this.host = host; this.pending = new Map(); this.pendingScopes = new Map(); this.stopping = new Map(); this.stopScopes = new Map(); this.closed = false }
  dispatch(id, { setup, homeScope } = {}) {
    if (this.closed) return Promise.reject(new Error('Assignment dispatcher closed'))
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(id)) return Promise.reject(new Error('Invalid Assignment identity'))
    const scope = homeScope ? structuredClone(homeScope) : null
    if (this.pending.has(id)) {
      if (!isDeepStrictEqual(this.pendingScopes.get(id), scope)) return Promise.reject(new Error('Assignment pending home scope conflict'))
      return this.pending.get(id)
    }
    const task = this.deliver(id, setup, scope)
    this.pendingScopes.set(id, scope)
    this.pending.set(id, task)
    task.finally(() => { if (this.pending.get(id) === task) { this.pending.delete(id); this.pendingScopes.delete(id) } }).catch(() => {})
    return task
  }
  async deliver(id, setup, homeScope) {
    const runtime = this.host.execution, client = runtime.client, profiles = runtime.profiles, signal = this.host.stop.signal
    const path = `${prefix}work-assignments/${encodeURIComponent(id)}`
    const remote = Boolean(homeScope)
    const scope = remote ? { id, host: runtime.host, worker: homeScope.worker_session, operation: homeScope.operation } : null
    if (remote && (!scope.operation?.home_node || scope.operation.home_node === runtime.host)) throw new Error('Explicit remote Assignment home required')
    let assignment = remote ? await assignmentHomeCall(client, scope, 'context', undefined, signal) : await client.call(path, undefined, signal)
    if (assignment.id !== id || assignment.worker.node_id !== runtime.host || assignment.state !== 'prepared') throw new Error('Assignment cannot be delivered by this Host')
    let command = assignment.dispatch.command
    const session = assignment.worker.session_id
    if (remote && !isDeepStrictEqual(command.operation, scope.operation)) throw new Error('Assignment frozen home scope mismatch')
    if (command.command_id !== id || command.session_id !== session) throw new Error('Assignment command identity mismatch')
    const acknowledge = receipt => {
      const request = { request_id: `${id}-${receipt.state}`, command, state: receipt.state === 'created' ? 'created' : 'uncertain' }
      return remote ? assignmentHomeCall(client, scope, 'creation', request, signal) : client.call(`${path}/creation`, request, signal)
    }
    const saved = this.host.dispatches.get(session, id)
    if (saved) {
      if (!isDeepStrictEqual(saved.request.operation, command.operation)) throw new Error('Assignment creation ledger home scope conflict')
      const receipt = saved.state === 'created' ? saved : await this.host.dispatches.reconcile(session, id)
      return acknowledge(receipt)
    }
    if (assignment.creation) throw new Error('Assignment creation ledger missing on this Host; recovery required')
    assignment = await prepareDispatchWorkspace(runtime, assignment, signal, homeScope)
    if (remote && !assignment.resources) return { state: 'waiting_home_resources', assignment_id: id }
    if (remote && assignment.resources.state !== 'held') throw new Error('Remote Assignment requires home-owned resource holds')
    command = assignment.dispatch.command
    await profiles.update(state => {
      const profile = state.profiles.find(row => row.id === assignment.candidate.resource.profile)
      if (!profile || (profile.type !== 'dsh' && !managedCodexEnabled(profile)) || profileRevision(profile) !== command.profile_revision) throw new Error('Assignment official profile unavailable or changed')
      const existing = state.bindings[session]
      if (existing) {
        if (existing.operationClosed || existing.profile.id !== profile.id || existing.revision !== command.profile_revision
            || !isDeepStrictEqual(existing.managedOperation, command.operation) || !isDeepStrictEqual(existing.managedAssignment, { id })) throw new Error('Assignment session binding conflict')
        return
      }
      Object.defineProperty(state.bindings, session, { value: { profile: structuredClone(profile), revision: command.profile_revision,
        seenInputs: [], managedOperation: structuredClone(command.operation), managedAssignment: { id } }, enumerable: true, writable: true, configurable: true })
    })
    if (!assignment.resources) {
      await client.call(`${path}/resources`, { request_id: `host-${id}`, expected_revision: assignment.revision }, signal)
      assignment = await client.call(path, undefined, signal)
    }
    if (assignment.resources?.state !== 'held') throw new Error('Assignment resource hold unavailable')
    let receipt
    try { receipt = await this.host.dispatches.dispatch(command, { setup, signal }) }
    catch (error) {
      const uncertain = this.host.dispatches.get(session, id)
      if (uncertain) await acknowledge(uncertain)
      throw error
    }
    return acknowledge(receipt)
  }
  async start(id, options = {}) {
    if (options.homeScope) throw new Error('Remote Assignment mandate delivery adapter required')
    const creation = await this.dispatch(id, options)
    if (creation.state !== 'created') return { creation, mandate: null }
    const owned = this.host.handles.get(creation.session_id)
    if (!owned || owned.run.signal.aborted) throw new Error('Assignment execution recovery required before mandate delivery')
    const path = `${prefix}work-assignments/${encodeURIComponent(id)}`
    const client = this.host.execution.client, signal = this.host.stop.signal
    const assignment = await client.call(path, undefined, signal)
    const command = assignment.mandate?.request ?? { request_id: `mandate-${id}`, expected_revision: assignment.revision }
    const mandate = await client.call(`${path}/mandate`, command, signal)
    return { creation, mandate }
  }
  async discoverRemote(home, { after } = {}) {
    if (this.closed) throw new Error('Assignment dispatcher closed')
    const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
    if (!valid(home) || home === this.host.execution.host || (after !== undefined && !valid(after))) throw new Error('Invalid remote Assignment catalog scope')
    const suffix = after === undefined ? '' : `?${new URLSearchParams({ after })}`
    const page = await this.host.execution.client.call(`${prefix}assignment-dispatches/remote/${encodeURIComponent(home)}${suffix}`, undefined, this.host.stop.signal)
    if (page.home_hub !== home || page.execution_host !== this.host.execution.host || !Array.isArray(page.items) || page.items.length > 64
        || (page.next_cursor != null && (!valid(page.next_cursor) || page.next_cursor !== page.items.at(-1)?.assignment_id))) throw new Error('Remote Assignment catalog identity mismatch')
    let previous = after ?? ''
    for (const row of page.items) {
      if (!valid(row.assignment_id) || row.assignment_id <= previous || !valid(row.worker_session) || !valid(row.operation?.id)
          || row.operation.home_node !== home || !Number.isSafeInteger(row.operation.attempt) || row.operation.attempt < 1
          || !Number.isSafeInteger(row.operation.epoch) || row.operation.epoch < 1) throw new Error('Remote Assignment catalog command scope mismatch')
      previous = row.assignment_id
    }
    return page
  }
  async declareOutputs(id, { homeScope } = {}) {
    if (this.closed) throw new Error('Assignment dispatcher closed')
    const runtime = this.host.execution, signal = this.host.stop.signal
    const scope = { id, host: runtime.host, worker: homeScope?.worker_session, operation: homeScope?.operation }
    if (!scope.operation?.home_node || scope.operation.home_node === runtime.host) throw new Error('Explicit remote Assignment home required')
    const assignment = await assignmentHomeCall(runtime.client, scope, 'context', undefined, signal)
    if (!isDeepStrictEqual(assignment.dispatch.command.operation, scope.operation)) throw new Error('Assignment frozen output home scope mismatch')
    await runtime.verificationArchive?.flush()
    const outputs = readAssignmentOutputs(runtime, assignment)
    if (!outputs) return null
    const receipt = await assignmentHomeCall(runtime.client, scope, 'outputs', { request_id: `outputs-${id}`, command: assignment.dispatch.command, outputs }, signal)
    if (receipt.assignment_id !== id || receipt.state !== 'outputs_declared' || receipt.completion_authorized !== false
        || !isDeepStrictEqual(receipt.outputs, outputs) || !isDeepStrictEqual(receipt.operation, scope.operation)
        || !isDeepStrictEqual(receipt.worker, assignment.worker) || receipt.context_hash !== assignment.context_hash
        || receipt.authorization_hash !== assignment.authorization_hash || receipt.stage_attempt !== assignment.stage_attempt) throw new Error('Assignment output declaration receipt mismatch')
    return receipt
  }
  stop(id, { homeScope } = {}) {
    if (this.closed) return Promise.reject(new Error('Assignment dispatcher closed'))
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(id)) return Promise.reject(new Error('Invalid Assignment identity'))
    const scope = homeScope ? structuredClone(homeScope) : null
    if (this.stopping.has(id)) {
      if (!isDeepStrictEqual(this.stopScopes.get(id), scope)) return Promise.reject(new Error('Assignment pending stop home scope conflict'))
      return this.stopping.get(id)
    }
    const task = this.stopOwned(id, scope)
    this.stopScopes.set(id, scope)
    this.stopping.set(id, task)
    task.finally(() => { if (this.stopping.get(id) === task) { this.stopping.delete(id); this.stopScopes.delete(id) } }).catch(() => {})
    return task
  }
  async stopOwned(id, homeScope) {
    await this.pending.get(id)
    const runtime = this.host.execution, profiles = runtime.profiles, client = runtime.client
    const path = `${prefix}work-assignments/${encodeURIComponent(id)}`
    const scope = homeScope ? { id, host: runtime.host, worker: homeScope.worker_session, operation: homeScope.operation } : null
    if (scope && (!scope.operation?.home_node || scope.operation.home_node === runtime.host)) throw new Error('Explicit remote Assignment home required')
    const assignment = scope ? await assignmentHomeCall(client, scope, 'context') : await client.call(path)
    if (scope && !isDeepStrictEqual(assignment.dispatch.command.operation, scope.operation)) throw new Error('Assignment frozen stop home scope mismatch')
    const session = assignment.worker.session_id, command = assignment.dispatch.command
    if (assignment.id !== id || assignment.worker.node_id !== runtime.host || assignment.creation?.state !== 'created') throw new Error('Assignment stop requires owned creation')
    let binding = profiles.binding(session)
    const run = await readAssignmentRun(runtime, { id: session }, binding, assignment)
    // A proof captured before interruption may carry the old epoch. Preserve an
    // already-issued stop request for exact replay and omit new completion proofs.
    const interrupting = ['cancelling', 'cancel_unconfirmed', 'taking_over'].includes(run.state)
    const finalArtifact = binding?.assignmentStop ? binding.assignmentStop.request.final_artifact : interrupting ? undefined : binding?.finalArtifact
    const finalInput = binding?.assignmentStop ? binding.assignmentStop.request.final_input : interrupting ? undefined : binding?.finalInput
    const request = { request_id: `stop-${id}`, command, kind: scope ? 'official_remote_drained' : 'official_local_drained', ...(finalArtifact ? { final_artifact: finalArtifact } : {}), ...(finalInput ? { final_input: finalInput } : {}) }
    if (!isDeepStrictEqual(binding?.managedAssignment, { id }) || !isDeepStrictEqual(binding?.managedOperation, command.operation)) throw new Error('Assignment stop binding changed')
    if (binding.assignmentStop && !isDeepStrictEqual(binding.assignmentStop.request, request)) throw new Error('Assignment stop identity conflict')
    if (binding.assignmentStop?.state !== 'drained') {
      const owned = this.host.handles.get(session)
      if (!owned) throw new Error('Assignment stop recovery requires actual execution ownership')
      await profiles.patchBinding(session, { assignmentStop: { request, state: 'stopping' } })
      await owned.dispose()
      await profiles.update(state => {
        const current = state.bindings[session]
        if (!isDeepStrictEqual(current?.assignmentStop?.request, request)
            || !isDeepStrictEqual(current?.managedOperation, command.operation)
            || !isDeepStrictEqual(current?.managedAssignment, { id })) throw new Error('Assignment stop binding changed during drain')
        current.operationClosed = true
        current.assignmentStop = { request, state: 'drained', observed_at: Date.now() }
      })
      binding = profiles.binding(session)
    }
    if (!binding.operationClosed || this.host.handles.has(session)) throw new Error('Assignment stop not durably closed')
    const receipt = scope ? await assignmentHomeCall(client, scope, 'stop', binding.assignmentStop.request) : await client.call(`${path}/stop-receipt`, binding.assignmentStop.request)
    if (receipt.assignment_id !== id || receipt.session_id !== session || receipt.state !== 'execution_drained') throw new Error('Assignment stop receipt mismatch')
    return receipt
  }
  drain({ prepare } = {}) {
    if (this.draining) return this.draining
    if (this.closed) return Promise.reject(new Error('Assignment dispatcher closed'))
    if (typeof prepare !== 'function') return Promise.reject(new Error('Trusted Assignment tool preparation required'))
    const task = this.scan(prepare)
    this.draining = task
    task.finally(() => { if (this.draining === task) this.draining = undefined }).catch(() => {})
    return task
  }
  async scan(prepare) {
    const runtime = this.host.execution, results = []
    let after
    do {
      const query = new URLSearchParams({ host: runtime.host, ...(after ? { after } : {}) })
      const page = await runtime.client.call(`${prefix}assignment-dispatches?${query}`, undefined, this.host.stop.signal)
      for (const assignment of page.items) {
        if (this.closed) return results
        try {
          const options = await prepare(structuredClone(assignment))
          if (!options) { results.push({ assignment_id: assignment.id, state: 'unsupported' }); continue }
          results.push(await this.dispatch(assignment.id, options))
        } catch { results.push({ assignment_id: assignment.id, state: 'delivery_failed' }) }
      }
      if (page.next_cursor && page.next_cursor === after) throw new Error('Assignment dispatch cursor did not advance')
      after = page.next_cursor
    } while (after)
    return results
  }
  async close() { this.closed = true; await Promise.allSettled([this.draining, ...this.pending.values(), ...this.stopping.values()].filter(Boolean)) }
}

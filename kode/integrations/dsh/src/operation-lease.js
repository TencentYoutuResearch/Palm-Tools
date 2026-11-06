import { isDeepStrictEqual } from 'node:util'
/** Conservative local lease deadline. Network failure never grants execution time. */
import { performance } from 'node:perf_hooks'
export async function acquireOperationLease(client, binding, worker, { leaseMs = 30000, signal, beforeClaim } = {}) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 60000) throw new Error('Invalid local lease duration')
  const path = `/api/v1/messaging/operations/${encodeURIComponent(binding.id)}`
  const call = (command, requestSignal) => binding.home_node && binding.home_node !== worker.node_id
    ? client.call(`/api/v1/messaging/operation-relay/${encodeURIComponent(binding.home_node)}`, { operation_id: binding.id, worker_session: worker.session_id, command: command ?? null }, requestSignal)
    : client.call(path, command, requestSignal)
  const abort = new AbortController()
  let selectionPolicy, row, deadline = 0, expiry, renewal, closed = false, chain = Promise.resolve()
  const serial = task => { const pending = chain.then(task); chain = pending.catch(() => {}); return pending }
  const stop = error => { clearTimeout(expiry); clearTimeout(renewal); abort.abort(error) }
  const parentAbort = () => stop(signal.reason)
  signal?.addEventListener('abort', parentAbort, { once: true })
  const requestSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
  const validate = (value, state, execution = true) => {
    if (value.id !== binding.id || value.attempt !== binding.attempt || value.epoch !== binding.epoch || value.worker.node_id !== worker.node_id || value.worker.session_id !== worker.session_id || value.state !== state) throw new Error('Operation lease identity or state changed')
    if (value.grant_required && worker.grant_enforcement !== true) throw Object.assign(new Error('Executor cannot enforce this operation grant'), { code: 'grant_enforcement_unsupported' })
    if (value.resource_required && (!worker.profile_id || value.resource?.profile !== worker.profile_id || value.resource?.host !== worker.node_id)) throw new Error('Operation execution resource does not match this Worker')
    if (value.resource_required && !['account_epoch', 'binding_revision'].every(key => Number.isSafeInteger(value.resource[key]) && value.resource[key] > 0)) throw new Error('Operation resource version is unproven')
    if (execution && state === 'active' && value.grant_required && value.grant_available !== true) throw new Error('Operation grant is not available')
    if (execution && state === 'active' && value.resource_required && value.resource_available !== true) throw new Error('Operation resource is not available')
    if (execution && state === 'active' && value.budget_required && value.budget_available !== true) throw new Error('Operation budget is not available')
    if (selectionPolicy !== undefined && !isDeepStrictEqual(value.selection_policy ?? null, selectionPolicy)) throw new Error('Operation selection policy changed')
    return value
  }
  const arm = (started, duration = leaseMs) => {
    if (!Number.isSafeInteger(duration) || duration <= 0 || duration > leaseMs) throw new Error('Invalid granted lease duration')
    deadline = started + duration
    clearTimeout(expiry)
    expiry = setTimeout(() => stop(new Error('Operation lease expired locally')), Math.max(0, deadline - performance.now()))
  }
  const current = async (execution = true) => {
    requestSignal.throwIfAborted()
    if (closed || performance.now() >= deadline) throw new Error('Operation lease is not active')
    row = validate(await call(undefined, requestSignal), 'active', execution)
    requestSignal.throwIfAborted()
    if (performance.now() >= deadline) throw new Error('Operation lease expired during validation')
    return row
  }
  const command = action => ({ ...(selectionPolicy && ['claim', 'renew', 'claim_resource', 'renew_resource'].includes(action.kind) ? { selection_ack: structuredClone(selectionPolicy) } : {}), attempt: row.attempt, epoch: row.epoch, expected_revision: row.revision, action })
  const leaseAction = kind => row.resource_required
    ? { kind: `${kind}_resource`, lease_ms: leaseMs, resource: { profile: worker.profile_id, account_epoch: row.resource.account_epoch, binding_revision: row.resource.binding_revision } }
    : { kind, lease_ms: leaseMs }
  const schedule = () => {
    renewal = setTimeout(() => {
      void serial(async () => {
        await current()
        const started = performance.now()
        const result = await call(command(leaseAction('renew')), requestSignal)
        requestSignal.throwIfAborted()
        if (!result.applied) throw new Error('Operation renewal rejected')
        row = validate(result.operation, 'active'); arm(started, row.lease_duration_ms ?? (row.budget_required || row.resource_required ? 0 : leaseMs)); schedule()
      }).catch(stop)
    }, Math.max(1, Math.floor(Math.min(leaseMs, deadline - performance.now()) / 3)))
  }
  try {
    requestSignal.throwIfAborted()
    row = validate(await call(undefined, requestSignal), 'prepared')
    selectionPolicy = structuredClone(row.selection_policy ?? null)
    if (selectionPolicy && (typeof beforeClaim !== 'function' || await beforeClaim(structuredClone(selectionPolicy)) !== true)) throw Object.assign(new Error('Executor cannot enforce this selection policy before claim'), { code: 'selection_enforcement_unsupported' })
    requestSignal.throwIfAborted()
    const started = performance.now()
    // Bound the claim itself. A lost response can leave active on the Hub, but
    // this process never submits work until the exact claim response is checked.
    arm(started)
    const result = await call(command(leaseAction('claim')), requestSignal)
    requestSignal.throwIfAborted()
    if (!result.applied) throw new Error('Operation claim rejected')
    row = validate(result.operation, 'active'); arm(started, row.lease_duration_ms ?? (row.budget_required || row.resource_required ? 0 : leaseMs)); schedule()
  } catch (error) { signal?.removeEventListener('abort', parentAbort); stop(error); throw error }
  return {
    get selectionPolicy() { return structuredClone(selectionPolicy) },
    signal: requestSignal,
    assertActive: () => serial(current).catch(error => { stop(error); throw error }),
    // Report admission is checked authoritatively by the Hub, separately from
    // availability for new work. Never revive an aborted or expired local lease.
    assertReportable: () => serial(() => current(false)).catch(error => { stop(error); throw error }),
    finish: () => serial(async () => {
      await current(false)
      const result = await call(command({ kind: 'report', report_id: `turn-${binding.attempt}-${binding.epoch}`, content: 'Native turn returned; independent review and verification remain required.' }), requestSignal)
      if (!result.applied) throw new Error('Operation report was not accepted')
      validate(result.operation, 'reported')
      closed = true; clearTimeout(expiry); clearTimeout(renewal)
      return result
    }).catch(error => { stop(error); throw error }),
    dispose: () => { signal?.removeEventListener('abort', parentAbort); closed = true; stop(new Error('Operation execution ended')) },
  }
}

const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
const reason = '用户在 IM 请求重新检查当前任务的执行条件'
export const executionRecheckKey = run => JSON.stringify(['execution-recheck', run.home_hub, run.team_id, run.id])
function verify(record, run) {
  const c = record?.command
  if (!record || !valid(record.request_id) || record.home_hub !== run.home_hub || record.team_id !== run.team_id || !['prepared', 'accepted', 'obsolete'].includes(record.state)
      || c?.run_id !== run.id || c.action !== 'recheck_execution' || !Number.isSafeInteger(c.expected_revision) || c.expected_revision < 1 || c.reason !== reason
      || Object.keys(c).sort().join(',') !== 'action,expected_revision,reason,run_id') throw Error('Wrong execution recheck scope')
  return record
}
function verifyReceipt(result, record, run) {
  const intent = result?.execution_recheck, c = record.command
  if (result?.id !== run.id || result.home_hub !== run.home_hub || result.team_id !== run.team_id || result.revision !== c.expected_revision + 1
      || !['queued', 'running', 'waiting_resource'].includes(result.state) || result.completion_authorized !== false || result.cancellation != null
      || intent?.request_id !== record.request_id || intent.expected_revision !== c.expected_revision || intent.reason !== c.reason || intent.state !== 'requested'
      || intent.actor?.kind !== 'human' || intent.actor.id !== 'local_owner') throw Error('Execution recheck was not confirmed')
  return result
}
function verifyLookup(snapshot, record, run) {
  if (snapshot?.snapshot !== 'work_run_command_receipt.v1' || snapshot.home_hub !== run.home_hub || snapshot.run_id !== run.id || snapshot.team_id !== run.team_id || snapshot.request_id !== record.request_id
      || !Number.isSafeInteger(snapshot.run_revision) || snapshot.run_revision < record.command.expected_revision || typeof snapshot.run_state !== 'string' || !Object.hasOwn(snapshot, 'receipt')) throw Error('Wrong execution recheck receipt snapshot')
  if (snapshot.receipt !== null) {
    const expected = { ...record.command, request_id: record.request_id }; delete expected.run_id
    const actual = snapshot.receipt?.request
    if (!actual || Object.keys(actual).sort().join(',') !== Object.keys(expected).sort().join(',') || Object.keys(expected).some(key => actual[key] !== expected[key])) throw Error('Conflicting execution recheck receipt')
    verifyReceipt(snapshot.receipt.result, record, run)
    if (snapshot.receipt.result.revision > snapshot.run_revision) throw Error('Execution receipt snapshot version mismatch')
  }
  return snapshot
}
function verifyObsolete(record, run) {
  const proof = verifyLookup(record.observation, record, run)
  if (proof.receipt !== null || proof.run_revision <= record.command.expected_revision) throw Error('Obsolete execution recheck not proved')
  return { outcome: 'obsolete', observation: proof }
}
export async function resolveExecutionRecheck({ storage, run, signal, lookup = requestExecutionRecheckReceipt }) {
  const record = await readExecutionRecheck(storage, run)
  if (!record) throw Error('Saved execution recheck required')
  if (signal?.aborted) throw Error('Disposed')
  if (record.state === 'accepted') return { state: 'accepted', receipt: record.receipt }
  if (record.state === 'obsolete') return { state: 'obsolete', ...verifyObsolete(record, run) }
  const observation = verifyLookup(await lookup({ run_id: run.id, team_id: run.team_id, request_id: record.request_id }, { signal }), record, run)
  if (signal?.aborted) throw Error('Disposed')
  if (observation.receipt !== null) {
    const receipt = observation.receipt.result
    await storage.save(executionRecheckKey(run), { ...record, state: 'accepted', receipt })
    return { state: 'accepted', receipt }
  }
  if (observation.run_revision > record.command.expected_revision) {
    await storage.save(executionRecheckKey(run), { ...record, state: 'obsolete', observation })
    return { state: 'obsolete', outcome: 'obsolete', observation }
  }
  return { state: 'prepared' }
}
export async function readExecutionRecheck(storage, run) {
  const record = await storage.read(executionRecheckKey(run))
  if (!record) return null
  verify(record, run)
  if (record.state === 'accepted') verifyReceipt(record.receipt, record, run)
  if (record.state === 'obsolete') verifyObsolete(record, run)
  return record
}
export async function confirmExecutionRecheck({ storage, run, observation, request = requestExecutionRecheck, lookup = requestExecutionRecheckReceipt, recover = false, signal, onPrepared = () => {}, uuid = () => crypto.randomUUID() }) {
  const key = executionRecheckKey(run), existing = await readExecutionRecheck(storage, run)
  if (signal?.aborted) throw Error('Disposed')
  if (existing?.state === 'accepted' && (recover || existing.command.expected_revision === run.revision)) return existing.receipt
  if (recover) {
    const resolved = await resolveExecutionRecheck({ storage, run, signal, lookup })
    if (resolved.state === 'accepted') return resolved.receipt
    if (resolved.state === 'obsolete') return { outcome: 'obsolete', observation: resolved.observation }
  }
  let record = existing?.state === 'prepared' ? existing : null
  if (!record) {
    if (recover || !observation || observation.home_hub !== run.home_hub || observation.run_id !== run.id || observation.team_id !== run.team_id || observation.run_revision !== run.revision
        || observation.authority !== 'host_observation' || observation.blocked !== true || observation.retry_allowed !== true
        || !['progression_failed', 'recovery_required', 'waiting_adapter'].includes(observation.state)
        || !['queued', 'running', 'waiting_resource'].includes(run.state) || run.completion_authorized !== false || run.cancellation != null) throw Error('Current execution fence required')
    record = verify(await storage.reserve(key, { request_id: uuid(), home_hub: run.home_hub, team_id: run.team_id, state: 'prepared',
      command: { run_id: run.id, action: 'recheck_execution', expected_revision: run.revision, reason } }, prior => { if (prior.state !== 'obsolete') return false; verify(prior, run); verifyObsolete(prior, run); return true }), run)
    if (record.state === 'accepted') return verifyReceipt(record.receipt, record, run)
  }
  if (signal?.aborted) throw Error('Disposed')
  onPrepared(record)
  const result = verifyReceipt(await request({ ...record.command, request_id: record.request_id }, { signal }), record, run)
  if (signal?.aborted) throw Error('Disposed')
  await storage.save(key, { ...record, state: 'accepted', receipt: result })
  return result
}
export async function requestExecutionRecheck(command, { signal } = {}) {
  const response = await fetch('/api/kode/work-run', { method: 'POST', credentials: 'same-origin', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) })
  if (!response.ok) throw Error('Execution recheck not confirmed')
  return response.json()
}

export async function requestExecutionRecheckReceipt({ run_id, team_id, request_id }, { signal } = {}) {
  const query = new URLSearchParams({ run_id, team_id, request_id })
  const response = await fetch('/api/kode/work-run/receipt?' + query, { method: 'GET', credentials: 'same-origin', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })
  if (!response.ok) throw Error('Execution recheck receipt unavailable')
  return response.json()
}

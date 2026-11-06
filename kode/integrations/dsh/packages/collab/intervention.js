import { requestExecutionRecheckReceipt } from './execution-recheck.js'
const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
const actions = new Set(['takeover', 'resume'])
export const interventionKey = run => JSON.stringify(['work-run-intervention', run.home_hub, run.team_id, run.id])
export function interventionAllowed(run, action) {
  return run.completion_authorized === false && run.cancellation == null && (action === 'takeover'
    ? ['waiting_user', 'waiting_resource', 'queued', 'running'].includes(run.state)
    : action === 'resume' && run.state === 'paused' && run.intervention?.stop_confirmed === true
      && run.intervention.resources_released === true && run.intervention.accounting === 'finalized')
}
function verify(record, run) {
  const command = record?.command
  if (!record || !valid(record.request_id) || record.home_hub !== run.home_hub || record.team_id !== run.team_id
    || !['prepared', 'accepted', 'obsolete'].includes(record.state) || command?.run_id !== run.id || !actions.has(command.action)
    || !Number.isSafeInteger(command.expected_revision) || command.expected_revision < 1 || typeof command.reason !== 'string'
    || !command.reason.trim() || command.reason.includes('\0') || new TextEncoder().encode(command.reason).length > 2048
    || Object.keys(command).sort().join(',') !== 'action,expected_revision,reason,run_id') throw Error('Wrong intervention scope')
  return record
}
function resultFor(result, record, run) {
  const command = record.command, intent = command.action === 'takeover' ? result?.intervention : result?.intervention?.resume
  if (result?.id !== run.id || result.home_hub !== run.home_hub || result.team_id !== run.team_id
    || result.revision !== command.expected_revision + 1 || result.completion_authorized !== false || result.cancellation != null
    || result.state !== (command.action === 'takeover' ? 'taking_over' : 'waiting_resource')
    || intent?.request_id !== record.request_id || intent.reason !== command.reason || intent.actor?.kind !== 'human'
    || intent.actor.id !== 'local_owner') throw Error('Intervention not confirmed')
  if (command.action === 'resume' && (intent.evidence_policy !== 'all_stages_revalidate' || intent.execution_authorized !== false
    || !Array.isArray(result.stages) || result.stages.some(stage => stage.state !== 'pending' || stage.assignment_id !== null || stage.evidence != null))) throw Error('Resume evidence not invalidated')
  return result
}
function lookupFor(snapshot, record, run) {
  if (snapshot?.snapshot !== 'work_run_command_receipt.v1' || snapshot.home_hub !== run.home_hub || snapshot.team_id !== run.team_id
    || snapshot.run_id !== run.id || snapshot.request_id !== record.request_id || !Number.isSafeInteger(snapshot.run_revision)
    || snapshot.run_revision < record.command.expected_revision || !Object.hasOwn(snapshot, 'receipt')) throw Error('Wrong intervention receipt scope')
  if (snapshot.receipt !== null) {
    const expected = { ...record.command, request_id: record.request_id }; delete expected.run_id
    const actual = snapshot.receipt?.request
    if (!actual || Object.keys(actual).sort().join(',') !== Object.keys(expected).sort().join(',')
      || Object.keys(expected).some(key => expected[key] !== actual[key])) throw Error('Conflicting intervention receipt')
    if (resultFor(snapshot.receipt.result, record, run).revision > snapshot.run_revision) throw Error('Invalid intervention receipt version')
  }
  return snapshot
}
export async function readIntervention(storage, run) {
  const record = await storage.read(interventionKey(run))
  if (!record) return null
  verify(record, run)
  if (record.state === 'accepted') resultFor(record.receipt, record, run)
  if (record.state === 'obsolete') {
    const snapshot = lookupFor(record.observation, record, run)
    if (snapshot.receipt !== null || snapshot.run_revision <= record.command.expected_revision) throw Error('Unproven obsolete intervention')
  }
  return record
}
export async function confirmIntervention({ storage, run, action, reason, recover = false, signal,
  request = requestIntervention, lookup = requestExecutionRecheckReceipt, uuid = () => crypto.randomUUID(), onPrepared = () => {} }) {
  const key = interventionKey(run)
  let record = await readIntervention(storage, run)
  signal?.throwIfAborted()
  if (recover && record?.state === 'accepted') return record.receipt
  if (recover && record?.state === 'obsolete') return { outcome: 'obsolete' }
  if (record?.state !== 'prepared') {
    if (recover || !interventionAllowed(run, action)) throw Error('Intervention requires current owner decision')
    const prepared = verify({ request_id: uuid(), home_hub: run.home_hub, team_id: run.team_id, state: 'prepared',
      command: { run_id: run.id, action, expected_revision: run.revision, reason } }, run)
    record = verify(await storage.reserve(key, prepared, current => current.state === 'obsolete'), run)
  }
  signal?.throwIfAborted(); onPrepared(record)
  const observation = lookupFor(await lookup({ run_id: run.id, team_id: run.team_id, request_id: record.request_id }, { signal }), record, run)
  signal?.throwIfAborted()
  if (observation.receipt === null && observation.run_revision > record.command.expected_revision) {
    await storage.save(key, { ...record, state: 'obsolete', observation })
    return { outcome: 'obsolete' }
  }
  const receipt = observation.receipt?.result ?? resultFor(await request({ ...record.command, request_id: record.request_id }, { signal }), record, run)
  signal?.throwIfAborted()
  await storage.save(key, { ...record, state: 'accepted', receipt })
  return receipt
}
export async function requestIntervention(command, { signal } = {}) {
  const response = await fetch('/api/kode/work-run', { method: 'POST', credentials: 'same-origin', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) })
  if (!response.ok) throw Error('Intervention not confirmed')
  return response.json()
}

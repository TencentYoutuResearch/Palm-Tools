/** Owner-reviewed consent is durable before transport; ambiguous requests retain identity. */
import { canonical } from './builder-accept-command.js'
const equal = (a, b) => canonical(a) === canonical(b)
const valid = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(v)
export const stageWaiverKey = (run, stage) => JSON.stringify(['stage-waiver', run.home_hub, run.team_id, run.id, stage])
export function verifyStageWaiver(record, result) {
  const command = record.command, stage = result?.stages?.find(s => s.stage_id === command.stage_id), decision = stage?.waiver
  if (result?.id !== command.run_id || result.home_hub !== record.home_hub || result.team_id !== record.team_id
    || result.revision !== command.expected_revision + 1 || result.completion_authorized !== false
    || result.state !== (record.plan.scope.policy.allow_delivery ? 'queued' : 'waiting_user')
    || stage?.state !== 'waived' || decision?.request_id !== command.request_id || decision.scope_hash !== command.scope_hash
    || decision.reason !== command.reason || !equal(decision.scope, record.plan.scope)
    || !equal(decision.actor, { kind: 'human', id: 'local_owner' })) throw Error('Invalid stage waiver receipt')
  return result
}
export async function confirmStageWaiver({ run, stage, plan, reason, storage, recover = false, request = requestStageWaiver, signal, uuid = () => crypto.randomUUID() }) {
  if (![run?.id, run?.home_hub, run?.team_id, stage].every(valid)) throw Error('Invalid waiver identity')
  const key = stageWaiverKey(run, stage), existing = await storage.read(key)
  let record
  if (recover) {
    if (existing?.state !== 'prepared') throw Error('No pending waiver decision')
    record = existing
  } else {
    if (plan?.run_id !== run.id || plan.stage_id !== stage || plan.run_revision !== run.revision || plan.completion_authorized !== false
      || !Number.isSafeInteger(run.revision) || run.revision < 1 || !/^[a-f0-9]{64}$/.test(plan.scope_hash ?? '')
      || plan.scope?.run_id !== run.id || plan.scope?.stage_id !== stage || typeof plan.scope?.policy?.allow_delivery !== 'boolean'
      || typeof reason !== 'string' || !reason.trim() || reason.includes('\0') || new TextEncoder().encode(reason).length > 2048) throw Error('Waiver review changed or reason invalid')
    if (existing?.state === 'prepared') throw Error('Recover the original waiver decision before reviewing another')
    const requestId = uuid()
    const proposed = structuredClone({ request_id: requestId, state: 'prepared', home_hub: run.home_hub, team_id: run.team_id, plan,
      command: { run_id: run.id, stage_id: stage, request_id: requestId, expected_revision: run.revision, scope_hash: plan.scope_hash, reason } })
    record = await storage.reserve(key, proposed, old => old.state === 'accepted' || old.state === 'stale')
    if (!equal(record, proposed)) throw Error('A different waiver decision was reserved')
  }
  if (record.home_hub !== run.home_hub || record.team_id !== run.team_id || record.command?.run_id !== run.id
    || record.command.stage_id !== stage || record.request_id !== record.command.request_id || !valid(record.command.request_id)) throw Error('Wrong waiver recovery scope')
  signal?.throwIfAborted()
  const result = verifyStageWaiver(record, await request(record, { signal }))
  await storage.save(key, { ...record, state: 'accepted', receipt: result })
  return result
}
export async function requestStageWaiver(record, { signal, fetcher = globalThis.fetch } = {}) {
  const options = { credentials: 'same-origin', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }
  const command = record.command, { run_id, stage_id, ...input } = command
  const query = new URLSearchParams({ run_id, stage_id, request_id: command.request_id })
  const response = await fetcher('/api/kode/work-run/waiver?' + query, options)
  if (!response.ok) throw Error('Waiver receipt lookup unavailable')
  const saved = await response.json()
  if (!saved || !Object.hasOwn(saved, 'receipt')) throw Error('Invalid waiver receipt lookup')
  if (saved.receipt !== null) {
    if (!equal(saved.receipt.request, { action: 'waive_stage', stage_id, input })) throw Error('Waiver request identity conflict')
    return saved.receipt.result
  }
  const posted = await fetcher('/api/kode/work-run/waiver', { ...options, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) })
  if (!posted.ok) throw Error('Waiver was not confirmed; recover the original decision')
  return posted.json()
}

/** A newer Hub revision fences the old command; a second receipt read closes the commit race. */
export async function resolveStageWaiver({ run, stage, storage, signal, fetcher = globalThis.fetch }) {
  const key = stageWaiverKey(run, stage), record = await storage.read(key)
  if (record?.state !== 'prepared' || record.home_hub !== run.home_hub || record.team_id !== run.team_id
    || record.command?.run_id !== run.id || record.command.stage_id !== stage) throw Error('No matching pending waiver')
  const options = { credentials: 'same-origin', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }
  const { run_id, stage_id, ...input } = record.command
  const lookup = async () => {
    const response = await fetcher('/api/kode/work-run/waiver?' + new URLSearchParams({ run_id, stage_id, request_id: input.request_id }), options)
    if (!response.ok) throw Error('Waiver receipt lookup unavailable')
    const value = await response.json()
    if (!value || !Object.hasOwn(value, 'receipt')) throw Error('Invalid waiver receipt lookup')
    if (value.receipt === null) return null
    if (!equal(value.receipt.request, { action: 'waive_stage', stage_id, input })) throw Error('Waiver identity conflict')
    return verifyStageWaiver(record, value.receipt.result)
  }
  let receipt = await lookup()
  if (!receipt) {
    const response = await fetcher('/api/kode/work-run?' + new URLSearchParams({ run_id }), options)
    if (!response.ok) throw Error('Current run unavailable')
    const current = await response.json()
    if (current.id !== run_id || current.home_hub !== record.home_hub || current.team_id !== record.team_id
      || !Number.isSafeInteger(current.revision) || current.revision <= input.expected_revision) throw Error('Original waiver can still be submitted; recover it first')
    receipt = await lookup()
    if (!receipt) {
      const stale = { ...record, state: 'stale', superseded_by_revision: current.revision }
      await storage.save(key, stale)
      return stale
    }
  }
  const accepted = { ...record, state: 'accepted', receipt }
  await storage.save(key, accepted)
  return accepted
}

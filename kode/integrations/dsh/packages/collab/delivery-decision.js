export const deliveryDecisionKey = run => JSON.stringify(['delivery-decision', run.home_hub, run.team_id, run.id, run.human_acceptance?.revision, run.human_acceptance?.evidence_hash])
const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
function validateReceipt(run, pending, result) {
  const command = pending.command, decision = result?.human_acceptance?.decision
  if (result?.id !== run.id || result.home_hub !== run.home_hub || result.team_id !== run.team_id
    || result.revision !== command.expected_revision + 1 || result.completion_authorized !== false
    || result.state !== (command.choice === 'accept' ? 'queued' : 'waiting_user')
    || result.human_acceptance?.state !== (command.choice === 'accept' ? 'accepted' : 'rejected')
    || result.human_acceptance?.evidence_hash !== command.evidence_hash
    || decision?.request_id !== pending.request_id || decision.choice !== command.choice || decision.reason !== command.reason
    || decision.evidence_hash !== command.evidence_hash || decision.actor?.kind !== 'human' || decision.actor.id !== 'local_owner') throw Error('Invalid delivery decision receipt')
  return result
}
export async function decideDelivery({ storage, run, choice, reason, request = requestDeliveryDecision, signal, uuid = () => crypto.randomUUID() }) {
  if (![run?.id, run?.home_hub, run?.team_id].every(valid) || !/^[a-f0-9]{64}$/.test(run.human_acceptance?.evidence_hash ?? '')
    || !Number.isSafeInteger(run.human_acceptance?.revision) || run.human_acceptance.revision < 1
    || !['accept', 'reject'].includes(choice) || typeof reason !== 'string' || !reason.trim() || reason.includes('\0') || new TextEncoder().encode(reason).length > 2048) throw Error('Invalid delivery decision')
  const key = deliveryDecisionKey(run), existing = await storage.read(key)
  if (!existing && (run.state !== 'waiting_user' || run.waiting_reason !== 'human_delivery_acceptance_required'
    || run.human_acceptance.state !== 'pending' || run.revision !== run.human_acceptance.revision)) throw Error('Delivery acceptance is not pending')
  const pending = existing ?? await storage.reserve(key, { request_id: uuid(), home_hub: run.home_hub, team_id: run.team_id, state: 'prepared',
    command: { run_id: run.id, expected_revision: run.human_acceptance.revision, evidence_hash: run.human_acceptance.evidence_hash, choice, reason } })
  if (!valid(pending.request_id) || pending.home_hub !== run.home_hub || pending.team_id !== run.team_id || pending.command?.run_id !== run.id
    || pending.command.evidence_hash !== run.human_acceptance.evidence_hash || pending.command.expected_revision !== run.human_acceptance.revision
    || pending.command.choice !== choice || pending.command.reason !== reason) throw Error('A different decision is pending; recover the original decision')
  signal?.throwIfAborted()
  if (pending.state === 'accepted') return validateReceipt(run, pending, pending.receipt)
  const result = validateReceipt(run, pending, await request({ ...pending.command, request_id: pending.request_id }, { signal }))
  await storage.save(key, { ...pending, state: 'accepted', receipt: result })
  return result
}
export async function requestDeliveryDecision(command, { signal, fetcher = globalThis.fetch } = {}) {
  const response = await fetcher('/api/kode/work-run/decision', { method: 'POST', credentials: 'same-origin', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) })
  if (!response.ok) throw Error('Delivery decision was not confirmed')
  return response.json()
}

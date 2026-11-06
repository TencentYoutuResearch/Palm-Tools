export const builderAcceptKey = draft => JSON.stringify(['builder-accept', draft.home_hub, draft.id])
export const canonical = value => JSON.stringify(value, function (_, item) { return item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item })
export async function acceptBuilderProposal({ storage, draft, teamId, request, signal, uuid = () => crypto.randomUUID() }) {
  const key = builderAcceptKey(draft)
  const pending = await storage.reserve(key, { request_id: uuid(), state: 'prepared', home_hub: draft.home_hub, proposal: draft.interview.proposed_team,
    command: { draft_id: draft.id, expected_revision: draft.revision, team_id: teamId, team_revision: 0 } })
  if (signal?.aborted) throw Error('Disposed')
  if (pending.home_hub !== draft.home_hub || pending.command?.draft_id !== draft.id) throw Error('Wrong proposal scope')
  const command = { ...pending.command, request_id: pending.request_id }
  const result = pending.state === 'saved' ? pending.receipt : await request(command, { signal })
  if (result.home_hub !== draft.home_hub || result.draft_id !== draft.id || result.draft_revision !== command.expected_revision
    || result.activation_performed !== false || result.eligible_for_execution !== false || result.actor?.kind !== 'human'
    || ['request_id', 'expected_revision', 'team_id', 'team_revision'].some(key => result.request?.[key] !== command[key])
    || result.team?.id !== command.team_id || result.team.home_hub !== draft.home_hub || result.team.revision !== 1 || result.team.status !== 'draft'
    || canonical(result.team.spec) !== canonical(pending.proposal)) throw Error('Invalid proposal acceptance receipt')
  if (pending.state !== 'saved') await storage.save(key, { ...pending, state: 'saved', receipt: result })
  return result
}
export async function requestBuilderAccept(command, { signal } = {}) {
  const controller = new AbortController(), abort = () => controller.abort()
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 15000)
  try {
    const response = await fetch('/api/kode/builder/accept-proposal', { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) })
    if (!response.ok) throw Error('Proposal acceptance unconfirmed')
    return await response.json()
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

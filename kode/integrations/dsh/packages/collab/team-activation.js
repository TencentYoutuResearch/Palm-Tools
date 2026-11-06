import { canonical } from './builder-accept-command.js'
export const activationKey = team => JSON.stringify(['team-activation', team.home_hub, team.id])
export async function teamActivationRequest(path, input, { signal } = {}) {
  if (!['activation-review', 'activation'].includes(path)) throw Error('Unsupported team action')
  const controller = new AbortController(), abort = () => controller.abort()
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 15000)
  try {
    const response = await fetch(`/api/kode/teams/${path}`, { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    if (!response.ok) throw Error('Team action not confirmed')
    return await response.json()
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
export async function activateReviewedTeam({ storage, team, review, request, signal }) {
  const key = activationKey(team)
  const pending = await storage.reserve(key, { request_id: review.prepared_command.request_id, home_hub: team.home_hub, state: 'prepared', command: { team_id: team.id, command: review.prepared_command } }, current => {
    if (current.state !== 'activated') return false
    verifyActivationReceipt(current.receipt, team, current.command.command)
    const previous = review.activation
    return previous && activationNeedsConfirmation(review) && previous.home_hub === team.home_hub && previous.team_id === team.id
      && Number.isSafeInteger(previous.revision) && previous.revision >= current.receipt.revision
      && previous.revision === review.prepared_command.expected_revision
  })
  if (signal?.aborted) throw Error('Disposed')
  if (pending.home_hub !== team.home_hub || pending.command?.team_id !== team.id) throw Error('Wrong activation scope')
  const result = pending.state === 'activated' ? pending.receipt : await request(pending.command, { signal })
  const command = pending.command.command
  verifyActivationReceipt(result, team, command)
  if (pending.state !== 'activated') await storage.save(key, { ...pending, state: 'activated', receipt: result })
  return result
}

export function verifyActivationReceipt(result, team, command) {
  if (!result || result.team_id !== team.id || result.home_hub !== team.home_hub || result.team_revision !== command.team_revision || result.revision !== command.expected_revision + 1
    || result.active !== true || result.actor?.kind !== 'human' || result.snapshot?.grant?.revision !== command.grant_revision
    || ['budget', 'scheduling'].some(kind => {
      const value = result.snapshot?.policies?.[kind]
      return canonical({ id: value?.id, revision: value?.revision, hash: value?.hash }) !== canonical(command[`${kind}_policy`])
    })) throw Error('Invalid activation receipt')
  return result
}

export function activationNeedsConfirmation(review) {
  const value = review?.activation, command = review?.prepared_command
  if (!value?.active) return true
  if (!command) return false
  return value.team_revision !== command.team_revision || value.snapshot?.grant?.revision !== command.grant_revision
    || ['budget', 'scheduling'].some(kind => {
      const policy = value.snapshot?.policies?.[kind]
      return canonical({ id: policy?.id, revision: policy?.revision, hash: policy?.hash }) !== canonical(command[`${kind}_policy`])
    })
}

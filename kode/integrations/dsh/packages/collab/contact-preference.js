export const contactPreferenceKey = team => JSON.stringify(['contact-preference', team.home_hub, team.id])
const actions = ['pin', 'unpin', 'archive', 'unarchive']

function verifyPreference(value) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.pinned !== 'boolean' || typeof value.archived !== 'boolean'
    || !Number.isSafeInteger(value.archived_through_sequence) || value.archived_through_sequence < 0) throw Error('Invalid contact preference')
  return value
}

export function verifyContactIntent(value, team) {
  if (!value || value.home_hub !== team.home_hub || value.team_id !== team.id
    || !['prepared', 'accepted'].includes(value.state) || value.request_id !== value.command?.request_id
    || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value.request_id) || !actions.includes(value.command.action)
    || !Number.isSafeInteger(value.command.expected_revision) || value.command.expected_revision < 0) throw Error('Invalid contact preference intent')
  return value
}

async function requestContact(team, requestId, { command, signal, fetcher }) {
  const query = new URLSearchParams({ view: 'contact-preference', team_id: team.id })
  if (!command) query.set('request_id', requestId)
  const response = await fetcher(`/api/kode/collab/teams?${query}`, {
    method: command ? 'POST' : 'GET', credentials: 'same-origin', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    ...(command ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) } : {}),
  })
  if (!response.ok) throw Error('Contact preference result unavailable')
  const result = await response.json()
  if (result.home_hub !== team.home_hub || result.team_id !== team.id || result.principal_id !== 'local_owner') throw Error('Foreign contact preference result')
  verifyPreference(result.preference)
  return result
}

export async function changeContactPreference({ storage, team, action, requestId, signal, fetcher = globalThis.fetch }) {
  if (!actions.includes(action)) throw Error('Invalid contact preference action')
  const before = verifyPreference(team.contact?.preference)
  const key = contactPreferenceKey(team)
  const pending = verifyContactIntent(await storage.reserve(key, {
    state: 'prepared', home_hub: team.home_hub, team_id: team.id, request_id: requestId,
    command: { request_id: requestId, expected_revision: before.revision, action },
  }), team)
  signal?.throwIfAborted()
  const recover = async () => {
    const status = await requestContact(team, pending.request_id, { signal, fetcher })
    if (status.request_id !== pending.request_id) throw Error('Contact receipt identity mismatch')
    if (status.receipt) {
      const saved = status.receipt.request
      if (!saved || Object.keys(saved).sort().join(',') !== 'action,expected_revision,request_id'
        || ['action', 'expected_revision', 'request_id'].some(key => saved[key] !== pending.command[key])) throw Error('Contact receipt command mismatch')
      return status.receipt.result
    }
    if (status.receipt !== null) throw Error('Invalid contact receipt absence')
    if (status.preference.revision > pending.command.expected_revision) return { ...status, superseded: true }
    if (status.preference.revision !== pending.command.expected_revision) throw Error('Contact preference revision unavailable')
    return null
  }
  let result = await recover()
  if (!result) {
    signal?.throwIfAborted()
    try { result = await requestContact(team, pending.request_id, { command: pending.command, signal, fetcher }) }
    catch (error) { result = await recover(); if (!result) throw error }
  }
  if (result.home_hub !== team.home_hub || result.team_id !== team.id || result.principal_id !== 'local_owner') throw Error('Foreign contact receipt')
  const preference = verifyPreference(result.preference)
  if (!result.superseded) {
    const field = ['pin', 'unpin'].includes(pending.command.action) ? 'pinned' : 'archived'
    const enabled = ['pin', 'archive'].includes(pending.command.action)
    if (preference.revision !== pending.command.expected_revision + 1 || preference[field] !== enabled) throw Error('Contradictory contact receipt')
  }
  await storage.save(key, { ...pending, state: 'accepted', receipt: result })
  return result
}

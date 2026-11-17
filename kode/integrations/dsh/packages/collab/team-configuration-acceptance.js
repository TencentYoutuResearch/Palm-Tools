import { canonical } from './builder-accept-command.js'
export const configurationAcceptanceKey = team => JSON.stringify(['team-configuration-acceptance', team.home_hub, team.id, team.revision])
export async function acceptanceRequest(team, command, { signal, requestId } = {}) {
  const query = new URLSearchParams({ id: team.id, ...(requestId ? { request_id: requestId } : {}) })
  const response = await fetch(`/api/kode/teams/configuration-acceptance?${query}`, {
    method: command ? 'POST' : 'GET', credentials: 'same-origin', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    ...(command ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: team.id, ...command }) } : {}),
  })
  if (!response.ok) throw Error('Configuration acceptance unconfirmed')
  return response.json()
}
export function verifyAcceptanceStatus(team, value) {
  if (value?.team_id !== team.id || value.team_revision !== team.revision || typeof value.accepted !== 'boolean'
    || !(value.parent_accepted_revision === null || (Number.isSafeInteger(value.parent_accepted_revision) && value.parent_accepted_revision > 0 && value.parent_accepted_revision < team.revision))) throw Error('Stale acceptance status')
  return value
}
export function prepareAcceptance(team, status, requestId) {
  verifyAcceptanceStatus(team, status)
  if (status.accepted || status.parent_accepted_revision === null) throw Error('Original Builder lineage required')
  verifyBuilderLineage(team, status.builder_lineage)
  return { request_id: requestId, expected_revision: team.revision, parent_accepted_revision: status.parent_accepted_revision, spec: structuredClone(team.spec) }
}
export function verifyBuilderLineage(team, lineage) {
  if (lineage?.team?.id !== team.id || lineage.home_hub !== team.home_hub || lineage.actor?.kind !== 'human'
    || !lineage.draft_id || !Number.isSafeInteger(lineage.draft_revision)) throw Error('Invalid Builder lineage')
  return lineage
}
export async function acceptConfiguration({ team, command, storage, request = acceptanceRequest, signal }) {
  if (command.expected_revision !== team.revision || canonical(command.spec) !== canonical(team.spec)) throw Error('Configuration changed')
  const key = configurationAcceptanceKey(team)
  const slot = await storage.reserve(key, { request_id: command.request_id, state: 'prepared', command })
  if (canonical(slot.command) !== canonical(command)) throw Error('Recover original acceptance request')
  if (signal?.aborted) throw Error('Disposed')
  const receipt = slot.state === 'confirmed' ? slot.receipt : await request(team, slot.command, { signal })
  verifyAcceptanceReceipt(team, slot.command, receipt)
  if (slot.state !== 'confirmed') await storage.save(key, { ...slot, state: 'confirmed', receipt })
  return receipt
}
export function verifyAcceptanceReceipt(team, command, receipt) {
  if (!receipt || receipt.home_hub !== team.home_hub || receipt.actor?.kind !== 'human'
    || receipt.activation_performed !== false || receipt.eligible_for_execution !== false
    || canonical(receipt.request) !== canonical(command) || receipt.team?.id !== team.id
    || receipt.team.home_hub !== team.home_hub || receipt.team.revision !== command.expected_revision
    || canonical(receipt.team.spec) !== canonical(command.spec) || receipt.builder_lineage?.team?.id !== team.id
    || receipt.builder_lineage.home_hub !== team.home_hub || receipt.builder_lineage.actor?.kind !== 'human'
    || !receipt.builder_lineage.draft_id || !Number.isSafeInteger(receipt.builder_lineage.draft_revision)
    || receipt.actor.id !== 'local_owner') throw Error('Invalid acceptance receipt')
  return receipt
}

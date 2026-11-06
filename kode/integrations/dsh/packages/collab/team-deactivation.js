export const deactivationKey = team => JSON.stringify(['team-deactivation', team.home_hub, team.id])
export function verifyActivationState(value, team) {
  if (!value || value.home_hub !== team.home_hub || value.team_id !== team.id || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.active !== 'boolean'
    || !Number.isSafeInteger(value.team_revision) || value.team_revision < 1 || !/^[a-f0-9]{64}$/.test(value.snapshot_hash) || value.actor?.kind !== 'human') throw Error('Invalid activation state')
  return value
}
export async function readActivationState(team, { signal } = {}) {
  const response = await fetch(`/api/kode/teams/activation?team_id=${encodeURIComponent(team.id)}`, { credentials: 'same-origin', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })
  if (!response.ok) throw Error('Activation state unavailable')
  return verifyActivationState(await response.json(), team)
}
export async function deactivateTeam({ storage, team, activation, requestId, request, signal }) {
  verifyActivationState(activation, team)
  const key = deactivationKey(team)
  const pending = await storage.reserve(key, { state: 'prepared', home_hub: team.home_hub, request_id: requestId, activation,
    command: { team_id: team.id, command: { action: 'deactivate', request_id: requestId, expected_revision: activation.revision } } })
  if (signal?.aborted) throw Error('Disposed')
  if (pending.home_hub !== team.home_hub || pending.command?.team_id !== team.id || pending.command.command.action !== 'deactivate') throw Error('Wrong deactivation scope')
  verifyActivationState(pending.activation, team)
  if (pending.command.command.expected_revision !== pending.activation.revision || pending.command.command.request_id !== pending.request_id || !pending.activation.active) throw Error('Wrong deactivation version')
  const receipt = verifyActivationState(await request(pending.command, { signal }), team)
  if (receipt.active || receipt.revision !== pending.command.command.expected_revision + 1 || receipt.team_revision !== pending.activation.team_revision || receipt.snapshot_hash !== pending.activation.snapshot_hash) throw Error('Invalid deactivation receipt')
  await storage.save(key, { ...pending, state: 'accepted', receipt })
  return receipt
}

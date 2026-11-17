import { nativeConfigurationTarget } from './team-native-target.js'
import { canonical } from './builder-accept-command.js'
import { withPrompt, promptTooLong, teamBytes, TEAM_MAX_BYTES } from './role-prompt.js'
export const configurationKey = team => JSON.stringify(['team-configuration', team.home_hub, team.id, team.revision])
/** coordinatorPrompt undefined keeps the saved instruction; a blank one omits it (never ""). */
export function prepareConfiguration(team, workers, requestId, coordinatorPrompt, edits = {}) {
  let executionTargets = structuredClone(team.spec.execution_targets)
  if (Object.keys(edits).some(key => !['name', 'purpose', 'additions', 'coordinator_targets'].includes(key))) throw Error('Unsupported configuration edit')
  for (const addition of edits.additions ?? []) {
    const target = nativeConfigurationTarget(team, addition)
    if (executionTargets.some(row => row.id === target.id)) throw Error('Duplicate target')
    executionTargets.push(target)
  }
  if (executionTargets.length > 64) throw Error('Too many targets')
  const targets = new Set(executionTargets.map(row => row.id))
  if (!Number.isSafeInteger(team.revision) || team.revision < 1 || workers.length !== team.spec.workers.length) throw Error('Invalid configuration')
  let spec = structuredClone(team.spec)
  spec.execution_targets = executionTargets
  for (const [key, limit] of [['name', 160], ['purpose', 8192]]) if (edits[key] !== undefined) {
    const value = edits[key]
    if (typeof value !== 'string' || !value.trim() || value.includes('\0') || new TextEncoder().encode(value.trim()).length > limit) throw Error('Invalid team identity')
    spec[key] = value.trim()
  }
  if (edits.coordinator_targets !== undefined) {
    const ids = edits.coordinator_targets
    if (spec.execution_mode !== 'interactive_native' || !Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !targets.has(id))) throw Error('Invalid coordinator targets')
    spec.coordinator_targets = [...ids]
  }
  if (coordinatorPrompt !== undefined) { if (promptTooLong(coordinatorPrompt)) throw Error('Invalid coordinator prompt'); spec = withPrompt(spec, 'coordinator_prompt', coordinatorPrompt) }
  spec.workers = workers.map((worker, index) => {
    const original = spec.workers[index]
    if (worker.id !== original.id || !worker.role.trim() || !worker.responsibilities.length || worker.responsibilities.some(x => !x.trim())
      || !worker.allowed_target_ids.length || new Set(worker.allowed_target_ids).size !== worker.allowed_target_ids.length || worker.allowed_target_ids.some(id => !targets.has(id))
      || !Number.isSafeInteger(worker.max_parallel) || worker.max_parallel < 1 || worker.max_parallel > 64 || promptTooLong(worker.role_prompt)) throw Error('Invalid worker configuration')
    return withPrompt({ ...original, role: worker.role.trim(), responsibilities: worker.responsibilities.map(x => x.trim()), allowed_target_ids: [...worker.allowed_target_ids], max_parallel: worker.max_parallel },
      'role_prompt', worker.role_prompt)
  })
  if (teamBytes(spec) > TEAM_MAX_BYTES) throw Error('Team too large')
  return { id: team.id, request_id: requestId, expected_revision: team.revision, spec }
}
export function verifyConfiguration(team, command, row) {
  if (!row || row.id !== team.id || row.home_hub !== team.home_hub || row.superagent_id !== team.superagent_id || row.conversation_id !== team.conversation_id
    || row.revision !== command.expected_revision + 1 || row.status !== 'draft' || row.eligible_for_execution !== false || canonical(row.spec) !== canonical(command.spec)) throw Error('Configuration receipt mismatch')
  return row
}
export async function saveConfiguration({ team, command, storage, request = requestConfiguration, signal }) {
  const key = configurationKey(team), record = await storage.reserve(key, { state: 'prepared', command })
  if (canonical(record.command) !== canonical(command)) throw Error('Recover the original pending edit')
  if (signal?.aborted) throw Error('Disposed')
  const row = verifyConfiguration(team, command, record.state === 'saved' ? record.receipt : await request(command, { signal }))
  if (record.state !== 'saved') await storage.save(key, { ...record, state: 'saved', receipt: row })
  return row
}
export async function requestConfiguration(command, { signal } = {}) {
  const response = await fetch('/api/kode/teams/configuration', { method: 'POST', credentials: 'same-origin', redirect: 'error', headers: { 'content-type': 'application/json' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), body: JSON.stringify(command) })
  if (!response.ok) throw Error('Configuration not confirmed')
  return response.json()
}

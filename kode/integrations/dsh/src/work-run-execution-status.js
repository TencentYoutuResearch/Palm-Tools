/** Host observation is separate from the authoritative Home WorkRun state. */
const final = new Set(['completed', 'failed', 'cancelled'])
const fences = new Set(['progression_failed', 'recovery_required', 'waiting_adapter', 'waiting_user', 'paused', 'waiting_accounting'])
const observations = new Set(['watching', 'retry_requested', 'waiting_remote_host',
  'evidence_selected', 'remote_resources_held', 'remote_workspace_authorized',
  'scheduled', 'stage_passed', 'started', 'waiting_consumption', 'waiting_execution',
  'waiting_outputs', 'waiting_remote_report', 'waiting_resource', 'rework_scheduled',
  'waiting_cancellation_accounting', 'cancellation_accounted', 'cancellation_execution_drained', 'waiting_remote_cancellation', 'waiting_cancellation_disposition', 'cancelling', 'cancel_unconfirmed', 'taking_over', ...fences])
const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
export function workRunExecutionStatus(service, run, home) {
  if (!run || !valid(run.id) || !valid(run.team_id) || !valid(home) || run.home_hub !== home
      || !Number.isSafeInteger(run.revision) || run.revision < 1 || typeof run.state !== 'string') throw Error('Invalid WorkRun execution scope')
  const base = { home_hub: home, run_id: run.id, team_id: run.team_id, run_revision: run.revision, authority: 'host_observation', retry_allowed: false }
  if (final.has(run.state)) return { ...base, state: 'terminal', blocked: false }
  if (!service || service.runtime?.host !== home || service.stop?.signal?.aborted) return { ...base, state: 'unavailable', blocked: null }
  const row = Object.hasOwn(service.rows ?? {}, run.id) ? service.rows[run.id] : null
  if (!row) return { ...base, state: 'not_observed', blocked: null }
  if (!Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.blocked !== 'boolean' || typeof row.state !== 'string') throw Error('Invalid Host execution observation')
  if (row.revision !== run.revision) return { ...base, state: 'stale', observed_revision: row.revision, blocked: null }
  if (fences.has(row.state) && !row.blocked) throw Error('Invalid Host recovery fence')
  if (!observations.has(row.state)) return { ...base, state: 'unrecognized', blocked: row.blocked }
  return { ...base, state: row.state, blocked: row.blocked,
    retry_allowed: row.blocked && ['progression_failed', 'recovery_required', 'waiting_adapter'].includes(row.state)
      && ['queued', 'running', 'waiting_resource'].includes(run.state) && run.completion_authorized === false && run.cancellation == null }
}

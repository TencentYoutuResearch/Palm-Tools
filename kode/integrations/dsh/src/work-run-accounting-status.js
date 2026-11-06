/** Home evidence only; this read never settles a call or authorizes execution. */
export async function readWorkRunAccounting(runtime, run, signal) {
  const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
  const integer = value => Number.isSafeInteger(value) && value >= 0
  const value = await runtime.client.call(`/api/v1/messaging/work-runs/${encodeURIComponent(run.id)}/accounting-status`, undefined, signal)
  if (value?.home_hub !== runtime.host || value.run_id !== run.id || value.team_id !== run.team_id
      || value.run_revision !== run.revision || value.authority !== 'home_accounting_observation'
      || value.read_only !== true || value.retry_allowed !== false || typeof value.blocked !== 'boolean'
      || value.state !== (value.blocked ? 'waiting_accounting' : 'no_usage_blocker')
      || value.reason !== (value.blocked ? 'usage_reconciliation_required' : null)
      || value.recovery !== (value.blocked ? 'blocked_until_trusted_usage_is_reconciled' : null)
      || typeof value.truncated !== 'boolean' || value.truncated && !value.blocked
      || !Array.isArray(value.unresolved_calls) || value.unresolved_calls.length > 64
      || value.blocked !== (value.unresolved_calls.length > 0)) throw Error('WorkRun accounting observation scope changed')
  const calls = value.unresolved_calls.map(call => {
    const budget = call.budget
    if (!id(call.call_id) || !id(call.operation_id) || !integer(call.attempt) || call.attempt < 1
        || !integer(call.epoch) || call.epoch < 1 || !['finished','uncertain'].includes(call.state)
        || call.accounting_status !== 'usage_unresolved'
        || !(call.assignment_id === null && call.stage_id === null || id(call.assignment_id) && id(call.stage_id))
        || budget !== null && (!id(budget?.reservation_id) || typeof budget.unit !== 'string'
          || !integer(budget.charged) || !integer(budget.held) || typeof budget.finalized !== 'boolean'
          || budget.frozen !== (!budget.finalized && budget.held > 0))) throw Error('Invalid WorkRun accounting evidence')
    return {call_id:call.call_id,operation_id:call.operation_id,attempt:call.attempt,epoch:call.epoch,
      assignment_id:call.assignment_id,stage_id:call.stage_id,state:call.state,accounting_status:call.accounting_status,
      budget:budget === null ? null : {reservation_id:budget.reservation_id,unit:budget.unit,charged:budget.charged,held:budget.held,finalized:budget.finalized,frozen:budget.frozen}}
  })
  if (new Set(calls.map(call => call.call_id)).size !== calls.length) throw Error('Duplicate WorkRun accounting call')
  return {home_hub:value.home_hub,run_id:value.run_id,team_id:value.team_id,run_revision:value.run_revision,
    authority:value.authority,read_only:true,blocked:value.blocked,state:value.state,reason:value.reason,
    recovery:value.recovery,retry_allowed:false,unresolved_calls:calls,truncated:value.truncated}
}

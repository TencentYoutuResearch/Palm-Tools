import { canonical } from './builder-accept-command.js'
export const initialBudgetKey = team => JSON.stringify(['team-initial-budget', team.home_hub, team.id])
export async function createInitialBudget({ team, command, storage, request, signal }) {
  const key = initialBudgetKey(team)
  const pending = await storage.reserve(key, { state: 'prepared', home_hub: team.home_hub, request_id: command.request_id, policy_id: team.spec.budget_policy_id, command: { team_id: team.id, command } })
  if (signal?.aborted) throw Error('Disposed')
  if (pending.home_hub !== team.home_hub || pending.command?.team_id !== team.id) throw Error('Wrong budget scope')
  const result = pending.state === 'configured' ? pending.receipt : await request(pending.command, { signal, method: 'POST' })
  const sent = pending.command.command, { expected_revision, ...budget } = sent.budget
  if (result.team_id !== team.id || result.team_revision !== sent.team_revision || result.request_id !== sent.request_id || result.activation_performed !== false || result.label !== '团队预算'
    || expected_revision !== 0 || result.budget?.revision !== 1 || result.budget.spent !== 0 || result.budget.reserved !== 0 || Object.entries(budget).some(([key, value]) => result.budget[key] !== value)
    || result.budget_policy?.id !== pending.policy_id || result.budget_policy.team_id !== team.id || result.budget_policy.revision !== 1
    || canonical(result.budget_policy.policy) !== canonical({ kind: 'budget', budget_ids: [budget.id], unit: budget.unit, max_assignment_charge: sent.initial_policy.max_assignment_charge, ...(sent.initial_policy.settlement !== undefined ? { settlement: sent.initial_policy.settlement } : {}) })) throw Error('Invalid initial budget receipt')
  if (pending.state !== 'configured') await storage.save(key, { ...pending, state: 'configured', receipt: result })
  return result
}

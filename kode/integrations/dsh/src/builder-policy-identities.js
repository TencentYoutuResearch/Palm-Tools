/** Stable names for proposed future configuration, not policy records or authorization. */
import { createHash } from 'node:crypto'
export function builderPolicyIdentities(home, teamId) {
  const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
  if (!valid(home) || !valid(teamId)) throw Error('Invalid Builder candidate identity')
  const suffix = createHash('sha256').update(JSON.stringify([home, teamId])).digest('hex')
  return { team_id: teamId, home_hub: home, configuration_created: false, eligible_for_execution: false,
    proposed_policy_ids: { grant_id: `builder-grant-${suffix}`, budget_policy_id: `builder-budget-${suffix}`, scheduling_policy_id: `builder-scheduling-${suffix}` } }
}

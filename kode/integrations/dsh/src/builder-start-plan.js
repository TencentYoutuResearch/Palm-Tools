/** Assemble a read-only Builder start plan from confirmed intent and current authority. */
import { isDeepStrictEqual } from 'node:util'
import { profileRevision } from './agent-profiles.js'
import { preflightOfficialSelection } from './official-selection-preflight.js'
import { OFFICIAL_BUILDER_TOOLS } from './official-builder-tools.js'
export async function planBuilderStart(runtime, input, { signal } = {}) {
  const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
  const fields = ['draft_id', 'command_id', 'request_id', 'owner_session', 'session_id', 'team_id', 'amount', 'limit_ids', 'unknown_quota']
  if (!input || Object.keys(input).some(key => !fields.includes(key)) || !fields.slice(0, 6).every(key => id(input[key]))
    || !Number.isSafeInteger(input.amount) || input.amount < 1 || input.amount > 4000000000000000
    || !Array.isArray(input.limit_ids) || (!input.limit_ids.length && input.unknown_quota !== 'team_budget') || input.limit_ids.length > 128 || input.limit_ids.some(value => !id(value)) || new Set(input.limit_ids).size !== input.limit_ids.length
    || !['require_fresh', 'team_budget'].includes(input.unknown_quota)) throw Error('Invalid Builder plan request')
  input = structuredClone(input)
  const call = path => runtime.client.call(`/api/v1/messaging/${path}`, undefined, signal)
  const path = `superagents/drafts/${encodeURIComponent(input.draft_id)}`
  const [draft, selected, configured] = await Promise.all([call(path), call(`${path}/selection`), call(`${path}/funding`)])
  const choice = selected.record, funding = configured.record
  if (draft.home_hub !== runtime.host || selected.home_hub !== runtime.host || configured.home_hub !== runtime.host
    || draft.id !== input.draft_id || selected.draft_id !== input.draft_id || configured.draft_id !== input.draft_id
    || draft.status !== 'draft' || !choice || !funding || choice.draft_revision !== draft.revision
    || funding.request.draft_revision !== draft.revision || funding.request.selection_revision !== choice.revision
    || !isDeepStrictEqual(funding.selection, choice)) throw Error('Builder confirmed configuration changed or missing')
  const selection = choice.selection, workspace = selection.workspace
  const local = runtime.ctx.get('workspaceRegistry')?.list().find(row => row.id === workspace.workspace_id)
  if (workspace.host_id !== runtime.host || local?.path !== workspace.root_ref) throw Error('Builder local workspace unavailable')
  const profile = runtime.profiles.get(selection.profile_id), revision = profileRevision(profile)
  const selection_policy = { profile_revision: revision, model: selection.model, effort: selection.effort, scope: 'executor_configuration' }
  const model = await preflightOfficialSelection(runtime.ctx, runtime.profiles,
    { profile, revision, managedBuilder: { draft_id: input.draft_id } }, selection_policy,
    { provider: selection.provider, model: selection.model, reasoningEffort: selection.effort }, signal,
    { session: { header: { cwd: local.path } } }, runtime.managedCodex)
  const [budget, grant, binding] = await Promise.all([
    call(`budgets/${encodeURIComponent(funding.budget.id)}`), call(`team-grants/${encodeURIComponent(funding.grant.policy.id)}`),
    call(`resource-binding?host=${encodeURIComponent(runtime.host)}&profile=${encodeURIComponent(profile.id)}`),
  ])
  const at = Date.now(), current = budget.budget
  if (!current || current.id !== funding.budget.id || current.unit !== funding.price.unit || current.starts_at > at || current.ends_at <= at
    || current.limit - current.spent - current.reserved < input.amount) throw Error('Builder creation budget unavailable')
  if (!isDeepStrictEqual(grant, funding.grant) || !grant.policy.enabled || grant.policy.expires_at <= at) throw Error('Builder creation grant changed or expired')
  if (binding.host !== runtime.host || binding.profile !== profile.id || !binding.binding_current || !binding.account_id || !Number.isSafeInteger(binding.account_epoch) || binding.account_epoch < 1 || !Number.isSafeInteger(binding.revision) || binding.revision < 1) throw Error('Builder resource account binding unavailable')
  const resource = { host: runtime.host, profile: profile.id, account_id: binding.account_id, account_epoch: binding.account_epoch, binding_revision: binding.revision, limit_ids: input.limit_ids, unknown_quota: input.unknown_quota }
  // Directory/planning reads grant no authority. Atomic startup rechecks this snapshot.
  if (!isDeepStrictEqual(await call(`${path}/selection`), selected) || !isDeepStrictEqual(await call(path), draft)
    || profileRevision(runtime.profiles.get(profile.id)) !== revision) throw Error('Builder configuration changed during planning')
  const command = { command_id: input.command_id, team_id: input.team_id, provider: selection.provider, selection_revision: choice.revision,
    start: { draft_id: input.draft_id, draft_revision: draft.revision, price_id: funding.price.id,
      operation: { owner_session: input.owner_session, request_key: input.request_id, worker: { node_id: runtime.host, session_id: input.session_id }, selection_policy,
        funding: { budget_ids: [current.id], amount: input.amount, unit: current.unit }, resource,
        grant_id: grant.policy.id, grant_scope: { team_id: grant.policy.team_id, revision: grant.revision, target: grant.policy.targets[0],
          capabilities: ['read', 'builder_draft_write'], tools: [...OFFICIAL_BUILDER_TOOLS], network: false, budget_ids: [current.id] } } } }
  return { state: 'planned', dispatch_authorized: false, command, model, quota_policy: input.unknown_quota, budget_available: current.limit - current.spent - current.reserved }
}

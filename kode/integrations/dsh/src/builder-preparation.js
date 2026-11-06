/** Prepare a Builder from an already owner-authorized operation; never infer permissions. */
import { isDeepStrictEqual } from 'node:util'
import { profileRevision } from './agent-profiles.js'
import { preflightOfficialSelection } from './official-selection-preflight.js'
import { OFFICIAL_BUILDER_TOOLS } from './official-builder-tools.js'

export async function prepareBuilderDispatch(runtime, input, { signal } = {}) {
  const fields = ['command_id','operation_id','operation_revision','draft_id','draft_revision','team_id','profile_id','provider']
  const identifier = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(v)
  const draftId = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(v)
  if (!input || Object.keys(input).some(k => !fields.includes(k))
      || !['command_id','operation_id','profile_id'].every(k => identifier(input[k]))
      || !['draft_id','team_id'].every(k => draftId(input[k]))
      || !['operation_revision','draft_revision'].every(k => Number.isSafeInteger(input[k]) && input[k] > 0)
      || typeof input.provider !== 'string' || !input.provider || input.provider.length > 4096 || input.provider.includes('\0')) throw new Error('Invalid Builder preparation')
  input = structuredClone(input)
  const call = (p,b) => runtime.client.call(`/api/v1/messaging/${p}`,b,signal)
  const path = `operations/${input.operation_id}`
  const op = await call(path), draft = await call(`superagents/drafts/${input.draft_id}`)
  if (op.id !== input.operation_id || op.state !== 'prepared' || op.revision !== input.operation_revision
      || op.worker.node_id !== runtime.host || !identifier(op.worker.session_id)
      || !op.budget_required || op.budget_available !== true || !op.grant_required || op.grant_available !== true
      || (op.resource_required && (op.resource_available !== true || op.resource?.profile !== input.profile_id))) throw new Error('Builder operation authorization unavailable or changed')
  if (draft.status !== 'draft' || draft.home_hub !== runtime.host || draft.revision !== input.draft_revision) throw new Error('Builder draft revision conflict')
  const grant = await call(`${path}/grant`), target = grant.binding?.scope?.target
  const workspace = runtime.ctx.get('workspaceRegistry')?.list().find(w => w.id === target?.workspace)
  if (!grant.available || target?.host !== runtime.host || !workspace || workspace.path !== target.root
      || !draft.interview.workspace_refs.some(w => w.host_id === runtime.host && w.workspace_id === workspace.id && w.root_ref === workspace.path)
      || !['read','builder_draft_write'].every(c => grant.binding.scope.capabilities.includes(c))
      || !OFFICIAL_BUILDER_TOOLS.every(t => grant.binding.scope.tools.includes(t))) throw new Error('Builder workspace or tool grant unavailable')
  const accounting = await call(`${path}/budget?attempt=${op.attempt}`)
  if (!accounting.price || accounting.reservation?.finalized || !(accounting.reservation?.held > 0)) throw new Error('Builder priced budget required')
  const profile = runtime.profiles.get(input.profile_id), revision = profileRevision(profile)
  const operation = {id:op.id,attempt:op.attempt,epoch:op.epoch}
  const builder={draft_id:input.draft_id}
  const binding = {profile,revision,seenInputs:[],managedOperation:operation,managedBuilder:builder}
  const checkBinding = prior => {
    if (prior && (prior.operationClosed || prior.managedAssignment || prior.managedCoordinator || prior.revision !== revision
        || prior.profile.id !== profile.id || profileRevision(prior.profile) !== revision
        || !isDeepStrictEqual(prior.managedOperation,operation)
        || (prior.managedBuilder && !isDeepStrictEqual(prior.managedBuilder,builder)))) throw new Error('Builder session binding conflict')
  }
  checkBinding(runtime.profiles.binding(op.worker.session_id))
  if (!op.selection_policy) throw new Error('Builder exact selection policy required')
  await preflightOfficialSelection(runtime.ctx,runtime.profiles,binding,op.selection_policy,{
    provider:input.provider,model:op.selection_policy.model,reasoningEffort:op.selection_policy.effort,
  },signal,{session:{header:{cwd:workspace.path}}},runtime.managedCodex)
  signal?.throwIfAborted()
  await call(`${path}/builder-scope`,{expected_revision:input.operation_revision,attempt:op.attempt,epoch:op.epoch,draft_id:input.draft_id,draft_revision:input.draft_revision})
  await runtime.profiles.update(state => {
    signal?.throwIfAborted()
    const current = state.profiles.find(p => p.id === input.profile_id)
    if (!current || profileRevision(current) !== revision) throw new Error('Builder profile changed during preparation')
    const prior = state.bindings[op.worker.session_id]
    checkBinding(prior)
    if(prior)prior.managedBuilder=builder
    if (!prior) Object.defineProperty(state.bindings,op.worker.session_id,{value:binding,enumerable:true,writable:true,configurable:true})
  })
  return {command_id:input.command_id,session_id:op.worker.session_id,operation,profile_revision:revision,
    provider:input.provider,model:op.selection_policy.model,effort:op.selection_policy.effort ?? null,cwd:workspace.path,
    tools:[...OFFICIAL_BUILDER_TOOLS],builder:{draft_id:input.draft_id,team_id:input.team_id}}
}

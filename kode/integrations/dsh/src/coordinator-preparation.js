/** Prepare the official loop only from an existing, owner-authorized Coordinator control. */
import { isDeepStrictEqual } from 'node:util'
import { profileRevision } from './agent-profiles.js'
import { preflightOfficialSelection } from './official-selection-preflight.js'
import { OFFICIAL_COORDINATOR_TOOLS, coordinatorToolNames } from './official-coordinator-tools.js'

export async function prepareCoordinatorDispatch(runtime, input, { signal } = {}) {
  const fields = ['command_id','team_id','control_revision','operation_revision','profile_id','provider']
  const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(v)
  if (!input || Array.isArray(input) || Object.keys(input).some(k => !fields.includes(k))
      || !['command_id','team_id','profile_id'].every(k => id(input[k]))
      || !['control_revision','operation_revision'].every(k => Number.isSafeInteger(input[k]) && input[k] > 0)
      || typeof input.provider !== 'string' || !input.provider || input.provider.length > 4096 || input.provider.includes('\0')) {
    throw new Error('Invalid Coordinator preparation')
  }
  input = structuredClone(input)
  const call = (p) => runtime.client.call(`/api/v1/messaging/${p}`, undefined, signal)
  const controlPath = `teams/${encodeURIComponent(input.team_id)}/coordinator-control`
  const { control } = await call(controlPath)
  if (!control || control.team_id !== input.team_id || control.home_hub !== runtime.host
      || control.revision !== input.control_revision || !id(control.request?.operation_id)) throw new Error('Coordinator control unavailable or changed')
  const activationPath = `teams/${encodeURIComponent(input.team_id)}/activation`
  const activation = await call(activationPath)
  const selected = activation.snapshot?.team?.spec?.execution_targets?.find(t => t.id === control.request.target_id)
  if (!activation.active || activation.revision !== control.request.activation_revision
      || !selected || selected.provider_id !== input.provider || selected.executor_profile_id !== input.profile_id) throw new Error('Coordinator activated executor changed')
  const path = `operations/${control.request.operation_id}`, op = await call(path)
  if (op.id !== control.request.operation_id || op.state !== 'prepared' || op.revision !== input.operation_revision
      || op.attempt !== control.request.attempt || op.epoch !== control.request.epoch
      || op.worker?.node_id !== runtime.host || !id(op.worker.session_id) || !isDeepStrictEqual(op.worker,control.worker)
      || !op.budget_required || op.budget_available !== true || !op.grant_required || op.grant_available !== true
      || !op.resource_required || op.resource_available !== true || op.resource?.profile !== input.profile_id) {
    throw new Error('Coordinator operation authorization unavailable or changed')
  }
  const grant = await call(`${path}/grant`), target = grant.binding?.scope?.target
  const workspace = runtime.ctx.get('workspaceRegistry')?.list().find(w => w.id === target?.workspace)
  if (!grant.available || grant.binding.scope.team_id !== input.team_id || target?.host !== runtime.host
      || !workspace || workspace.path !== target.root || !['read','delegate'].every(c=>grant.binding.scope.capabilities.includes(c))
      || !OFFICIAL_COORDINATOR_TOOLS.every(t=>grant.binding.scope.tools.includes(t))) throw new Error('Coordinator workspace grant unavailable')
  const accounting = await call(`${path}/budget?attempt=${op.attempt}`)
  if (!accounting.price || accounting.reservation?.finalized || !(accounting.reservation?.held > 0)) throw new Error('Coordinator priced budget required')
  const profile = runtime.profiles.get(input.profile_id), revision = profileRevision(profile)
  const operation = { id:op.id, attempt:op.attempt, epoch:op.epoch }
  const coordinator = { team_id:input.team_id, conversation_id:control.conversation_id, control_revision:control.revision }
  const binding = { profile, revision, seenInputs:[], managedOperation:operation, managedCoordinator:coordinator }
  const predecessor=control.predecessor
  const restores=prior=>prior&&predecessor&&isDeepStrictEqual(predecessor.worker,op.worker)
    && prior.managedCoordinator?.team_id===input.team_id&&prior.managedCoordinator?.conversation_id===control.conversation_id
    && prior.managedCoordinator?.control_revision===predecessor.control_revision
    && isDeepStrictEqual(prior.managedOperation,{id:predecessor.operation_id,attempt:predecessor.attempt,epoch:predecessor.epoch})
  if(restores(runtime.profiles.binding(op.worker.session_id))){
    await runtime.ready
    if(runtime.active?.has(op.worker.session_id)||runtime.ctx.get('agents')?.get(op.worker.session_id))throw Error('Prior Coordinator runtime remains owned')
    runtime.tools.assertSettled(op.worker.session_id,runtime.profiles.binding(op.worker.session_id).managedOperation)
  }
  const check = prior => {
    if(restores(prior)&&(prior.managedBuilder||prior.managedAssignment||prior.revision!==revision||profileRevision(prior.profile)!==revision
      ||runtime.active?.has(op.worker.session_id)||runtime.ctx.get('agents')?.get(op.worker.session_id)))throw Error('Coordinator recovery binding conflict')
    if (prior && !restores(prior) && (prior.operationClosed || prior.managedBuilder || prior.managedAssignment
        || prior.revision !== revision || profileRevision(prior.profile) !== revision
        || !isDeepStrictEqual(prior.managedOperation,operation)
        || (prior.managedCoordinator && !isDeepStrictEqual(prior.managedCoordinator,coordinator)))) throw new Error('Coordinator session binding conflict')
  }
  check(runtime.profiles.binding(op.worker.session_id))
  if (!op.selection_policy) throw new Error('Coordinator exact selection policy required')
  await preflightOfficialSelection(runtime.ctx,runtime.profiles,binding,op.selection_policy,{
    provider:input.provider, model:op.selection_policy.model, reasoningEffort:op.selection_policy.effort,
  },signal,{session:{header:{cwd:workspace.path}}},runtime.managedCodex)
  // Recheck after asynchronous model configuration resolution. Runtime lease admission
  // remains authoritative if activation/control changes after this read.
  if (!isDeepStrictEqual((await call(controlPath)).control,control)) throw new Error('Coordinator control changed during preparation')
  const latest = await call(activationPath)
  if (!latest.active || latest.revision !== activation.revision) throw new Error('Coordinator activation changed during preparation')
  await runtime.profiles.update(state => {
    signal?.throwIfAborted()
    const current = state.profiles.find(p => p.id === input.profile_id)
    if (!current || profileRevision(current) !== revision) throw new Error('Coordinator profile changed during preparation')
    const prior = state.bindings[op.worker.session_id]
    check(prior)
    if (prior) {
      if(restores(prior)){
        prior.coordinatorPredecessor={operation:prior.managedOperation,coordinator:prior.managedCoordinator}
        prior.managedOperation=operation;prior.operationClosed=false
      }
      prior.managedCoordinator = coordinator
    }
    else Object.defineProperty(state.bindings,op.worker.session_id,{ value:binding, enumerable:true, writable:true, configurable:true })
  })
  return { command_id:input.command_id, session_id:op.worker.session_id, operation, profile_revision:revision,
    provider:input.provider, model:op.selection_policy.model, effort:op.selection_policy.effort ?? null,
    cwd:workspace.path, tools:coordinatorToolNames(grant.binding.scope.tools), coordinator }
}

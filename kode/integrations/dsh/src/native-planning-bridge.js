/** Owner-side planning uses the ordinary native lifecycle, not a Team operation.
 * Draft ownership and durable create/input receipts belong to the calling route.
 * Trusted factory admission must exist before creation announces an Agent.
 */
import { persistedPlanningContext } from './planning-draft-context.js'
import { prepareNativeHandoff, validateFrozenNativeHandoff } from './native-handoff-contract.js'
import { profileRevision } from './agent-profiles.js'
import { profileRoute } from './agent-profiles.js'
import { selectModelPlan } from './model-selection.js'
import { resolveDefaultSelection } from './model-alias.js'
import { appendFastPreference } from './model-fast.js'
import { isDeepStrictEqual } from 'node:util'
import { NATIVE_PLANNING_RECORD, validatePlanningBinding, nativePlanningBinding } from './native-planning-session.js'
import { assertBuilderPromptJournal } from './builder-settings.js'
import { assertPrivatePlanningLocation } from './planning-private-directory.js'

const idValid = id => typeof id === 'string' && /^session-[a-f0-9-]{36}$/.test(id)
const fail = message => Object.assign(Error(message), { code: 'NATIVE_PLANNING_REJECTED' })
export function createNativePlanningBridge({ ctx, service }) {
  const controller = () => ctx.get('sessionController')
  const registry = () => ctx.get('workspaceRegistry')
  async function resolve(id) {
    const { agent, error } = await controller().resolveAgent(id)
    if (error || !agent || agent.id !== id) throw fail('Original planning session unavailable; do not create a replacement')
    return agent
  }
  function metadata(agent) {
    return { session_id: agent.id, cwd: agent.session.header.cwd, status: agent.status,
      mode: 'interactive_planning', execution_authorized: false }
  }
  async function create(input) {
    const { session_id: sessionId, workspace_id: workspaceId, profile_id: profileId, selection, title } = structuredClone(input)
    if (!idValid(sessionId) || typeof title !== 'string' || !title.trim()) throw fail('Fresh planning identity required')
    const admission = await ctx.get('kodePlanningRuntime')?.sessionAdmission(sessionId, { mode: 'fresh' })
    if (!admission) throw fail('Trusted draft admission required before creation')
    const binding = validatePlanningBinding(admission.binding)
    if (binding.session_id !== sessionId || binding.workspace_id !== workspaceId || !isDeepStrictEqual(admission.selection, selection)) throw fail('Planning creation differs from the trusted draft binding')
    const isPrivate = binding.location?.kind === 'private_planning'
    const workspace = isPrivate ? undefined : registry()?.get(workspaceId)
    const cwd = isPrivate ? await assertPrivatePlanningLocation(binding, service.profiles.path) : workspace?.path
    if (!cwd || cwd !== binding.cwd || (isPrivate ? workspaceId !== null : !workspaceId)) throw fail('Selected native planning location unavailable')
    await service.profiles.reload?.()
    const profile = (service.profiles.listAgents?.() ?? service.profiles.list()).find(p => profileRoute(p.id) === selection?.provider)
    if (input.profile_revision !== undefined && (!profile || profileRevision(profile) !== input.profile_revision)) throw fail('Planning target profile revision changed')
    if (!profile || profile.id !== profileId || profile.type === 'dsh' || !service.hasRuntime(profile.type)) throw fail('Select an installed native Agent')
    const models = await service.adapter.listModels(selection.provider, profile, selection.model)
    const selected = resolveDefaultSelection(models, selection, profile.defaultModel)
    const plan = selectModelPlan(profile, models, selected)
    if (plan.model !== selection.model || (plan.reasoningEffort ?? null) !== (selection.reasoningEffort ?? null)) throw fail('Planning selection must be an exact native catalog selection')
    const existing = (await controller().list({})).items.some(row => row.sessionId === sessionId)
    if (existing || ctx.get('agents')?.get(sessionId) || service.profiles.binding(sessionId)) throw fail('Cannot adopt an existing conversation as a fresh draft')
    const result = await controller().create({ sessionId, agentPreset: 'kode-native', ...(isPrivate ? { cwd } : { workspaceId }) })
    if (result.sessionId !== sessionId) throw fail('Native creation changed identity; outcome requires reconciliation')
    let agent = await resolve(sessionId)
    const events = agent.session.snapshotEvents?.()
    if (!Array.isArray(events) || events.some(e => ['user/message', 'turn/start', 'request/header'].includes(e.type)) || agent.session.header.cwd !== cwd) throw fail('Planning requires a blank session in the selected location')
    if (agent.isKodeNativeAgent !== true || !isDeepStrictEqual(nativePlanningBinding(agent), binding)) throw fail("Planning creation did not enter the trusted native factory; reconcile the original identity")
    await service.profiles.bind(sessionId, profile.id)
    service.recordBinding(agent, profile)
    await agent.selectModel(plan)
    if (selected.fast !== undefined) {
      const model = models.find(row => row.id === plan.model)
      if (model?.fastCapability?.transport !== 'model-variant') appendFastPreference(agent.session, plan, selected.fast, model?.fastCapability?.tier)
    }
    await controller().rename({ sessionId, title })
    await agent.ctx.sessions.flush(agent.session)
    return { ...metadata(agent), selection: { provider: selection.provider, ...plan } }
  }
  async function inspect(sessionId) {
    if (!await ctx.get('kodePlanningRuntime')?.sessionAdmission(sessionId, { mode: 'restore' })) throw fail('Unknown planning session')
    return metadata(await resolve(sessionId))
  }
  async function proveExisting(input) {
    const { binding: rawBinding, profile_id: profileId, selection } = structuredClone(input)
    const binding = validatePlanningBinding(rawBinding), id = binding.session_id
    // Only the registry's fixed identity may be inspected. This never resolves an
    // Agent, invokes a catalog/CLI, flushes a writer, or repairs partial creation.
    const admission = await ctx.get('kodePlanningRuntime')?.sessionAdmission(id, { mode: 'fresh' })
    if (!admission || !isDeepStrictEqual(admission.binding, binding) || !isDeepStrictEqual(admission.selection, selection)) throw fail('Planning recovery authority changed')
    if (binding.location?.kind === 'private_planning') await assertPrivatePlanningLocation(binding, service.profiles.path)
    else if (registry()?.get(binding.workspace_id)?.path !== binding.cwd) throw fail('Planning recovery workspace changed')
    await service.profiles.reload?.()
    const profile = service.profiles.list().find(p => p.id === profileId)
    const bound = service.profiles.binding(id)
    if (!profile || !bound || !isDeepStrictEqual(bound.profile, profile) || selection.provider !== profileRoute(profileId)
      || Object.keys(bound).some(k => k.startsWith('managed') && bound[k] != null)
      || bound.threadId || bound.historySource || bound.historyBootstrapped || bound.inFlight || bound.seenInputs?.length) throw fail('Planning recovery profile or native lineage is not blank')
    const persistence = ctx.get('sessionPersistence')
    if (!persistence) throw fail('Planning journal unavailable')
    let handle
    try {
      handle = await persistence.open(id, 'read')
      const { events } = await handle.read()
      const header = handle.header
      if (header.id !== id || header.cwd !== binding.cwd || header.parentSession !== undefined || header.parentSessionId !== undefined || header.isSeeded
        || handle.inheritedEventCount !== 0 || !Array.isArray(events)) throw fail('Planning recovery journal identity changed')
      const marks = events.filter(e => e.type === NATIVE_PLANNING_RECORD)
      if (marks.length !== 1 || !isDeepStrictEqual(marks[0].data, binding)
        || events.some(e => /^(user|assistant|tool|turn|request|agent\/inbox)\//.test(e.type))) throw fail('Planning recovery requires the original blank journal')
      if (!isDeepStrictEqual(persistedPlanningContext(events, binding), admission.context)) throw fail('Planning recovery draft context changed')
      assertBuilderPromptJournal(events, admission.builder_prompt)
      const { fast, ...expectedSelection } = selection
      const selected = events.filter(e => e.type === 'model/selection')
      if (!selected.length || selected.some(e => !isDeepStrictEqual(e.data, expectedSelection))) throw fail('Planning recovery selection is incomplete or changed')
      if (fast !== undefined) {
        const saved = events.findLast(e => e.type === 'plugin:kode/model-fast')?.data
        if (!saved || saved.provider !== selection.provider || saved.model !== selection.model || saved.fast !== fast) throw fail('Planning Fast preference durability is unconfirmed')
      }
      return { verified: true, session_id: id, cwd: binding.cwd, proof: 'read_only_blank_native_journal' }
    } finally { await handle?.close() }
  }
  async function completePartial({ binding: raw, command }) {
    const binding = validatePlanningBinding(raw)
    const factory = ctx.get('kodeNativeFactory')
    if (typeof factory?.completePlanningCreation !== 'function') throw fail('Original native factory cannot complete this partial')
    if (binding.workspace_id && !registry()?.get(binding.workspace_id)?.sessionIds.includes(binding.session_id)) throw fail('Partial Session is not attached to its original workspace')
    const agent = await factory.completePlanningCreation(command, binding.session_id)
    if (agent.isKodeNativeAgent !== true || !isDeepStrictEqual(nativePlanningBinding(agent), binding) || agent.id !== binding.session_id || agent.session.header.cwd !== binding.cwd) throw fail('Partial completion did not establish original native identity')
    await agent.ctx.sessions.flush(agent.session)
    return { verified: true, session_id: agent.id, cwd: binding.cwd, proof: 'original_setup_completed_by_native_factory' }
  }
  const facade={service:name=>name==='kodeAgents'?service:ctx.get(name)}
  const prepareHandoffTarget=(profile_id,selection)=>prepareNativeHandoff(facade,{profile_id,selection})
  async function validateHandoffTarget(profileId,revision,selection){
    await service.profiles.reload?.()
    const profile=service.profiles.list().find(p=>p.id===profileId)
    if(!profile)throw fail('Planning target Agent unavailable')
    return validateFrozenNativeHandoff(facade,{profile_revision:revision,selection},profile)
  }
  async function readHandoffSource(raw,{requireIdle=false}={}){
    const binding=validatePlanningBinding(raw),id=binding.session_id,live=ctx.get('agents')?.get(id)
    let handle
    try{
      handle=await ctx.get('sessionPersistence').open(id,'read')
      const {events}=await handle.read(),header=handle.header
      if(header.id!==id||header.cwd!==binding.cwd||header.parentSession||header.parentSessionId||header.isSeeded||header.origin||handle.inheritedEventCount!==0)throw fail('Planning handoff source journal changed')
      const marks=events.filter(e=>e.type===NATIVE_PLANNING_RECORD)
      if(marks.length!==1||!isDeepStrictEqual(marks[0].data,binding))throw fail('Planning handoff source marker changed')
      const context=persistedPlanningContext(events,binding)
      if(requireIdle){
        const bound=service.profiles.binding(id),queues={'next-turn':[],'next-step':[]}
        for(const e of events)if(e.type==='agent/inbox/spliced'){const q=queues[e.data.target];if(!q)throw fail('Unknown planning inbox');q.splice(e.data.start,e.data.removedCount??0,...(e.data.inserted??[]))}
        const start=events.findLast(e=>e.type==='turn/start'),end=events.findLast(e=>e.type==='turn/end')
        if(!bound||Object.keys(bound).some(k=>k.startsWith('managed')&&bound[k]!=null)||bound.inFlight||bound.stopBlocked||service.adapter.hasContinuation?.(id)!==false||service.adapter.busy?.has(id)
          ||start&&(!end||start.seq>end.seq)||Object.values(queues).some(q=>q.length)
          ||live&&(live.status!=='idle'||live.inbox.nextTurn.length||live.inbox.nextStep.length||live.activeInputs?.size||!isDeepStrictEqual(nativePlanningBinding(live),binding)))throw Object.assign(fail('Planning source must be idle with no pending input'),{code:'PLANNING_HANDOFF_SOURCE_BUSY'})
      }
      return {context}
    }finally{await handle?.close()}
  }
  return Object.freeze({ create, inspect, proveExisting, completePartial,prepareHandoffTarget,validateHandoffTarget,readHandoffSource })
}

/** Owner-confirmed planning successor, using native preparation and creation.
 * The ordinary handoff mailbox's automatic input stage is never called here.
 */
import { randomUUID, createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { validatePlanningBinding } from './native-planning-session.js'
import { snapshotPlanningDraft, planningSnapshotFields } from './planning-draft-context.js'
import { readBuilderPrompt } from './builder-settings.js'
import { createPrivatePlanningLocation } from './planning-private-directory.js'
const fail = (code, message) => Object.assign(Error(message), { code, status: 409 })
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
export function planningRecordFor(state, sessionId) {
  const current = Object.values(state.sessions).filter(row => row.binding?.session_id === sessionId)
  const old = Object.values(state.history ?? {}).filter(row => row.binding?.session_id === sessionId)
  const pending = Object.values(state.handoffs ?? {}).filter(row => row.stage === 'creating' && row.target?.binding?.session_id === sessionId).map(row => row.target)
  const all = [...current.map(record => ({record,kind:'current'})), ...old.map(record => ({record,kind:'history'})), ...pending.map(record => ({record,kind:'pending'}))]
  if (all.length > 1) throw fail('PLANNING_REGISTRY_INVALID', 'Duplicate planning generation')
  return all[0]
}
export const pendingPlanningHandoff = (state, id) => Object.values(state.handoffs ?? {}).find(row => row.stage === 'creating' && row.command.sessionId === id)
export function createPlanningHandoff({service,home,read,update,draftState,currentWorkspace,bridge,response,keyOf,jobs,freezePlanningResources}) {
  const requestKey = command => createHash('sha256').update(JSON.stringify([home,command.planning.draft_id,command.requestId])).digest('hex')
  async function source(id, {idle=false,allowPending=false}={}) {
    const state=await read(), found=planningRecordFor(state,id)
    if(!found)return undefined
    const record=found.record,binding=validatePlanningBinding(record.binding)
    if(binding.home_hub!==home)throw fail('PLANNING_HANDOFF_SOURCE_CHANGED','Planning source belongs to another home')
    const {draft}=await draftState(binding.draft_id);await currentWorkspace(binding,draft)
    const evidence=await bridge.readHandoffSource(binding,{requireIdle:idle})
    if(!isDeepStrictEqual(planningSnapshotFields(record,home),planningSnapshotFields(evidence.context.data,home)))throw fail('PLANNING_HANDOFF_SOURCE_CHANGED','Frozen planning resources or prompt version changed')
    if(found.kind!=='current')return {state:'superseded',record,binding,draft,evidence}
    const pending=pendingPlanningHandoff(state,id)
    if(pending&&!allowPending&&idle)throw fail('PLANNING_HANDOFF_PENDING','The original successor request requires reconciliation')
    return {state:pending?'handoff_pending':'active',record,binding,draft,evidence,pending}
  }
  async function status(id) {
    const value=await source(id);if(!value)return null
    const {binding,draft,evidence,pending}=value
    return {home_hub:home,draft_id:binding.draft_id,session_id:id,context_epoch:binding.context_epoch,draft_revision:draft.revision,
      context_sha256:evidence.context.sha256,source_draft_revision:evidence.context.draft_revision,latest_context_sha256:snapshotPlanningDraft(binding,draft,value.record).sha256,state:value.state,...(pending?{pending:{request_id:pending.command.requestId,reserved_session_id:pending.target.binding.session_id,retry_command:structuredClone(pending.command)}}:{})}
  }
  const assertSource = (value, expected) => {
    if(!value||value.state==='superseded'||value.binding.draft_id!==expected.draft_id||value.binding.context_epoch!==expected.source_epoch
      || value.draft.revision!==expected.draft_revision||value.evidence.context.sha256!==expected.source_context_sha256
      || (expected.refresh_context ? value.evidence.context.draft_revision!==expected.refresh_context.source_draft_revision
        || snapshotPlanningDraft(value.binding,value.draft,value.record).sha256!==expected.refresh_context.target_context_sha256
        : value.evidence.context.draft_revision!==expected.draft_revision))throw fail('PLANNING_HANDOFF_SOURCE_CHANGED','Planning source generation or draft revision changed')
  }
  async function prepare(input) {
    if(!exact(input,['action','sessionId','profileId','selection',...(input?.refreshContext===true?['refreshContext']:[])])||input.action!=='prepare-handoff'||!id(input.sessionId)||!id(input.profileId)||!input.selection?.model)throw fail('INVALID_REQUEST','Explicit native handoff selection required')
    const value=await source(input.sessionId,{idle:true});if(!value||value.state!=='active')throw fail('PLANNING_HANDOFF_REQUIRED','Active planning source required')
    const target=await bridge.prepareHandoffTarget(input.profileId,input.selection)
    const planning={draft_id:value.binding.draft_id,source_epoch:value.binding.context_epoch,draft_revision:value.draft.revision,source_context_sha256:value.evidence.context.sha256,target_profile_revision:target.profile_revision}
    // A stale source is never silently upgraded by ordinary Agent handoff.
    // Only the explicit latest-draft preparation produces this exact old/new proof.
    if(input.refreshContext===true&&value.evidence.context.draft_revision!==value.draft.revision)planning.refresh_context={source_draft_revision:value.evidence.context.draft_revision,target_context_sha256:snapshotPlanningDraft(value.binding,value.draft,value.record).sha256}
    assertSource(await source(input.sessionId,{idle:true}),planning)
    return {kind:'planning',prepared:{action:'handoff',sessionId:input.sessionId,profileId:target.profile_id,selection:target.selection,planning},automatic_input:false,execution_authorized:false}
  }
  const receipt=(row,disposition)=>({...response(row.target,disposition),kind:'planning',source_session_id:row.command.sessionId,source_epoch:row.command.planning.source_epoch,request_id:row.command.requestId,automatic_input:false})
  async function assertCurrentContext(row){
    const {draft}=await draftState(row.command.planning.draft_id)
    const context=(await bridge.readHandoffSource(row.target.binding)).context
    if(draft.revision!==row.command.planning.draft_revision||!isDeepStrictEqual(context,snapshotPlanningDraft(row.target.binding,draft,row.target)))throw fail('PLANNING_HANDOFF_UNCERTAIN','Draft changed during activation; inspect the original successor')
    const state=await read(),active=state.sessions[keyOf(home,row.command.planning.draft_id)]
    if(!isDeepStrictEqual(active,row.target))throw fail('PLANNING_SESSION_SUPERSEDED','This successor is no longer the current planning generation')
    if(pendingPlanningHandoff(state,row.target.binding.session_id))throw fail('PLANNING_HANDOFF_PENDING','This successor has another pending handoff')
  }
  async function handoff(input) {
    if(!exact(input,['action','sessionId','profileId','requestId','selection','planning'])||input.action!=='handoff'||![input.sessionId,input.profileId,input.requestId].every(id)
      ||!exact(input.planning,['draft_id','source_epoch','draft_revision','source_context_sha256','target_profile_revision',...(input.planning?.refresh_context?['refresh_context']:[])])
      ||input.planning?.refresh_context&&(!exact(input.planning.refresh_context,['source_draft_revision','target_context_sha256'])
        ||!Number.isSafeInteger(input.planning.refresh_context.source_draft_revision)||input.planning.refresh_context.source_draft_revision<1
        ||input.planning.refresh_context.source_draft_revision>=input.planning.draft_revision
        ||!/^[a-f0-9]{64}$/.test(input.planning.refresh_context.target_context_sha256??''))||!id(input.planning.draft_id)
      ||![input.planning.source_epoch,input.planning.draft_revision].every(n=>Number.isSafeInteger(n)&&n>0)
      ||![input.planning.source_context_sha256,input.planning.target_profile_revision].every(s=>/^[a-f0-9]{64}$/.test(s??''))||!input.selection?.model)throw fail('INVALID_REQUEST','Exact reviewed planning handoff required')
    const command=structuredClone(input),key=keyOf(home,command.planning.draft_id),rk=requestKey(command),job=jobs.get(key)
    if(job){if(!isDeepStrictEqual(job.handoff,command))throw fail('PLANNING_CREATION_IN_PROGRESS','Another planning transition is in progress');return job.task}
    const task=(async()=>{
      let row=(await read()).handoffs?.[rk]
      if(row&&!isDeepStrictEqual(row.command,command))throw fail('PLANNING_HANDOFF_REQUEST_CHANGED','Original handoff request must be replayed unchanged')
      if(row?.stage==='ready'){
        if((await read()).sessions[key]?.binding?.session_id!==row.target.binding.session_id)throw fail('PLANNING_SESSION_SUPERSEDED','This successor is no longer the current planning generation')
        await assertCurrentContext(row)
        return receipt(row,'recovered')
      }
      const before=await source(command.sessionId,{idle:true,allowPending:Boolean(row)});assertSource(before,command.planning)
      await bridge.validateHandoffTarget(command.profileId,command.planning.target_profile_revision,command.selection)
      const initial=!row
      if(initial){
        const sessionId=`session-${randomUUID()}`
        const location=before.binding.location?await createPrivatePlanningLocation({profilesPath:service.profiles.path,home,draftId:command.planning.draft_id,sessionId}):{workspace_id:before.binding.workspace_id,cwd:before.binding.cwd}
        const binding=validatePlanningBinding({version:1,mode:'interactive_planning',home_hub:home,draft_id:command.planning.draft_id,context_epoch:before.binding.context_epoch+1,session_id:sessionId,...location})
        const selection={provider:`kode-agent-${command.profileId}`,...command.selection}
        const request_input={draft_id:binding.draft_id,draft_revision:command.planning.draft_revision,request_id:command.requestId,profile_id:command.profileId,model:selection.model,...(selection.reasoningEffort?{reasoning_effort:selection.reasoningEffort}:{}),...(binding.workspace_id?{workspace_id:binding.workspace_id}:{})}
        const builder_prompt = await readBuilderPrompt(service.profiles)
        const frozen = await freezePlanningResources(binding, before.draft, before.record)
        row={command,stage:'creating',source:structuredClone(before.record),target:{binding,...frozen,builder_prompt,profile_id:command.profileId,profile_revision:command.planning.target_profile_revision,selection,request_id:command.requestId,request_input,stage:'creating'}}
        await update(state=>{
          if(!isDeepStrictEqual(state.sessions[key],before.record)||pendingPlanningHandoff(state,command.sessionId))throw fail('PLANNING_HANDOFF_SOURCE_CHANGED','Source changed before successor reservation')
          state.handoffs??={};if(state.handoffs[rk])throw fail('PLANNING_HANDOFF_PENDING','Original successor reservation already exists');state.handoffs[rk]=structuredClone(row)
        })
      }
      assertSource(await source(command.sessionId,{idle:true,allowPending:true}),command.planning)
      const target=row.target,binding=target.binding
      if(initial)await bridge.create({session_id:binding.session_id,workspace_id:binding.workspace_id,profile_id:target.profile_id,selection:target.selection,title:`Team planning: ${before.draft.interview.purpose.slice(0,120)}`,profile_revision:target.profile_revision})
      // Unknown creation is only proved, never retried or assigned another ID.
      const proof=await bridge.proveExisting({binding,profile_id:target.profile_id,selection:target.selection})
      if(proof.verified!==true||proof.session_id!==binding.session_id||proof.cwd!==binding.cwd)throw fail('PLANNING_HANDOFF_UNCERTAIN','Successor identity requires reconciliation')
      await bridge.validateHandoffTarget(command.profileId,command.planning.target_profile_revision,command.selection)
      assertSource(await source(command.sessionId,{idle:true,allowPending:true}),command.planning)
      const ready=await update(state=>{
        const prior=state.handoffs?.[rk]
        if(!isDeepStrictEqual(prior,row)||!isDeepStrictEqual(state.sessions[key],row.source))throw fail('PLANNING_REGISTRY_CHANGED','Planning pointer changed before activation')
        state.history??={};if(state.history[command.sessionId])throw fail('PLANNING_REGISTRY_INVALID','Source generation already archived')
        state.history[command.sessionId]=structuredClone(row.source)
        prior.stage='ready';prior.target.stage='ready';state.sessions[key]=structuredClone(prior.target);return prior
      })
      // Different documents cannot be atomically committed. Drift remains gated
      // by readContext and is never reported as a usable successful transition.
      await assertCurrentContext(ready)
      return receipt(ready,'fresh')
    })().catch(error=>{
      // After a reservation, generic transport/creation failures must never look
      // like a safe pre-write rejection. The exact command remains reconcilable.
      if(typeof error?.code==='string'&&/^(PLANNING_|DRAFT_)/.test(error.code))throw Object.assign(error,{status:409})
      throw fail('PLANNING_HANDOFF_UNCERTAIN','Handoff was not confirmed; preserve and verify the original request without creating a replacement')
    })
    jobs.set(key,{handoff:command,task});try{return await task}finally{if(jobs.get(key)?.task===task)jobs.delete(key)}
  }
  return {status,prepare,handoff}
}

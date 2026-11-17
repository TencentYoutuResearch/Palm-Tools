import {interactiveInterruptionProof} from './interactive-interruption-proof.js'
import {symbols} from '@deepseek-ai/cordis'
/** Original native conversations bound to an owner-accepted interactive Team.
 * No controlled operation, credential registration, usage fabrication or history import.
 */
import {createHash} from 'node:crypto'
import {isDeepStrictEqual as equal} from 'node:util'
import {Session} from '@deepseek-ai/dsh-session'
import {profileRevision,profileRoute} from './agent-profiles.js'
import {resolveDefaultSelection,resolveAdvertisedModel} from './model-alias.js'
import {deliveryInputId} from './delivery-tracker.js'
import {snapshotTeamRolePrompt} from './team-role-prompts.js'
const actual=a=>a?.[symbols.original]??a
const RECORD='plugin:kode/interactive-team',INPUT='plugin:kode/interactive-team-input'
const digest=v=>createHash('sha256').update(v).digest('hex')
const clone=v=>structuredClone(v)
const fail=message=>Object.assign(Error(message),{code:'INTERACTIVE_TEAM_UNCONFIRMED'})
const path='/api/v1/messaging/interactive-teams'
// The released Host and Kode can load distinct copies of the persistence package.
// Match its explicit public error contract and exact identity, never generic ENOENT/text.
export const isAbsentInteractiveSession=(error,id)=>error?.name==='SessionPersistenceNotFoundError'&&error?.constructor?.name==='SessionPersistenceNotFoundError'&&error?.sessionId===id
const sid=id=>typeof id==='string'&&/^session-[a-f0-9-]{36}$/.test(id)
export function createInteractiveTeamHostRuntime({ctx,backend,service,home,nativeBinding}){
 if(!backend?.call||!service?.profiles||typeof nativeBinding!=='function')throw fail('Original interactive Host services required')
 const profiles=service.profiles,rows=new Map(),sessions=new Map(),owned=new WeakMap(),active=new Set(),opening=new Set(),diagnostics=new Map()
 const controller=()=>ctx.get('sessionController')
 const facade={service:name=>name==='kodeAgents'?service:ctx.get(name)}
 async function accept(value){
  const b=value?.binding,t=value?.team_snapshot
  if(!b||b.execution_mode!=='interactive_native'||b.version!==1||b.state!=='bound'||b.home_hub!==home||!sid(b.native_session_id)
   ||!b.binding_id||!Number.isSafeInteger(b.revision)||b.revision<1||!['channel','dm'].includes(b.surface_kind)
   ||b.workspace?.host_id!==home||t?.id!==b.team_id||t.revision!==b.team_revision||t.home_hub!==home||t.spec?.execution_mode!=='interactive_native')throw fail('Interactive server identity differs')
  await profiles.reload?.()
  const profile=profiles.get(b.selection?.profile_id)
  if(!profile||profile.type==='dsh'||!service.hasRuntime(profile.type)||profileRevision(profile)!==b.selection.profile_revision||!b.selection.model||b.selection.model==='default')throw fail('Original native selection unavailable or changed')
  const workspace=ctx.get('workspaceRegistry')?.get(b.workspace.workspace_id)
  if(!workspace||workspace.path!==b.workspace.root_ref)throw fail('Original workspace registration changed')
  const selection={provider:profileRoute(profile.id),model:b.selection.model,...(b.selection.reasoningEffort==null?{}:{reasoningEffort:b.selection.reasoningEffort})}
  const prior=rows.get(b.binding_id)
  if(prior&&(!equal(prior.binding,b)||!equal(prior.team,t)))throw fail('Interactive binding changed')
  if(prior)return prior
  const row={binding:clone(b),team:clone(t),profile:clone(profile),selection,staged:new Map(),results:new Map(),dispatches:new Set(),finishes:new Set()}
  rows.set(b.binding_id,row);sessions.set(b.native_session_id,b.binding_id);return row
 }
 async function read(id){const value=clone(await backend.call(`${path}/bindings/${encodeURIComponent(id)}`));if(value?.binding?.binding_id!==id)throw fail('Interactive binding read identity differs');return accept(value)}
 async function exact(agent,binding){
  const row=owned.get(actual(agent)),native=nativeBinding(agent)
  if(!row||native?.service!==runtime||!equal(native.binding,row.binding)||agent.id!==row.binding.native_session_id||binding&&!equal(binding,row.binding))throw fail('Foreign interactive Agent')
  if(await read(row.binding.binding_id)!==row)throw fail('Interactive owner row changed')
  const after=nativeBinding(agent)
  if(owned.get(actual(agent))!==row||after?.service!==runtime||!equal(after.binding,row.binding)||agent.disposed)throw fail('Interactive owner changed during validation')
  const p=profiles.binding(agent.id)
  if(!p||p.revision!==row.binding.selection.profile_revision||p.profile.id!==row.binding.selection.profile_id
   ||['managedOperation','managedAssignment','managedCoordinator','managedBuilder','context_scope'].some(k=>p[k]!=null)
   ||agent.session.header.cwd!==row.binding.workspace.root_ref)throw fail('Interactive native owner changed')
  return row
 }
 async function absent(row){
  const id=row.binding.native_session_id
  if(ctx.get('agents')?.get(id)||ctx.get('sessions')?.get(id)||profiles.binding(id))return false
  let handle
  try{handle=await ctx.get('sessionPersistence').open(id,'read');await handle.read();return false}
  catch(error){if(isAbsentInteractiveSession(error,id))return true;throw error}
  finally{await handle?.close()}
 }
 async function proof(id){
  const p=clone(await phase(id,'recovery_lookup',()=>backend.call(`${path}/bindings/${encodeURIComponent(id)}/recovery`)))
  const row=await phase(id,'binding_validation',()=>accept(p)),b=row.binding,m=p.message
  if(b.binding_id!==id||m?.id!==b.first_source_message_id||m.surface_id!==b.surface_id||m.thread_id!==b.thread_id||!equal(m.actor,{kind:'human',id:'local_owner'})||digest(m.content)!==b.first_source_content_sha256)throw fail('Original recovery proof differs')
  if(p.reply_message!=null){const r=p.reply_message;if(r.source_message_id!==m.id||r.surface_id!==b.surface_id||r.thread_id!==b.thread_id||r.kind!=='superagent_reply'||r.delivery_state!=='published'||!equal(r.actor,{kind:'interactive_participant',team_id:b.team_id,participant_id:b.participant_id,target_id:b.target_id,session_id:b.native_session_id})||typeof r.id!=='string')throw fail('Original publication proof differs')}
  return {row,p}
 }
 async function phase(id,name,run){
  diagnostics.set(id,{phase:name,code:'INTERACTIVE_IN_PROGRESS'})
  try{return await run()}catch(error){diagnostics.set(id,{phase:name,code:'INTERACTIVE_PHASE_UNCONFIRMED'});throw Object.assign(error,{interactive_phase:error.interactive_phase??name})}
 }
 async function ready(row,{create=false}={}){
  const b=row.binding
  await phase(b.binding_id,'catalog',async()=>{
   const models=await service.adapter.listModels(profileRoute(row.profile.id),row.profile,b.selection.model)
   // A frozen null means no effort override, not 'choose a new UI default'.
   // Preserve that contract even when the CLI advertises its current native default.
   const selection=b.selection.reasoningEffort==null
    ? {model:resolveAdvertisedModel(models,b.selection.model)}
    : resolveDefaultSelection(models,{model:b.selection.model,reasoningEffort:b.selection.reasoningEffort})
   if(!models.length||selection.model!==b.selection.model||(selection.reasoningEffort??null)!==(b.selection.reasoningEffort??null)||profileRevision(profiles.get(row.profile.id))!==b.selection.profile_revision)throw fail('Exact original model catalogue selection required')
  })
  if(create)await phase(b.binding_id,'native_create',async()=>{
   if(!await absent(row))throw fail('Cannot adopt an existing native conversation')
   const result=await controller().create({sessionId:b.native_session_id,workspaceId:b.workspace.workspace_id,agentPreset:'kode-native'})
   if(result.sessionId!==b.native_session_id)throw fail('Native create outcome differs; inspect original Session')
  })
  return phase(b.binding_id,'native_verify',async()=>{
   const {agent,error}=await controller().resolveAgent(b.native_session_id)
   if(error||!agent)throw fail('Original native Session unavailable')
   await exact(agent,b)
   if(!equal(agent.model.current(),row.selection))throw fail('Native factory did not install the exact selection')
   if(await agent.ctx.sessions.flush(agent.session)!==true)throw fail('Native identity not durable')
   diagnostics.set(b.binding_id,{phase:'ready',code:'INTERACTIVE_READY'})
   return {...view(row),state:'ready',session_id:agent.id}
  })
 }
 async function settleInterrupted(row,proof,header,events,turnId){
  const command=interactiveInterruptionProof({binding:row.binding,receipt:proof.receipt,message:proof.message,header,events},turnId)
  const result=clone(await backend.call(`${path}/bindings/${encodeURIComponent(row.binding.binding_id)}/sources/interrupted`,command))
  const expected={...proof.receipt,state:'interrupted',interruption:command}
  if(!equal(result.binding,row.binding)||!equal(result.receipt,expected)||![true,false].includes(result.new_interruption))throw fail('Interrupted receipt differs')
  const settled={state:'interrupted',cause:'approval_rejected',source_message_id:proof.message.id,receipt_id:proof.receipt.receipt_id,automatic_replay_allowed:false,usage:{state:'unknown'}}
  row.results.set(proof.receipt.receipt_id,settled);return {...view(row),...settled}
 }
 function view(row){return {binding:clone(row.binding),execution_mode:'interactive_native',accounting:{state:'not_applicable'},usage:{state:'unknown'}}}
 const runtime={
  async inspectSource(sourceId){
   const p=await phase(sourceId,'source_lookup',()=>backend.call(`${path}/by-original-source/${encodeURIComponent(sourceId)}`))
   if(p?.message?.id!==sourceId||p?.binding?.first_source_message_id!==sourceId)throw fail('Original source lookup differs')
   return runtime.inspect(p.binding.binding_id)
  },
  async inspect(id){
   const priorDiagnostic=diagnostics.get(id)
   const {row,p}=await proof(id)
   const missing=await phase(id,'native_storage_probe',()=>absent(row))
   if(priorDiagnostic)diagnostics.set(id,priorDiagnostic);else diagnostics.delete(id)
   return {...view(row),state:p.reply_message?'published':p.receipt?.state==='interrupted'?'interrupted':'bound',...(p.receipt?.state==='interrupted'?{cause:p.receipt.interruption?.cause}: {}),source_message_id:p.message.id,...(p.reply_message?{reply_message_id:p.reply_message.id}:{}),
    recovery:{recovery_allowed:p.never_claimed===true&&missing&&!opening.has(id)&&!active.has(id),state:p.never_claimed===true&&missing&&!opening.has(id)&&!active.has(id)?'recoverable':'requires_inspection',native_absent:missing,never_claimed:p.never_claimed===true,automatic_replay_allowed:false},
    diagnostic:diagnostics.get(id)??{phase:'unknown',code:'INTERACTIVE_OUTCOME_UNCONFIRMED'}}
  },
  async reconcileInterrupted(input){
   if(input.request_id!==`reconcile:${input.source_message_id}`||active.has(input.binding_id)||opening.has(input.binding_id))throw fail('Original input must be idle before terminal reconciliation')
   opening.add(input.binding_id)
   let handle
   try{
    const {row,p}=await proof(input.binding_id)
    if(p.message.id!==input.source_message_id||!p.receipt||!['claimed','interrupted'].includes(p.receipt.state))throw fail('No original interrupted receipt')
    const live=ctx.get('agents')?.get(row.binding.native_session_id)
    if(live&&live.status!=='idle')throw fail('Native input still active')
    handle=await ctx.get('sessionPersistence').open(row.binding.native_session_id,'read')
    const stored=await handle.read(),header=clone(stored.header??handle.header),events=clone(stored.events)
    if(handle.inheritedEventCount)throw fail('Inherited journal cannot settle original source')
    interactiveInterruptionProof({binding:row.binding,receipt:p.receipt,message:p.message,header,events})
    const latest=await handle.read()
    if(!equal(events,latest.events)||!equal(header,latest.header??handle.header))throw fail('Terminal journal changed')
    const checked=await proof(input.binding_id)
    if(!equal(checked.p,p))throw fail('Terminal source changed')
    return await settleInterrupted(row,p,header,events)
   }finally{await handle?.close();opening.delete(input.binding_id)}
  },
  async interruptedTurn(agent,{binding,receipt,turn_id}){
   const row=await exact(agent,binding)
   if(!row.dispatches.has(receipt?.receipt?.receipt_id))throw fail('No original source dispatch')
   if(await agent.ctx.sessions.flush(agent.session)!==true)throw fail('Interrupted journal not durable')
   const events=clone(Session.prototype.snapshotEvents.call(agent.session)),header=clone(agent.session.header)
   await exact(agent,binding)
   if(!equal(events,Session.prototype.snapshotEvents.call(agent.session))||!equal(header,agent.session.header))throw fail('Interrupted journal changed')
   return settleInterrupted(row,receipt,header,events,turn_id)
  },
  async recover(input){
   if(input.request_id!==`composer-source:${input.source_message_id}`)throw fail('Original source request identity required')
   if(opening.has(input.binding_id)||active.has(input.binding_id))throw fail('Original native creation or delivery in progress')
   opening.add(input.binding_id)
   try{
    const {row,p}=await phase(input.binding_id,'recovery_proof',()=>proof(input.binding_id))
    if(input.source_message_id!==p.message.id||p.never_claimed!==true||!await absent(row))throw fail('Original source is not safely recoverable')
    // No replacement id and no original-message send. Native storage create is exclusive.
    await ready(row,{create:true})
    // Revalidate the unclaimed source after creation, before the one-shot claim.
    const checked=await proof(input.binding_id)
    if(!equal(checked.p,p)||checked.p.never_claimed!==true)throw fail('Original source changed during recovery')
    return await runtime.deliver(input)
   }finally{opening.delete(input.binding_id)}
  },
  async sessionAdmission(id,{mode,binding_id}={}){
   const known=binding_id??sessions.get(id)
   if(!known)return undefined // Ordinary Sessions have no dependency on these routes.
   if(!['fresh','restore'].includes(mode))throw fail('Invalid native lifecycle mode')
   const row=await read(known)
   if(row.binding.native_session_id!==id)throw fail('Interactive Session reference changed')
   const worker=row.binding.participant_id.startsWith('worker:')?row.binding.participant_id.slice(7):undefined
   if(worker===undefined&&row.binding.participant_id!=='coordinator')throw fail('Unknown interactive participant')
   return {binding:clone(row.binding),cwd:row.binding.workspace.root_ref,selection:clone(row.selection),role_prompt:snapshotTeamRolePrompt({home_hub:home,team_id:row.binding.team_id,team_revision:row.binding.team_revision,spec:row.team.spec,...(worker===undefined?{}:{worker_id:worker})})}
  },
  async setupAgent(agent,{binding}){
   const row=await read(binding.binding_id)
   if(!equal(binding,row.binding)||agent.id!==binding.native_session_id||agent.session.header.cwd!==binding.workspace.root_ref||owned.has(actual(agent)))throw fail('Interactive native setup differs')
   await profiles.bind(agent.id,row.profile.id)
   await profiles.update(state=>{const p=state.bindings[agent.id];if(!p||p.revision!==binding.selection.profile_revision||p.profile.id!==binding.selection.profile_id||['managedOperation','managedAssignment','managedCoordinator','managedBuilder','context_scope'].some(k=>p[k]!=null)||p.historySource||p.historyBootstrapped)throw fail('Interactive profile has another owner')})
   owned.set(actual(agent),row)
  },
  async assertSession(agent,{binding}){await exact(agent,binding);return true},
  async open(input){
   input=clone(input)
   const response=clone(await backend.call(`${path}/bindings`,clone(input))),b=response?.binding
   if(!b||['team_id','team_revision','surface_id','thread_id','audience_revision','participant_id','target_id','context_epoch'].some(k=>b[k]!==input[k])||b.workspace?.workspace_id!==input.workspace_id)throw fail('Interactive creation target differs')
   if(opening.has(b.binding_id)||active.has(b.binding_id))throw fail('Original native creation or delivery in progress')
   opening.add(b.binding_id)
   try{
    const row=await phase(b.binding_id,'binding_validation',()=>accept(response))
    const existing=(await controller().list({})).items.some(item=>item.sessionId===b.native_session_id)
    if(response.new_binding===true){if(existing)throw fail('Cannot adopt an existing native conversation')}
    else if(response.new_binding!==false||!existing)throw fail('Native creation is unconfirmed; use explicit original-source recovery')
    return await ready(row,{create:response.new_binding===true})
   }finally{opening.delete(b.binding_id)}
  },
  inputReceipt(agent,message){const row=owned.get(actual(agent)),staged=row?.staged.get(message.id);if(!staged)throw fail('No trusted interactive source');return clone(staged.proof)},
  async revalidateInput(agent,{binding,receipt:proof}){
   const receipt=proof?.receipt
   const row=await exact(agent,binding),stage=receipt&&row.staged.get(deliveryInputId(receipt.receipt_id))
   if(!stage||!equal(stage.proof,proof))throw fail('Interactive source identity differs')
   const checked=await backend.call(`${path}/bindings/${encodeURIComponent(binding.binding_id)}/sources/claim`,clone(stage.command))
   if(checked.new_claim!==false||!equal(checked.binding,binding)||!equal(checked.receipt,receipt)||!equal(checked.message,stage.proof.message))throw fail('Interactive source changed before input')
   await exact(agent,binding)
   if(row.staged.get(deliveryInputId(receipt.receipt_id))!==stage)throw fail('Interactive staged source changed')
   return true
  },
  async beforeTurn(agent,{binding,receipt:proof,selection}){
   const receipt=proof?.receipt
   const row=await exact(agent,binding)
   const requested=row.selection,model=selection?.model,effort=selection?.effort,codex=row.profile.type==='codex'||row.profile.protocol==='codex'
   if(selection?.scope!=='executor_configuration'||model?.requested!==requested.model||
      (codex?selection.source!=='turn/start_request'||model.status!=='requested':model.status!=='reported'||model.observed!==requested.model)||
      (requested.reasoningEffort!==undefined&&(effort?.requested!==requested.reasoningEffort||(codex?effort.status!=='requested':effort.status!=='reported'||effort.observed!==requested.reasoningEffort))))throw fail('Interactive native model changed')
   await runtime.revalidateInput(agent,{binding,receipt:proof})
   if(row.dispatches.has(receipt.receipt_id))throw fail('Source dispatch already attempted; reconcile without replay')
   row.dispatches.add(receipt.receipt_id)
   return {receipt_id:receipt.receipt_id,state:'claimed',dispatch_allowed:true}
  },
  async deliver(input){
   const row=await read(input.binding_id),b=row.binding
   if(active.has(b.binding_id))throw fail('Interactive conversation already delivering')
   active.add(b.binding_id)
   try{
    const {agent,error}=await controller().resolveAgent(b.native_session_id)
    if(error||!agent)throw fail('Original interactive Session unavailable')
    await exact(agent,b)
    const command={request_id:input.request_id,source_message_id:input.source_message_id}
    const result=await backend.call(`${path}/bindings/${encodeURIComponent(b.binding_id)}/sources/claim`,command)
    const r=result.receipt,m=result.message
    if(result.new_claim!==true||!equal(result.binding,b)||r?.binding_id!==b.binding_id||r.native_session_id!==agent.id||r.state!=='claimed'||m?.id!==input.source_message_id||r.source_message_id!==m.id||!equal(m.actor,{kind:'human',id:'local_owner'})||typeof m.content!=='string'||digest(m.content)!==r.source_content_sha256)throw fail('No fresh exact interactive source')
    const id=deliveryInputId(r.receipt_id),proof={binding:clone(b),receipt:clone(r),message:clone(m),new_claim:true}
    row.staged.set(id,{proof,command})
    await agent.followup({id,role:'user',source:{kind:'user'},content:[{type:'text',text:m.content}]});await agent.whenIdle()
    const completed=row.results.get(r.receipt_id)
    if(!completed)throw fail('Native turn outcome requires inspection; no automatic replay')
    return {...view(row),...clone(completed)}
   }finally{active.delete(b.binding_id)}
  },
  async completedTurn(agent,{binding,receipt,turn_id}){
   const row=await exact(agent,binding),r=receipt?.receipt
   if(!row.dispatches.has(r.receipt_id)||row.finishes.has(r.receipt_id)||!Number.isSafeInteger(turn_id)||turn_id<1)throw fail('Native completion lacks its unique source dispatch')
   const events=clone(Session.prototype.snapshotEvents.call(agent.session)),headers=clone(agent.session.header)
   const marker=events.find(e=>e.type===INPUT&&e.data.receipt_id===r.receipt_id)
   const identity=events.filter(e=>e.type===RECORD)
   const start=events.findLast(e=>e.type==='turn/start'&&e.data.turn===turn_id),end=events.findLast(e=>e.type==='turn/end'&&e.data.turn===turn_id)
   const answer=events.findLast(e=>e.type==='assistant/message'&&start&&end&&e.seq>start.seq&&e.seq<end.seq)
   if(identity.length!==1||!equal(identity[0].data.binding,binding)||!marker||marker.data.binding_id!==binding.binding_id||marker.data.source_message_id!==r.source_message_id||marker.data.source_content_sha256!==r.source_content_sha256||marker.data.native_session_id!==agent.id
    ||!start||!end||marker.seq>=start.seq||end.data.reason?.kind!=='completed'||!answer||headers.id!==agent.id||headers.cwd!==binding.workspace.root_ref||headers.parentSessionId||headers.parentSession)throw fail('Exact completed native journal proof unavailable')
   const users=events.filter(e=>e.type==='user/message'&&start&&end&&e.seq>start.seq&&e.seq<end.seq)
   if(users.length!==1||users[0].data.id!==marker.data.input_id||marker.data.input_id!==deliveryInputId(r.receipt_id)||!equal(users[0].data.content,[{type:'text',text:receipt.message.content}])||digest(receipt.message.content)!==r.source_content_sha256)throw fail('Completed turn source differs')
   const text=(answer.data.message?.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')
   if(!text.trim())throw fail('Native final answer is empty')
   if(await agent.ctx.sessions.flush(agent.session)!==true)throw fail('Native completion not durable');await exact(agent,binding)
   if(!equal(events,Session.prototype.snapshotEvents.call(agent.session))||!equal(headers,agent.session.header))throw fail('Native journal changed during completion')
   row.finishes.add(r.receipt_id)
   const command=Object.freeze({request_id:`finish:${r.receipt_id}`,receipt_id:r.receipt_id,native_session_id:agent.id,journal_id:agent.id,turn_id:String(turn_id),header_sha256:digest(JSON.stringify(headers)),source_marker_sha256:digest(JSON.stringify(marker)),text,text_sha256:digest(text)})
   const finished=clone(await backend.call(`${path}/bindings/${encodeURIComponent(binding.binding_id)}/sources/finish`,command))
   const out=finished.outbox,done=finished.receipt
   const report={journal_id:command.journal_id,turn_id:command.turn_id,header_sha256:command.header_sha256,source_marker_sha256:command.source_marker_sha256}
   if(!equal(finished.binding,binding)||!out?.outbox_id||out.state!=='pending'||out.binding_id!==binding.binding_id||out.receipt_id!==r.receipt_id||out.text!==text||out.text_sha256!==command.text_sha256||out.proof_kind!=='owner_host_report'||!equal(out.host_report,report)||!equal(done,{...r,state:'completed',outbox_id:out.outbox_id}))throw fail('Native completion receipt differs')
   await exact(agent,binding)
   const published=clone(await backend.call(`${path}/bindings/${encodeURIComponent(binding.binding_id)}/outbox/${encodeURIComponent(out.outbox_id)}/publish`,{}))
   const message=published.message,actor={kind:'interactive_participant',team_id:binding.team_id,participant_id:binding.participant_id,target_id:binding.target_id,session_id:binding.native_session_id}
   if(!message?.id||message.surface_id!==binding.surface_id||message.thread_id!==binding.thread_id||message.source_message_id!==r.source_message_id||message.content!==text||message.kind!=='superagent_reply'||message.delivery_state!=='published'||message.execution_authorized!==false||!equal(message.actor,actor)||!equal(message.scope,receipt.message.scope)||!equal(published.receipt,done)||!equal(published.outbox,{...out,state:'published',message}))throw fail('Native publication receipt differs')
   await exact(agent,binding)
   const result={state:'published',message_id:published.message.id,usage:{state:'unknown'}};row.results.set(r.receipt_id,result);return clone(result)
  },
 }
 return Object.freeze(runtime)
}

/** Interactive owner-bound native lifecycle. No budget, token, or Hub tool grant. */
import { symbols } from '@deepseek-ai/cordis'
import { Session, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { isDeepStrictEqual as equal } from 'node:util'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { deliveryInputId } from './delivery-tracker.js'
export const INTERACTIVE_TEAM_RECORD='plugin:kode/interactive-team'
export const INTERACTIVE_TEAM_INPUT_RECORD='plugin:kode/interactive-team-input'
const owners=new WeakMap(),raw=a=>a?.[symbols.original]??a,events=s=>Session.prototype.snapshotEvents.call(s)
const fail=m=>Object.assign(new Error(m),{code:'INTERACTIVE_TEAM_REJECTED'})
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value)}return value}
const sha=s=>createHash('sha256').update(s).digest('hex')
export const nativeInteractiveTeamBinding=a=>owners.get(raw(a))
export function assertInteractiveJournalAdmission(session,admission){
 const rows=events(session).filter(e=>e.type===INTERACTIVE_TEAM_RECORD)
 if(rows.length && (!admission||rows.length!==1||rows[0].seq!==0||!equal(rows[0].data.binding,admission.binding)))throw fail('Interactive journal requires its exact Host owner')
}
function validateSnapshot(snapshot,id,options){
 const b=snapshot?.binding,s=snapshot?.selection
 if(!b||b.version!==1||b.execution_mode!=='interactive_native'||b.state!=='bound'||b.native_session_id!==id||!/^session-[a-f0-9-]{36}$/.test(id)||!b.binding_id||!b.target_id||!['channel','dm'].includes(b.surface_kind)||!/^coordinator$|^worker:.+$/.test(b.participant_id)||!Number.isSafeInteger(b.team_revision)||!Number.isSafeInteger(b.context_epoch)||!Number.isSafeInteger(b.audience_revision)||!b.home_hub||!b.team_id||!b.surface_id||!b.thread_id||!isAbsolute(b.workspace?.root_ref??'')||!b.workspace.host_id||!b.workspace.workspace_id||snapshot.cwd!==b.workspace.root_ref||!s||s.provider!==`kode-agent-${b.selection?.profile_id}`||s.model!==b.selection.model||(s.reasoningEffort??null)!==(b.selection.reasoningEffort??null)||! /^[a-f0-9]{64}$/.test(b.selection.profile_revision)||options.meta?.cwd!==undefined&&options.meta.cwd!==snapshot.cwd)throw fail('Invalid interactive binding or frozen native selection')
 return b
}
function marker(row,input,proof){
 const p=structuredClone(proof),r=p?.receipt,m=p?.message,b=row.binding
 if(!equal(p?.binding,b)||r?.binding_id!==b.binding_id||r.native_session_id!==b.native_session_id||r.state!=='claimed'||!r.receipt_id||m?.id!==r.source_message_id||typeof m.content!=='string'||sha(m.content)!==r.source_content_sha256||!equal(m.actor,{kind:'human',id:'local_owner'})||m.surface_id!==b.surface_id||m.thread_id!==b.thread_id||input?.id!==deliveryInputId(r.receipt_id)||input.role!=='user'||!equal(input.source,{kind:'user'})||!equal(input.content,[{type:'text',text:m.content}]))throw fail('Interactive input differs from trusted source receipt')
 return {binding_id:b.binding_id,receipt_id:r.receipt_id,source_message_id:r.source_message_id,source_content_sha256:r.source_content_sha256,native_session_id:b.native_session_id,input_id:input.id}
}
function checkHistory(row,session,restore=false){
 assertInteractiveJournalAdmission(session,row)
 const log=events(session),records=log.filter(e=>e.type===INTERACTIVE_TEAM_INPUT_RECORD),seen=new Set()
 for(const r of records){
  const d=r.data
  if(d.binding_id!==row.binding.binding_id||d.native_session_id!==row.binding.native_session_id||d.input_id!==deliveryInputId(d.receipt_id)||seen.has(d.receipt_id))throw fail('Foreign or duplicate interactive source marker')
  seen.add(d.receipt_id)
  const users=log.filter(e=>e.type==='user/message'&&e.data.id===d.input_id)
  if(users.length>1||users.some(e=>e.seq<=r.seq||e.data.role!=='user'||e.data.content.length!==1||e.data.content[0].type!=='text'||sha(e.data.content[0].text)!==d.source_content_sha256))throw fail('Interactive source journal mismatch')
  if(restore){const u=users[0],start=u&&log.findLast(e=>e.seq<u.seq&&e.type==='turn/start');if(!start||!log.some(e=>e.seq>u.seq&&e.type==='turn/end'&&e.data.turn===start.data.turn&&e.data.reason?.kind==='completed'))throw fail('Uncertain interactive source cannot replay')}
 }
 if(log.some(e=>e.type==='user/message'&&!records.some(r=>r.data.input_id===e.data.id)))throw fail('Foreign interactive user history')
}
export async function prepareNativeInteractiveSession(ctx,options,restore,storedEvents){
 const id=options.resumeSessionId??options.sessionId,service=ctx.get('kodeInteractiveTeamRuntime'),mode=restore?'restore':'fresh'
 const markers=storedEvents?.filter(e=>e.type===INTERACTIVE_TEAM_RECORD)??[]
 if(markers.length>1)throw fail('Duplicate interactive identity')
 if(markers.length&&!service)throw fail('Interactive Host unavailable on restore')
 // For ordinary ids, the service contract is a local cache lookup, never a backend lookup.
 const snapshot=structuredClone(await service?.sessionAdmission(id,{mode,...(markers.length?{binding_id:markers[0].data.binding.binding_id}:{})}))
 if(!snapshot){if(markers.length)throw fail('Interactive journal cannot fall back to ordinary native');return null}
 if(!['setupAgent','assertSession','inputReceipt','revalidateInput','beforeTurn','completedTurn'].every(k=>typeof service[k]==='function'))throw fail('Interactive Host interface incomplete')
 if(options.seed!==undefined||options.parentAgent!==undefined||options.inheritedEventCount!==undefined||options.meta?.parentSession||options.meta?.isSeeded)throw fail('Interactive Session forbids inherited history')
 // SessionController may carry unrelated global defaults. The authenticated
 // binding supplies the frozen selection; the factory installs it before storage.
 const binding=validateSnapshot(snapshot,id,options);freeze(snapshot);const row={binding,snapshot,service,pending:Promise.resolve(),failed:false,sources:new Map(),turns:new Map()}
 const scopedTools=Object.freeze({schemas:()=>[]})
 const fiber=await ctx.isolate('tools').plugin({name:'interactive-native-tools',inject:['sessions','sessionPersistence','sessionProjections','agents','kodeAgents'],apply(c){c.provide('tools',scopedTools)}})
 row.check=async agent=>{if(await service.assertSession(agent,{binding:structuredClone(binding)})!==true||!equal(snapshot,await service.sessionAdmission(id,{mode,binding_id:binding.binding_id})))throw fail('Interactive authority changed');checkHistory(row,agent.session)}
 return {ctx:fiber.ctx.extend({tools:scopedTools}),binding,snapshot,selection:snapshot.selection,cwd:snapshot.cwd,
  bind(session){if(session.header?.parentSession||session.header?.isSeeded)throw fail('Interactive journal cannot inherit a parent');if(restore){if(!markers.length||session.inheritedEventCount)throw fail('Interactive cold restore requires owned journal');checkHistory(row,session,true)}else{if(events(session).length||session.inheritedEventCount)throw fail('Interactive Session must be fresh');appendPluginRecord(session,INTERACTIVE_TEAM_RECORD,{version:1,binding:structuredClone(binding),usage_state:'unknown'})}},
  async setup(agent){owners.set(raw(agent),row);await service.setupAgent(agent,{binding:structuredClone(binding),mode});await row.check(agent)},check:row.check,
  async close(agent){if(agent)owners.delete(raw(agent));await fiber.dispose()}}
}
export function assertNativeInteractiveAction(agent,action){if(nativeInteractiveTeamBinding(agent))throw fail(`Interactive Team cannot ${action}`)}
export function enqueueNativeInteractiveInput(agent,message){
 const row=nativeInteractiveTeamBinding(agent),input=structuredClone(message),proof=structuredClone(row.service.inputReceipt(agent,input)),data=marker(row,input,proof)
 const task=row.pending.then(async()=>{
  if(row.failed||agent.disposed)throw fail('Interactive input is fenced')
  await row.check(agent)
  if(events(agent.session).some(e=>e.type===INTERACTIVE_TEAM_INPUT_RECORD&&e.data.receipt_id===data.receipt_id))throw fail('Interactive source already recorded; no replay')
  if(proof.new_claim!==true||await row.service.revalidateInput(agent,{binding:row.binding,receipt:proof})!==true)throw fail('Interactive source revoked or not new')
  try{appendPluginRecord(agent.session,INTERACTIVE_TEAM_INPUT_RECORD,data);if(await agent.ctx.sessions.flush(agent.session)!==true)throw fail('Interactive source not durable')
   row.sources.set(input.id,proof);await row.check(agent)
   if(await row.service.revalidateInput(agent,{binding:row.binding,receipt:proof})!==true)throw fail('Interactive source revoked')
   agent.inbox.append('next-turn',input);if(await agent.ctx.sessions.flush(agent.session)!==true)throw fail('Interactive inbox not durable');agent.parked=false;agent.wake();return {state:'queued',receipt_id:data.receipt_id}
  }catch(e){row.failed=true;throw e}
 });row.pending=task.catch(()=>{});return task
}
export async function awaitNativeInteractiveInput(agent){await nativeInteractiveTeamBinding(agent)?.pending}
export async function assertNativeInteractiveTurn(agent,{selection,messages,nativeContinuation}){
 const row=nativeInteractiveTeamBinding(agent);if(!row)return
 if(row.failed||nativeContinuation||messages.length!==1||!equal(selection,row.snapshot.selection))throw fail('Interactive turn selection/source mismatch')
 const proof=row.sources.get(messages[0].id);marker(row,messages[0],proof)
 await row.check(agent);if(await row.service.revalidateInput(agent,{binding:row.binding,receipt:proof})!==true)throw fail('Interactive source revoked')
 if(await agent.ctx.sessions.flush(agent.session)!==true)throw fail('Interactive turn not durable')
 row.turns.set(agent.turn,proof)
}
export async function completeNativeInteractiveTurn(agent,turn,reason){
 const row=nativeInteractiveTeamBinding(agent);if(!row)return
 const receipt=row.turns.get(turn);if(!receipt)return
 row.turns.delete(turn)
 if(reason.kind!=='completed'){row.failed=true;if(reason.kind==='interrupted'&&row.service.interruptedTurn){await row.check(agent);await row.service.interruptedTurn(agent,{binding:structuredClone(row.binding),receipt:structuredClone(receipt),turn_id:turn})}return}
 await row.check(agent)
 // Host derives final text and fixed target from this owned, completed journal.
 try{await row.service.completedTurn(agent,{binding:structuredClone(row.binding),receipt:structuredClone(receipt),turn_id:turn})}catch(error){row.failed=true;throw error}
}

/** Deny-only history export boundary. Markers grant no execution authority. */
export function assertNoInteractiveHistoryCopy(log){
 if(log?.some(e=>e.type===INTERACTIVE_TEAM_RECORD||e.type===INTERACTIVE_TEAM_INPUT_RECORD))throw fail('Interactive Team history cannot be copied into an ordinary Session')
}
export async function assertInteractiveParentHistory(ctx,options){
 assertNoInteractiveHistoryCopy(options.seed)
 if(nativeInteractiveTeamBinding(options.parentAgent))throw fail('Interactive Team cannot parent an ordinary Session')
 assertNoInteractiveHistoryCopy(options.parentAgent?.session?.snapshotEvents?.())
 const parent=options.meta?.parentSession??options.meta?.parentSessionId
 if(!parent)return
 const live=ctx.agents.get(parent)
 if(live){assertNoInteractiveHistoryCopy(live.session.snapshotEvents());if(nativeInteractiveTeamBinding(live))throw fail('Interactive Team cannot export its parent history')}
 let handle
 try{handle=await ctx.sessionPersistence.open(parent,'read');const stored=await handle.read();assertNoInteractiveHistoryCopy(stored.events)}finally{await handle?.close()}
}

/** Compose existing authenticated Session clients, native profiles and ledgers.
 * No registration, token generation, catalog, tool grant or model fallback here.
 * Capability inspection must be the Host's native implementation, not input data.
 */
import {nativeScopeCapability} from './native-scope-capability.js'
import {isDeepStrictEqual} from 'node:util'
import {createHash} from 'node:crypto'
import {Session} from '@deepseek-ai/dsh-session'
import {contextScopeKey} from './context-scope.js'
import {profileRevision} from './agent-profiles.js'
import {deliveryInputId} from './delivery-tracker.js'
import {acquireOperationLease} from './operation-lease.js'
import {createNativeContextInputClient} from './native-context-input-client.js'
import {createScopedRolePromptResolver} from './native-scoped-role-prompt.js'
const fail=(message,code='NATIVE_SCOPE_HOST_REJECTED')=>Object.assign(Error(message),{code})
const hash=text=>createHash('sha256').update(text).digest('hex')
export function createNativeCoordinatorHostRuntime({host,clientForSession,profiles,workspaceRegistry,usageOutbox,selectionOutbox,context,nativeFactory}){
 if(!host||typeof clientForSession!=='function'||!profiles||!usageOutbox||!selectionOutbox)throw fail('Existing native Host services required')
 const rows=new Map(),owned=new WeakMap()
 const path=key=>`/api/v1/messaging/context-v2/contexts/${encodeURIComponent(key)}`
 async function read(id){
  if(!/^context-[a-f0-9]{64}$/.test(id))throw fail('Reserved scope Session required')
  const client=clientForSession(id);if(!client)throw fail('Existing authenticated Session credential required','scope_session_not_registered')
  const result=await client.call(`${path(id.slice(8))}/source-authority`),a=result?.authority,f=result?.host_binding?.frozen,op=result?.operation
  if(result.source_read_allowed!==true||result.dispatch_allowed!==false||a?.session_id!==id||a.context_key!==contextScopeKey(a.context_scope)
   ||a.context_scope.home_hub!==host||a.worker?.node_id!==host||a.worker.session_id!==id||a.origin.host_id!==host
   ||!['discussion_thread','team_private'].includes(a.context_scope.kind)||f?.context?.key!==a.context_key
   ||!isDeepStrictEqual(f.context.context_scope,a.context_scope)||!isDeepStrictEqual(f.context.origin,a.origin)||f.context.team_revision!==a.team_revision
   ||op?.id!==a.operation_id||op.attempt!==a.attempt||op.epoch!==a.epoch||!isDeepStrictEqual(op.worker,a.worker)
   ||!op.grant_required||!op.budget_required||!op.resource_required||result.host_binding.state!=='bound_not_admitted')throw fail('Authenticated scope source authority mismatch')
  const target=f.execution_target,profile=profiles.get(target.executor_profile_id)
  if(!profile||profileRevision(profile)!==target.executor_profile_revision||target.host_id!==host
   ||op.resource?.profile!==profile.id||op.selection_policy?.profile_revision!==target.executor_profile_revision
   ||op.selection_policy.model!==target.model_id||(op.selection_policy.effort??null)!==(target.effort??null))throw fail('Original native profile/model differs from frozen owner choice')
  const workspace=workspaceRegistry.list().find(w=>w.id===a.origin.workspace_id)
  if(!workspace||workspace.path!==a.origin.root_ref)throw fail('Original workspace binding unavailable')
  const selection={provider:`kode-agent-${profile.id}`,model:target.model_id,...(target.effort==null?{}:{reasoningEffort:target.effort})}
  const snapshot={authority:structuredClone(a),cwd:workspace.path,selection}
  const operation={id:op.id,attempt:op.attempt,epoch:op.epoch,budget_required:true}
  return {client,result,profile,snapshot,operation}
 }
 async function current(id){
  const fresh=await read(id),prior=rows.get(id)
  if(prior&&(!isDeepStrictEqual(prior.snapshot,fresh.snapshot)||!isDeepStrictEqual(prior.result.host_binding.frozen,fresh.result.host_binding.frozen)))throw fail('Frozen native scope changed')
  if(prior){prior.result=fresh.result;return prior}
  const row={...fresh,receipts:new Map(),agents:new WeakSet()};rows.set(id,row);return row
 }
 async function exact(agent){const row=owned.get(agent);if(!row||!row.agents.has(agent)||agent.id!==row.snapshot.authority.session_id)throw fail('Foreign native agent');await current(agent.id);return row}
 async function capability(row){
  const support=nativeScopeCapability({profile:structuredClone(row.profile),selection:structuredClone(row.snapshot.selection),grant:structuredClone(row.result.host_binding.frozen.grant)})
  if(support?.supported!==true||support.selection_confirmed!==true||support.tool_scope_verified!==true||support.usage_supported!==true)throw fail(`Original executor cannot yet enforce scoped execution: ${(support?.reasons??['capability_unverified']).join(', ')}`,'native_scope_capability_unsupported')
  return support
 }
 const service={
  async deliver(input){
   if(!input||Object.keys(input).sort().join(',')!=='entry_id,request_id,session_id'||!['entry_id','request_id','session_id'].every(k=>typeof input[k]==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(input[k])))throw fail('Exact stored input reference required')
   input=structuredClone(input)
   const row=await current(input.session_id)
   await capability(row) // Unsupported executors do not consume the source.
   if(row.deliveryAttempted)throw fail('Native delivery already attempted; reconcile exact receipts')
   const factory=typeof nativeFactory==='function'?nativeFactory():nativeFactory
   if(!context||!factory?.createAgent)throw fail('Original native factory unavailable')
   row.deliveryAttempted=true
   let agent=context.agents.get(input.session_id)
   if(agent){if(!owned.has(agent))throw fail('Cannot adopt an unowned native Agent')}
   else{
    row.handle=await factory.createAgent(context,{sessionId:input.session_id,agentOptions:structuredClone(row.snapshot.selection),meta:{cwd:row.snapshot.cwd}})
    agent=row.handle.agent
    if(!owned.has(agent))throw fail('Original native factory omitted trusted scope setup')
   }
   const message=await service.stageInput(input.session_id,input)
   await agent.followup(message);await agent.whenIdle()
   return service.complete(agent)
  },
  async sessionAdmission(id,{mode}){if(!['fresh','restore'].includes(mode))throw fail('Invalid native admission mode');return structuredClone((await current(id)).snapshot)},
  async setupAgent(agent,{authority}){
   const row=await current(agent.id);if(!isDeepStrictEqual(authority,row.snapshot.authority)||owned.has(agent))throw fail('Native setup identity mismatch')
   const prior=profiles.binding(agent.id)
   if(prior?.managedOperation&&!isDeepStrictEqual(prior.managedOperation,row.operation))throw fail('Native operation cannot be rebound')
   if(prior&&(prior.profile?.id!==row.profile.id||prior.revision!==profileRevision(row.profile)||prior.managedBuilder||prior.managedAssignment||prior.managedCoordinator))throw fail('Native Session has another owner')
   await profiles.bind(agent.id,row.profile.id)
   await profiles.update(state=>{
    const binding=Object.hasOwn(state.bindings,agent.id)?state.bindings[agent.id]:undefined
    if(!binding||binding.profile?.id!==row.profile.id||binding.revision!==profileRevision(row.profile)
     ||binding.managedBuilder||binding.managedAssignment||binding.managedCoordinator
     ||(binding.managedOperation&&!isDeepStrictEqual(binding.managedOperation,row.operation))
     ||(binding.context_scope&&!isDeepStrictEqual(binding.context_scope,authority.context_scope)))throw fail('Native owner changed during setup')
    Object.assign(binding,{managedOperation:structuredClone(row.operation),context_scope:structuredClone(authority.context_scope),scoped_v2:true})
   })
   row.agents.add(agent);owned.set(agent,row)
  },
  async assertSession(agent,{authority}){const row=await exact(agent);return isDeepStrictEqual(authority,row.snapshot.authority)},
  inputReceipt(agent,message){const row=owned.get(agent),proof=row?.receipts.get(message.id);if(!proof)throw fail('No staged authoritative input');return structuredClone(proof)},
  async revalidateInput(agent,proof){
   const row=await exact(agent),a=row.snapshot.authority
   const value=await row.client.call(`${path(a.context_key)}/inbox/${encodeURIComponent(proof.entry.id)}/source?claim_id=${encodeURIComponent(proof.entry.claim_id)}`)
   if(value.source_validated!==true||value.dispatch_allowed!==false||!isDeepStrictEqual(value.authority,a)
    ||!isDeepStrictEqual(value.entry,proof.entry)||!isDeepStrictEqual(value.message,proof.message))throw fail('Claimed native source changed')
   return true
  },
  async stageInput(id,{entry_id,request_id}){
   const row=await current(id),a=row.snapshot.authority
   if(row.claimAttempted)throw fail('Source already attempted; explicit reconciliation required')
   row.claimAttempted=true
   const result=await row.client.call(`${path(a.context_key)}/inbox/claim`,{request_id,entry_id,operation_id:a.operation_id,journal_id:a.journal_id})
   if(result.new_claim!==true)throw fail('Source claim does not authorize another injection')
   const e=result.receipt?.entry??result.entry,m=result.message
   if(e?.id!==entry_id||e.context_key!==a.context_key||e.journal_id!==a.journal_id||e.operation_id!==a.operation_id||e.state!=='claimed'
    ||m?.id!==e.source_message_id||typeof m.content!=='string'||hash(m.content)!==e.source_content_sha256||m.attachments
    ||m.surface_id!==a.surface_id||m.thread_id!==a.thread_id||!isDeepStrictEqual(m.scope,a.origin)||!isDeepStrictEqual(m.actor,{kind:'human',id:'local_owner'}))throw fail('Exact text-only native input required')
   const proof={authority:a,entry:e,message:m},input={id:deliveryInputId(e.id),role:'user',source:{kind:'user'},content:[{type:'text',text:m.content}]}
   row.receipts.set(input.id,structuredClone(proof));return input
  },
  async assertNativeBinding(agent,{authority,operation,profile_revision}){
   const row=await exact(agent),binding=profiles.binding(agent.id)
   return isDeepStrictEqual(authority,row.snapshot.authority)&&isDeepStrictEqual(operation,row.operation)&&isDeepStrictEqual(binding.managedOperation,row.operation)&&binding.revision===profile_revision&&profile_revision===profileRevision(row.profile)
  },
  async assertResolvedNativeProfile(agent,{authority,operation,profile_revision,resolvedProfile}){
   const row=await exact(agent)
   if(!await service.assertNativeBinding(agent,{authority,operation,profile_revision})||!isDeepStrictEqual(resolvedProfile,row.profile))throw fail('Resolved executor differs from owner-frozen profile','native_resolved_profile_unverified')
   return true
  },
  async acquireOperationLease(agent,operation,signal,{beforeClaim}={}){
   const row=await exact(agent);if(!isDeepStrictEqual(operation,row.operation))throw fail('Wrong original operation')
   const support=await capability(row)
   return acquireOperationLease(row.client,operation,{node_id:host,session_id:agent.id,profile_id:row.profile.id,grant_enforcement:support.tool_scope_verified===true},{signal,beforeClaim})
  },
  async beforeInference(agent,proof){
   const row=await exact(agent)
   if(!await service.assertNativeBinding(agent,proof)||!proof.lease)throw fail('Original native lease binding required')
   if(!isDeepStrictEqual(proof.input,[{type:'text',text:proof.source?.message?.content}]))throw fail('Actual native input differs from exact source')
   await capability(row);await proof.lease.assertActive();await service.revalidateInput(agent,proof.source)
   selectionOutbox.assertSettled(agent.id,row.operation,proof.lease.selectionPolicy)
   if(row.transport)throw fail('Native inference already attempted')
   const a=row.snapshot.authority,f=row.result.host_binding
   row.transport=createNativeContextInputClient({client:row.client,binding:{context_key:a.context_key,session_id:a.session_id,journal_id:a.journal_id,host_binding_id:f.binding_id,manifest_sha256:f.frozen.manifest_sha256,operation:row.operation}})
   return row.transport.begin(proof.source,proof.signal)
  },
  async resolveRolePrompt(agent,{authority,mode}){
   await exact(agent)
   return createScopedRolePromptResolver({sourceAuthority:async()=> (await current(agent.id)).result,ownsAgent:(value,a)=>owned.has(value)&&isDeepStrictEqual(a,owned.get(value).snapshot.authority)})(agent,{authority,mode})
  },
  async complete(agent){
   const row=owned.get(agent);if(!row?.transport)throw fail('No admitted native turn')
   const binding=profiles.binding(agent.id)
   if(agent.lastError||binding.lastOutcome!=='completed'||binding.operationClosed!==true)throw fail('Native completion remains uncertain')
   const events=Session.prototype.snapshotEvents.call(agent.session),sources=events.filter(e=>e.type==='plugin:kode/native-scoped-input')
   if(sources.length!==1)throw fail('Expected one exact native input per attempt')
   const suffix=events.filter(e=>e.seq>sources[0].seq),end=suffix.findLast(e=>e.type==='turn/end'),answer=suffix.findLast(e=>e.type==='assistant/message')
   if(end?.data?.reason?.kind!=='completed'||!answer||answer.seq>=end.seq)throw fail('No committed native final answer')
   const text=answer.data.message.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');if(!text.trim())throw fail('Empty native reply')
   await usageOutbox.tick()
   const usage=await usageOutbox.confirmedReceipt(agent.id,row.operation)
   const status=await row.transport.status();if(status.state!=='admitted')throw fail('Native turn needs explicit reconciliation')
   const finished=await row.transport.finish({request_id:`finish:${status.request_id}`,usage_event_id:usage.usage_event_id,text})
   const result=await row.client.call(`${path(row.snapshot.authority.context_key)}/native-inputs/${encodeURIComponent(finished.admission_id)}/publish`,{})
   if(typeof result?.message_id!=='string'||!result.message_id||typeof result.new_publication!=='boolean')throw fail('Native publication receipt invalid')
   return {state:'published',message_id:result.message_id}
  },
 }
 return Object.freeze(service)
}

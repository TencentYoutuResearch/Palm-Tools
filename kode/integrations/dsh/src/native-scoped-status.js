/** Read-only projection from existing exact-thread owner APIs. No bootstrap or replay. */
import {isDeepStrictEqual} from 'node:util'
import {contextScopeKey,discussionScopeId} from './context-scope.js'
const prefix='/api/v1/messaging/'
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v)
const fail=()=>Object.assign(Error('Scoped status evidence mismatch'),{code:'SCOPED_STATUS_EVIDENCE_INVALID'})
const unverified=reason=>({state:'not_verified',reason})
export async function readNativeScopedStatus(client,input){
 if(!input||Object.keys(input).sort().join(',')!=='source_message_id,surface_id,thread_id'||!Object.values(input).every(id))throw fail()
 const {surface_id,thread_id,source_message_id}=input
 let after=0,surface,source,exhausted=false
 // At most 200 messages; never inspect another thread or return any transcript.
 for(let count=0;count<4;count++){
  const page=await client.call(`${prefix}collaboration/surfaces/${encodeURIComponent(surface_id)}/messages?thread_id=${encodeURIComponent(thread_id)}&limit=50&after=${after}`)
  const s=page?.surface,scope=s?.scope
  if(s?.id!==surface_id||!s.enabled||!['channel','dm'].includes(s.kind)||!Array.isArray(s.team_ids)
   ||!scope||!['home_hub','host_id','workspace_id','root_ref'].every(k=>typeof scope[k]==='string'&&scope[k])
   ||!Array.isArray(page.items)||page.items.length>50||typeof page.has_more!=='boolean'
   ||surface&&!isDeepStrictEqual(surface,s))throw fail()
  surface=s
  if(page.items.some(m=>m.surface_id!==surface_id||m.thread_id!==thread_id||!isDeepStrictEqual(m.scope,scope)))throw fail()
  const matches=page.items.filter(m=>m.id===source_message_id);if(matches.length>1)throw fail()
  if(matches.length){source=matches[0];break}
  if(!page.has_more){exhausted=true;break}
  if(!Number.isSafeInteger(page.next_cursor)||page.next_cursor<=after)throw fail()
  after=page.next_cursor
 }
 const result={...input,state:'not_ready',automatic_replay_allowed:false,execution_confirmed:false,
  bootstrap:{state:'not_bootstrappable',reason:'stored_source_bootstrap_unavailable'},
  context:unverified('source_not_resolved'),activation:unverified('source_not_resolved'),
  credential:unverified('credential_not_inspected'),host_binding:unverified('host_binding_not_inspected'),
  capability:unverified('native_capability_not_inspected')}
 if(!source)return {...result,state:'source_not_verified',source:{state:exhausted?'not_found':'outside_lookup_window'},bootstrap:unverified('source_not_resolved')}
 if(source.actor?.kind!=='human'||source.actor.id!=='local_owner'||source.kind!=='discussion'||source.execution_authorized!==false)throw fail()
 result.source={state:source.delivery_state==='stored_only'?'stored_only':'existing_delivery',
  reason:['isolated_context_required','recipient_required','audience_publication_approval_required','team_activation_required','task_settled_or_cancelled','thread_context_compaction_required'].includes(source.delivery_reason)?source.delivery_reason:'unspecified'}
 if(result.source.state!=='stored_only'){
  result.state='existing_delivery';result.bootstrap=unverified('prior_delivery_requires_reconciliation');return result
 }
 result.state='stored_only'
 const mentions=source.mentions
 if(!Array.isArray(mentions)||mentions.length!==1||!id(mentions[0].team_id)||!Number.isSafeInteger(mentions[0].team_revision)||mentions[0].team_revision<1){
  result.context=unverified('single_team_recipient_required');result.activation=unverified('single_team_recipient_required');return result
 }
 const mention=mentions[0]
 if(!surface.team_ids.includes(mention.team_id)){
  result.context=unverified('recipient_no_longer_member');result.activation=unverified('recipient_no_longer_member');return result
 }
 const context_scope={version:2,home_hub:surface.scope.home_hub,team_id:mention.team_id,
  kind:surface.kind==='dm'?'team_private':'discussion_thread',scope_id:discussionScopeId(surface_id,thread_id),context_epoch:1}
 const key=contextScopeKey(context_scope)
 // A 400 may mean missing OR revoked context. Do not guess which from error prose.
 try{
  const response=await client.call(`${prefix}context-v2/contexts/${key}`),c=response?.context
  if(c?.key!==key||!isDeepStrictEqual(c.context_scope,context_scope)||c.surface_id!==surface_id||c.thread_id!==thread_id
   ||!isDeepStrictEqual(c.origin,surface.scope)||c.team_revision!==mention.team_revision||c.audience_revision!==surface.audience_revision)throw fail()
  result.context={state:'registered',context_key:key}
  result.bootstrap={state:'requires_explicit_input',reason:'registration_is_not_delivery_authority'}
 }catch(error){
  if(error.code==='SCOPED_STATUS_EVIDENCE_INVALID'||[401,403].includes(error.status))throw error
  result.context=unverified('context_unavailable_or_revoked')
 }
 try{
  const active=await client.call(`${prefix}teams/${encodeURIComponent(mention.team_id)}/activation`)
  if(active?.team_id!==mention.team_id||active.home_hub!==surface.scope.home_hub||typeof active?.active!=='boolean'||typeof active.authority_valid!=='boolean'||!Number.isSafeInteger(active.team_revision))throw fail()
  result.activation={state:active.active&&active.authority_valid&&active.team_revision===mention.team_revision?'authorized':'not_ready'}
 }catch(error){
  if(error.code==='SCOPED_STATUS_EVIDENCE_INVALID'||[401,403].includes(error.status))throw error
  result.activation=error.status===404?{state:'not_ready',reason:'activation_unavailable'}:unverified('activation_lookup_unavailable')
 }
 return result
}

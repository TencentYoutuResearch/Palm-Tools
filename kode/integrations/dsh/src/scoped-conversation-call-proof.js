/** Owned journal evidence only. Host callbacks must independently authenticate
 * the live scope binding and claim. Hashes never grant execution permission. */
import {isDeepStrictEqual} from 'node:util'
import {Session,pluginRecordOf} from '@deepseek-ai/dsh-session'
import {contextScopeKey} from './context-scope.js'
import {SCOPED_COORDINATOR_JOURNAL_RECORD} from './scoped-coordinator-journal.js'
import {PUBLIC_MANIFEST_RECORD,validatePublicManifest,canonicalManifestHash,publicTextHash} from './scoped-coordinator-prompt.js'
import {snapshotProviderRequest,verifyProviderRequest} from './scoped-provider-transport.js'
import {conversationRequestEvidence} from './scoped-conversation-request.js'
const fail=message=>Object.assign(Error(message),{code:'SCOPED_CALL_PROOF_REJECTED'})
const SOURCE='plugin:kode/scoped-local-input'
function inspectOwnedConversationCall({session,authority,claim,publicManifest},rawRequest){
  const a=structuredClone(authority),proof=structuredClone(claim),key=contextScopeKey(a.context_scope)
  if(!(session instanceof Session)||session.id!==a.session_id||a.session_id!==`context-${key}`||a.context_key!==key
    ||session.header.isSeeded!==false||session.header.parentSession!==undefined||session.inheritedEventCount!==0
    ||!['discussion_thread','team_private'].includes(a.context_scope.kind))throw fail('Owned conversation Session identity mismatch')
  const events=Session.prototype.snapshotEvents.call(session)
  const markers=events.filter(e=>pluginRecordOf(e)?.type===SCOPED_COORDINATOR_JOURNAL_RECORD)
  const expected={version:1,authority:{context_scope:a.context_scope,session_id:a.session_id,journal_id:a.journal_id},header:{...session.header,delegationDepth:session.header.delegationDepth??0}}
  if(markers.length!==1||markers[0].seq!==0||!isDeepStrictEqual(markers[0].data,expected))throw fail('Journal origin or generation mismatch')
  const accepted=validatePublicManifest(publicManifest.manifest,key),publicRows=events.filter(e=>pluginRecordOf(e)?.type===PUBLIC_MANIFEST_RECORD)
  if(!isDeepStrictEqual(accepted,publicManifest))throw fail('Public manifest accepted snapshot mismatch')
  if(publicRows.length!==1||publicRows[0].seq!==1||!isDeepStrictEqual(publicRows[0].data,{version:1,context_key:key,manifest_sha256:accepted.hash,tool_manifest_sha256:canonicalManifestHash(null)}))throw fail('Exact empty-tool public manifest mismatch')
  const sources=events.filter(e=>pluginRecordOf(e)?.type===SOURCE),last=sources.at(-1)
  if(!last||!isDeepStrictEqual(last.data.claim,{authority:a,entry:proof.entry})||!isDeepStrictEqual(proof.authority,a)
    ||proof.entry?.state!=='claimed'||proof.entry.context_key!==key||proof.entry.journal_id!==a.journal_id
    ||proof.entry.operation_id!==a.operation_id||proof.entry.source_message_id!==proof.message?.id
    ||last.data.input_id!==proof.message.id||last.data.content_sha256!==publicTextHash(proof.message.content)
    ||proof.entry.source_content_sha256!==last.data.content_sha256)throw fail('Current source claim mismatch')
  const userEvents=events.filter(e=>e.type==='user/message')
  for(const row of sources){
    const source=row.data,c=source.claim
    if(source.context_key!==key||!isDeepStrictEqual(c?.authority?.context_scope,a.context_scope)
      ||c.authority.journal_id!==a.journal_id||c.authority.session_id!==session.id)throw fail('Foreign source journal')
    const users=userEvents.filter(e=>e.data.id===source.message_id)
    if(users.length!==1||users[0].seq<=row.seq||!isDeepStrictEqual(users[0].data.source,{kind:'user'})
      ||users[0].data.content.length!==1||users[0].data.content[0].type!=='text'
      ||publicTextHash(users[0].data.content[0].text)!==source.content_sha256)throw fail('Source does not identify exact journal message')
  }
  if(userEvents.some(e=>sources.filter(s=>s.data.message_id===e.data.id).length!==1))throw fail('Unreceipted user history')
  const header=Session.prototype.requestHeader.call(session)
  if(!header||header.tools?.length)throw fail('Conversation-only header required')
  const expectedRequest={...header.config,sessionId:session.id,messages:Session.prototype.deriveMessages.call(session),toolHistory:Session.prototype.toolHistory.call(session),tools:[]}
  const request=verifyProviderRequest(snapshotProviderRequest(rawRequest),expectedRequest)
  const evidence=conversationRequestEvidence(request,{sessionId:session.id,route:header.config})
  return Object.freeze({evidence,source_sequence:last.seq,events:structuredClone(events)})
}

export function createScopedConversationCallProof({session,authority,claim,hostBinding,publicManifest,assertOwned,flush}){
  if(typeof assertOwned!=='function'||typeof flush!=='function')throw fail('Owned-session and durability callbacks required')
  const state={session,authority:structuredClone(authority),claim:structuredClone(claim),publicManifest:structuredClone(publicManifest)}
  const binding=structuredClone(hostBinding),a=state.authority,f=binding?.frozen
  const catalog={profile:'conversation_reply_v1',version:1,tools:[]},token=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v)
  if(!token(binding?.binding_id)||binding.revision!==1||binding.state!=='bound_not_admitted'||binding.context_key!==a.context_key
    ||binding.claim_allowed!==false||binding.execution_authorized!==false||binding.runtime_ready!==false
    ||!isDeepStrictEqual(f?.context?.context_scope,a.context_scope)||f.context.key!==a.context_key
    ||f.control?.context_key!==a.context_key||f.control.journal_id!==a.journal_id||!isDeepStrictEqual(f.control.context_scope,a.context_scope)
    ||f.control.request?.operation_id!==a.operation_id||f.operation?.id!==a.operation_id
    ||f.operation.attempt!==a.attempt||f.operation.epoch!==a.epoch||!isDeepStrictEqual(f.operation.worker,a.worker)
    ||f.enrollment?.revoked!==false||f.enrollment.home!==a.context_scope.home_hub||f.enrollment.host_id!==a.origin.host_id
    ||!isDeepStrictEqual(f.manifest,catalog)||f.manifest_sha256!==canonicalManifestHash(catalog))throw fail('Exact server Host scope binding required')
  let busy=false
  return Object.freeze({async prove(rawRequest){
    if(busy)throw fail('Call proof already in progress')
    // Snapshot before any external await. Never attest later caller mutations.
    const snapshot=snapshotProviderRequest(rawRequest),raw={...snapshot.content,...(snapshot.signal?{signal:snapshot.signal}:{})}
    busy=true
    try{
      await assertOwned()
      const before=inspectOwnedConversationCall(state,raw)
      if(await flush(session)!==true)throw fail('Owned writer durability not confirmed')
      await assertOwned()
      const after=inspectOwnedConversationCall(state,raw)
      if(!isDeepStrictEqual(before,after))throw fail('Journal changed during call proof durability')
      const entry=state.claim.entry,evidence=after.evidence
      if(![entry.id,entry.claim_id,entry.source_message_id].every(token))throw fail('Exact source receipt identity required')
      const scoped_call=Object.freeze({schema_version:1,profile_id:'conversation_reply_v1',host_binding_id:binding.binding_id,
        context_key:a.context_key,session_id:a.session_id,journal_id:a.journal_id,entry_id:entry.id,claim_id:entry.claim_id,
        source_message_id:entry.source_message_id,source_content_sha256:entry.source_content_sha256,
        request_sha256:evidence.request_sha256,tools_sha256:evidence.tools_sha256,manifest_sha256:f.manifest_sha256})
      return Object.freeze({scoped_call,...evidence})
    }finally{busy=false}
  }})
}

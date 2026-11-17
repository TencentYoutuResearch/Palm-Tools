/** Sources must be fetched from the authenticated owner-only Builder endpoint.
 * A matching model-supplied envelope, actor or hash never supplies authority.
 */
import {isDeepStrictEqual} from 'node:util'
import {Session} from '@deepseek-ai/dsh-session'
import {builderToken,validateBuilderAuthority} from './builder-context-scope.js'
import {canonicalManifestHash} from './scoped-builder-manifest.js'
export const BUILDER_INPUT_RECORD='plugin:kode/scoped-builder-input'
const fail=message=>Object.assign(Error(message),{code:'BUILDER_INPUT_REJECTED'})
export function validateBuilderInput(authority,value){
  authority=validateBuilderAuthority(authority)
  const source=structuredClone(value),request=source?.request,receipt=source?.receipt,a=authority
  if(!source||Object.keys(source).sort().join(',')!=='receipt,request'||!request||!receipt
    ||Object.keys(request).sort().join(',')!=='attempt,content,draft_id,epoch,request_id'
    ||!builderToken(request.request_id)||request.draft_id!==a.builder_context.draft_id
    ||request.attempt!==a.operation.attempt||request.epoch!==a.operation.epoch
    ||typeof request.content!=='string'||!request.content.trim()||Buffer.byteLength(request.content)>16384||request.content.includes('\0')
    ||receipt.operation_id!==a.operation.id||!builderToken(receipt.message_id)||receipt.home_hub!==a.builder_context.home_hub
    ||!isDeepStrictEqual(receipt.actor,{kind:'human',id:'local_owner'})
    ||!isDeepStrictEqual(receipt.worker,{node_id:a.builder_context.home_hub,session_id:a.session_id})
    ||receipt.state!=='queued'||!Number.isSafeInteger(receipt.created_at)||receipt.created_at<1)throw fail('Builder owner input receipt mismatch')
  return source
}
export function deriveBuilderToolInvocation({session,authority,source,execution,name,args}){
  if(!(session instanceof Session)||session.id!==authority.session_id||execution?.agent?.session!==session
    ||execution.parent!==undefined||execution.name!==name||!builderToken(execution.callId)
    ||execution.rootCallId!==undefined&&execution.rootCallId!==execution.callId||!isDeepStrictEqual(execution.arguments,args))throw fail('Owned Builder tool execution required')
  const events=Session.prototype.snapshotEvents.call(session),record=events.filter(e=>e.type===BUILDER_INPUT_RECORD).at(-1)
  if(!record||!isDeepStrictEqual(record.data.authority,authority)||!isDeepStrictEqual(record.data.source,source))throw fail('Builder tool source differs from journal')
  const step=events.filter(e=>e.type==='step/start').at(-1)
  const calls=events.filter(e=>e.type==='tool/call'&&e.seq>record.seq&&e.seq>step?.seq&&e.data.callId===execution.callId&&e.data.name===name)
  if(calls.length!==1)throw fail('Unique live Builder tool call required')
  const call=calls[0]
  if(call.data.turn!==step.data.turn||call.data.step!==step.data.step
    ||events.some(e=>e.seq>call.seq&&(e.type==='turn/end'||e.type==='step/end'||e.type==='tool/result'&&e.sourceEventSeqs?.includes(call.seq))))throw fail('Builder tool call already settled')
  let parsed;try{parsed=JSON.parse(call.data.arguments||'{}')}catch{throw fail('Builder arguments are not JSON')}
  if(!isDeepStrictEqual(parsed,args))throw fail('Builder tool arguments changed')
  const identity={context_key:authority.context_key,session_id:session.id,journal_id:authority.journal_id,
    operation:authority.operation,source_message_id:source.receipt.message_id,source_request_id:source.request.request_id,
    tool_call_seq:call.seq,tool_call_id:execution.callId,tool_name:name,arguments_sha256:canonicalManifestHash(args)}
  return {request_id:`builder-tool:${canonicalManifestHash(identity)}`,...identity}
}

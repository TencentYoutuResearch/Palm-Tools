/** Journal-derived identity, never a grant. The owned Root checks Agent identity,
 * authority and durability before and after deriving this immutable snapshot. */
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {Session} from '@deepseek-ai/dsh-session'
export const SCOPED_TOOL_IMPLEMENTATION='kode-context-stage-tools-v1'
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value
export const scopedToolHash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
export const scopedToolSchema=action=>({type:'object',properties:action==='publish_reply'?{text:{type:'string',minLength:1,maxLength:65536}}:{},required:action==='publish_reply'?['text']:[],additionalProperties:false})
export const scopedToolRequestId=({session_id,journal_id,source_receipt_id,tool_call_seq})=>'tool:'+createHash('sha256').update(JSON.stringify([1,session_id,journal_id,source_receipt_id,tool_call_seq])).digest('hex')
const fail=message=>Object.assign(Error(message),{code:'SCOPED_INVOCATION_REJECTED'})
export function deriveScopedToolInvocation({session,authority,grant,toolName,args,execution}){
  if(!(session instanceof Session)||session.id!==authority.session_id||execution?.agent?.session!==session
    ||execution.parent!==undefined||execution.name!==toolName||typeof execution.callId!=='string'
    ||!/^[A-Za-z0-9_.:-]{1,160}$/.test(execution.callId)
    ||execution.rootCallId!==undefined&&execution.rootCallId!==execution.callId
    ||!isDeepStrictEqual(execution.arguments,args))throw fail('Owned tool execution mismatch')
  const events=Session.prototype.snapshotEvents.call(session)
  const source=events.filter(e=>e.type==='plugin:kode/scoped-local-input').at(-1)
  const claim=source?.data?.claim,entry=claim?.entry
  if(!entry||grant.source_receipt_id!==entry.id||grant.entry_id!==entry.id||grant.claim_id!==entry.claim_id
    ||grant.source_message_id!==entry.source_message_id||source.data.input_id!==entry.source_message_id
    ||claim.authority?.journal_id!==authority.journal_id||claim.authority?.session_id!==session.id
    ||claim.authority?.operation_id!==authority.operation_id||entry.journal_id!==authority.journal_id)throw fail('Tool source claim mismatch')
  const step=events.filter(e=>e.type==='step/start').at(-1)
  const matches=events.filter(e=>e.type==='tool/call'&&e.seq>source.seq&&e.seq>step?.seq
    &&e.data.callId===execution.callId&&e.data.name===toolName)
  if(matches.length!==1)throw fail('Unique current journal tool call required')
  const call=matches[0]
  if(!Number.isSafeInteger(call.seq)||call.seq<1||call.data.turn!==step.data.turn||call.data.step!==step.data.step
    ||events.some(e=>e.seq>call.seq&&(e.type==='step/end'||e.type==='turn/end'||e.type==='tool/result'&&e.sourceEventSeqs?.includes(call.seq))))throw fail('Tool call already completed or stale')
  let parsed
  try{parsed=JSON.parse(call.data.arguments||'{}')}catch{throw fail('Tool call arguments are not JSON')}
  if(!isDeepStrictEqual(parsed,args))throw fail('Tool call argument mutation')
  const value={session_id:session.id,journal_id:authority.journal_id,source_receipt_id:entry.id,
    tool_call_seq:call.seq,tool_call_id:execution.callId,tool_name:toolName,arguments_sha256:scopedToolHash(args)}
  return Object.freeze({request_id:scopedToolRequestId(value),...value})
}

/** Unwired v2 inbox bridge. Backend authority, not user input, enables dispatch.
 * Prepared-only staging receipts never consume an input or invoke the root.
 * No automatic retries: uncertain claims require explicit reconciliation.
 */
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {contextScopeKey,discussionScopeId} from './context-scope.js'
const fail=message=>Object.assign(Error(message),{code:'SCOPED_DISPATCH_REJECTED'})
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(value)
const ready=value=>value?.runtime_ready===true&&value?.dispatch_allowed===true&&value?.stage==='runtime'
function identity(row,key){
  const a=structuredClone(row)
  if(!a||a.context_key!==key||contextScopeKey(a.context_scope)!==key
    ||a.session_id!==`context-${key}`||a.worker?.session_id!==a.session_id
    ||a.worker?.node_id!==a.context_scope.home_hub
    ||a.origin?.home_hub!==a.context_scope.home_hub
    ||!['journal_id','operation_id'].every(k=>id(a[k]))
    ||!['operation_revision','attempt','epoch','control_revision','team_revision','audience_revision'].every(k=>Number.isSafeInteger(a[k])&&a[k]>0))throw fail('Invalid authoritative scope identity')
  return a
}
export function createScopedCoordinatorDispatcher({backend,root}){
  if(!['authority','claim','finish'].every(k=>typeof backend?.[k]==='function')
    ||typeof root?.followupClaim!=='function')throw fail('Trusted inbox and owned root required')
  const busy=new Set()
  return Object.freeze({
    async deliver(contextKey,command){
      command=structuredClone(command)
      if(!command||Object.keys(command).some(k=>!['entry_id','request_id'].includes(k))
        ||!id(command.entry_id)||!id(command.request_id)||command.request_id.length>140)throw fail('Exact inbox command required')
      if(busy.has(contextKey))throw fail('Context dispatch already active')
      busy.add(contextKey)
      let claim,authority,entered=false,finishing=false,phase='authority'
      try{
        const before=await backend.authority(contextKey)
        if(!ready(before))throw fail('Scoped runtime not ready')
        authority=identity(before.authority,contextKey)
        phase='claim'
        claim=structuredClone(await backend.claim(contextKey,{request_id:command.request_id,entry_id:command.entry_id,
          operation_id:authority.operation_id,journal_id:authority.journal_id}))
        phase='validate_claim'
        if(!ready(claim)||!isDeepStrictEqual(identity(claim.authority,contextKey),authority))throw fail('Claim authority changed')
        if(claim.receipt?.entry?.id!==command.entry_id||claim.receipt.entry.context_key!==contextKey)throw fail('Claim receipt target changed')
        // Idempotent receipt reads do not grant permission to run the input again.
        if(claim.new_claim===false)return Object.freeze({state:'already_claimed',entry_id:command.entry_id})
        const e=claim.receipt?.entry,m=claim.message
        if(claim.new_claim!==true||!e||e.id!==command.entry_id||e.context_key!==contextKey
          ||e.state!=='claimed'||!id(e.claim_id)||e.operation_id!==authority.operation_id
          ||!Number.isSafeInteger(e.revision)||e.revision<2
          ||e.journal_id!==authority.journal_id||!isDeepStrictEqual(e.worker,authority.worker)
          ||e.operation_revision!==authority.operation_revision||e.operation_attempt!==authority.attempt
          ||e.operation_epoch!==authority.epoch||e.control_revision!==authority.control_revision
          ||!id(e.source_message_id)||m?.id!==e.source_message_id||m.kind!=='discussion'
          ||discussionScopeId(m.surface_id,m.thread_id)!==authority.context_scope.scope_id
          ||!isDeepStrictEqual(m.actor,{kind:'human',id:'local_owner'})
          ||!isDeepStrictEqual(m.scope,authority.origin)||typeof m.content!=='string'
          ||createHash('sha256').update(m.content).digest('hex')!==e.source_content_sha256)throw fail('Claim source identity changed')
        entered=true
        const latest=await backend.authority(contextKey)
        if(!ready(latest)||!isDeepStrictEqual(identity(latest.authority,contextKey),authority))throw fail('Authority revoked before delivery')
        const result=await root.followupClaim(contextKey,{authority,entry:e,message:m})
        if(result?.state!=='completed'||typeof result.finalText!=='string'||!result.finalText.trim())throw fail('No verified local turn outcome')
        finishing=true;phase='finish'
        const receipt=await backend.finish(contextKey,{request_id:`finish:${command.request_id}`,entry_id:e.id,
          claim_id:e.claim_id,operation_id:authority.operation_id,journal_id:authority.journal_id,
          outcome:'completed',reply:result.finalText})
        const terminal=receipt?.entry
        if(!ready(receipt)||!isDeepStrictEqual(identity(receipt.authority,contextKey),authority)
          ||!isDeepStrictEqual(terminal,{...e,revision:e.revision+1,state:'completed',reply:result.finalText}))throw fail('Terminal receipt does not confirm local outcome')
        return Object.freeze({state:'completed',entry_id:e.id,receipt,publication_confirmed:false})
      }catch(error){
        if(phase==='claim'||phase==='finish')throw Object.assign(new Error(`Scoped ${phase} outcome uncertain: ${error.message}`,{cause:error}),{
          code:'SCOPED_OUTCOME_UNCERTAIN',context_key:contextKey,entry_id:command.entry_id,
          request_id:phase==='claim'?command.request_id:`finish:${command.request_id}`,reconciliation_required:true})
        // Once admitted, failure might follow a model/tool effect. Record uncertain,
        // never put the input back on a queue. Failed reconciliation stays explicit.
        if(entered&&!finishing){
          const e=claim.receipt.entry
          try{const receipt=await backend.finish(contextKey,{request_id:`uncertain:${command.request_id}`,entry_id:e.id,
            claim_id:e.claim_id,operation_id:authority.operation_id,journal_id:authority.journal_id,
            outcome:'uncertain',reply:null})
            if(!isDeepStrictEqual(identity(receipt?.authority,contextKey),authority)
              ||!isDeepStrictEqual(receipt?.entry,{...e,revision:e.revision+1,state:'uncertain',reply:null}))throw fail('Uncertain outcome receipt mismatch')
          }catch(reconcile){throw Object.assign(new AggregateError([error,reconcile],'Scoped outcome uncertain; reconciliation required'),{
            code:'SCOPED_OUTCOME_UNCERTAIN',context_key:contextKey,entry_id:e.id,
            request_id:`uncertain:${command.request_id}`,reconciliation_required:true})}
          throw Object.assign(new Error(`Scoped outcome uncertain: ${error.message}`,{cause:error}),{
            code:'SCOPED_OUTCOME_UNCERTAIN',context_key:contextKey,entry_id:e.id,
            request_id:`uncertain:${command.request_id}`,reconciliation_required:false,automatic_replay_allowed:false})
        }
        throw error
      }finally{busy.delete(contextKey)}
    },
  })
}

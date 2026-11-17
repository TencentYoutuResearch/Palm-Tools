/** Closed model bridge for an independent root. No parent Cordis/LLM service is
 * inherited. A trusted Host must supply real lease and durable accounting policy;
 * acquirePermit returns a Host-owned operation lease plus a fresh durable call
 * policy; its lease lifecycle remains with that Host, not this per-call wrapper.
 * This helper neither acquires authority nor makes an unready backend ready.
 */
import {isDeepStrictEqual} from 'node:util'
import {contextScopeKey} from './context-scope.js'
import {streamLeasedOfficialCall} from './official-call-lease.js'
import {snapshotProviderRequest} from './scoped-provider-transport.js'
const fail=message=>Object.assign(Error(message),{code:'SCOPED_MODEL_REJECTED'})
export function createScopedCoordinatorModel({authority,resolveAuthority,acquirePermit,dispatch}){
  authority=structuredClone(authority)
  if(!authority||authority.context_key!==contextScopeKey(authority.context_scope)
    ||authority.session_id!==`context-${authority.context_key}`
    ||typeof authority.operation_id!=='string'||typeof authority.journal_id!=='string'
    ||![resolveAuthority,acquirePermit,dispatch].every(fn=>typeof fn==='function'))throw fail('Trusted scoped model dependencies required')
  let busy=false
  const check=async()=>{
    const current=await resolveAuthority()
    if(current?.runtime_ready!==true||current?.dispatch_allowed!==true||current?.stage!=='runtime'
      ||!isDeepStrictEqual(current.authority,authority))throw fail('Scoped model authority unavailable')
  }
  return function stream(raw){
    const snapshot=snapshotProviderRequest(raw)
    const request={...snapshot.content,...(snapshot.signal===undefined?{}:{signal:snapshot.signal})}
    return (async function*(){
    if(busy)throw fail('Scoped model call already active')
    if(request?.sessionId!==authority.session_id)throw fail('Scoped model session mismatch')
    busy=true
    try{
      await check()
      const permit=await acquirePermit(structuredClone(authority))
      if(!permit||!isDeepStrictEqual(permit.authority,authority)||!permit.lease?.signal
        ||typeof permit.lease.assertActive!=='function'||typeof permit.policy?.admit!=='function'
        ||typeof permit.policy?.record!=='function'||!permit.policy.callId
        ||request.provider!==permit.route?.provider||request.model!==permit.route?.model
        ||request.reasoningEffort!==permit.route?.reasoningEffort)throw fail('Exact operation lease, model route and accounting policy required')
      const lease={signal:permit.lease.signal,assertActive:async()=>{await check();await permit.lease.assertActive()}}
      // The original meter handles begin/usage/finish/interrupted with the same
      // durable policy used by ordinary official execution. No default raw path.
      const transport={async *stream(scoped){
        await lease.assertActive()
        for await(const chunk of dispatch(scoped)){await lease.assertActive();yield chunk}
      }}
      yield* streamLeasedOfficialCall(transport,request,lease,permit.policy)
    }finally{busy=false}
    })()
  }
}

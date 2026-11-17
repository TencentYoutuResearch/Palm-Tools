/** Builder's closed call boundary. The Host supplies authenticated admission,
 * not self-reported worker flags. Never pass the parent's prepared call here.
 */
import {Context} from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import {isDeepStrictEqual} from 'node:util'
import {validateBuilderAuthority} from './builder-context-scope.js'
import {snapshotProviderRequest} from './scoped-provider-transport.js'
import {streamLeasedOfficialCall} from './official-call-lease.js'
const fail=message=>Object.assign(Error(message),{code:'BUILDER_MODEL_REJECTED'})
export function createScopedBuilderModel({authority,resolveAdmission,acquirePermit,dispatch}){
  authority=validateBuilderAuthority(authority)
  if(![resolveAdmission,acquirePermit,dispatch].every(fn=>typeof fn==='function'))throw fail('Trusted Builder admission, lease and provider required')
  let busy=false
  const check=async()=>{
    const current=await resolveAdmission()
    if(current?.dispatch_allowed!==true||!isDeepStrictEqual(current.authority,authority))throw fail('Builder Host admission unavailable or changed')
  }
  return raw=>{
    const {content,signal}=snapshotProviderRequest(raw),request={...content,...(signal?{signal}:{})}
    return (async function*(){
      if(busy||request.sessionId!==authority.session_id)throw fail('Builder model session unavailable')
      busy=true
      try{
        await check()
        const permit=await acquirePermit(structuredClone(authority))
        if(!permit||!isDeepStrictEqual(permit.authority,authority)||!(permit.lease?.signal instanceof AbortSignal)
          ||typeof permit.lease.assertActive!=='function'||typeof permit.policy?.admit!=='function'||typeof permit.policy.record!=='function'
          ||!permit.policy.callId||request.provider!==permit.route?.provider||request.model!==permit.route.model
          ||request.reasoningEffort!==permit.route.reasoningEffort)throw fail('Exact Builder lease, selection and accounting required')
        const lease={signal:permit.lease.signal,assertActive:async()=>{await check();await permit.lease.assertActive()}}
        const transport={async *stream(input){
          await lease.assertActive()
          for await(const chunk of dispatch(input)){await lease.assertActive();yield chunk}
        }}
        yield* streamLeasedOfficialCall(transport,request,lease,permit.policy)
      }finally{busy=false}
    })()
  }
}

/** Host-only construction. Installs provider adapters into a NEW service/event
 * bus. The installer receives no parent Context or profiles, only registerAdapter.
 * Credential acquisition/configuration remains the existing authorized Host's job.
 */
export async function createIndependentBuilderProvider({installProvider}){
  if(typeof installProvider!=='function')throw fail('Independent provider installer required')
  const ctx=new Context();let closed=false
  try{
    await ctx.plugin(LlmRuntime)
    await installProvider(Object.freeze({registerAdapter:(names,adapter)=>ctx.llm.registerAdapter(names,adapter)}))
    return Object.freeze({
      async prepareCall(route,signal){
        if(closed||!route||Object.keys(route).some(k=>!['provider','model','reasoningEffort'].includes(k))
          ||!['provider','model'].every(k=>typeof route[k]==='string'&&route[k]))throw fail('Exact independent provider route required')
        const fixed=structuredClone(route),prepared=await ctx.llm.prepareCall(fixed,signal)
        if(!isDeepStrictEqual(prepared.config,fixed))throw fail('Independent provider changed selection')
        return Object.freeze({config:Object.freeze(structuredClone(prepared.config)),stream:raw=>{
          if(closed)throw fail('Independent provider closed')
          const {content,signal}=snapshotProviderRequest(raw)
          if(content.provider!==fixed.provider||content.model!==fixed.model||content.reasoningEffort!==fixed.reasoningEffort)throw fail('Prepared Builder route mismatch')
          return prepared.stream({...content,...(signal?{signal}:{})})
        }})
      },
      async close(){if(!closed){closed=true;await ctx.fiber.dispose()}},
    })
  }catch(error){await ctx.fiber.dispose().catch(()=>{});throw error}
}

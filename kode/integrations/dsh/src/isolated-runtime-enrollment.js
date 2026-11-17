/** Privileged owner-side Host identity handshake. Never pass ownerCall to a
 * model, root Context, tool, or session credential client. Enrollment is NOT a
 * runtime lease or permission to send model input. No credentials are created.
 */
import {randomUUID} from 'node:crypto'
const prefix='/api/v1/messaging/runtime-host-v1'
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(value)
const fail=message=>Object.assign(Error(message),{code:'HOST_ENROLLMENT_REJECTED'})
const freeze=value=>{if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value)}return value}
export function createIsolatedRuntimeEnrollment({ownerCall,home,hostId,bootId}){
  if(typeof ownerCall!=='function'||![home,hostId,bootId].every(token))throw fail('Privileged owner transport and exact Host identity required')
  const requestId=`host-register-${randomUUID()}`,challengeRequest=`host-challenge-${randomUUID()}`
  let enrollment,pending,attempted=false
  const validate=(value,allowRevoked=false)=>{
    const e=value?.enrollment
    if(!e||!token(e.id)||e.home!==home||e.host_id!==hostId||e.boot_id!==bootId||e.protocol_version!==1
      ||!Number.isSafeInteger(e.revision)||e.revision<1||typeof e.revoked!=='boolean'
      ||enrollment&&(e.id!==enrollment.id||e.revision<enrollment.revision||enrollment.revoked&&!e.revoked)
      ||value.status!==(e.revoked?'revoked':'active')||value.trust_basis!=='owner_admin_controlled_host'
      ||value.runtime_authorized!==false||value.runtime_ready!==false||!allowRevoked&&e.revoked)throw fail('Host enrollment identity or status mismatch')
    enrollment=freeze(structuredClone(e))
    return freeze({enrollment,status:value.status,runtime_authorized:false,runtime_ready:false})
  }
  const uncertain=(cause,phase)=>Object.assign(new Error(`Host ${phase} outcome needs reconciliation`,{cause}),{
    code:'HOST_ENROLLMENT_UNCERTAIN',request_id:requestId,reconciliation_required:true})
  const reconcile=async()=>{
    const response=await ownerCall(`${prefix}/register-requests/${encodeURIComponent(requestId)}`)
    if(response?.status==='not_found')throw uncertain(fail('No committed registration observed'),'registration')
    return validate(response,true)
  }
  return Object.freeze({
    get requestId(){return requestId},
    register(){
      if(pending)return pending
      if(attempted)return reconcile()
      attempted=true
      pending=(async()=>{
        let challenge
        try{challenge=await ownerCall(`${prefix}/challenges`,{request_id:challengeRequest,host_id:hostId,boot_id:bootId,protocol_version:1})}
        catch(cause){throw uncertain(cause,'challenge')}
        if(!token(challenge?.challenge_id)||typeof challenge.nonce!=='string'||!challenge.nonce||challenge.nonce.length>512
          ||!Number.isSafeInteger(challenge.expires_at)||challenge.expires_at<=0||challenge.home!==home
          ||challenge.host_id!==hostId||challenge.boot_id!==bootId||challenge.protocol_version!==1
          ||challenge.runtime_authorized!==false)throw fail('Host challenge identity mismatch')
        try{return validate(await ownerCall(`${prefix}/enrollments`,{request_id:requestId,challenge_id:challenge.challenge_id,
          nonce:challenge.nonce,host_id:hostId,boot_id:bootId,protocol_version:1}))}
        catch(cause){
          // Only read after an uncertain send. Never repeat registration or turn
          // an old receipt into a new lease/active permission.
          try{return await reconcile()}catch{throw uncertain(cause,'registration')}
        }
      })().finally(()=>{pending=undefined})
      return pending
    },
    reconcile,
    async status(){
      if(!enrollment)return reconcile()
      return validate(await ownerCall(`${prefix}/enrollments/${encodeURIComponent(enrollment.id)}`),true)
    },
    async revoke(){
      if(pending)throw fail('Host registration in progress')
      if(!enrollment)throw fail('Known Host enrollment required')
      if(enrollment.revoked)return freeze({enrollment,status:'revoked',runtime_authorized:false,runtime_ready:false})
      const expected=enrollment
      try{
        const response=await ownerCall(`${prefix}/revocations`,{request_id:`host-revoke-${randomUUID()}`,enrollment_id:expected.id,expected_revision:expected.revision})
        const result=validate(response,true)
        if(result.status!=='revoked'||result.enrollment.id!==expected.id||result.enrollment.revision!==expected.revision+1)throw fail('Revocation receipt mismatch')
        return result
      }catch(cause){
        try{const current=validate(await ownerCall(`${prefix}/enrollments/${encodeURIComponent(expected.id)}`),true);if(current.status==='revoked')return current}catch{}
        throw uncertain(cause,'revocation')
      }
    },
  })
}

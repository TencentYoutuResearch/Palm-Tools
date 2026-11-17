import test from 'node:test'
import assert from 'node:assert/strict'
import {createIsolatedRuntimeEnrollment} from '../src/isolated-runtime-enrollment.js'
function fixture(){
  const state={registers:0,revokes:0,challenge:0,entry:undefined,loseRegister:false,loseRevoke:false,loseChallenge:false}
  const response=()=>({enrollment:structuredClone(state.entry),status:state.entry.revoked?'revoked':'active',receipt_replay:false,
    trust_basis:'owner_admin_controlled_host',runtime_authorized:false,runtime_ready:false})
  const ownerCall=async(path,body)=>{
    if(path.endsWith('/challenges')){state.challenge++;if(state.loseChallenge)throw Error('challenge response lost');return{challenge_id:'challenge',nonce:'nonce',expires_at:Date.now()+30000,home:'home',host_id:'host',boot_id:'boot',protocol_version:1,runtime_authorized:false}}
    if(path.endsWith('/enrollments')&&body){state.registers++;assert.equal(body.nonce,'nonce');state.entry={id:'enrollment',home:'home',host_id:'host',boot_id:'boot',protocol_version:1,revision:1,revoked:false};if(state.loseRegister)throw Error('registration response lost');return response()}
    if(path.endsWith('/revocations')){state.revokes++;assert.equal(body.expected_revision,state.entry.revision);state.entry.revoked=true;state.entry.revision++;if(state.loseRevoke)throw Error('revocation response lost');return response()}
    if(path.includes('/register-requests/')||path.includes('/enrollments/'))return state.entry?response():{status:'not_found',runtime_authorized:false,runtime_ready:false}
    throw Error('unexpected endpoint')
  }
  const options={ownerCall,home:'home',hostId:'host',bootId:'boot'}
  return{state,options,api:createIsolatedRuntimeEnrollment(options)}
}
test('owner registration creates identity only, never runtime authority',async()=>{
  const f=fixture(),row=await f.api.register()
  assert.equal(row.status,'active');assert.equal(row.runtime_authorized,false);assert.equal(row.runtime_ready,false)
  assert.equal((await f.api.register()).enrollment.id,row.enrollment.id);assert.equal(f.state.registers,1)
})
test('lost register response reconciles by read and never repeats mutation',async()=>{
  const f=fixture();f.state.loseRegister=true
  assert.equal((await f.api.register()).status,'active');await f.api.register();assert.equal(f.state.registers,1)
})
test('unobserved challenge outcome remains explicitly uncertain',async()=>{
  const f=fixture();f.state.loseChallenge=true
  await assert.rejects(f.api.register(),e=>e.code==='HOST_ENROLLMENT_UNCERTAIN')
  await assert.rejects(f.api.register(),e=>e.reconciliation_required)
  assert.equal(f.state.challenge,1);assert.equal(f.state.registers,0)
})
test('revoke response loss reads current tombstone without replay',async()=>{
  const f=fixture();await f.api.register();f.state.loseRevoke=true
  assert.equal((await f.api.revoke()).status,'revoked');await f.api.revoke();assert.equal(f.state.revokes,1)
  assert.equal((await f.api.register()).status,'revoked');assert.equal(f.state.registers,1)
  f.state.entry.revoked=false
  await assert.rejects(f.api.status(),/identity or status/)
})
test('foreign home, boot or false readiness claims never pass',async()=>{
  for(const mutation of [r=>r.enrollment.home='foreign',r=>r.enrollment.boot_id='foreign',r=>r.runtime_ready=true,r=>r.runtime_authorized=true]){
    const f=fixture(),call=f.options.ownerCall
    const api=createIsolatedRuntimeEnrollment({...f.options,ownerCall:async(...args)=>{const r=await call(...args);if(r.enrollment)mutation(r);return r}})
    await assert.rejects(api.register());assert.equal(f.state.registers,1)
  }
})
test('concurrent register has one challenge and one registration',async()=>{
  const f=fixture();const [a,b]=await Promise.all([f.api.register(),f.api.register()])
  assert.deepEqual(a,b);assert.equal(f.state.challenge,1);assert.equal(f.state.registers,1)
})

/** Explicit owner-authorized free-model check: interrupt one admitted request, then use a fresh thread. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { CodexManagedDecision } from '../src/codex-managed-decision.js'

const stopSummary = value => value ? { leader_exited:value.leader_exited, process_group_empty:value.process_group_empty,
  signal_failure_count:value.signal_failures.length } : null
const summary = (decision, result, started) => ({
  elapsed_ms:Date.now()-started, admitted_requests:decision.gate?.forwarded??0,
  gate_state:decision.gate?.state??null, model:result.configuration?.model??null,
  model_basis:'requested_model_configuration_unverified', native_thread_id:result.configuration?.native_thread_id??null,
  terminal:result.terminal??null, usage:result.usage??null, stop:stopSummary(result.stop),
  exposed_tool_calls:result.calls.length, outcome:result.failure?'failed':'completed',
  failure_code:result.failure?.code??null, failure_name:result.failure?.name??null,
  failure_details:result.failure_details??null,
})

test('live Hy4 admitted cancellation stops its group without exposing tools and a fresh thread recovers', {
  skip:process.env.KODE_TEST_LIVE_FREE_WRAPPER!=='1', timeout:120000,
},async t=>{
  for(const name of ['KODE_TEST_MANAGED_CODEX_WRAPPER','KODE_TEST_MANAGED_CODEX_EXECUTABLE','KODE_TEST_WRAPPER_HOME','KODE_TEST_WRAPPER_PROVIDER','KODE_TEST_NATIVE_MODEL'])assert.ok(process.env[name],`Explicit ${name} required`)
  const root=await realpath(await mkdtemp(join(tmpdir(),'kode-live-recovery-'))),decisions=[]
  const evidence={schema_version:1,scope:'actual_live_cancellation_then_new_request_not_full_team_delivery',requested_model:process.env.KODE_TEST_NATIVE_MODEL,
    cost_basis:'owner_authorized_free_resource_not_independently_billed',provider_cost_status:'unconfirmed',phases:[]}
  let admissions=0,originalFailure
  const create=()=>{
    const decision=new CodexManagedDecision({cwd:root,stateRoot:root,model:process.env.KODE_TEST_NATIVE_MODEL,effort:'low',allowUserInput:false,timeoutMs:45000,
      profile:{type:'codex',executable:process.env.KODE_TEST_MANAGED_CODEX_WRAPPER,env:{TCODEX_SKIP_UPDATE:'1',TCODEX_DISABLE_TELEMETRY:'1'}},
      bootstrap:{executable:process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE,pathVariable:'TCODEX_CODEX_PATH',provider:process.env.KODE_TEST_WRAPPER_PROVIDER,home:process.env.KODE_TEST_WRAPPER_HOME},
      admit:async()=>{admissions++}})
    decisions.push(decision);return decision
  }
  try{
    const first=create(),started=Date.now()
    const tools=[{name:'kode_read_recovery_marker',description:'Read the harmless marker through a Host tool.',parameters:{type:'object',properties:{},additionalProperties:false}}]
    await first.prepare({messages:[{role:'system',content:[{type:'text',text:'Request only the supplied marker tool once. Do not access files, shell, network, or any other tool.'}]},
      {role:'user',content:[{type:'text',text:'Read the recovery marker.'}]}],tools})
    let cancelRequested=false,responseStatus=null,finished=false
    // Observes the real proxy response entering its pipe. It neither reads credentials nor replaces any response.
    first.gate.server.on('request',(_request,response)=>{
      response.once('pipe',()=>{
        responseStatus=response.statusCode
        if(finished||first.gate.state!=='forwarded')return
        cancelRequested=true
        first.stop.abort(Object.assign(Error('Acceptance requested cancellation'),{code:'LIVE_TEST_CANCELLED'}))
      })
    })
    const result=await first.execute();finished=true
    evidence.phases.push({phase:'admitted_interruption',...summary(first,result,started),cancel_requested:cancelRequested,
      response_status:responseStatus,race:cancelRequested?'cancel_requested_before_completion':'completed_or_failed_before_cancel',
      usage_status:result.usage?'reported':'unknown_not_zero',host_tool_executions:0})
    assert.equal(first.gate.forwarded,1,'the gate must not automatically retry inference')
    assert.equal(first.gate.forwarded,admissions)
    assert.deepEqual(result.calls,[],'an interrupted decision must not expose a Host tool')
    assert.ok(result.stop?.leader_exited&&result.stop.process_group_empty,'cannot recover before actual stop is proven')
    assert.equal(result.stop.signal_failures.length,0)
    if(cancelRequested)assert.ok(result.failure,'intentional cancellation must remain visible')

    const second=create(),recoveryStarted=Date.now()
    await second.prepare({messages:[{role:'system',content:[{type:'text',text:'Do not use any tools. Compute 2+3 and reply exactly PALM_HY4_RECOVERY_OK:5.'}]},
      {role:'user',content:[{type:'text',text:'Compute the sum.'}]}],tools:[]})
    const recovered=await second.execute()
    evidence.phases.push({phase:'fresh_thread_recovery',...summary(second,recovered,recoveryStarted),
      answer_matches:recovered.texts.join('').trim()==='PALM_HY4_RECOVERY_OK:5'})
    assert.equal(Boolean(recovered.failure),false,recovered.failure?.code??'recovery decision failed')
    assert.equal(recovered.texts.join('').trim(),'PALM_HY4_RECOVERY_OK:5')
    assert.deepEqual(recovered.calls,[])
    assert.ok(recovered.usage?.input_tokens>0)
    assert.ok(recovered.stop?.leader_exited&&recovered.stop.process_group_empty)
    assert.equal(recovered.stop.signal_failures.length,0)
    assert.notEqual(result.configuration.native_thread_id,recovered.configuration.native_thread_id)
    assert.equal(second.gate.forwarded,1)
    assert.equal(admissions,2)
    assert.equal(responseStatus,200,'interruption must observe a successful upstream response')
    assert.equal(cancelRequested,true,'completion before cancellation is a recorded race, not cancellation coverage')
    evidence.acceptance_passed=true
  }catch(error){
    originalFailure=error
    evidence.acceptance_passed=false
    evidence.original_failure={name:error.name,code:error.code??null}
    throw error
  }finally{
    // All cleanup is bounded by the existing native process-group stop implementation.
    let cleanupFailure
    for(const decision of decisions){try{await decision.close()}catch(error){cleanupFailure??=error}}
    if(cleanupFailure){evidence.acceptance_passed=false;evidence.cleanup_failure={name:cleanupFailure.name,code:cleanupFailure.code??null}}
    evidence.finished_at=Date.now();evidence.admissions=admissions
    evidence.cleanup=decisions.map(decision=>({stop:stopSummary(decision.stopEvidence),forwarded:decision.gate?.forwarded??0}))
    try{
      const destination=process.env.KODE_TEST_LIVE_EVIDENCE_DIR
      if(destination){
        assert.ok(isAbsolute(destination));await mkdir(destination,{recursive:true,mode:0o700})
        const folder=await mkdtemp(join(destination,'live-recovery-'))
        await writeFile(join(folder,'result.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600,flag:'wx'})
        t.diagnostic(JSON.stringify({live_recovery_evidence:join(folder,'result.json')}))
      }
    }catch{t.diagnostic('Live recovery evidence could not be saved; original acceptance result is retained')}
    t.diagnostic(JSON.stringify({live_recovery:evidence}))
    if(decisions.every(decision=>!decision.rpc||decision.stopEvidence?.process_group_empty)){try{await rm(root,{recursive:true,force:true})}catch{t.diagnostic('Private live test directory cleanup needs review')}}
    if(cleanupFailure&&!originalFailure)throw cleanupFailure
  }
})

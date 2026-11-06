import test from 'node:test'
import assert from 'node:assert/strict'
import { VerificationRunners } from '../src/verification-runners.js'
import { readBuilderVerificationReference } from '../src/builder-verification-reference.js'
test('Builder exact local command lookup exposes only public reference and rejects unselected hosts and arbitrary fields',async()=>{
 const registry=new VerificationRunners('/fixture/not-opened')
 const reference=registry.register({runner_id:'local',command_id:'check',revision:'1',executable:'/fixture/private-bin',executable_hash:'a'.repeat(64),args:['private-argument'],env:{FIXTURE_PRIVATE:'not-output'},timeout_ms:1000,max_output_bytes:1024,scenario_ids:['smoke'],capabilities:['read'],network:false,tool_id:'kode_verify_output'})
 const runtime={host:'home',closed:false,verificationRunners:registry,ready:Promise.resolve()},draft={home_hub:'home',status:'draft',interview:{workspace_refs:[{host_id:'home'}]}},input={runner_id:'local',command_id:'check',revision:'1'}
 const result=await readBuilderVerificationReference(runtime,draft,input)
 assert.deepEqual(result.reference,reference);assert.equal(result.execution_performed,false);assert.equal(result.registration_performed,false)
 assert.doesNotMatch(JSON.stringify(result),/private-bin|private-argument|FIXTURE_PRIVATE|not-output/)
 await assert.rejects(readBuilderVerificationReference(runtime,{...draft,interview:{workspace_refs:[{host_id:'foreign'}]}},input))
 await assert.rejects(readBuilderVerificationReference(runtime,{...draft,home_hub:'foreign'},input))
 await assert.rejects(readBuilderVerificationReference(runtime,draft,{...input,path:'/private/file'}))
 await assert.rejects(readBuilderVerificationReference(runtime,draft,{...input,revision:'missing'}))
 await registry.close()
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,writeFile,chmod,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VerificationRunners } from '../src/verification-runners.js'
import { previewVerification,confirmVerification } from '../src/verification-review.js'
test('review binds executable bytes and host, never executes, and recovers immutable registration after restart',async t=>{
 const root=await mkdtemp(join(tmpdir(),'kode-command-review-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const executable=join(root,'check');await writeFile(executable,'fixture executable, must never run');await chmod(executable,0o700)
 let runners=new VerificationRunners(join(root,'registry'))
 const input={runner_id:'local',command_id:'check',revision:'1',executable,args:['--check'],timeout_ms:1000,max_output_bytes:1024,scenario_ids:['smoke'],capabilities:['read'],network:false,tool_id:'kode_verify_output'}
 const review=await previewVerification(runners,'home',input)
 assert.equal(runners.definitions.size,0);assert.equal(runners.pending.size,0);assert.deepEqual(review.definition.env,{})
 await assert.rejects(previewVerification(runners,'home',{...input,env:{SECRET:'not-read'}}))
 await assert.rejects(confirmVerification(runners,'foreign',review))
 await assert.rejects(confirmVerification(runners,'home',{...review,definition:{...review.definition,args:['different']}}))
 await writeFile(executable,'changed bytes')
 await assert.rejects(confirmVerification(runners,'home',review),/content changed/)
 const current=await previewVerification(runners,'home',input),receipt=await confirmVerification(runners,'home',current)
 assert.equal(receipt.execution_performed,false);assert.equal(runners.pending.size,0)
 await runners.close();runners=await new VerificationRunners(join(root,'registry')).open()
 await writeFile(executable,'later changed file cannot invalidate committed registration recovery')
 assert.deepEqual(await confirmVerification(runners,'home',current),receipt)
 await assert.rejects(confirmVerification(runners,'home',await previewVerification(runners,'home',input)),/identity conflict/)
 await runners.close()
})

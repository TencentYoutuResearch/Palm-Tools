/** Real Hub/Host startup, with an executable tripwire instead of any provider. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdtemp,rm,access} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {liveParallelFixtureSource} from './support/live-parallel-fixture-source.js'
test('parallel transformed real Hub startup reaches live boundary without inference',{skip:!process.env.KODE_TEST_BACKEND_URL},async()=>{
 const root=await mkdtemp(join(tmpdir(),'parallel-setup-')),script=new URL('.parallel-setup-'+randomUUID()+'.mjs',import.meta.url),sentinel=join(root,'provider-called'),engine=join(root,'forbidden-provider')
 try{
  await writeFile(engine,`#!/bin/sh\ntouch '${sentinel}'\nexit 91\n`,{mode:0o700})
  let source=liveParallelFixtureSource(await readFile(new URL('fixture-coordinator-pipeline.js',import.meta.url),'utf8'))
  source=source.replace("const nativeCoordinator=process.env.KODE_TEST_NATIVE_COORDINATOR==='1'||liveCoordinatorScenario","const nativeCoordinator=false // setup-only: controlled DSH profile, no provider executable")
  source=source.replace("effort:liveCoordinatorScenario?'low':null","effort:null")
  const seam="   liveEvidence=createLiveEvidenceRecorder({directory:process.env.KODE_TEST_LIVE_EVIDENCE_DIR,team,profiles,ctx,call,diagnostic:value=>t.diagnostic(value)})"
  assert.equal(source.split(seam).length,2)
  source=source.replace(seam,`   assert.ok(owned&&host.coordinatorInbox&&runService)
   assert.equal(calls,0)
   assert.equal(execution.managedCodex.active.size,0)
   assert.equal((await call('budgets/budget/reservations')).reservations.length,1)
   assert.equal((await call('budgets/budget')).budget.reserved,40)
   t.diagnostic(JSON.stringify({parallel_setup_verified:true,decisions:0}))
   return
${seam}`)
  await writeFile(script,source,{flag:'wx'})
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('KODE_TEST_')&&key!=='NODE_TEST_CONTEXT'))
  Object.assign(env,{KODE_TEST_BACKEND_URL:'fixture',KODE_TEST_LIVE_COORDINATOR:'1',KODE_TEST_LIVE_FREE_WRAPPER:'1',KODE_TEST_MANAGED_CODEX_EXECUTABLE:engine,KODE_TEST_MANAGED_CODEX_WRAPPER:engine,KODE_TEST_WRAPPER_PROVIDER:'forbidden-setup-only',KODE_TEST_WRAPPER_HOME:root,KODE_TEST_NATIVE_MODEL:'setup-only'})
  const result=spawnSync(process.execPath,['--test','--test-reporter=spec',script.pathname],{env,encoding:'utf8'})
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr)
  assert.match(result.stdout,/"parallel_setup_verified":true/)
  await assert.rejects(access(sentinel),{code:'ENOENT'})
 }finally{await rm(script,{force:true});await rm(root,{recursive:true,force:true})}
})

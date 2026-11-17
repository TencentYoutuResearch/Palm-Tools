import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { retainedFeatureRunner, freezeFeatureManifest, prepareFeatureSnapshot } from './support/retained-feature-runner.js'
const manifest={task_id:'example-replay',source_repo:'/fixture/source',source_commit:'a'.repeat(40),snapshot_paths:['src'],allowed_write_paths:['src/feature.js'],request:'帮我修一下这个小问题，完成后请独立检查并告诉我结果。',verification:{executable:process.execPath,args:['-e','process.exit(0)'],env:{},timeout_ms:1000,max_output_bytes:1000,scenario_ids:['boundary']}}
async function fixture(t,options={}){
 const root=await mkdtemp(join(tmpdir(),'retained-runner-test-'));t.after(()=>rm(root,{recursive:true,force:true}));let state='queued',disposed=0,scansStopped=0,sends=0,stops=0,guard,observeStage
 const runtime={ui:{send:async request=>{guard();assert.equal(request,manifest.request);sends++;return{id:'human'}}},status:async()=>({state}),pauseAutomatic:async()=>{scansStopped++},requestOwnerCancel:async()=>{stops++;state='cancelling'},reconcileCancellation:async()=>({state:'cancel_unconfirmed'}),capture:async()=>{},close:async()=>{disposed++}}
 const runner=await retainedFeatureRunner({manifest,runMs:options.runMs??10000,stageMs:options.stageMs??5000,createHub:async()=>({root,node:'retained-example',stop:async()=>{}}),prepareSnapshot:async()=>({root:join(root,'project')}),createRuntime:async args=>{guard=args.admit;observeStage=args.observeStage;assert.equal(args.deadlines.decisionMs,300000);return runtime}})
 t.after(()=>runner.close());return{runner,root,runtime,setState:s=>state=s,observeStage:id=>observeStage(id),disposed:()=>disposed,scansStopped:()=>scansStopped,sends:()=>sends,stops:()=>stops}
}
test('manifest is immutable; traversal and accidental real inference are rejected',async()=>{
 const frozen=freezeFeatureManifest(manifest);assert.ok(Object.isFrozen(frozen.manifest.verification.args));assert.match(frozen.hash,/^[a-f0-9]{64}$/)
 assert.throws(()=>freezeFeatureManifest({...manifest,snapshot_paths:['../secret']}))
 await assert.rejects(retainedFeatureRunner({manifest,mode:'hy4',createRuntime:async()=>{assert.fail('must not start')}}),/readiness/)
})
test('UI starts once, held status retains Host and random localhost control requires authorization',async t=>{
 const f=await fixture(t);await assert.rejects(async()=>f.runner.admit(),/paused/)
 assert.deepEqual(await Promise.all([f.runner.start(),f.runner.start()]),[{id:'human'},{id:'human'}]);assert.equal(f.sends(),1)
 f.runner.admit();await f.runner.pause(Object.assign(Error('timeout'),{code:23}));assert.throws(()=>f.runner.admit(),/paused/)
 assert.equal((await f.runner.status()).phase,'held');assert.equal(f.disposed(),0);assert.equal(f.scansStopped(),1)
 const control=JSON.parse(await readFile(join(f.root,'control.json'),'utf8'))
 assert.equal((await fetch(control.url+'/status')).status,401)
 const response=await fetch(control.url+'/status',{headers:{authorization:'Bearer '+control.token}})
 assert.equal(response.status,200);assert.equal((await response.json()).last_failure.code,23)
 assert.equal((await fetch(control.url+'/start',{method:'POST',headers:{authorization:'Bearer '+control.token}})).status,404)
})
test('owner cancel uses adapter authority, never claims a complete drain or releases accounting',async t=>{
 const f=await fixture(t);await f.runner.start();await f.runner.pause()
 assert.deepEqual(await f.runner.stop(),{state:'cancel_unconfirmed'});assert.deepEqual(await f.runner.stop(),{state:'cancel_unconfirmed'});assert.equal(f.stops(),1);assert.equal(f.disposed(),0)
 await f.runner.close();await f.runner.close();assert.equal(f.disposed(),1)
})
test('normal completion stops new admission but keeps UI and Host alive for independent acceptance',async t=>{
 const f=await fixture(t);await f.runner.start();f.setState('completed');assert.equal((await f.runner.status()).phase,'completed')
 assert.throws(()=>f.runner.admit(),/paused/);assert.equal(f.disposed(),0);assert.equal(f.scansStopped(),1)
 assert.deepEqual(await f.runner.start(),{id:'human'});assert.equal(f.sends(),1)
})
test('stage deadline pauses without resetting repeated observations or destroying owned execution',async t=>{
 const f=await fixture(t,{stageMs:15,runMs:5000});await f.runner.start();f.observeStage('implement');f.observeStage('implement')
 await new Promise(resolve=>setTimeout(resolve,40));assert.equal((await f.runner.status()).phase,'held');assert.equal(f.disposed(),0);assert.equal(f.scansStopped(),1)
})

test('snapshot copies only selected old committed files and leaves source dirty state unchanged',async t=>{
 const root=await mkdtemp(join(tmpdir(),'feature-source-test-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const source=join(root,'source'),hubRoot=join(root,'hub');await mkdir(join(source,'src'),{recursive:true});await mkdir(hubRoot)
 const git=args=>promisify(execFile)('/usr/bin/git',['-C',source,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'f@example.com',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'f@example.com'}})
 await git(['init','-q']);await writeFile(join(source,'src','feature.js'),'old committed source');await writeFile(join(source,'outside.txt'),'excluded');await git(['add','.']);await git(['commit','-qm','historical source'])
 const source_commit=(await git(['rev-parse','HEAD'])).stdout.trim();await writeFile(join(source,'src','feature.js'),'existing dirty content');await writeFile(join(source,'src','private-untracked.txt'),'do not copy')
 const before=(await git(['status','--porcelain=v1'])).stdout
 const snapshot=await prepareFeatureSnapshot({...manifest,source_repo:source,source_commit},hubRoot)
 assert.equal(await readFile(join(snapshot.root,'src','feature.js'),'utf8'),'old committed source')
 await assert.rejects(readFile(join(snapshot.root,'src','private-untracked.txt')),{code:'ENOENT'});await assert.rejects(readFile(join(snapshot.root,'outside.txt')),{code:'ENOENT'})
 assert.equal((await git(['status','--porcelain=v1'])).stdout,before);assert.equal(snapshot.committed_bytes,20);assert.equal(snapshot.root,await (await import('node:fs/promises')).realpath(snapshot.root))
})

test('uncertain UI send immediately pauses admission and cannot be resent with a fresh request',async t=>{
 const f=await fixture(t),failure=Error('UI reply lost');f.runtime.ui.send=async()=>{throw failure}
 await assert.rejects(f.runner.start(),error=>error===failure);assert.equal((await f.runner.status()).phase,'held');assert.equal(f.disposed(),0)
 assert.throws(()=>f.runner.admit(),/paused/);await assert.rejects(f.runner.start(),error=>error===failure)
})

test('delivery completion keeps final reply admission open until exact conversation report arrives',async t=>{
 const f=await fixture(t);await f.runner.start();let reported=false
 f.runtime.status=async()=>({state:'completed',completion_reported:reported})
 assert.equal((await f.runner.status()).phase,'running');f.runner.admit();assert.equal(f.scansStopped(),0)
 reported=true;assert.equal((await f.runner.status()).phase,'completed');assert.equal(f.scansStopped(),1)
 assert.throws(()=>f.runner.admit(),/paused/)
})

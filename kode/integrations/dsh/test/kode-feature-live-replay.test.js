/** Replay a real historical Kode feature through Home with one actual managed Worker; other roles are controlled. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
const exec=promisify(execFile)
import { selectiveReplayLog, replayProcessFailure } from './support/live-replay-log.js'
const featureCommit='e2f0c0ba8cf3517732bb81604ecfa89fafa8e7fe'
const modulePath='kode/integrations/dsh/src/model-alias.js'
const request='麻烦帮我在这个旧版 Kode 快照里补回默认模型选择功能。请在 kode/integrations/dsh/src/model-alias.js 增加并导出 resolveDefaultSelection(models, preference, fallbackModel)，保留已有 resolveAdvertisedModel 的行为。默认模型按显式偏好、fallback、目录默认和首项依次选择；推理强度只能取模型公布的值；Fast 需要模型声明能力，支持 service-tier 和 model-variant，显式 false 要保留，切换 variant 后使用目标模型的默认推理强度。非法输入请给出清楚的中文错误。只修改这个源文件，不改测试、不安装依赖、不联网、不提交推送。先读现有文件，做完后按团队流程归档交付就好。'
const verification=`
const assert=require('node:assert/strict');
(async()=>{const {pathToFileURL}=require('node:url'),{resolve}=require('node:path');const d=await import(pathToFileURL(resolve(${JSON.stringify(modulePath)})));assert.equal(typeof d.resolveDefaultSelection,'function');
const service=[{id:'fixture',name:'Friendly',isDefault:true,reasoningEfforts:[{id:'medium'},{id:'high'}],defaultReasoningEffort:'medium',fastCapability:{transport:'service-tier',tier:'priority',defaultEnabled:false}}];
assert.deepEqual(d.resolveDefaultSelection(service,{model:'fixture',reasoningEffort:'high',fast:true}),{model:'fixture',reasoningEffort:'high',fast:true});
assert.deepEqual(d.resolveDefaultSelection(service),{model:'fixture',reasoningEffort:'medium',fast:false});
assert.deepEqual(d.resolveDefaultSelection(service,{model:'Friendly',fast:false}),{model:'fixture',reasoningEffort:'medium',fast:false});
assert.throws(()=>d.resolveDefaultSelection(service,{model:'fixture',reasoningEffort:'invalid'}));assert.throws(()=>d.resolveDefaultSelection(service,{model:'fixture',reasoningEffort:''}));
assert.throws(()=>d.resolveDefaultSelection([{id:'plain'}],{model:'plain',fast:true}));assert.throws(()=>d.resolveDefaultSelection(service,{fast:'yes'}));assert.throws(()=>d.resolveDefaultSelection([]));
const variants=[{id:'normal',reasoningEfforts:[{id:'medium'}],defaultReasoningEffort:'medium',fastCapability:{transport:'model-variant',fastModelId:'fast',standardModelId:'normal',defaultEnabled:false}},{id:'fast',reasoningEfforts:[{id:'high'}],defaultReasoningEffort:'high',fastCapability:{transport:'model-variant',fastModelId:'fast',standardModelId:'normal',defaultEnabled:true}}];
assert.deepEqual(d.resolveDefaultSelection(variants,{model:'normal',fast:true}),{model:'fast',reasoningEffort:'high',fast:true});
assert.deepEqual(d.resolveDefaultSelection(variants,{model:'fast',fast:false}),{model:'normal',reasoningEffort:'medium',fast:false});
assert.deepEqual(d.resolveDefaultSelection([{id:'first'},{id:'second',isDefault:true}],{},'first'),{model:'first'});
assert.equal(d.resolveAdvertisedModel([{id:'a',name:'same'},{id:'b',name:'same'}],'a'),'a');assert.throws(()=>d.resolveAdvertisedModel([{id:'a',name:'same'},{id:'b',name:'same'}],'same'));
process.stdout.write('verified: real historical default-selection feature, 14 behavior checks');})().catch(error=>{process.stderr.write(error.stack);process.exit(1)});`

function replace(source,from,to){assert.ok(source.includes(from),'Live replay fixture seam changed: '+from.slice(0,100));return source.replace(from,to)}

test('actual Hy4 Worker replays Kode default model selection from the pre-feature module snapshot',{
 skip:process.env.KODE_TEST_LIVE_FREE_WRAPPER!=='1'||!process.env.KODE_TEST_BACKEND_URL,timeout:400000,
},async t=>{
 for(const key of ['KODE_TEST_HOST_NODE','KODE_TEST_MANAGED_CODEX_WRAPPER','KODE_TEST_MANAGED_CODEX_EXECUTABLE','KODE_TEST_WRAPPER_HOME','KODE_TEST_WRAPPER_PROVIDER','KODE_TEST_NATIVE_MODEL','KODE_TEST_LIVE_EVIDENCE_DIR'])assert.ok(process.env[key],`Explicit ${key} required`)
 const here=dirname(fileURLToPath(import.meta.url)),repo=resolve(here,'../../../..'),sourceFile=join(here,'fixture-coordinator-pipeline.js')
 const base=(await exec('/usr/bin/git',['-C',repo,'rev-parse',featureCommit+'^'])).stdout.trim()
 const baseline=(await exec('/usr/bin/git',['-C',repo,'show',base+':'+modulePath])).stdout
 assert.equal(baseline.includes('export function resolveDefaultSelection'),false,'this must be an actual pre-feature source')
 let source=await readFile(sourceFile,'utf8')
 source=replace(source,"await git(['init','-q']);await writeFile(join(root,'README.md'),'Fixture project');await git(['add','.']);await git(['commit','-qm','fixture baseline'])",`
  const oldArchive=join(runtimeRoot,'old-module.tar');
  await promisify(execFile)('/usr/bin/git',['-C',${JSON.stringify(repo)},'archive','--format=tar','--output='+oldArchive,${JSON.stringify(base)},'kode/integrations/dsh']);
  await promisify(execFile)('/usr/bin/tar',['-xf',oldArchive,'-C',root]);
  await git(['init','-q']);await git(['add','.']);await git(['commit','-qm','pre-feature module snapshot']);
  const baselineCheck=await promisify(execFile)(process.execPath,['-e',${JSON.stringify(verification)}],{cwd:root}).then(()=>({passed:true}),()=>({passed:false}));
  assert.equal(baselineCheck.passed,false,'the real feature behavior must fail before implementation');
  t.diagnostic(JSON.stringify({live_replay_baseline:{feature_commit:${JSON.stringify(featureCommit)},source_commit:${JSON.stringify(base)},scope:'historical_dsh_module_snapshot_not_full_repository_build',baseline_acceptance_passed:false}}));`)
 const oldArgs="args:['-e',\"if(require('node:fs').readFileSync('implemented.txt','utf8')!=='implemented')process.exit(3);process.stdout.write('verified')\"]"
 source=replace(source,oldArgs,'args:'+JSON.stringify(['-e',verification]))
 source=replace(source,"['kode_write_source','kode_capture_output','kode_publish_output'],['read','workspace_write']","['kode_read_source','kode_write_source','kode_capture_output','kode_publish_output'],['read','workspace_write']")
 source=replace(source,"else if(output==='reviewed'&&step===1){assert.equal(result('worker-0').text,followupScenario&&followup?'implemented revised':'implemented');", "else if(output==='reviewed'&&step===1){assert.match(result('worker-0').text,/export function resolveDefaultSelection/);")
 source=source.replaceAll("path:'implemented.txt'",'path:'+JSON.stringify(modulePath))
 source=source.replaceAll('/Implement the requirement/','/默认模型/')
 source=replace(source,"liveWorker?'Implement the requirement. Create implemented.txt with the exact content implemented, without a trailing newline. Capture and publish the artifact evidence.':'Implement the requirement'",JSON.stringify(request))
 source=replace(source,"managedInference:{...(liveWorker?{reasoningEfforts:[liveEffort]}","managedInference:{...(liveWorker?{timeoutMs:90000,reasoningEfforts:[liveEffort]}")
 source=replace(source,"slowScenario?720000:30000","slowScenario?300000:30000")
 source=replace(source,"  if(liveCoordinatorScenario){\n   liveEvidence=", "  if(liveWorker)liveEvidence=createLiveEvidenceRecorder({directory:process.env.KODE_TEST_LIVE_EVIDENCE_DIR,team,profiles,ctx,call,diagnostic:value=>t.diagnostic(value)})\n  if(liveCoordinatorScenario){\n   liveEvidence=")
 source=replace(source,"if(serialized!==liveProgress){liveProgress=serialized;t.diagnostic", "if(serialized!==liveProgress){liveProgress=serialized;await liveEvidence?.capture('progress',{run});t.diagnostic")
 source=replace(source,"  const completed=await call(`work-runs/${runs[0].run.id}`)\n", "  const completed=await call(`work-runs/${runs[0].run.id}`)\n  await liveEvidence?.capture('home_completed',{run:completed})\n  await promisify(execFile)(process.execPath,['-e',"+JSON.stringify(verification)+"],{cwd:completed.task_workspaces.code.root})\n  assert.equal(await readFile(join(root,"+JSON.stringify(modulePath)+"),'utf8'),"+JSON.stringify(baseline)+",'original pre-feature source is preserved')\n")
 source=replace(source,"await hub.close()}}", "await hub.stop();t.diagnostic(JSON.stringify({live_replay_retained_hub:{root:hub.root,node:hub.node,scope:'private_disposable_test_only',business_teams_touched:false}}))}}")
 const script=join(here,'.kode-feature-live-'+randomUUID()+'.mjs')
 await writeFile(script,source,{mode:0o600,flag:'wx'})
 const env={...process.env,KODE_TEST_LIVE_WORKER:'1',KODE_TEST_LIVE_ALL_WORKERS:'0',KODE_TEST_NATIVE_EFFORT:'low',KODE_TEST_NATIVE_ANSWER:'0',KODE_TEST_COORDINATOR_ANSWER:'0',KODE_TEST_REMOTE_ANSWER:'0',KODE_TEST_COORDINATOR_BROWSER:'0',KODE_TEST_COORDINATOR_BOOTSTRAP:'0',KODE_TEST_COORDINATOR_BLOCKED:'0',KODE_TEST_COORDINATOR_TRANSFER:'0',KODE_TEST_COORDINATOR_OWNER_SETUP:'0',KODE_TEST_COORDINATOR_BUILDER_SETUP:'0',KODE_TEST_MANAGED_CODEX_BOOTSTRAP_ENGINE:process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE,KODE_TEST_MANAGED_CODEX_EXECUTABLE:process.env.KODE_TEST_MANAGED_CODEX_WRAPPER}
 delete env.NODE_TEST_CONTEXT
 try{
  const result=await exec(process.env.KODE_TEST_HOST_NODE,['--test','--test-reporter=spec',script],{env,timeout:380000,maxBuffer:2*1024*1024})
  await mkdir(process.env.KODE_TEST_LIVE_EVIDENCE_DIR,{recursive:true,mode:0o700})
  await writeFile(join(process.env.KODE_TEST_LIVE_EVIDENCE_DIR,'kode-feature-replay.log'),selectiveReplayLog(result.stdout),{mode:0o600})
  assert.match(result.stdout,/pass 1/);assert.match(result.stdout,/fail 0/)
  for(const line of result.stdout.split('\n'))if(/live_replay_|live_worker_decisions|live_evidence/.test(line))t.diagnostic(line)
 }catch(error){
  await mkdir(process.env.KODE_TEST_LIVE_EVIDENCE_DIR,{recursive:true,mode:0o700})
  await writeFile(join(process.env.KODE_TEST_LIVE_EVIDENCE_DIR,'kode-feature-replay.log'),selectiveReplayLog(error.stdout??''),{mode:0o600})
  t.diagnostic('Real replay failed; inspect selective checkpoints and process metadata.')
  throw replayProcessFailure(error)
 }finally{await rm(script,{force:true})}
})

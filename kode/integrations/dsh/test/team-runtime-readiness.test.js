import test from 'node:test'
import assert from 'node:assert/strict'
import { VerificationRunners } from '../src/verification-runners.js'
import { teamRuntimeReadiness,inspectTeamRuntimeReadiness } from '../src/team-runtime-readiness.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp,realpath,writeFile,readFile,readdir,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verificationReadiness } from '../src/verification-readiness.js'
test('activation diagnostics check registered command identity, environment and scope without execution',async()=>{
 const runners=new VerificationRunners('/tmp/kode-fixture-readiness')
 try{
  const reference=runners.register({runner_id:'runner',command_id:'check',revision:'1',tool_id:'kode_verify_output',executable:'/fixture/node',executable_hash:'a'.repeat(64),args:[],env:{},timeout_ms:1000,max_output_bytes:1024,scenario_ids:['smoke'],capabilities:['read'],network:false})
  const runtime={host:'home',verificationRunners:runners}
  const stage={id:'verify',produces:['verified'],execution:{repository_binding:'code',tools:['kode_verify_output'],capabilities:['read'],network:false}}
  const rule={kind:'verification',command_binding:'check',environment_binding:'local',required_scenarios:['smoke']}
  const project={commands:{check:{runner_id:'runner',id:'check',revision:'1',definition_hash:reference.definition_hash,environment_binding:'local',repository_binding:'code',scenario_ids:['smoke']}},environments:{local:{host_id:'home',adapter_id:'local_process_v1',configuration_hash:reference.environment_hash}}}
  const review={configuration:{bindings:[{id:'delivery',workflow:{pack:{stages:[stage],evidence_rules:{verified:rule}}},project:{config:{spec:project}}}]}}
  assert.equal(teamRuntimeReadiness(runtime,review).default_adapter_checks_complete,true)
  assert.equal(teamRuntimeReadiness(runtime,review).eligible_for_execution,false)
  const check=change=>{const p=structuredClone(project),s=structuredClone(stage);change(p,s);return verificationReadiness(runtime,p,s,rule)}
  assert.equal(check(p=>p.commands.check.revision='missing'),'verification_command_unregistered')
  assert.equal(check(p=>p.commands.check.definition_hash='wrong'),'verification_definition_mismatch')
  assert.equal(check(p=>p.environments.local.configuration_hash='wrong'),'verification_definition_mismatch')
  assert.equal(check(p=>p.commands.check.scenario_ids=[]),'verification_definition_mismatch')
  assert.equal(check((p,s)=>s.execution.tools=[]),'verification_scope_insufficient')
  assert.equal(check((p,s)=>s.execution.capabilities=[]),'verification_scope_insufficient')
  assert.equal(check(p=>p.environments.local.host_id='remote'),'remote_verification_not_checked')
  assert.equal(check(p=>p.environments.local.adapter_id='other'),'verification_adapter_unavailable')
  assert.equal(check(p=>p.commands.check.repository_binding='other'),'verification_binding_incomplete')
  stage.execution.tools.push('custom-tool')
  assert.ok(teamRuntimeReadiness(runtime,review).stages[0].issues.includes('default_stage_tool_unavailable'))
  assert.equal(teamRuntimeReadiness(null,review).status,'runtime_unavailable')
  assert.equal(runners.pending.size,0)
 }finally{await runners.close()}
})
test('artifact preflight checks only selected local repository baselines without creating or changing them',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'kode-readiness-')))
 const git=args=>promisify(execFile)('/usr/bin/git',['-C',root,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}})
 try{
  await writeFile(join(root,'file.txt'),'fixture')
  const workspace={host_id:'home',workspace_id:'workspace',root_ref:root},runtime={host:'home'}
  const project={repositories:{code:{repository_id:'repository',workspace}}}
  const stage={id:'implement',produces:['artifact'],execution:{repository_binding:'code',tools:['kode_capture_output'],capabilities:['read']}}
  const review={team:{spec:{workspace_refs:[workspace]}},configuration:{bindings:[{id:'local',workflow:{pack:{stages:[stage],evidence_rules:{artifact:{kind:'artifact'}}}},project:{config:{spec:project}}}]}}
  const inspect=()=>inspectTeamRuntimeReadiness(runtime,review)
  assert.ok((await inspect()).stages[0].issues.includes('artifact_repository_baseline_unavailable'))
  assert.deepEqual(await readdir(root),['file.txt'],'preflight does not initialize Git')
  await git(['init','-q'])
  assert.equal((await inspect()).default_adapter_checks_complete,false,'an unborn repository is still incomplete')
  await git(['add','file.txt']);await git(['commit','-qm','fixture baseline'])
  const index=await readFile(join(root,'.git/index')),head=(await git(['rev-parse','HEAD'])).stdout
  const ready=await inspect();assert.equal(ready.default_adapter_checks_complete,true);assert.equal(ready.stages[0].artifact_repository.status,'ready')
  assert.deepEqual(await readFile(join(root,'.git/index')),index);assert.equal((await git(['rev-parse','HEAD'])).stdout,head)
  assert.equal((await inspectTeamRuntimeReadiness(runtime,review,{workspaces:[]})).stages[0].artifact_repository.status,'artifact_repository_outside_selected_scope')
  project.repositories.code.workspace={...workspace,host_id:'remote',root_ref:'/not-opened'}
  const remote=await inspectTeamRuntimeReadiness(runtime,review,{workspaces:[project.repositories.code.workspace]})
  assert.equal(remote.stages[0].artifact_repository.status,'artifact_repository_remote_unchecked');assert.equal(remote.default_adapter_checks_complete,false)
 }finally{await rm(root,{recursive:true,force:true})}
})

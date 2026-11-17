import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdir,writeFile,mkdtemp,rm,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {promisify} from 'node:util'
import {execFile} from 'node:child_process'
import {LlmAdapter} from '@deepseek-ai/dsh-llm'
import {assignmentDependencies} from '../src/assignment-dependencies.js'
import {isolatedHub} from './support/isolated-hub.js'
import {createFeatureRuntimeFactory,replayToolPolicies,replayProfile,freezeReplayTaskMethod,closeReportedCoordinators} from './support/feature-runtime-factory.js'
const deadlines={decisionMs:300000,stageMs:1200000,runMs:2400000,grantValidityMs:3000000}

test('replay policy is an additional exact write/admission constraint, never a grant replacement',async()=>{
 let enabled=true,originalCalls=0
 const policies=replayToolPolicies(['src/allowed.js'],()=>{if(!enabled)throw Error('paused')})
 const agent={},definition={capabilities:['read','workspace_write'],network:false,workspaceLock:true,implementation:{},authorize:()=>{originalCalls++;return true}}
 policies.register('kode_write_source',definition,agent)
 policies.register('kode_patch_source',definition,agent)
 assert.equal(await policies.get('kode_patch_source',agent).authorize({arguments:{path:'src/other.js'}},{}),false)
 const policy=policies.get('kode_write_source',agent)
 assert.equal(policy.implementation,definition.implementation)
 assert.equal(await policy.authorize({arguments:{path:'src/other.js'}},{}),false);assert.equal(originalCalls,0)
 assert.equal(await policy.authorize({arguments:{path:'src/allowed.js'}},{}),true);assert.equal(originalCalls,1)
 enabled=false;await assert.rejects(policy.authorize({arguments:{path:'src/allowed.js'}},{}),/paused/);assert.equal(originalCalls,1)
})
test('Hy4 profile requires explicit bootstrap and preserves product-default deadline and all official roles',()=>{
 const env={KODE_TEST_MANAGED_CODEX_WRAPPER:'/fixture/tcodex',KODE_TEST_MANAGED_CODEX_EXECUTABLE:'/fixture/codex',KODE_TEST_WRAPPER_PROVIDER:'tencent',KODE_TEST_WRAPPER_HOME:'/fixture/config',KODE_TEST_NATIVE_MODEL:'hy4-ioa'}
 assert.throws(()=>replayProfile('hy4',deadlines,{}),/Explicit/)
 assert.throws(()=>replayProfile('hy4',{...deadlines,decisionMs:90000},env),/default/)
 const profile=replayProfile('hy4',deadlines,env)
 assert.equal(profile.managedInference.timeoutMs,300000)
 assert.deepEqual(profile.managedInference.roles,['coordinator','worker'])
 assert.equal(profile.managedInference.bootstrap.executable,'/fixture/codex')
 assert.equal(profile.executable,'/fixture/tcodex')
})
test('Host freezes optional derived method once within the original dependency artifact bound',async()=>{
 const root=await mkdtemp(join(tmpdir(),'replay-method-')),path=join(root,'method.md'),instructions='Derived task method; original skills are not installed or executed.\n'
 try{
  assert.equal(await freezeReplayTaskMethod(undefined),null)
  await writeFile(path,instructions)
  const hash=createHash('sha256').update(instructions).digest('hex'),frozen=await freezeReplayTaskMethod({path,sha256:hash})
  assert.equal(frozen.content_hash,hash);assert.equal(frozen.instructions,instructions);assert.match(frozen.source,/owner-derived/)
  await writeFile(path,'changed');assert.equal(frozen.instructions,instructions)
  await assert.rejects(freezeReplayTaskMethod({path,sha256:hash}),/changed/)
  await symlink(path,join(root,'link'));await assert.rejects(freezeReplayTaskMethod(join(root,'link')))
  await writeFile(path,'x'.repeat(16385));await assert.rejects(freezeReplayTaskMethod(path),/16KiB/)
  await writeFile(path,'bad\0text');await assert.rejects(freezeReplayTaskMethod(path),/text/)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('formal isolated test team is accepted/activated through owner Builder routes before any model or user intake',{
 skip:!process.env.KODE_TEST_BACKEND_URL,timeout:30000,
},async()=>{
 const hub=await isolatedHub('feature-runtime-setup'),root=join(hub.root,'project')
 let runtime,inference=0,admitted=false
 try{
  await mkdir(root);await writeFile(join(root,'README.md'),'Disposable replay source\n')
  const git=args=>promisify(execFile)('/usr/bin/git',['-C',root,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.com',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.com'}})
  await git(['init','-q']);await git(['add','.']);await git(['commit','-qm','fixture source'])
  class NoInference extends LlmAdapter{async*stream(){inference++;assert.equal(admitted,true,'No inference before UI intake');yield{type:'block-start',index:0,blockType:'text'};yield{type:'block-end',index:0,block:{type:'text',text:'已收到隔离验证请求。'}};yield{type:'usage',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}};yield{type:'finish',reason:{kind:'stop'}}}}
  const methodPath=join(hub.root,'owner-task-method.md'),method='This is an owner-derived test method, not execution of an installed skill. Read the source, implement narrowly, review independently and verify the frozen scenarios.'
  await writeFile(methodPath,method)
  const methodHash=createHash('sha256').update(method).digest('hex')
  const manifest={task_method:{path:methodPath,sha256:methodHash},task_id:'feature-setup',request:'帮我核对这个隔离项目的历史会话身份，补齐测试后再交付。',allowed_write_paths:['README.md'],verification:{executable:process.execPath,args:['-e','process.stdout.write("frozen check")'],env:{},timeout_ms:5000,max_output_bytes:65536,scenario_ids:['identity']}}
  runtime=await createFeatureRuntimeFactory({controlledAdapter:new NoInference()})({hub,manifest,snapshot:{root},mode:'controlled',deadlines,teamId:manifest.task_id,admit:()=>{assert.equal(admitted,true,'not admitted')}})
  const status=await runtime.status();assert.equal(status.state,'ready');assert.equal(status.formal_test_team,true);assert.equal(status.builder_model_started,false)
  assert.equal(inference,0);assert.equal(status.owned_handles,0)
  const call=p=>hub.client.call('/api/v1/messaging/'+p)
  assert.equal((await call('superagents/drafts/replay-draft')).status,'draft')
  const teams=await call('teams');assert.equal(teams.items.length,1);assert.equal(teams.items[0].id,manifest.task_id)
  const activation=await call('teams/'+manifest.task_id+'/activation');assert.equal(activation.active,true)
  assert.equal(status.task_method_sha256,methodHash)
  const binding=activation.snapshot.bindings[0]
  for(const stage of binding.workflow.pack.stages){assert.equal(stage.execution.dependencies.length,1);const dependency=binding.workflow_dependencies[stage.id][0];assert.equal(dependency.config.spec.artifact.instructions,method);assert.equal(dependency.config.spec.artifact.content_hash,methodHash);assert.deepEqual(dependency.config.spec.artifact.tools,[]);assert.equal(assignmentDependencies({stage,dependencies:binding.workflow_dependencies[stage.id],worker:{node_id:hub.node},grant_scope:stage.execution})[0].content_hash,methodHash)}
  assert.equal((await call('budgets/replay-budget')).budget.reserved,0)
  assert.equal((await call('conversations/'+teams.items[0].conversation_id+'/messages')).items.length,0)
  assert.match(runtime.ui.url,/^http:\/\/127\.0\.0\.1:/)
  if(process.env.KODE_TEST_FEATURE_UI==='1'){admitted=true;const send=runtime.ui.send(manifest.request);assert.equal(runtime.ui.send(manifest.request),send);await send;assert.equal((await call('conversations/'+teams.items[0].conversation_id+'/messages')).items.filter(row=>row.actor?.kind==='human').length,1)}
  await runtime.pauseAutomatic();assert.equal((await runtime.status()).paused,true);if(!process.env.KODE_TEST_FEATURE_UI)assert.equal(inference,0)
 }finally{await runtime?.close();await hub.close()}
})

test('completed replay uses official Coordinator close and exact prior intent before requiring zero reservations',async()=>{
 const prior={request_id:'prior-close',attempt:1,epoch:2,price_id:'price',settlement:'internal_price'},actions=[]
 let reserved=39
 const host={handles:new Map([['coordinator',{agent:{whenIdle:async()=>actions.push('idle')},run:{finish(){assert.fail('report-only finish must not replace accounting')}}}]]),coordinatorCloseRecovery:{close:async()=>actions.push('stop-recovery')},closeCoordinator:async input=>{assert.deepEqual(input,{operation_id:'op',command:prior});actions.push('official-close');reserved=0;return{state:'closed'}}}
 const profiles={binding:()=>({managedCoordinator:{},managedOperation:{id:'op',attempt:1,epoch:2}})}
 const call=async path=>path.endsWith('/coordinator-close')?{intent:{request:prior}}:{budget:{reserved}}
 const budget=await closeReportedCoordinators({host,profiles,call,budgetId:'budget',priceId:'price',requestId:'new-close'})
 assert.equal(budget.reserved,0);assert.deepEqual(actions,['stop-recovery','idle','official-close'])
 host.closeCoordinator=async()=>({state:'closing'})
 await assert.rejects(closeReportedCoordinators({host,profiles,call,budgetId:'budget',priceId:'price',requestId:'new-close'}),/accounting must finish/)
})

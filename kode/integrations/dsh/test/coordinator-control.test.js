import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { AgentProfiles } from '../src/agent-profiles.js'
import { prepareCoordinatorDispatch } from '../src/coordinator-preparation.js'
import { OfficialDispatch } from '../src/official-dispatch.js'
import { coordinatorInput } from '../src/coordinator-input.js'
import { isolatedHub } from './support/isolated-hub.js'
test('Coordinator control is exclusive, pinned to activation and cannot replace expired unreconciled execution',{skip:!process.env.KODE_TEST_BACKEND_URL,timeout:30000},async()=>{
 const hub=await isolatedHub('coordinator-control')
 try{
  const profiles=await new AgentProfiles(join(hub.root,'profiles.json')).open([{id:'profile',type:'dsh',name:'Coordinator'}])
  await profiles.bind('revision-probe','profile')
  const profileHash=profiles.binding('revision-probe').revision
  const root='/api/v1/messaging',call=(p,b)=>hub.client.call(`${root}/${p}`,b),at=Date.now()
  const workspace={host_id:hub.node,workspace_id:'workspace',root_ref:'/fixture'},target={host:hub.node,workspace:'workspace',root:'/fixture'}
  const version=r=>({id:r.id,version:r.version,hash:r.hash}),policy=r=>({id:r.id,revision:r.revision,hash:r.hash})
  const flow=await call('workflows',{id:'flow',version:'1',inputs:['request'],stages:[{id:'inspect',role:'coordinator',requires:['request'],produces:['artifact'],independent_from:[],execution:{task_tag:'inspection',repository_binding:'code',capabilities:['read'],tools:['kode_artifact_capture','kode_coordinator_publish_reply'],network:false}}],completion_stages:['inspect'],evidence_rules:{artifact:{kind:'artifact',repository_binding:'code'}}})
  const project=await call('project-configs',{id:'project',version:'1',spec:{kind:'project_bindings',repositories:{code:{repository_id:'repo',workspace}},environments:{},commands:{},connections:{}}})
  const delivery=await call('project-configs',{id:'delivery',version:'1',spec:{kind:'delivery_policy',project:version(project),workflow:version(flow),targets:[{kind:'local',repository_binding:'code'}],required_outputs:['artifact']}})
  await call('resource-accounts',{id:'account',expected_epoch:0,enabled:true})
  await call('assignment-capacities',{account_id:'account',expected_revision:0,max_active_assignments:2})
  await call('resource-bindings',{host:hub.node,profile:'profile',account_id:'account',account_epoch:1,expected_revision:0})
  await call('capability-profiles',{id:'capability',expected_revision:0,host:hub.node,profile:'profile',model:'model',assessments:{}})
  await call('budgets',{id:'budget',scope:'team',scope_id:'team',unit:'credits',limit:100,starts_at:at-1000,ends_at:at+60000,expected_revision:0})
  const budget=await call('team-policies',{id:'budget-policy',team_id:'team',expected_revision:0,policy:{kind:'budget',budget_ids:['budget'],unit:'credits',max_assignment_charge:10}})
  const resource={host:hub.node,profile:'profile',account_id:'account',account_epoch:1,binding_revision:1,limit_ids:['daily'],unknown_quota:'team_budget'}
  const schedule=await call('team-policies',{id:'schedule',team_id:'team',expected_revision:0,policy:{kind:'scheduling',targets:{control:{resource,capability_id:'capability',capability_revision:1,preferred:false}},weights:{quality:1,cost:0,latency:0},minimum_quality:0,minimum_confidence:0}})
  const spec={name:'Team',purpose:'Work',kind:'coordinator',workspace_refs:[workspace],execution_targets:[{id:'control',host_id:hub.node,executor_profile_id:'profile',executor_profile_revision:profileHash,provider_id:'fixture',model_id:'model',effort:null,account_binding_id:'account',capability_profile_revision:'1'}],workers:[],coordinator_targets:['control'],workflow_pack_refs:[version(flow)],delivery_bindings:[{id:'local',workflow:version(flow),project:version(project),delivery_policy:version(delivery)}],grant_id:'grant',budget_policy_id:'budget-policy',scheduling_policy_id:'schedule',limits:{max_active_assignments:2,max_active_runs:2},proactive_mode:'off'}
  const team=await call('teams',{id:'team',request_id:'create',expected_revision:0,spec})
  const grant=(await call('team-grants',{expected_revision:0,policy:{id:'grant',team_id:'team',enabled:true,expires_at:at+60000,targets:[target],capabilities:['read','delegate'],tools:['kode_artifact_capture','kode_coordinator_publish_reply','kode_coordinator_workflow_start','kode_coordinator_configuration','kode_coordinator_workflow_status'],network:false,budget_ids:['budget']}})).grant
  await call('teams/team/activation',{action:'activate',request_id:'activate',expected_revision:0,team_revision:1,grant_revision:grant.revision,budget_policy:policy(budget),scheduling_policy:policy(schedule)})
  await call('price-versions',{id:'price',model:'model',model_policy:'requested_model',unit:'credits',input_per_million:1,cached_per_million:1,output_per_million:1})
  const selection={profile_revision:profileHash,model:'model',effort:null,scope:'executor_configuration'}
  const prepare=async id=>{
   const registered=await call('sessions',{session_id:id,title:'Coordinator',runtime:'external'})
   const bundle=await call('operation-bundles',{owner_session:'owner',request_key:id,worker:{node_id:hub.node,session_id:id},selection_policy:selection,funding:{budget_ids:['budget'],amount:10,unit:'credits'},resource,grant_id:'grant',grant_scope:{team_id:'team',revision:1,target,capabilities:['read','delegate'],tools:['kode_artifact_capture','kode_coordinator_publish_reply','kode_coordinator_workflow_start','kode_coordinator_configuration','kode_coordinator_workflow_status'],network:false,budget_ids:['budget']}})
   await call(`budget-reservations/${bundle.reservation.request.id}/pricing`,{price_id:'price'})
   return {...bundle,client:hub.client.forSession(registered.owner_token)}
  }
  const first=await prepare('first'),second=await prepare('second'),path='teams/team/coordinator-control'
  const command=(bundle,expected_revision=0)=>({request_id:bundle.operation.id,expected_revision,team_revision:1,activation_revision:1,operation_id:bundle.operation.id,operation_revision:bundle.operation.revision,attempt:1,epoch:1,target_id:'control'})
  assert.deepEqual(await call(path),{control:null})
  await assert.rejects(first.client.call(`${root}/${path}`,command(first)),/403/)
  await assert.rejects(first.client.call(`${root}/${path}`),/403/)
  await assert.rejects(call(path,{...command(first),activation_revision:2}),/activation changed/)
  await assert.rejects(call(path,{...command(first),target_id:'worker'}),/configured Coordinator/)
  const race=await Promise.allSettled([call(path,command(first)),call(path,command(second))])
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1)
  const winner=race[0].status==='fulfilled'?first:second,loser=winner===first?second:first,control=race.find(r=>r.status==='fulfilled').value
  assert.equal(control.conversation_id,team.conversation_id);assert.equal(control.superagent_id,team.superagent_id)
  assert.deepEqual(await call(path,command(winner)),control)
  await assert.rejects(call(`operations/${winner.operation.id}/builder-scope`,{expected_revision:winner.operation.revision,attempt:1,epoch:1,draft_id:'missing',draft_revision:1}),/cannot become Builder/)
  await assert.rejects(call(path,command(loser,1)),/prior Coordinator/)
  const runtime={host:hub.node,client:hub.client,profiles,ctx:{get:name=>name==='workspaceRegistry'?{list:()=>[{id:'workspace',path:'/fixture'}]}:undefined,llm:{resolveCallConfig:async c=>c}}}
  const preparation={command_id:'create-coordinator',team_id:'team',control_revision:1,operation_revision:winner.operation.revision,profile_id:'profile',provider:'fixture'}
  await assert.rejects(prepareCoordinatorDispatch(runtime,{...preparation,provider:'different'}),/activated executor/)
  await assert.rejects(prepareCoordinatorDispatch(runtime,{...preparation,control_revision:2}),/control unavailable/)
  await assert.rejects(prepareCoordinatorDispatch({...runtime,ctx:{...runtime.ctx,llm:{resolveCallConfig:async c=>({...c,model:'fallback'})}}},preparation),/resolved configuration differs/)
  assert.equal(profiles.binding(winner.operation.worker.session_id),undefined)
  const prepared=await prepareCoordinatorDispatch(runtime,preparation)
  assert.deepEqual(prepared.coordinator,{team_id:'team',conversation_id:team.conversation_id,control_revision:1})
  assert.deepEqual(await prepareCoordinatorDispatch(runtime,preparation),prepared)
  let creations=0
  const officialDispatch=new OfficialDispatch({execution:{profiles},stop:new AbortController(),create:async()=>{creations++;throw Error('fixture creation interrupted')}})
  const {coordinator,...ordinary}=prepared
  await assert.rejects(officialDispatch.dispatch(ordinary),/binding mismatch/)
  await assert.rejects(officialDispatch.dispatch({...prepared,coordinator:{...coordinator,control_revision:2}}),/binding mismatch/)
  assert.throws(()=>officialDispatch.dispatch({...prepared,tools:['ungranted_tool']}),/Coordinator dispatch/)
  assert.equal(creations,0)
  await assert.rejects(officialDispatch.dispatch(prepared),/fixture creation interrupted/)
  assert.equal((await officialDispatch.dispatch(prepared)).state,'uncertain')
  assert.equal(creations,1,'ambiguous creation never repeats')
  await profiles.patchBinding(winner.operation.worker.session_id,{managedBuilder:{draft_id:'draft'}})
  await assert.rejects(prepareCoordinatorDispatch(runtime,preparation),/binding conflict/)
  await profiles.update(state=>{delete state.bindings[winner.operation.worker.session_id].managedBuilder})
  let op=(await winner.client.call(`${root}/operations/${winner.operation.id}`,{attempt:1,epoch:1,expected_revision:winner.operation.revision,selection_ack:selection,action:{kind:'claim_resource',lease_ms:3000,resource:{profile:'profile',account_epoch:1,binding_revision:1}}})).operation
  const human=await call(`conversations/${team.conversation_id}/messages`,{request_id:'request',content:'Please implement this requirement'})
  const inputPath=`conversations/${team.conversation_id}/messages/${human.id}/coordinator-input`
  const dispatch={operation_id:op.id,control_revision:1,attempt:1,epoch:1}
  const pendingPath=`conversations/${team.conversation_id}/pending-inputs`
  assert.deepEqual((await call(pendingPath)).items,[{message_id:human.id,sequence:human.sequence}])
  await assert.rejects(winner.client.call(`${root}/${pendingPath}`),/403/)
  await assert.rejects(call(`${pendingPath}?limit=33`),/invalid pending/)
  await assert.rejects(winner.client.call(`${root}/${inputPath}`,dispatch),/403/)
  await assert.rejects(call(inputPath,{...dispatch,control_revision:2}),/control or activation mismatch/)
  const [queued,retry]=await Promise.all([call(inputPath,dispatch),call(inputPath,dispatch)])
  assert.deepEqual(retry,queued);assert.deepEqual(queued.message,human)
  assert.equal(queued.receipt.state,'queued')
  assert.deepEqual((await call(pendingPath)).items,[])
  await assert.rejects(call(`conversations/${team.conversation_id}/work-runs`,{...dispatch,request_id:'premature-run',source_message_id:human.id,binding_id:'local',inputs:{request:'Implement'}}),/consumption not confirmed/)
  await assert.rejects(call(`conversations/${team.conversation_id}/coordinator-replies`,{...dispatch,request_id:'premature',source_message_id:human.id,content:'Not consumed yet'}),/consumption not confirmed/)
  const inbox=await call(`messages/${queued.receipt.message_id}`)
  const binding={managedOperation:{id:op.id,attempt:1,epoch:1},managedCoordinator:{team_id:'team',conversation_id:team.conversation_id,control_revision:1}}
  const resolved=await coordinatorInput(hub.client,binding,inbox,'input',undefined)
  assert.equal(resolved.content[0].text,human.content)
  assert.equal(resolved.role,'user')
  await assert.rejects(coordinatorInput(hub.client,binding,{...inbox,id:'spoofed'},'input',undefined),/receipt mismatch/)
  await assert.rejects(coordinatorInput(hub.client,binding,{...inbox,source:{...inbox.source,session_id:'peer'}},'input',undefined),/identity mismatch/)
  const recoveryPath='teams/team/coordinator-recovery'
  await assert.rejects(winner.client.call(`${root}/${recoveryPath}`),/403/)
  assert.equal((await call(recoveryPath)).recovery.stop_confirmed,false)
  await new Promise(resolve=>setTimeout(resolve,3100))
  await assert.rejects(call(path,command(loser,1)),/prior Coordinator/,'expiry is not confirmed stop')
  assert.equal((await call(recoveryPath)).recovery.stop_confirmed,false,'lease expiry never proves drainage')
  op=await call(`operations/${op.id}`)
  op=(await call(`operations/${op.id}`,{attempt:op.attempt,epoch:op.epoch,expected_revision:op.revision,action:{kind:'cancel'}})).operation
  op=(await call(`operations/${op.id}`,{attempt:op.attempt,epoch:op.epoch,expected_revision:op.revision,action:{kind:'attest_stopped',reason:'fixture runtime stopped'}})).operation
  await assert.rejects(call(path,command(loser,1)),/prior Coordinator/,'stop without accounting finalization still blocks replacement')
  assert.deepEqual((await call(recoveryPath)).recovery.blockers,['budget_not_finalized'])
  await call(`budget-reservations/${winner.reservation.request.id}/settle`,{event_id:'finish',expected_revision:1,total_charge:0,finalized:true,basis:'reported'})
  const evidence=await call('tool-evidence',{call_id:'uncertain-tool',tool:'kode_artifact_capture',operation_id:op.id,worker_session:op.worker.session_id,attempt:1,epoch:1,status:'uncertain',started_at:1,ended_at:2})
  await assert.rejects(call(path,command(loser,1)),/tool outcome remains unresolved/)
  const unresolved=(await call(recoveryPath)).recovery
  assert.equal(unresolved.unresolved_tools,1);assert.deepEqual(unresolved.tool_evidence_sequences,[evidence.sequence]);assert.equal(unresolved.resume_authorized,false)
  await call('tool-resolutions',{operation_id:winner.operation.id,evidence_sequence:evidence.sequence,request_id:'resolve',decision:'verified_not_applied',evidence_ref:'fixture:verified'})
  const ready=(await call(recoveryPath)).recovery
  assert.equal(ready.replacement_prerequisites_satisfied,true);assert.equal(ready.resume_authorized,false)
  const replaced=await call(path,command(loser,1));assert.equal(replaced.revision,2);assert.equal(replaced.predecessor.operation_id,winner.operation.id);assert.equal(replaced.predecessor.control_revision,1);assert.deepEqual(replaced.predecessor.worker,winner.operation.worker)
  assert.deepEqual(await call(path,command(winner)),control,'old receipt never reclaims control')
  await hub.stop('SIGKILL');await hub.start()
  assert.deepEqual(await call(path),{control:replaced})
  assert.deepEqual((await call(inputPath)).input,queued)
  assert.deepEqual(await call(inputPath,dispatch),queued,'old input never requeues after control replacement')
  await assert.rejects(call(inputPath,{...dispatch,operation_id:loser.operation.id,control_revision:2}),/already bound/)
  await call('teams/team/activation',{action:'deactivate',request_id:'off',expected_revision:1})
  await assert.rejects(loser.client.call(`${root}/operations/${loser.operation.id}`,{attempt:1,epoch:1,expected_revision:loser.operation.revision,selection_ack:selection,action:{kind:'claim_resource',lease_ms:3000,resource:{profile:'profile',account_epoch:1,binding_revision:1}}}),/Coordinator team authority unavailable/)
  assert.equal((await call(`operations/${loser.operation.id}`)).state,'prepared')
  await assert.rejects(prepareCoordinatorDispatch({...runtime,client:hub.client},{...preparation,control_revision:2,operation_revision:loser.operation.revision}),/activated executor/)
  assert.equal(profiles.binding(loser.operation.worker.session_id),undefined)
 }finally{await hub.close()}
})

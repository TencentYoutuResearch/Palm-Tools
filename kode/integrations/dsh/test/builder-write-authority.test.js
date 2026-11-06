import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
test('Builder writes require exact bound operation and preserve owner facts with durable actor attribution', {skip:!process.env.KODE_TEST_BACKEND_URL,timeout:30000},async()=>{
 const hub=await isolatedHub('builder-authority')
 try{
  const root='/api/v1/messaging',call=(p,b)=>hub.client.call(`${root}/${p}`,b)
  const registration=await call('sessions',{session_id:'builder',title:'Builder',runtime:'external'}),worker=hub.client.forSession(registration.owner_token)
  const interview={purpose:'Configure a team',workspace_refs:[{host_id:hub.node,workspace_id:'fixture',root_ref:'/fixture'}],answers:{delivery:'local'},questions:[],proposed_team:null}
  await call('superagents/drafts',{id:'draft',request_id:'create',expected_revision:0,revoked:false,interview})
  await call('superagents/drafts',{id:'foreign',request_id:'create',expected_revision:0,revoked:false,interview})
  let op=await call('operations',{owner_session:'owner',request_key:'builder',worker:{node_id:hub.node,session_id:'builder'},budget_required:true,grant_required:true})
  const at=Date.now()
  await call('budgets',{id:'creation',scope:'team',scope_id:'builder',unit:'credits',limit:100,starts_at:at-1000,ends_at:at+60000,expected_revision:0})
  await call('budget-reservations',{id:'hold',budget_ids:['creation'],amount:80,unit:'credits',operation_id:op.id})
  op=await call(`operations/${op.id}/budget`,{attempt:1,expected_revision:op.revision,reservation_id:'hold'})
  const scope={team_id:'builder',revision:1,target:{host:hub.node,workspace:'fixture',root:'/fixture'},capabilities:['read','builder_draft_write'],tools:['kode_builder_save_draft','kode_builder_inspect_workspace'],network:false,budget_ids:['creation']}
  const grant={id:'grant',team_id:'builder',enabled:true,expires_at:at+60000,targets:[scope.target],capabilities:scope.capabilities,tools:scope.tools,network:false,budget_ids:scope.budget_ids}
  await call('team-grants',{expected_revision:0,policy:grant})
  op=await call(`operations/${op.id}/grant`,{expected_revision:op.revision,binding:{grant_id:'grant',attempt:1,epoch:1,scope}})
  const bind={expected_revision:op.revision,attempt:1,epoch:1,draft_id:'draft',draft_revision:1}
  assert.deepEqual(await call(`operations/${op.id}/builder-scope`),{scope:null})
  await assert.rejects(worker.call(`${root}/operations/${op.id}/builder-scope`),/403/)
  await assert.rejects(worker.call(`${root}/operations/${op.id}/builder-scope`,bind),/403/)
  const bound=await call(`operations/${op.id}/builder-scope`,bind)
  assert.deepEqual(await call(`operations/${op.id}/builder-scope`),{scope:bound})
  assert.deepEqual(await call(`operations/${op.id}/builder-scope`,bind),bound)
  await assert.rejects(call(`operations/${op.id}/builder-scope`,{...bind,draft_id:'foreign'}),/immutable/)
  const command={id:'draft',request_id:'ask',expected_revision:1,revoked:false,builder_operation:{id:op.id,attempt:1,epoch:1},interview:{...interview,questions:[{id:'budget',prompt:'What is the team budget?'}]}}
  await assert.rejects(call('superagents/drafts',command),/not active/)
  op=(await worker.call(`${root}/operations/${op.id}`,{attempt:1,epoch:1,expected_revision:op.revision,action:{kind:'claim',lease_ms:60000}})).operation
  await assert.rejects(worker.call(`${root}/superagents/drafts`,command),/403/)
  await assert.rejects(call('superagents/drafts',{...command,id:'foreign'}),/scope changed/)
  const saved=await call('superagents/drafts',command)
  assert.equal(saved.actor.kind,'builder');assert.equal(saved.actor.session_id,'builder');assert.equal(saved.actor.operation_id,op.id)
  for(const field of ['purpose','answers','workspace_refs','inspections','questionnaire']){
   const invalid=structuredClone(command);invalid.expected_revision=2;invalid.request_id=`bad-${field}`
   const values={purpose:'replace purpose',answers:{delivery:'deploy'},workspace_refs:[{host_id:hub.node,workspace_id:'foreign',root_ref:'/foreign'}],inspections:[{workspace:interview.workspace_refs[0],facts:[{path:'README.md',status:'missing'}]}],questionnaire:{id:'replacement',version:'1',questions:[{id:'other',prompt:'Other?'}]}}
   invalid.interview[field]=values[field]
   await assert.rejects(call('superagents/drafts',invalid),/cannot change/)
  }
  await assert.rejects(call('superagents/drafts',{...command,request_id:'revoke',expected_revision:2,revoked:true}),/cannot revoke/)
  const continuation=`operations/${op.id}/builder-continue`
  const confirm={draft_id:'draft',attempt:1,epoch:1,answer:{request_id:'confirm-budget',expected_revision:2,answers:{budget:'50 credits'}}}
  await assert.rejects(worker.call(`${root}/${continuation}`,confirm),/403/)
  await assert.rejects(call(continuation,{...confirm,epoch:2}),/active authorized/)
  assert.deepEqual(await call('superagents/drafts/draft'),saved,'failed enqueue rolls back answer and receipt')
  const [confirmed,duplicate]=await Promise.all([call(continuation,confirm),call(continuation,confirm)])
  assert.deepEqual(duplicate,confirmed,'concurrent retries enqueue one continuation')
  assert.equal(confirmed.draft.revision,3)
  assert.equal(confirmed.draft.interview.answers.budget,'50 credits')
  assert.equal(confirmed.input.receipt.actor.kind,'human')
  assert.equal(confirmed.input.request.draft_id,'draft')
  await assert.rejects(call(continuation,{...confirm,answer:{...confirm.answer,answers:{budget:'500 credits'}}}),/identity conflict/)
  const observation={id:'draft',request_id:'observed',expected_revision:3,revoked:false,host_inspection:{operation:{id:op.id,attempt:1,epoch:1},workspace_id:'fixture',paths:['README.md']},interview:{...confirmed.draft.interview,inspections:[{workspace:interview.workspace_refs[0],facts:[{path:'README.md',status:'missing'}]}]}}
  await assert.rejects(worker.call(`${root}/superagents/drafts`,observation),/403/)
  await assert.rejects(call('superagents/drafts',{...observation,builder_operation:{id:op.id,attempt:1,epoch:1}}),/conflicting/)
  for(const change of [
    {interview:{...observation.interview,answers:{delivery:'changed'}}},
    {host_inspection:{...observation.host_inspection,paths:['package.json']}},
    {host_inspection:{...observation.host_inspection,workspace_id:'foreign'}},
    {host_inspection:{...observation.host_inspection,paths:['../private']}}
  ])await assert.rejects(call('superagents/drafts',{...observation,...change}),/cannot change|unselected|missing|invalid/)
  assert.deepEqual(await call('superagents/drafts/draft'),confirmed.draft)
  const observed=await call('superagents/drafts',observation)
  assert.equal(observed.actor.kind,'host_inspection');assert.deepEqual(observed.actor.selection,observation.host_inspection)
  assert.deepEqual(await call('superagents/drafts',observation),observed)
  await call('team-grants',{expected_revision:1,policy:{...grant,enabled:false}})
  await assert.rejects(call(continuation,{...confirm,answer:{request_id:'denied-confirm',expected_revision:4,answers:{delivery:'deploy'}}}),/grant denied/)
  assert.deepEqual(await call('superagents/drafts/draft'),observed,'denied continuation cannot save changed answers')
  await assert.rejects(call('superagents/drafts',{...command,request_id:'after-revoke',expected_revision:4}),/grant denied/)
  assert.deepEqual(await call('superagents/drafts',command),saved,'committed replay stays readable without a new write')
  await hub.stop('SIGKILL');await hub.start()
  assert.deepEqual(await call(`operations/${op.id}/builder-scope`),{scope:bound})
  assert.deepEqual(await call('superagents/drafts',command),saved)
  assert.deepEqual(await call('superagents/drafts/draft'),observed)
  assert.deepEqual(await call(continuation,confirm),confirmed,'restart and revoked grant preserve historical confirmation')
  assert.deepEqual(await call(`operations/${op.id}/builder-scope`,bind),bound)
  assert.deepEqual((await call('teams')).items,[])
  assert.equal((await call('budgets/creation')).budget.spent,0,'write authority is not a new accounting path')
 }finally{await hub.close()}
})

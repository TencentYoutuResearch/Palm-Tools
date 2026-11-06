import test from 'node:test'
import assert from 'node:assert/strict'
import { readBuilderCurrentResource } from '../src/builder-current-resource.js'
for(const type of ['dsh','codex'])test(`current ${type} Builder resource projection denies foreign execution and excludes private configuration`,async()=>{
 const binding={profile:{id:'official',type,name:'Official',env:{PRIVATE_FIXTURE:'never-project'},args:['private-argument'],
  ...(type==='codex'?{managedInference:{endpoint:'https://example.com/responses',roles:['builder']}}:{})},managedBuilder:{draft_id:'draft'},managedOperation:{id:'op',attempt:1,epoch:1}}
 const agent={id:'builder',options:{provider:type==='codex'?'kode-workflow-official':'fixture',model:'model'}}
 const draft={home_hub:'home',status:'draft',interview:{workspace_refs:[{host_id:'home'}]}}
 let op={id:'op',attempt:1,epoch:1,worker:{node_id:'home',session_id:'builder'},selection_policy:{model:'model',effort:null}}
 let account={host:'home',profile:'official',account_id:'account',account_epoch:1,revision:2,binding_current:true,private_fixture:'never-project'}
 const paths=[]
 const runtime={host:'home',profiles:{binding:()=>binding},client:{call:async path=>{paths.push(path);return structuredClone(path.includes('/operations/')?op:account)}}}
 const result=await readBuilderCurrentResource(runtime,agent,draft)
 assert.equal(result.account.id,'account');assert.equal(result.account.current,true)
 assert.equal(result.eligible_for_execution,false);assert.equal(result.role_fit_status,'not_assessed');assert.equal(result.quota_status,'not_checked')
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_FIXTURE|never-project|private-argument/)
 assert.deepEqual(paths,['/api/v1/messaging/operations/op','/api/v1/messaging/resource-binding?host=home&profile=official'])
 for(const change of [{worker:{node_id:'foreign',session_id:'builder'}},{epoch:2},{selection_policy:{model:'different'}}]){
  const prior=op;op={...op,...change};await assert.rejects(readBuilderCurrentResource(runtime,agent,draft),/identity changed/);op=prior
 }
 account={...account,host:'foreign'};await assert.rejects(readBuilderCurrentResource(runtime,agent,draft),/account identity mismatch/)
 await assert.rejects(readBuilderCurrentResource(runtime,agent,{...draft,status:'revoked'}),/unavailable/)
 await assert.rejects(readBuilderCurrentResource(runtime,agent,{...draft,home_hub:'foreign'}),/unavailable/)
 binding.operationClosed=true;await assert.rejects(readBuilderCurrentResource(runtime,agent,draft),/unavailable/)
})

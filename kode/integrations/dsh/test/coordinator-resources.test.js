import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
import { parseProviderBalance } from '../src/provider-balances.js'
import { readCoordinatorResources } from '../src/coordinator-resources.js'
test('Coordinator coverage pages every activated target and separates real Hub budgets from provider facts', {skip:!process.env.KODE_TEST_BACKEND_URL,timeout:30000},async()=>{
 const hub=await isolatedHub('coordinator-resources')
 try{
  const call=(p,b)=>hub.client.call(`/api/v1/messaging/${p}`,b),at=Date.now()
  await call('resource-accounts',{id:'account',expected_epoch:0,enabled:true})
  await call('budgets',{id:'budget',scope:'team',scope_id:'team',unit:'credits',limit:100,expected_revision:0,starts_at:at-1000,ends_at:at+60000})
  const targets={},execution_targets=[]
  for(let i=0;i<9;i++){
   const id=`target-${i}`,host=i===8?'remote':hub.node
   await call('resource-bindings',{host,profile:id,account_id:'account',account_epoch:1,expected_revision:0})
   execution_targets.push({id,host_id:host,executor_profile_id:id,account_binding_id:'account',model_id:'model'})
   targets[id]={resource:{host,profile:id,account_id:'account',account_epoch:1,binding_revision:1,unknown_quota:'team_budget'}}
  }
  const activation={snapshot:{team:{spec:{execution_targets}},policies:{budget:{policy:{kind:'budget',budget_ids:['budget'],unit:'credits',max_assignment_charge:40}},scheduling:{policy:{kind:'scheduling',targets}}}}}
  const before=await call('budgets/budget'),first=await readCoordinatorResources(call,activation,'team')
  assert.equal(first.targets.length,8);assert.equal(first.configured_target_count,9);assert.equal(first.next_cursor,'target-7')
  assert.ok(first.targets.every(t=>t.provider_windows.status==='unavailable'&&t.provider_monetary.status==='not_connected'))
  assert.deepEqual(first.team_budgets[0].snapshot,before);assert.equal(first.team_budgets[0].label,'团队预算')
  const last=await readCoordinatorResources(call,activation,'team',first.next_cursor)
  assert.equal(last.targets[0].host,'remote');assert.equal(last.next_cursor,null)
  await assert.rejects(readCoordinatorResources(call,activation,'team','foreign'),/cursor/)
  const sample=parseProviderBalance('deepseek_balance',{is_available:true,balance_infos:[{currency:'CNY',total_balance:'12.5',granted_balance:'0',topped_up_balance:'12.5'}]},at)
  await call('monetary-quota',{host:hub.node,profile:'target-0',account_id:'account',account_epoch:1,binding_revision:1,source:'deepseek_balance',status:'reported',observed_at_ms:at,sample})
  const observed=await readCoordinatorResources(call,activation,'team')
  assert.deepEqual(observed.targets[0].provider_monetary.sources[0].last_reported.sample,sample)
  assert.equal(observed.targets[0].provider_windows.status,'unavailable','money does not fabricate window quota')
  assert.deepEqual(await call('budgets/budget'),before,'reads never reserve or charge')
  const unavailable=await readCoordinatorResources(async p=>{if(p.startsWith('monetary-quota?'))throw Error('private detail');return call(p)},activation,'team')
  assert.ok(unavailable.targets.every(t=>t.provider_monetary.status==='authority_unavailable'))
  assert.doesNotMatch(JSON.stringify(unavailable),/private detail/)
  const bindings=new Map()
  // Each target must change on its own second read, irrespective of concurrent HTTP ordering.
  const raced=await readCoordinatorResources(async p=>{const value=await call(p);if(p.startsWith('resource-binding?')){const reads=(bindings.get(p)??0)+1;bindings.set(p,reads);if(reads===2)return {...value,revision:2}}return value},activation,'team')
  assert.equal(bindings.size,8);assert.ok([...bindings.values()].every(reads=>reads===2))
  assert.ok(raced.targets.every(t=>t.status==='binding_unavailable'&&t.provider_monetary.sources.length===0))
  await call('resource-accounts',{id:'account',expected_epoch:1,enabled:false})
  const disabled=await readCoordinatorResources(call,activation,'team')
  assert.ok(disabled.targets.every(t=>t.status==='binding_unavailable'))
  assert.equal(disabled.eligible_for_execution,false)
 }finally{await hub.close()}
})

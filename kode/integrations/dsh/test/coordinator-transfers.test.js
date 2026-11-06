import test from 'node:test'
import assert from 'node:assert/strict'
import { CoordinatorTransfers } from '../src/coordinator-transfers.js'
function fixture(){
 const binding={managedCoordinator:{team_id:'team',conversation_id:'conversation',control_revision:2},managedOperation:{id:'op',attempt:1,epoch:1}}
 const host={stop:new AbortController(),handles:new Map([['session',{run:{signal:new AbortController().signal}}]]),execution:{host:'home',profiles:{binding:()=>structuredClone(binding)}}}
 return {host,binding}
}
test('automatic custody discovery coalesces, skips blocked rows, and recovers lost writes by durable discovery',async()=>{
 const {host}=fixture();let transferred=false,writes=0
 host.execution.client={call:async(path,body)=>{
  if(!body)return {home_hub:'home',team_id:'team',control_revision:2,items:transferred?[]:[{run_id:'blocked',revision:1},{run_id:'ready',revision:2}],next_cursor:null}
  if(path.includes('/blocked/'))throw Error('revision changed')
  writes++;transferred=true;throw Error('committed response lost')
 }}
 const first=new CoordinatorTransfers(host,{intervalMs:100})
 const [one,two]=await Promise.all([first.scan(),first.scan()]);assert.deepEqual(one,two);assert.equal(one.length,2);assert.equal(writes,1)
 await first.close()
 const reopened=new CoordinatorTransfers(host,{intervalMs:100});assert.deepEqual(await reopened.scan(),[]);assert.equal(writes,1);await reopened.close()
})
test('changed control or runtime ownership cannot authorize a transfer',async()=>{
 for(const race of ['page','owner']){
  const {host,binding}=fixture();let writes=0
  host.execution.client={call:async(_path,body)=>{if(body){writes++;throw Error('unexpected mutation')}
   if(race==='owner')binding.operationClosed=true
   return {home_hub:'home',team_id:'team',control_revision:race==='page'?3:2,items:[{run_id:'run',revision:1}],next_cursor:null}
  }}
  const pump=new CoordinatorTransfers(host)
  assert.equal((await pump.scan())[0].state,'pending');assert.equal(writes,0);await pump.close()
 }
})

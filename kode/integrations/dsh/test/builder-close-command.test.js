import test from 'node:test'
import assert from 'node:assert/strict'
import { builderCloseKey,confirmBuilderClose,readBuilderClose } from '../packages/collab/builder-close-command.js'
function fixture(){
 const draft={id:'draft',home_hub:'home',revision:8},profile='a'.repeat(64),tools=['kode_builder_read_draft']
 const startup={state:'created',home_hub:'home',command:{command_id:'create',provider:'fixture',team_id:'team',start:{draft_id:'draft',price_id:'price',operation:{worker:{node_id:'home',session_id:'builder'},selection_policy:{model:'model',profile_revision:profile},grant_scope:{target:{root:'/repo'},tools},funding:{amount:60,unit:'credits'}}}},receipt:{state:'created',request:{command_id:'create',session_id:'builder',provider:'fixture',model:'model',effort:null,profile_revision:profile,cwd:'/repo',builder:{draft_id:'draft',team_id:'team'},operation:{id:'op',attempt:1,epoch:1},tools}}}
 const values=new Map();let saveFail=false
 const storage={read:async key=>structuredClone(values.get(key)??null),reserve:async(key,row)=>{if(!values.has(key))values.set(key,structuredClone(row));return structuredClone(values.get(key))},save:async(key,row)=>{if(saveFail){saveFail=false;throw Error('fixture local acknowledgement lost')}values.set(key,structuredClone(row))}}
 const closed=input=>({home_hub:'home',state:'closed',execution_resumed:false,intent:{operation_id:'op',draft_id:'draft',state:'closing',request:structuredClone(input.command)},accounting:{operation_id:'op',attempt:1,draft_id:'draft',price_id:'price',label:'团队预算',basis:'configured_internal_price',provider_cost_status:'unconfirmed',completion_authorized:false,reservation:{request:{amount:60,unit:'credits'},charged:1,held:0,finalized:true}}})
 const waiting=input=>({home_hub:'home',state:'waiting_accounting',reason:'needs_reconciliation',retryable:false,execution_resumed:false,intent:closed(input).intent,
  accounting:{state:'waiting_accounting',reason:'needs_reconciliation',retryable:false,recovery:'blocked_until_trusted_usage_is_reconciled',
   unresolved_calls:[{call_id:'missing-call',state:'finished',accounting_status:'usage_unresolved'}],
   budget:{reservation_id:'reservation',unit:'credits',charged:2,held:58,finalized:false,frozen:true}}})
 return {draft,startup,storage,values,closed,waiting,failSave:()=>{saveFail=true}}
}
for(const failure of ['reply','save'])test(`Builder finish preserves one reviewed identity after ${failure} loss`,async()=>{
 const f=fixture(),sent=[];let first=true,effects=0,receipt
 const request=async input=>{sent.push(structuredClone(input));if(!receipt){effects++;receipt=f.closed(input)}if(first){first=false;if(failure==='reply')throw Error('fixture committed close reply lost');f.failSave()}return receipt}
 await assert.rejects(confirmBuilderClose({...f,request,uuid:()=> 'reviewed-close'}),/lost/)
 const pending=await readBuilderClose(f.storage,f.draft,f.startup);assert.equal(pending.state,'prepared')
 f.draft.revision++
 const result=await confirmBuilderClose({...f,request,uuid:()=> 'must-not-replace'})
 assert.equal(result.state,'closed');assert.deepEqual(sent[0],sent[1]);assert.equal(effects,1)
 assert.equal((await readBuilderClose(f.storage,f.draft,f.startup)).state,'closed')
 await confirmBuilderClose({...f,request:()=>{throw Error('closed history must not dispatch')},uuid:()=> 'unused'})
})
test('Builder finish rejects wrong scope and unproved budget release before a success claim',async()=>{
 for(const change of [r=>r.home_hub='foreign',r=>r.accounting.reservation.held=1,r=>r.accounting.provider_cost_status='confirmed',r=>r.accounting.price_id='other']){
  const f=fixture();await assert.rejects(confirmBuilderClose({...f,uuid:()=> 'close',request:async input=>{const receipt=f.closed(input);change(receipt);return receipt}}),/receipt|release/)
  assert.equal((await readBuilderClose(f.storage,f.draft,f.startup)).state,'prepared')
 }
 const f=fixture();let requests=0
 await assert.rejects(confirmBuilderClose({...f,draft:{...f.draft,id:'other'},request:()=>{requests++}}),/startup/)
 assert.equal(requests,0)
 const stopped=new AbortController();stopped.abort()
 await assert.rejects(confirmBuilderClose({...f,signal:stopped.signal,request:()=>{requests++},uuid:()=> 'close'}),/Disposed/);assert.equal(requests,0)
 const key=builderCloseKey(f.draft,f.startup),stored=f.values.get(key);stored.command.command.price_id='changed'
 await assert.rejects(readBuilderClose(f.storage,f.draft,f.startup),/scope/)
})
test('Builder pending drain is distinct from closed accounting and recovers the exact command',async()=>{
 const f=fixture(),commands=[]
 const pending=await confirmBuilderClose({...f,uuid:()=> 'close',request:async input=>{commands.push(structuredClone(input));return {home_hub:'home',state:'closing',reason:'pending_inputs',pending_inputs:1,intent:f.closed(input).intent}}})
 assert.equal(pending.state,'closing');assert.equal((await readBuilderClose(f.storage,f.draft,f.startup)).state,'closing')
 await confirmBuilderClose({...f,uuid:()=> 'new',request:async input=>{commands.push(structuredClone(input));return f.closed(input)}})
 assert.deepEqual(commands[0],commands[1])
})
test('Builder missing usage is saved and reopened without replaying its nonretryable close',async()=>{
 const f=fixture();let requests=0
 const waiting=await confirmBuilderClose({...f,uuid:()=> 'close',request:async input=>{requests++;return f.waiting(input)}})
 assert.equal(waiting.state,'waiting_accounting')
 assert.equal(waiting.accounting.budget.finalized,false)
 const saved=await readBuilderClose(f.storage,f.draft,f.startup)
 assert.equal(saved.state,'waiting_accounting');assert.deepEqual(saved.last_observation,waiting)
 f.draft.revision++
 assert.deepEqual(await confirmBuilderClose({...f,uuid:()=> 'unused',request:()=>{throw Error('must not replay waiting close')}}),waiting)
 assert.equal(requests,1)
 saved.last_observation.accounting.unresolved_calls[0].accounting_status='counter_regression'
 await f.storage.save(builderCloseKey(f.draft,f.startup),saved)
 await assert.rejects(readBuilderClose(f.storage,f.draft,f.startup),/unresolved usage/)
})
test('Builder missing usage preserves a zero held balance without claiming finalization',async()=>{
 const f=fixture()
 const waiting=await confirmBuilderClose({...f,uuid:()=> 'close',request:async input=>{
  const result=f.waiting(input);result.accounting.budget={...result.accounting.budget,charged:60,held:0,frozen:false};result.accounting.unresolved_calls[0].state='uncertain';return result
 }})
 assert.equal(waiting.accounting.budget.held,0);assert.equal(waiting.accounting.budget.finalized,false)
 assert.equal((await readBuilderClose(f.storage,f.draft,f.startup)).state,'waiting_accounting')
})
test('Builder waiting accounting rejects unproved identity, hold and missing-usage claims',async()=>{
 const changes=[
  r=>r.home_hub='foreign',r=>r.intent.operation_id='other',r=>r.intent.draft_id='other',
  r=>r.intent.request.attempt++,r=>r.intent.request.epoch++,r=>r.intent.request.price_id='other',
  r=>r.execution_resumed=true,r=>r.retryable=true,r=>r.reason='accounting_unresolved',
  r=>r.accounting.reason='accounting_unresolved',r=>r.accounting.retryable=true,r=>r.accounting.recovery='retry',
  r=>r.accounting.unresolved_calls=[],r=>r.accounting.unresolved_calls[0].call_id='',
  r=>r.accounting.unresolved_calls[0].state='started',r=>r.accounting.unresolved_calls[0].state='unknown',
  r=>r.accounting.unresolved_calls[0].accounting_status='counter_regression',
  r=>r.accounting.unresolved_calls.push({call_id:'other-call',state:'finished',accounting_status:'cache_write_pricing_unresolved'}),
  r=>r.accounting.unresolved_calls.push({...r.accounting.unresolved_calls[0]}),
  r=>r.accounting.budget.reservation_id='',r=>r.accounting.budget.unit='other',
  r=>r.accounting.budget.charged=-1,r=>r.accounting.budget.held=59,r=>r.accounting.budget.held=Number.MAX_SAFE_INTEGER,
  r=>r.accounting.budget.finalized=true,r=>r.accounting.budget.frozen=false,
 ]
 for(const change of changes){
  const f=fixture()
  await assert.rejects(confirmBuilderClose({...f,uuid:()=> 'close',request:async input=>{
   const result=f.waiting(input);change(result);return result
  }}),/receipt|unresolved usage/)
  assert.equal((await readBuilderClose(f.storage,f.draft,f.startup)).state,'prepared')
 }
})
test('Builder lost waiting-state save recovers the exact command once and then stops replaying',async()=>{
 const f=fixture(),sent=[];let first=true
 const request=async input=>{sent.push(structuredClone(input));if(first){first=false;f.failSave()}return f.waiting(input)}
 await assert.rejects(confirmBuilderClose({...f,uuid:()=> 'reviewed-close',request}),/lost/)
 assert.equal((await readBuilderClose(f.storage,f.draft,f.startup)).state,'prepared')
 const waiting=await confirmBuilderClose({...f,uuid:()=> 'must-not-replace',request})
 assert.deepEqual(sent[0],sent[1]);assert.equal(waiting.state,'waiting_accounting')
 await confirmBuilderClose({...f,request:()=>{throw Error('waiting history must not dispatch')},uuid:()=> 'unused'})
 assert.equal(sent.length,2)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openScopedCoordinatorProfiles} from '../src/scoped-coordinator-profiles.js'
import {contextScopeKey,discussionScopeId} from '../src/context-scope.js'
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'kode-one-scope-store-')),path=join(dir,'profiles.json'),stores=[]
  const scope={version:2,home_hub:'home',team_id:'team',kind:'discussion_thread',scope_id:discussionScopeId('surface','thread'),context_epoch:1}
  const key=contextScopeKey(scope),authority={context_key:key,context_scope:scope,session_id:`context-${key}`,journal_id:'journal',operation_id:'operation'}
  const binding={revision:1,managedOperation:{id:'operation',attempt:1,epoch:1}},options={path,authority,binding}
  const open=async(mode='fresh',overrides={})=>{const store=await openScopedCoordinatorProfiles({...options,mode,...overrides});stores.push(store);return store}
  t.after(async()=>{for(const store of stores)await store.close().catch(()=>{});await rm(dir,{recursive:true,force:true})})
  const call=id=>({request:{call_id:id,worker_session:authority.session_id,operation_id:'operation',attempt:1,epoch:1},home_node:null,events:[],done:false})
  return{path,options,key:authority.session_id,open,call}
}
test('fresh never overwrites and live lock excludes a second writer',async t=>{
  const f=await fixture(t),a=await f.open()
  await assert.rejects(f.open('restore'),/EEXIST/)
  await a.close();const before=await readFile(f.path,'utf8')
  await assert.rejects(f.open('fresh'),/EEXIST/)
  assert.equal(await readFile(f.path,'utf8'),before)
  const b=await f.open('restore');assert.deepEqual(Object.keys(b.bindings),[f.key])
})
test('concurrent outbox updates serialize and reopen without other scopes',async t=>{
  const f=await fixture(t),a=await f.open()
  await Promise.all(Array.from({length:10},(_,i)=>a.update(async state=>{
    await new Promise(resolve=>setImmediate(resolve))
    ;(state.bindings[f.key].officialCalls??={})[`c${i}`]=f.call(`c${i}`)
  })))
  const snapshot=a.bindings;snapshot[f.key].managedOperation.id='forged'
  assert.equal(a.binding(f.key).managedOperation.id,'operation');assert.equal(a.binding('other'),undefined)
  await a.close();const b=await f.open('restore')
  assert.equal(Object.keys(b.binding(f.key).officialCalls).length,10)
})
test('foreign session, fixed binding, arbitrary secrets and cross-operation calls cannot persist',async t=>{
  const f=await fixture(t),a=await f.open(),before=await readFile(f.path,'utf8')
  for(const mutate of [state=>state.bindings.other={},state=>state.bindings[f.key].managedOperation.id='other',
    state=>state.bindings[f.key].apiKey='not-a-real-secret',state=>state.unrelated='PRIVATE',
    state=>state.bindings[f.key].officialCalls={bad:{...f.call('bad'),request:{...f.call('bad').request,worker_session:'foreign'}}}]){
    await assert.rejects(a.update(mutate));assert.equal(await readFile(f.path,'utf8'),before)
  }
  await a.update(state=>{state.bindings[f.key].officialCalls={good:f.call('good')}})
})
test('restore pins original journal and operation without migrating content',async t=>{
  const f=await fixture(t),a=await f.open();await a.close()
  await assert.rejects(f.open('restore',{authority:{...f.options.authority,journal_id:'different'}}),/origin/)
  const restored=await f.open('restore');await restored.close()
  const row=JSON.parse(await readFile(f.path,'utf8'));row.bindings[f.key].managedOperation.epoch=2
  await writeFile(f.path,JSON.stringify(row))
  await assert.rejects(f.open('restore'),/fixed binding/)
})
test('update callback cannot retain a mutable alias to committed state',async t=>{
  const f=await fixture(t),a=await f.open();let captured
  const result=await a.update(state=>{captured=state;return state.bindings[f.key]})
  captured.bindings[f.key].managedOperation.id='foreign'
  result.managedOperation.id='also-foreign'
  assert.equal(a.binding(f.key).managedOperation.id,'operation')
  assert.equal(JSON.parse(await readFile(f.path,'utf8')).bindings[f.key].managedOperation.id,'operation')
})
test('lost lock ownership fences updates rather than overwriting or stealing',async t=>{
  const f=await fixture(t),a=await f.open(),before=await readFile(f.path,'utf8')
  await writeFile(`${f.path}.lock`,'different-owner')
  await assert.rejects(a.update(state=>{state.bindings[f.key].officialCalls={a:f.call('a')}}),/lock ownership/)
  await assert.rejects(a.update(()=>{}),/writer unavailable/)
  assert.equal(await readFile(f.path,'utf8'),before)
  await assert.rejects(a.close(),/lock ownership/)
  await assert.rejects(a.close(),/lock ownership/)
})
test('real profile fingerprint revisions are preserved exactly',async t=>{
  const f=await fixture(t),binding={...f.options.binding,revision:'a'.repeat(64)}
  const a=await f.open('fresh',{binding});assert.equal(a.binding(f.key).revision,binding.revision)
  await a.close();const b=await f.open('restore',{binding});assert.equal(b.binding(f.key).revision,binding.revision)
  await assert.rejects(b.update(state=>{state.bindings[f.key].revision='b'.repeat(64)}),/fixed binding/)
})

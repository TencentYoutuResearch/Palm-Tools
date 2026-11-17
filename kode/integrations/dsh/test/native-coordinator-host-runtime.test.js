import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {profileRevision} from '../src/agent-profiles.js'
import {createNativeCoordinatorHostRuntime} from '../src/native-coordinator-host-runtime.js'
const base=JSON.parse(await readFile(new URL('./fixtures/native-host-source-authority.json',import.meta.url),'utf8'))
function fixture(){
 const row=structuredClone(base),a=row.authority,target=row.host_binding.frozen.execution_target
 const profile={id:target.executor_profile_id,name:'Fixture',type:'codex',executable:'fixture-no-execution'}
 const revision=profileRevision(profile);target.executor_profile_revision=revision;row.operation.selection_policy.profile_revision=revision
 const bindings={},calls=[]
 const profiles={async update(fn){return fn({bindings})},get:id=>id===profile.id?structuredClone(profile):undefined,binding:id=>structuredClone(bindings[id]),async bind(id,p){assert.equal(p,profile.id);bindings[id]??={profile:structuredClone(profile),revision,seenInputs:[]}},async patchBinding(id,patch){Object.assign(bindings[id],structuredClone(patch))}}
 const client={async call(path,body){calls.push({path,body});if(path.endsWith('/source-authority'))return structuredClone(row);throw Error('Unexpected mutable call')}}
 const runtime=createNativeCoordinatorHostRuntime({host:a.context_scope.home_hub,clientForSession:id=>id===a.session_id?client:undefined,profiles,workspaceRegistry:{list:()=>[{id:a.origin.workspace_id,path:a.origin.root_ref}]},usageOutbox:{},selectionOutbox:{},inspectExecutor:()=>({supported:true,tool_scope_verified:true,selection_confirmed:true,usage_supported:true})})
 return {runtime,row,a,profile,bindings,calls,profiles,agent:{id:a.session_id}}
}
test('original source/profile/workspace resolves without registering credentials or changing model',async()=>{
 const f=fixture();const snapshot=await f.runtime.sessionAdmission(f.agent.id,{mode:'fresh'});assert.equal(snapshot.selection.model,f.row.host_binding.frozen.execution_target.model_id)
 await f.runtime.setupAgent(f.agent,{authority:f.a});assert.equal(await f.runtime.assertSession(f.agent,{authority:f.a}),true)
 assert.deepEqual(f.bindings[f.agent.id].context_scope,f.a.context_scope);assert.ok(f.calls.every(c=>c.body===undefined))
})
test('source-owned unsupported capability denies before original claim despite forged constructor/profile flags',async()=>{
 const f=fixture();await f.runtime.setupAgent(f.agent,{authority:f.a});const op=f.bindings[f.agent.id].managedOperation
 await assert.rejects(f.runtime.acquireOperationLease(f.agent,op,new AbortController().signal),{code:'native_scope_capability_unsupported'})
 assert.ok(f.calls.every(c=>c.body===undefined));assert.ok(f.calls.every(c=>!c.path.includes('/operations/')))
})
test('missing existing credential never creates a registration',async()=>{const f=fixture();await assert.rejects(f.runtime.sessionAdmission(`context-${'f'.repeat(64)}`,{mode:'fresh'}),{code:'scope_session_not_registered'});assert.equal(f.calls.length,0)})
test('changed workspace/model/revision/foreign caller rejects',async()=>{
 for(const mutate of [f=>f.row.authority.origin.root_ref='/other',f=>f.row.host_binding.frozen.execution_target.model_id='other',f=>f.row.host_binding.frozen.execution_target.executor_profile_revision='f'.repeat(64)]){const f=fixture();mutate(f);await assert.rejects(f.runtime.sessionAdmission(f.agent.id,{mode:'fresh'}))}
 const f=fixture();await assert.rejects(f.runtime.assertSession(f.agent,{authority:f.a}),/Foreign/)
})
test('delivery fails before factory creation or source claim when original executor is unsupported',async()=>{const f=fixture();await assert.rejects(f.runtime.deliver({session_id:f.agent.id,entry_id:'entry',request_id:'request'}),{code:'native_scope_capability_unsupported'});assert.ok(f.calls.every(c=>c.body===undefined))})

test('resolved executor is exact original frozen profile; unknown extension changes are not silently authorized',async()=>{
 const f=fixture();await f.runtime.setupAgent(f.agent,{authority:f.a});const b=f.profiles.binding(f.agent.id)
 const proof={authority:f.a,operation:b.managedOperation,profile_revision:b.revision,resolvedProfile:f.profile}
 assert.equal(await f.runtime.assertResolvedNativeProfile(f.agent,proof),true)
 await assert.rejects(f.runtime.assertResolvedNativeProfile(f.agent,{...proof,resolvedProfile:{...f.profile,args:['--different-provider']}}),{code:'native_resolved_profile_unverified'})
})

test('setup ownership is rechecked atomically after bind without overwriting another owner',async()=>{
 for(const change of [{managedOperation:{id:'foreign',attempt:1,epoch:1}},{managedAssignment:{id:'foreign'}},{context_scope:{kind:'foreign'}}]){
  const f=fixture(),bind=f.profiles.bind;f.profiles.bind=async(...args)=>{await bind(...args);Object.assign(f.bindings[f.agent.id],structuredClone(change))}
  await assert.rejects(f.runtime.setupAgent(f.agent,{authority:f.a}),/owner changed during setup/)
  for(const [key,value] of Object.entries(change))assert.deepEqual(f.bindings[f.agent.id][key],value)
  await assert.rejects(f.runtime.assertSession(f.agent,{authority:f.a}),/Foreign/)
 }
})

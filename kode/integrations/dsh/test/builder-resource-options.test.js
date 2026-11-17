import test from 'node:test'
import assert from 'node:assert/strict'
import {builderProfileEligible,builderProviderOptions,builderModelQuery,validBuilderModelScope} from '../packages/collab/builder-resource-options.js'
const native={resource_kind:'execution_profile',profile_id:'claude',profile_revision:'a'.repeat(64),name:'Managed Claude',executor_type:'claude',runtime_available:true,builder_selection_eligible:true,managed_roles:['builder'],managed_route_registered:true,managed_provider_id:'kode-workflow-claude'}
test('only explicit role-aware builder catalog entries are selectable, never inventory dispatch claims',()=>{
 assert.equal(builderProfileEligible(native),true)
 for(const patch of [{managed_roles:['worker']},{managed_route_registered:false},{builder_selection_eligible:false},{managed_provider_id:null},{runtime_available:false}]) assert.equal(builderProfileEligible({...native,...patch}),false)
 assert.equal(builderProfileEligible({...native,executor_type:'dsh'}),true)
 assert.equal(builderProfileEligible({resource_kind:'execution_profile',executor_type:'dsh',runtime_available:true}),false)
 assert.equal(builderProfileEligible({...native,eligible_for_dispatch:false}),true)
})
test('managed model catalogs bind to exact profile, revision and provider without arbitrary provider choices',()=>{
 const rows=[native,{resource_kind:'official_loop_provider',provider_id:'unrelated',name:'Other',route_registered:true}]
 assert.deepEqual(builderProviderOptions(rows,native),[{id:'kode-workflow-claude',name:'Managed Claude'}])
 const url=new URL(builderModelQuery(native,'kode-workflow-claude','opus'),'http://localhost')
 assert.deepEqual(Object.fromEntries(url.searchParams),{provider:'kode-workflow-claude',profile_id:'claude',profile_revision:'a'.repeat(64),model:'opus'})
 assert.equal(builderModelQuery(native,'unrelated'),null)
 const response={home_hub:'home',provider:'kode-workflow-claude',profile_id:'claude',profile_revision:'a'.repeat(64),eligible_for_dispatch:false}
 assert.equal(validBuilderModelScope(response,native,response.provider,'home'),true)
 for(const patch of [{profile_revision:'b'.repeat(64)},{profile_id:'other'},{home_hub:'remote'},{eligible_for_dispatch:true}]) assert.equal(validBuilderModelScope({...response,...patch},native,response.provider,'home'),false)
 const dsh={...native,executor_type:'dsh'}
 assert.deepEqual(builderProviderOptions(rows,dsh),[{id:'unrelated',name:'Other'}])
 assert.equal(builderModelQuery(dsh,'unrelated'),'/api/kode/builder/models?provider=unrelated')
})

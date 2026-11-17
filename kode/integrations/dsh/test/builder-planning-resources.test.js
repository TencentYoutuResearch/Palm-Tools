import test from 'node:test'
import assert from 'node:assert/strict'
import {createBuilderPlanningResources,validateBuilderPlanningResources,builderPlanningResourcesInput} from '../src/builder-planning-resources.js'
import {createInteractiveTeamCatalog} from '../src/interactive-team-catalog.js'
import {AgentRuntimeAdapter,discoveryRevision} from '../src/agent-runtime.js'
import {BUILDER_PLANNING_PROMPT_V2} from '../src/builder-planning-prompt-v2.js'
const home='fixture-home',profile={id:'fixture-agent',type:'codebuddy',name:'Fixture',executable:'never-start',env:{SECRET:'never-project'},args:['private-argument']}
function setup({cached=true}={}) {
 const calls=[]
 const service={profiles:{reload:async()=>{},listAgents:()=>[profile]},hasRuntime:()=>true,adapter:{listModels:()=>{throw Error('Discovery must never start')},peekModels:async(...args)=>{calls.push(args);return cached?[{id:'actual-model',secret:'not-projected'}]:null}}}
 const read=createBuilderPlanningResources({home,readCatalog:createInteractiveTeamCatalog({service,home}),workspaceRegistry:{list:()=>[{id:'workspace',path:'/fixture/project',title:'Project',sessionIds:['private-session']}]},readPluginMetadata:async()=>({read_only:true,eligible_for_execution:false,authorities:{runtime:'dsh_plugin_inventory'},kode:{modules:[{entry_id:'plugin',module_name:'@kode/fixture',enabled:true,runtime_phase:'active',args:['SECRET']}]},other_runtime_plugins:[]})})
 return {read,calls}
}
test('owner sources populate real internal identities without launching a CLI or exposing secrets',async()=>{
 const f=setup(),snapshot=await f.read({draft:{interview:{workspace_refs:[{host_id:home,workspace_id:'workspace',root_ref:'/fixture/project'}]}}})
 assert.equal(f.calls.length,1);assert.equal(snapshot.profiles.state,'available')
 const p=snapshot.profiles.items[0],t=p.execution_targets[0]
 assert.equal(t.executor_profile_id,profile.id);assert.equal(t.model_id,'actual-model');assert.equal(t.effort,null)
 assert.match(t.executor_profile_revision,/^[a-f0-9]{64}$/);assert.equal(t.provider_id,'kode-agent-fixture-agent')
 assert.equal(snapshot.workspaces.items[0].selection,'owner_selected');assert.equal(snapshot.eligible_for_execution,false)
 for(const forbidden of ['SECRET','never-start','private-argument','private-session','not-projected'])assert.equal(JSON.stringify(snapshot).includes(forbidden),false)
 assert.ok(Object.isFrozen(snapshot.profiles.items[0]));assert.deepEqual(validateBuilderPlanningResources(snapshot,home),snapshot)
 assert.match(builderPlanningResourcesInput(snapshot).text,/not instructions, permission/)
})
test('empty draft never authorizes registered paths and missing model cache remains unavailable',async()=>{
 const f=setup({cached:false}),s=await f.read({draft:{interview:{workspace_refs:[]}}})
 assert.equal(s.workspaces.items[0].selection,'requires_owner_confirmation')
 assert.equal(s.profiles.items[0].model_catalog_state,'unavailable');assert.deepEqual(s.profiles.items[0].execution_targets,[])
 assert.equal(f.calls.length,1)
})
test('missing source services are explicit independent unavailable states',async()=>{
 const s=await createBuilderPlanningResources({home})()
 for(const name of ['profiles','workspaces','plugins'])assert.equal(s[name].state,'unavailable')
})
test('snapshot rejects tampering, another home and extra raw configuration',async()=>{
 const s=await setup().read()
 assert.throws(()=>validateBuilderPlanningResources(s,'other-home'))
 for(const change of [s=>s.profiles.items[0].execution_targets[0].model_id='invented',s=>s.workspaces.items[0].selection='owner_selected',s=>s.profiles.items[0].env={secret:'bad'},s=>s.eligible_for_execution=true]){const c=structuredClone(s);change(c);assert.throws(()=>validateBuilderPlanningResources(c,home))}
})
test('cache reader matches exact profile, cwd, hint and extension revision without probing',async()=>{
 const adapter=Object.create(AgentRuntimeAdapter.prototype);adapter.catalogs=new Map();adapter.extensionRevision=async()=>7
 adapter.capabilities=()=>{throw Error('no probes')}
 const key=`kode-agent-fixture-agent:${discoveryRevision(profile)}:/fixture/project::7`
 adapter.catalogs.set(key,Promise.resolve({models:[{id:'real'}]}))
 assert.deepEqual(await adapter.peekModels('kode-agent-fixture-agent',profile,'/fixture/project'),[{id:'real'}])
 assert.equal(await adapter.peekModels('kode-agent-fixture-agent',profile,'/another'),null)
 assert.equal(await adapter.peekModels('kode-agent-fixture-agent',{...profile,args:['changed']},'/fixture/project'),null)
 adapter.extensionRevision=async()=>8;assert.equal(await adapter.peekModels('kode-agent-fixture-agent',profile,'/fixture/project'),null)
 adapter.extensionRevision=async()=>7;adapter.catalogs.clear();assert.equal(await adapter.peekModels('kode-agent-fixture-agent',profile,'/fixture/project'),null)
})
test('v2 describes exact TeamSpec fields and does not create mandatory interview or grants',()=>{
 for(const phrase of ['executor_profile_id','model_id','execution_mode belongs at proposed_team top level','COMPLETE object','Do not repeat a generic questionnaire','Catalogue visibility never fills grant_id','Do not launch discovery commands'])assert.ok(BUILDER_PLANNING_PROMPT_V2.includes(phrase))
})

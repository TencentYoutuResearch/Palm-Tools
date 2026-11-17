import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHostBuilderPlanningResources } from '../src/builder-planning-resource-host.js'
const home = 'fixture'
function fixture() {
  const calls = [], services = new Map()
  services.set('workspaceRegistry', { list() { calls.push('workspaces'); return [{id:'project',path:'/fixture/project'}] } })
  services.set('pluginInventory', { async list() { calls.push('plugins'); return {entries:[{entryId:'kode',moduleName:'@kode/dsh',enabled:true,fiberPhase:'active',private:'do-not-project'}]} } })
  const profile = { id:'native',type:'codex',name:'Native',executable:'never-start',args:['private-argument'],env:{SECRET:'do-not-project'} }
  const service = { profiles:{reload:async()=>{},listAgents:()=>[profile]},hasRuntime:()=>true,
    adapter:{peekModels:async()=>{calls.push('cache');return [{id:'cached-model'}]},listModels:()=>{throw Error('Must not launch model discovery')}} }
  const read = createHostBuilderPlanningResources({ctx:{get:key=>services.get(key)},service,home})
  return {read,calls,services,service}
}
test('Host reader uses original services and cache-only metadata without extra authority',async()=>{
  const f=fixture(),snapshot=await f.read({draft:{interview:{workspace_refs:[]}}})
  assert.deepEqual(f.calls,['cache','workspaces','plugins'])
  assert.equal(snapshot.profiles.items[0].execution_targets[0].model_id,'cached-model')
  assert.equal(snapshot.workspaces.items[0].selection,'requires_owner_confirmation')
  assert.equal(snapshot.plugins.items[0].module_name,'@kode/dsh')
  assert.equal(snapshot.plugins.items[0].runtime_verification,'not_verified')
  assert.equal(snapshot.eligible_for_execution,false)
  for(const secret of ['private-argument','do-not-project','SECRET'])assert.equal(JSON.stringify(snapshot).includes(secret),false)
})
test('late or unavailable optional services stay unavailable without fabricated resources',async()=>{
  const f=fixture();f.services.clear();f.service.adapter.peekModels=async()=>null
  const first=await f.read({draft:{interview:{workspace_refs:[]}}})
  assert.equal(first.profiles.items[0].model_catalog_state,'unavailable')
  assert.equal(first.plugins.state,'unavailable');assert.equal(first.workspaces.state,'unavailable')
  f.services.set('workspaceRegistry',{list:()=>[]})
  assert.equal((await f.read()).workspaces.state,'available')
})
test('Host injects reader only at planning service composition',async()=>{
  const text=await readFile(new URL('../src/host.js',import.meta.url),'utf8')
  assert.match(text,/readResources: createHostBuilderPlanningResources\(\{ ctx: runtimeCtx, service, home: node.node_id \}\)/)
})

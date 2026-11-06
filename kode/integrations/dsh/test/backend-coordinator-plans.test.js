import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { AgentProfiles } from '../src/agent-profiles.js'
import { BackendAgentProfiles,BackendDocument } from '../src/backend-state.js'
import { isolatedHub } from './support/isolated-hub.js'
test('shared backend profiles migrate, update and reopen durable Coordinator start intents across Hub crash',{skip:!process.env.KODE_TEST_BACKEND_URL},async()=>{
 const hub=await isolatedHub('backend-start-plans')
 try{
  const path=join(hub.root,'legacy.json'),local=await new AgentProfiles(path).open([{id:'official',name:'Official',type:'dsh'}])
  const prior={home_hub:hub.node,input:{team_id:'team',request_id:'first'},command:{command_id:'first'},created_at:1}
  await local.update(state=>{state.coordinatorStartPlans.first=prior})
  const first=await new BackendAgentProfiles(hub.client,path).open()
  assert.deepEqual(first.coordinatorStartPlans.first,prior)
  await first.update(state=>{assert.deepEqual(state.coordinatorStartPlans.first,prior);state.coordinatorStartPlans.second={...prior,input:{team_id:'team',request_id:'second'}}})
  await first.bind('session','official')
  await hub.stop('SIGKILL');await hub.start()
  const reopened=await new BackendAgentProfiles(hub.client,join(hub.root,'unused.json')).open()
  assert.deepEqual(reopened.coordinatorStartPlans.first,prior)
  assert.equal(reopened.coordinatorStartPlans.second.input.request_id,'second')
  assert.equal(reopened.binding('session').profile.id,'official')
  await reopened.patchBinding('session',{threadId:'thread'})
  await first.reload()
  assert.deepEqual(first.coordinatorStartPlans,reopened.coordinatorStartPlans)
  const document=new BackendDocument(hub.client,'agents'),saved=await document.read()
  delete saved.coordinatorStartPlans;await document.write(saved)
  await reopened.reload()
  assert.deepEqual(Object.keys(reopened.coordinatorStartPlans),[],'legacy shared documents normalize the absent map')
  await reopened.update(state=>{state.coordinatorStartPlans.afterLegacy=prior})
  await first.reload();assert.deepEqual(first.coordinatorStartPlans.afterLegacy,prior)
  assert.throws(()=>first.adopt({...saved,coordinatorStartPlans:[]}),/start plans/)
 }finally{await hub.close()}
})
test('migration refuses divergent immutable local and shared Coordinator plans',{skip:!process.env.KODE_TEST_BACKEND_URL},async()=>{
 const hub=await isolatedHub('backend-plan-conflict')
 try{
  const path=join(hub.root,'legacy.json'),local=await new AgentProfiles(path).open([])
  await local.update(state=>{state.coordinatorStartPlans.same={command:{id:'local'}}})
  const document=new BackendDocument(hub.client,'agents');await document.read()
  await document.write({version:1,profiles:[],bindings:{},coordinatorStartPlans:{same:{command:{id:'shared'}}}})
  await assert.rejects(new BackendAgentProfiles(hub.client,path).open(),/Conflicting migrated/)
  assert.deepEqual((await document.read()).coordinatorStartPlans.same,{command:{id:'shared'}})
 }finally{await hub.close()}
})

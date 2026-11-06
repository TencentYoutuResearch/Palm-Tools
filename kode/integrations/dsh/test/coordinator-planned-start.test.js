import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProfiles } from '../src/agent-profiles.js'
import { startPlannedCoordinator } from '../src/coordinator-planned-start.js'
const input={team_id:'team',command_id:'create',request_id:'start',owner_session:'owner',session_id:'coordinator',workspace_id:'workspace',task_tag:'coordination'}
test('durable plan survives ambiguous start and profile reconstruction without reranking',async()=>{
 const root=await mkdtemp(join(tmpdir(),'kode-coordinator-plan-')),path=join(root,'profiles.json')
 try{
  let plans=0,starts=0
  const command={fixture:'original selection'}
  const profiles=await new AgentProfiles(path).open()
  const host={execution:{host:'home',profiles},stop:new AbortController(),coordinatorPlanStarts:new Map(),
   planCoordinatorStart:async()=>{plans++;return {command}},startCoordinator:async c=>{starts++;assert.deepEqual(c,command);throw Error('committed response lost')}}
  await assert.rejects(startPlannedCoordinator(host,input),/response lost/)
  assert.equal(plans,1);assert.equal(starts,1)
  host.execution.profiles=await new AgentProfiles(path).open()
  await host.execution.profiles.save({id:'profile',name:'ordinary',type:'dsh'})
  host.execution.profiles=await new AgentProfiles(path).open()
  host.planCoordinatorStart=()=>{throw Error('must never rerank historical start')}
  host.startCoordinator=async c=>{starts++;assert.deepEqual(c,command);return {state:'created'}}
  assert.deepEqual(await Promise.all([startPlannedCoordinator(host,input),startPlannedCoordinator(host,input)]),[{state:'created'},{state:'created'}])
  assert.equal(starts,2,'concurrent recovery coalesces')
  await assert.rejects(startPlannedCoordinator(host,{...input,workspace_id:'other'}),/identity conflict/)
  assert.equal(starts,2)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('failed plan persistence never starts an operation',async()=>{
 let starts=0
 const host={execution:{host:'home',profiles:{coordinatorStartPlans:{},update:async()=>{throw Error('disk failure')}}},stop:new AbortController(),coordinatorPlanStarts:new Map(),planCoordinatorStart:async()=>({command:{}}),startCoordinator:()=>{starts++}}
 await assert.rejects(startPlannedCoordinator(host,input),/disk failure/)
 assert.equal(starts,0)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { AssignmentDispatchHost } from '../src/assignment-dispatch-host.js'

function fixture(resources) {
  const operation = { id: 'operation', attempt: 1, epoch: 1, home_node: 'home' }
  const assignment = { id: 'assignment', worker: { node_id: 'remote', session_id: 'worker' }, state: 'prepared',
    bundle: { operation }, dispatch: { state: 'blocked', command: { command_id: 'assignment', session_id: 'worker', operation } },
    ...(resources === undefined ? {} : { resources }) }
  const calls = []
  const host = { execution: { host: 'remote', client: { async call(path) { calls.push(path); return assignment } } },
    stop: new AbortController(), dispatches: { get() { return undefined } }, handles: new Map() }
  return { dispatcher: new AssignmentDispatchHost(host), calls,
    options: { homeScope: { worker_session: 'worker', operation } } }
}

test('remote prepared assignment without Home resource receipt waits without creating a Worker', async () => {
  const { dispatcher, calls, options } = fixture(undefined)
  assert.deepEqual(await dispatcher.dispatch('assignment', options), { state: 'waiting_home_resources', assignment_id: 'assignment' })
  assert.equal(calls.length, 1)
})

test('remote assignment with a released Home resource receipt is rejected', async () => {
  const { dispatcher, calls, options } = fixture({ state: 'released', receipt: { state: 'released' } })
  await assert.rejects(dispatcher.dispatch('assignment', options), /Remote Assignment requires home-owned resource holds/)
  assert.equal(calls.length, 1)
})

// Fault-injected disk/HTTP failures use actual durable profile documents.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProfiles } from '../src/agent-profiles.js'
async function stopFixture(t, creation = 'created') {
  const root = await mkdtemp(join(tmpdir(), 'assignment-stop-fault-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{id:'profile',name:'Fixture',type:'dsh'}])
  const operation={id:'op',attempt:1,epoch:1,home_node:'local'}
  const command={command_id:'assignment',session_id:'worker',operation}
  const assignment={id:'assignment',run_id:'run',worker:{node_id:'local',session_id:'worker'},dispatch:{command},creation:{state:creation}}
  await profiles.bind('worker','profile')
  await profiles.patchBinding('worker',{managedAssignment:{id:'assignment'},managedOperation:operation})
  let drains=0, receipts=0, creations=0, saved=null
  const host={stop:new AbortController(),handles:new Map(),dispatches:{get:()=>saved,reconcile:async()=>saved},execution:{host:'local',profiles,client:{async call(path,body){
    if(path.endsWith('/creation')){creations++;assert.equal(body.state,'created');assert.deepEqual(body.command,command);assignment.creation.state='created';return {state:'created'}}
    if(path.endsWith('/stop-receipt')){receipts++;assert.equal(profiles.binding('worker').assignmentStop.state,'drained');return {assignment_id:'assignment',session_id:'worker',state:'execution_drained'}}
    if(path.includes('/work-runs/'))return {id:'run',state:'cancelling'}
    return structuredClone(assignment)
  }}}}
  host.handles.set('worker',{async dispose(){drains++;host.handles.delete('worker')}})
  const dispatcher=new AssignmentDispatchHost(host)
  t.after(()=>dispatcher.close())
  return {dispatcher,host,profiles,command,counts:()=>({drains,receipts,creations}),save:row=>{saved=row}}
}
test('stop retains observed drain through a failed profile commit and retries without disposing twice',async t=>{
 const f=await stopFixture(t),update=f.profiles.update.bind(f.profiles)
 let failed=false
 f.profiles.update=fn=>{if(f.counts().drains&&!failed){failed=true;return Promise.reject(Error('disk full'))}return update(fn)}
 await assert.rejects(f.dispatcher.stop('assignment'),/disk full/)
 assert.deepEqual(f.counts(),{drains:1,receipts:0,creations:0})
 assert.equal(f.host.handles.size,0)
 assert.equal(f.profiles.binding('worker').assignmentStop.state,'stopping')
 await f.dispatcher.stop('assignment')
 assert.deepEqual(f.counts(),{drains:1,receipts:1,creations:0})
 assert.equal(f.dispatcher.stopEvidence.size,0)
})
test('rejected in-flight dispatch cannot short-circuit stopping a known created Worker',async t=>{
 const f=await stopFixture(t)
 let reject
 f.dispatcher.pending.set('assignment',new Promise((_,r)=>{reject=r}))
 const stopped=f.dispatcher.stop('assignment');reject(Error('creation response lost'))
 await stopped
 assert.deepEqual(f.counts(),{drains:1,receipts:1,creations:0})
})
test('uncertain creation drains owned execution but holds Home receipt until evidence can reconcile',async t=>{
 const f=await stopFixture(t,'uncertain')
 await assert.rejects(f.dispatcher.stop('assignment'),/creation remains uncertain/)
 assert.deepEqual(f.counts(),{drains:1,receipts:0,creations:0})
 assert.equal(f.profiles.binding('worker').assignmentStop.state,'drained')
 f.save({state:'created',request:f.command})
 await f.dispatcher.stop('assignment')
 assert.deepEqual(f.counts(),{drains:1,receipts:1,creations:1})
})
test('unknown execution never becomes drained merely because dispatch failed',async t=>{
 const f=await stopFixture(t,'uncertain')
 f.host.handles.clear()
 await assert.rejects(f.dispatcher.stop('assignment'),/actual execution ownership/)
 assert.deepEqual(f.counts(),{drains:0,receipts:0,creations:0})
 assert.equal(f.profiles.binding('worker').assignmentStop,undefined)
})
test('process reconstruction cannot reuse volatile drain evidence after its commit failed',async t=>{
 const f=await stopFixture(t),update=f.profiles.update.bind(f.profiles)
 f.profiles.update=fn=>f.counts().drains?Promise.reject(Error('disk full')):update(fn)
 await assert.rejects(f.dispatcher.stop('assignment'),/disk full/)
 const fresh=new AssignmentDispatchHost(f.host)
 t.after(()=>fresh.close())
 await assert.rejects(fresh.stop('assignment'),/actual execution ownership/)
 assert.deepEqual(f.counts(),{drains:1,receipts:0,creations:0})
})

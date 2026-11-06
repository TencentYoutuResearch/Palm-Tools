import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm,symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { ExclusiveResources,resourceNames } from '../src/exclusive-resources.js'
test('named resource batches exclude other teams, roll back partial acquisition and reject stale/forged leases',{skip:!process.env.KODE_TEST_HOST_NODE},async()=>{
 const root=await mkdtemp(join(tmpdir(),'kode-exclusive-draft-'))
 const a=new ExclusiveResources(root),b=new ExclusiveResources(root)
 try{
  const lease=await a.acquire(['b','c'],'team-a');a.assertHeld(lease,['c','b'],'team-a')
  assert.throws(()=>b.assertHeld(lease,['b','c'],'team-a'),/unavailable/)
  await assert.rejects(b.acquire(['a','b'],'team-b'),{code:'EXCLUSIVE_RESOURCE_BUSY'})
  const rolledBack=await b.acquire(['a'],'team-b');await rolledBack.release()
  await lease.release();await lease.release();assert.throws(()=>a.assertHeld(lease,['b','c'],'team-a'),/unavailable/)
  const next=await b.acquire(['c','b'],'team-b');await next.release()
  const stop=AbortSignal.abort();await assert.rejects(a.acquire(['a'],'aborted',{signal:stop}))
  const cancellation=new AbortController(),cancelled=await a.acquire(['a'],'cancelled',{signal:cancellation.signal})
  cancellation.abort();assert.throws(()=>a.assertHeld(cancelled,['a'],'cancelled'))
  await assert.rejects(b.acquire(['a'],'successor'),{code:'EXCLUSIVE_RESOURCE_BUSY'})
  await cancelled.release();const successor=await b.acquire(['a'],'successor');await successor.release()
  assert.throws(()=>resourceNames(['duplicate','duplicate']),/Invalid/)
  assert.throws(()=>resourceNames(['../outside']),/Invalid/)
  assert.throws(()=>resourceNames(['device/path']),/Invalid/)
  assert.deepEqual(resourceNames(['port:3000','device.camera']),['device.camera','port:3000'])
 }finally{await rm(root,{recursive:true,force:true})}
})
test('two owned processes and aliased namespace share the same kernel resource ownership until SIGKILL', {skip:!process.env.KODE_TEST_HOST_NODE,timeout:15000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'kode-exclusive-process-')),alias=root+'-alias'
 let child
 try{
  await symlink(root,alias)
  child=fork(new URL('./support/exclusive-resource-holder.js',import.meta.url),[root],{execPath:process.env.KODE_TEST_HOST_NODE,stdio:['ignore','ignore','ignore','ipc']})
  const [message]=await once(child,'message');assert.equal(message.state,'held')
  const other=new ExclusiveResources(alias)
  await assert.rejects(other.acquire(['fixture-device'],'other-team'),{code:'EXCLUSIVE_RESOURCE_BUSY'})
  const exited=once(child,'exit');child.kill('SIGKILL');await exited
  const recovered=await other.acquire(['fixture-device'],'other-team');await recovered.release()
 }finally{if(child?.exitCode===null&&child?.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited}await rm(alias,{force:true});await rm(root,{recursive:true,force:true})}
})

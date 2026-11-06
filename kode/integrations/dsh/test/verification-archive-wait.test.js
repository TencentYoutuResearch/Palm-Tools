/** Archive transport unit boundary; no model/command or Hub validation is simulated as delivery. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { AgentProfiles } from '../src/agent-profiles.js'
import { VerificationArchive } from '../src/verification-archive.js'
test('verification archival admission waits only for frozen bytes and refuses invalid receipts or revoked ownership',async()=>{
 const root=await mkdtemp(join(tmpdir(),'kode-verification-wait-'));let archive
 try{
  const profiles=await new AgentProfiles(join(root,'profiles.json')).open([{id:'official',name:'Official',type:'dsh'}])
  const operation={id:'op',attempt:1,epoch:1}
  await profiles.bind('worker','official');await profiles.patchBinding('worker',{managedOperation:operation,artifactOutbox:{observation:{evidence:{id:'verify',operation_id:'op',attempt:1,epoch:1},home_reconciled:true,home_sequence:7}}})
  let calls=0,valid=false;const bodies=[]
  archive=new VerificationArchive({call:async(path,body)=>{
   calls++;bodies.push(body.result_json);assert.equal(path,'/api/v1/messaging/verification-records/7')
   if(calls===1)throw Error('fixture receipt lost')
   return {sequence:7,record_hash:valid?createHash('sha256').update(body.result_json).digest('hex'):'0'.repeat(64),result_json:body.result_json,completion_authorized:false}
  }},profiles)
  const observed={request_id:'verify',operation,observed:{exit_code:0},completion_authorized:false}
  assert.equal((await archive.record('worker',operation,observed)).home_reconciled,false)
  observed.observed.exit_code=9
  await assert.rejects(archive.awaitSettled('worker',operation,{timeoutMs:1}),/home archival/)
  assert.throws(()=>archive.assertSettled('worker',operation),/home archival/)
  const stop=new AbortController();stop.abort(Error('fixture owner revoked'))
  const before=calls;await assert.rejects(archive.awaitSettled('worker',operation,{signal:stop.signal}),/owner revoked/);assert.equal(calls,before)
  valid=true;let checks=0
  await archive.awaitSettled('worker',operation,{assertOwner:async()=>{checks++}})
  archive.assertSettled('worker',operation);assert.ok(checks>=2)
  assert.ok(bodies.every(raw=>JSON.parse(raw).observed.exit_code===0),'changed caller objects never alter frozen result bytes')
 }finally{await archive?.close();await rm(root,{recursive:true,force:true})}
})

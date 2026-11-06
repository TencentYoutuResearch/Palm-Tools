import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdir,writeFile,realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BackendAgentProfiles } from '../src/backend-state.js'
import { ArtifactOutbox } from '../src/artifact-outbox.js'
import { isolatedHub } from './support/isolated-hub.js'
for(const loseReply of [false,true])test(`shared profile registry reconciles frozen artifact bytes (lost reply=${loseReply})`,{skip:!process.env.KODE_TEST_BACKEND_URL,timeout:30000},async()=>{
 const hub=await isolatedHub('shared-artifact-outbox');let outbox
 try{
  const root=join(await realpath(hub.root),'project');await mkdir(root)
  const git=args=>promisify(execFile)('/usr/bin/git',['-C',root,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}})
  await git(['init','-q']);await writeFile(join(root,'file.txt'),'base');await git(['add','file.txt']);await git(['commit','-qm','fixture baseline'])
  await writeFile(join(root,'file.txt'),'implemented')
  const registration=await hub.client.call('/api/v1/messaging/sessions',{session_id:'worker',title:'Worker',runtime:'external'})
  const op=await hub.client.call('/api/v1/messaging/operations',{owner_session:'owner',request_key:'capture',worker:{node_id:hub.node,session_id:'worker'}})
  await hub.client.forSession(registration.owner_token).call('/api/v1/messaging/operations/'+op.id,{attempt:1,epoch:1,expected_revision:1,action:{kind:'claim',lease_ms:60000}})
  const profiles=await new BackendAgentProfiles(hub.client,join(hub.root,'profiles.json')).open([{id:'official',name:'Official',type:'dsh'}])
  const operation={id:op.id,attempt:1,epoch:1}
  await profiles.bind('worker','official');await profiles.patchBinding('worker',{managedOperation:operation})
  let lost=false
  outbox=new ArtifactOutbox({call:async(...args)=>{const result=await hub.client.call(...args);if(loseReply&&!lost&&args[0]==='/api/v1/messaging/artifact-evidence'){lost=true;throw Error('fixture committed artifact reply lost')}return result}},profiles)
  const result=await outbox.capture('worker',operation,'capture',{workspaceRoot:root,repositoryId:'repository'})
  if(loseReply){assert.equal(result.home_reconciled,false);await writeFile(join(root,'file.txt'),'changed after capture')}
  const aborted=new AbortController();aborted.abort(Error('fixture admission revoked'))
  await assert.rejects(outbox.awaitSettled('worker',operation,{signal:aborted.signal}),/admission revoked/)
  let checks=0;await outbox.awaitSettled('worker',operation,{assertOwner:async()=>{checks++}})
  assert.ok(checks>0)
  const settled=profiles.binding('worker').artifactOutbox[Object.keys(profiles.binding('worker').artifactOutbox)[0]]
  assert.equal(settled.home_reconciled,true,outbox.lastError?.error?.message)
  assert.equal(settled.home_archive_reconciled,true,outbox.lastError?.error?.message)
  assert.deepEqual(settled.evidence,result.evidence,'reconciliation never recaptures changed source')
  assert.equal((await hub.client.call('/api/v1/messaging/operations/'+op.id+'/events')).events.filter(e=>e.data.kind==='artifact_evidence').length,1)
  outbox.assertSettled('worker',operation)
  const reopened=await new BackendAgentProfiles(hub.client,join(hub.root,'unused.json')).open()
  assert.deepEqual(reopened.binding('worker').artifactOutbox,profiles.binding('worker').artifactOutbox)
 }finally{await outbox?.close();await hub.close()}
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentProfiles } from '../src/agent-profiles.js'
import { resumeCoordinator } from '../src/coordinator-resume.js'
test('ambiguous resume is durable and never blindly retried after profile reopen',async()=>{
 const root=await mkdtemp(join(tmpdir(),'kode-resume-')),path=join(root,'profiles.json')
 try{
  const profiles=await new AgentProfiles(path).open([{id:'profile',type:'dsh',name:'Coordinator'}]);await profiles.bind('session','profile')
  const operation={id:'new',attempt:1,epoch:1},coordinator={team_id:'team',conversation_id:'conversation',control_revision:2}
  await profiles.patchBinding('session',{managedOperation:operation,managedCoordinator:coordinator,coordinatorPredecessor:{operation:{id:'old',attempt:1,epoch:1}},operationClosed:false})
  const command={command_id:'resume',session_id:'session',operation,coordinator,profile_revision:profiles.binding('session').revision,provider:'provider',model:'model',effort:null,cwd:'/fixture',tools:[]}
  let calls=0
  const host={execution:{profiles},stop:new AbortController(),coordinatorResumes:new Map(),ctx:{get:()=>({open:async()=>({header:{id:'session',cwd:'/fixture'},close:async()=>{}})})},resume:async()=>{calls++;throw Error('resume result unknown')}}
  await assert.rejects(resumeCoordinator(host,command),/result unknown/)
  host.execution.profiles=await new AgentProfiles(path).open()
  const receipt=await resumeCoordinator(host,command)
  assert.equal(receipt.state,'uncertain');assert.equal(calls,1)
  await assert.rejects(resumeCoordinator(host,{...command,model:'changed'}),/identity conflict/)
  assert.equal(calls,1)
 }finally{await rm(root,{recursive:true,force:true})}
})

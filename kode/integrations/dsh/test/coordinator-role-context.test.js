import test from 'node:test'
import assert from 'node:assert/strict'
import {Session} from '@deepseek-ai/dsh-session'
import {mountCoordinatorContext,coordinatorPrompt} from '../src/coordinator-context.js'
import {assertCoordinatorRolePromptDurable} from '../src/coordinator-role-context.js'
import {promptProvenance} from '../src/prompt-provenance.js'
function fixture(){
 const scope={team_id:'team',conversation_id:'conversation',control_revision:1},op={id:'op',attempt:1,epoch:1},session=Session.create('worker')
 const binding={managedOperation:op,managedCoordinator:scope},control={home_hub:'home',team_id:'team',conversation_id:'conversation',revision:1,worker:{node_id:'home',session_id:'worker'},request:{operation_id:'op',attempt:1,epoch:1,team_revision:2}}
 const state={activation:{active:true,authority_valid:true,home_hub:'home',team_id:'team',team_revision:2,snapshot:{team:{id:'team',home_hub:'home',revision:2,spec:{coordinator_prompt:'ONLY_COORDINATOR',workers:[{id:'other',role_prompt:'FOREIGN_WORKER'}]}}}},control,flush:true},sections=[]
 const ctx={sessions:{flush:async()=>state.flush},get:()=>({section:row=>{sections.push(row);return()=>sections.splice(sections.indexOf(row),1)}})}
 const runtime={host:'home',profiles:{binding:()=>binding,patchBinding:async(_id,patch)=>Object.assign(binding,patch)},client:{call:async path=>structuredClone(path.endsWith('/activation')?state.activation:{control:state.control})}}
 return {ctx,runtime,scope,binding,state,sections,agent:{id:'worker',session,ctx}}
}
test('fixed procedure remains intact; exact Team role appends and prepared input is checked',async()=>{
 const f=fixture(),dispose=await mountCoordinatorContext(f.ctx,f.agent,f.runtime,f.scope)
 assert.equal(f.sections.find(s=>s.name==='kode.coordinator').text,coordinatorPrompt(f.scope))
 await assertCoordinatorRolePromptDurable(f.agent,f.runtime)
 const role=f.sections.find(s=>s.name==='kode.coordinator.role');assert.match(role.text,/ONLY_COORDINATOR/);assert.doesNotMatch(role.text,/FOREIGN_WORKER/)
 const messages=[{role:'system',content:f.sections.map(s=>s.text).join('\n')}]
 assert.equal(promptProvenance(f.binding,{messages}).instruction.role,'coordinator')
 assert.throws(()=>promptProvenance(f.binding,{messages:[{role:'system',content:coordinatorPrompt(f.scope)}]}),/role prompt missing/)
 dispose();assert.equal(f.sections.length,0)
})
test('repeat mount uses same durable snapshot; revision drift requires new context',async()=>{
 const f=fixture();(await mountCoordinatorContext(f.ctx,f.agent,f.runtime,f.scope))();(await mountCoordinatorContext(f.ctx,f.agent,f.runtime,f.scope))()
 assert.equal(f.agent.session.snapshotEvents().filter(e=>e.type==='plugin:kode/coordinator-role-prompt').length,1)
 f.state.activation.snapshot.team.spec.coordinator_prompt='changed'
 await assert.rejects(mountCoordinatorContext(f.ctx,f.agent,f.runtime,f.scope),/snapshot changed/)
})
test('wrong frozen revision, revoked activation and failed flush mount no prompt',async()=>{
 for(const change of [f=>f.state.activation.snapshot.team.revision=9,f=>f.state.activation.authority_valid=false]){
  const f=fixture();change(f);await assert.rejects(mountCoordinatorContext(f.ctx,f.agent,f.runtime,f.scope));assert.equal(f.sections.length,0)
 }
})
test('legacy missing role stays fixed-only and invents no default',async()=>{
 const f=fixture();delete f.state.activation.snapshot.team.spec.coordinator_prompt
 const dispose=await mountCoordinatorContext(f.ctx,f.agent,f.runtime,f.scope);assert.equal(f.sections.length,1);assert.equal(f.binding.coordinatorRolePrompt,null);dispose()
})

test('setup does not flush before factory enter; publication blocks failed durable flush',async()=>{
 const f=fixture();let calls=0;f.ctx.sessions.flush=async()=>{calls++;return false}
 const dispose=await mountCoordinatorContext(f.ctx,f.agent,f.runtime,f.scope);assert.equal(calls,0)
 await assert.rejects(assertCoordinatorRolePromptDurable(f.agent,f.runtime),/not durable/);assert.equal(calls,1);dispose()
})

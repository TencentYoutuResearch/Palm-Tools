import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareCapabilityUpdate, confirmCapabilityUpdate } from '../packages/collab/team-capability-update.js'
const profile={id:'profile',revision:1,host:'home',profile:'executor',model:'model',assessments:{fit:{evaluation:{kind:'task_fit',tag:'coding',score:50},source:'user',confidence:1,evidence:[],updated_at:1,valid_until:9999999999999,pinned:true}}}
const team={id:'team',home_hub:'home',revision:1,superagent_id:'super',conversation_id:'chat',spec:{scheduling_policy_id:'policy',execution_targets:[{id:'target',host_id:'home',executor_profile_id:'executor',model_id:'model',account_binding_id:'account',capability_profile_revision:'1'}]}}
const policy={id:'policy',home_hub:'home',team_id:'team',revision:1,policy:{kind:'scheduling',targets:{target:{resource:{host:'home',profile:'executor',account_id:'account'},capability_id:'profile',capability_revision:1,preferred:true}},weights:{quality:1}}}
const base={team,policy,profile,targetId:'target',assessments:{fit:{...profile.assessments.fit,evaluation:{kind:'task_fit',tag:'coding',score:80}}},replacePins:true,requestId:'request'}
const prepared=()=>prepareCapabilityUpdate(base)
function receipt(){const next=structuredClone(team),schedule=structuredClone(policy);next.revision=2;next.eligible_for_execution=false;next.spec.execution_targets[0].capability_profile_revision='2';schedule.revision=2;schedule.policy.targets.target.capability_revision=2;return {home_hub:'home',team_id:'team',request_id:'request',target_id:'target',activation_performed:false,eligible_for_execution:false,team:next,scheduling_policy:schedule,capability_profile:{...profile,revision:2,assessments:base.assessments}}}
function storage(){let row;return {read:()=>row,reserve:async(_,candidate)=>row??(row=structuredClone(candidate)),save:async(_,value)=>{row=structuredClone(value)}}}
test('capability confirmation preserves original update after lost reply and rejects changed pending input',async()=>{
 const s=storage(),bodies=[];let lost=true
 const request=async body=>{bodies.push(body);if(lost){lost=false;throw Error('lost')}return receipt()}
 await assert.rejects(confirmCapabilityUpdate({storage:s,prepared:prepared(),request}),/lost/)
 await assert.rejects(confirmCapabilityUpdate({storage:s,prepared:prepareCapabilityUpdate({...base,requestId:'new'}),request}),/original pending/)
 await confirmCapabilityUpdate({storage:s,prepared:structuredClone(s.read()),request})
 assert.deepEqual(bodies[0],bodies[1]);assert.equal(s.read().state,'accepted')
 await confirmCapabilityUpdate({storage:s,prepared:s.read(),request});assert.equal(bodies.length,2)
})
test('capability confirmation cannot acknowledge unrelated team or scheduling changes',async()=>{
 for(const mutate of [r=>r.team.spec.execution_targets.push({id:'other'}),r=>r.scheduling_policy.policy.targets.target.preferred=false,r=>r.activation_performed=true,r=>r.capability_profile.revision=3]){
  const s=storage();await assert.rejects(confirmCapabilityUpdate({storage:s,prepared:prepared(),request:async()=>{const r=receipt();mutate(r);return r}}),/receipt mismatch/)
  assert.equal(s.read().state,'prepared')
 }
})
test('fixed preference replacement and assessment provenance are explicit',()=>{
 assert.throws(()=>prepareCapabilityUpdate({...base,replacePins:false}),/fixed-preference/)
 assert.throws(()=>prepareCapabilityUpdate({...base,assessments:{fit:{source:'measured',pinned:true,score:80}}}),/provenance/)
 assert.throws(()=>prepareCapabilityUpdate({...base,profile:{...profile,revision:2}}),/context changed/)
})

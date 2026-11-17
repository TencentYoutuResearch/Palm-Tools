/** Pure in-memory control/profile fixtures; no Hub, persistence, credentials or inference. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { profileRevision } from '../src/agent-profiles.js'
import { prepareCoordinatorDispatch } from '../src/coordinator-preparation.js'
import { mountCoordinatorContext } from '../src/coordinator-context.js'
import { startCoordinator } from '../src/coordinator-start.js'
import { OFFICIAL_COORDINATOR_TOOLS } from '../src/official-coordinator-tools.js'

const v2 = {version:2,home_hub:'home',team_id:'team',kind:'team_private',scope_id:'private',context_epoch:1}
function fixture() {
  const profile={id:'profile',name:'Fixture',type:'dsh'}, revision=profileRevision(profile)
  const worker={node_id:'home',session_id:'session'}, operation={id:'op',attempt:1,epoch:1}
  const coordinator={team_id:'team',conversation_id:'conversation',control_revision:1}
  const control={team_id:'team',home_hub:'home',revision:1,conversation_id:'conversation',worker,
    request:{operation_id:'op',attempt:1,epoch:1,target_id:'target',activation_revision:1,team_revision:1}}
  const op={...operation,revision:1,state:'prepared',worker,budget_required:true,budget_available:true,
    grant_required:true,grant_available:true,resource_required:true,resource_available:true,resource:{profile:'profile'},
    selection_policy:{profile_revision:revision,model:'model',effort:null,scope:'executor_configuration'}}
  const activation={active:true,authority_valid:true,revision:1,home_hub:'home',team_id:'team',team_revision:1,snapshot:{team:{id:'team',home_hub:'home',revision:1,spec:{execution_targets:[{id:'target',provider_id:'fixture',executor_profile_id:'profile'}]}}}}
  const grant_scope={team_id:'team',target:{host:'home',workspace:'workspace',root:'/fixture'},capabilities:['read','delegate'],tools:[...OFFICIAL_COORDINATOR_TOOLS]}
  const state={profiles:[profile],bindings:{}}, calls=[]
  const runtime={host:'home',profiles:{get:()=>profile,binding:id=>state.bindings[id],update:async fn=>fn(state),patchBinding:async(id,patch)=>Object.assign(state.bindings[id],patch)},
    ctx:{get:name=>name==='workspaceRegistry'?{list:()=>[{id:'workspace',path:'/fixture'}]}:undefined,llm:{resolveCallConfig:async config=>config}},
    client:{call:async path=>{calls.push(path)
      if(path.endsWith('/coordinator-control'))return {control}
      if(path.endsWith('/activation'))return activation
      if(path.endsWith('/operations/op'))return op
      if(path.endsWith('/grant'))return {available:true,binding:{scope:grant_scope}}
      if(path.includes('/budget?'))return {price:{},reservation:{held:1}}
      if(path.endsWith('/coordinator-starts'))return {bundle:{operation:op},control}
      throw Error('Unexpected fixture call '+path)
    }}}
  const input={command_id:'create',team_id:'team',control_revision:1,operation_revision:1,profile_id:'profile',provider:'fixture'}
  return {runtime,state,calls,control,op,operation,coordinator,input,grant_scope}
}

test('legacy preparation remains idempotent and labels only newly created bindings',async()=>{
  const f=fixture(), first=await prepareCoordinatorDispatch(f.runtime,f.input)
  assert.deepEqual(first.coordinator,f.coordinator)
  assert.equal(f.state.bindings.session.contextIsolation,'legacy_shared')
  assert.deepEqual(await prepareCoordinatorDispatch(f.runtime,f.input),first)
  delete f.state.bindings.session.contextIsolation
  await prepareCoordinatorDispatch(f.runtime,f.input)
  assert.equal(Object.hasOwn(f.state.bindings.session,'contextIsolation'),false,'existing binding is not migrated')
})

for(const location of ['control','request','operation','prior'])test(`preparation rejects authoritative v2 ${location} before creating a binding`,async()=>{
  const f=fixture()
  if(location==='control')f.control.context_scope=v2
  if(location==='request')f.control.request.context_scope=v2
  if(location==='operation')f.op.context_scope=v2
  if(location==='prior')f.state.bindings.session={managedCoordinator:{...f.coordinator,context_scope:v2}}
  const before=structuredClone(f.state.bindings)
  await assert.rejects(prepareCoordinatorDispatch(f.runtime,f.input),{code:'CONTEXT_SCOPE_UNSUPPORTED'})
  assert.deepEqual(f.state.bindings,before)
})

test('legacy mount requires exact control and never mounts v2 control prompt',async()=>{
  const f=fixture(); await prepareCoordinatorDispatch(f.runtime,f.input)
  const sections=[],ctx={get:()=>({section:value=>{sections.push(value);return ()=>{}}})}
  await mountCoordinatorContext(ctx,{id:'session',session:Session.create('session')},f.runtime,f.coordinator)
  assert.equal(sections.length,1)
  f.control.context_scope=v2
  await assert.rejects(mountCoordinatorContext(ctx,{id:'session'},f.runtime,f.coordinator),{code:'CONTEXT_SCOPE_UNSUPPORTED'})
  assert.equal(sections.length,1)
})

test('legacy start preserves prepared command and v2 Hub control cannot dispatch',async()=>{
  const f=fixture(),dispatches=[]
  const host={execution:f.runtime,stop:new AbortController(),coordinatorStarts:new Map(),
    dispatches:{get:()=>null,dispatch:async command=>{dispatches.push(command);return {state:'created'}}},
    prepareCoordinator:input=>prepareCoordinatorDispatch(f.runtime,input)}
  const input={command_id:'create',team_id:'team',provider:'fixture',start:{request_id:'start',operation:{worker:f.control.worker,resource:f.op.resource,grant_scope:f.grant_scope}}}
  assert.deepEqual(await startCoordinator(host,input),{state:'created'})
  assert.deepEqual(dispatches[0].coordinator,f.coordinator)
  f.control.context_scope=v2
  await assert.rejects(startCoordinator(host,input),{code:'CONTEXT_SCOPE_UNSUPPORTED'})
  assert.equal(dispatches.length,1)
})

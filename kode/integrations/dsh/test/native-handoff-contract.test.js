import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { normalizeProfile, profileRevision } from '../src/agent-profiles.js'
import { prepareNativeHandoff, validateFrozenNativeHandoff, assertOrdinaryHandoffSource } from '../src/native-handoff-contract.js'
import { RuntimeBridge } from '../src/runtime-bridge.js'
import { registerAgentHubApi } from '../src/agent-hub-api.js'
import { Readable } from 'node:stream'
import { Session } from '@deepseek-ai/dsh-session'

function fixture() {
 const profile = normalizeProfile({ id:'native-tclaude', name:'tclaude', type:'claude', executable:'/fixture/tclaude', env:{PRIVATE_FIXTURE:'not-to-export'} })
 const source = { profile:normalizeProfile({id:'source',name:'Source',type:'codex'}) }, rows=[{sessionId:'source',cwd:tmpdir(),blank:false}], agents=new Map()
 let model='first', creates=0, inputs=0
 const selections=[], services={
  agents:{get:id=>agents.get(id)},
  kodeAgents:{ profiles:{list:()=>[profile],binding:id=>id==='source'?source:undefined,defaultModelFor:()=>({model,reasoningEffort:'high',fast:true}),bind:async()=>{}},hasRuntime:()=>true,recordBinding(){},adapter:{listModels:async()=>['first','second'].map(id=>({id,reasoningEfforts:[{id:'high'}],defaultReasoningEffort:'high',fastCapability:{transport:'config-option',defaultEnabled:false}}))}},
  workspaceRegistry:{resolveByPath:async()=>({id:'workspace'})},
  sessionController:{list:async()=>({items:rows}),create:async({sessionId})=>{creates++;rows.push({sessionId,cwd:tmpdir(),blank:true});agents.set(sessionId,{id:sessionId,status:'idle',session:{header:{cwd:tmpdir()},snapshotEvents:()=>[],append(){}},selectModel:selection=>selections.push(selection),ctx:{sessions:{flush:async()=>{}}}});return{sessionId}},resolveAgent:async id=>({agent:agents.get(id)}),prompt:async()=>{inputs++}},
 }
 const bridge=new RuntimeBridge({get:key=>services[key]},{call:async()=>({sessions:[]})})
 bridge.publish=async()=>{}
 return {profile,source,rows,agents,services,bridge,selections,setDefault:value=>{model=value},counts:()=>({creates,inputs})}
}
test('native handoff prepares canonical identity and selection without exporting CLI configuration or creating a session',async()=>{
 const f=fixture(),prepared=await prepareNativeHandoff(f.bridge,{profile_id:f.profile.id,source_session_id:'source'})
 assert.deepEqual(prepared,{profile_id:f.profile.id,profile_revision:profileRevision(f.profile),selection:{model:'first',reasoningEffort:'high',fast:true}})
 assert.deepEqual(f.counts(),{creates:0,inputs:0})
 assert.ok(!JSON.stringify(prepared).includes('PRIVATE_FIXTURE'))
 f.setDefault('second')
 const result=await validateFrozenNativeHandoff(f.bridge,{profile_revision:prepared.profile_revision,selection:prepared.selection,handoff_source_session_id:'source'},f.profile)
 assert.equal(result.selection.model,'first','later defaults cannot alter prepared selection')
})
test('managed/scoped/unconfirmed/active sources are fenced before discovery or publication',async()=>{
 for(const patch of [{managedOperation:{}},{managedBuilder:{}},{managedCoordinator:{}},{managedAssignment:{}},{context_scope:{}},{contextIsolation:'scoped_v2'}]){
  const f=fixture();Object.assign(f.source,patch)
  f.services.kodeAgents.adapter.listModels=()=>assert.fail('must not discover')
  await assert.rejects(prepareNativeHandoff(f.bridge,{profile_id:f.profile.id,source_session_id:'source'}),{code:'MANAGED_HANDOFF_REQUIRED'})
  assert.deepEqual(f.counts(),{creates:0,inputs:0})
 }
 const f=fixture();f.agents.set('source',{status:'running'})
 await assert.rejects(prepareNativeHandoff(f.bridge,{profile_id:f.profile.id,source_session_id:'source'}),{code:'HANDOFF_SOURCE_BUSY'})
 assert.throws(()=>assertOrdinaryHandoffSource({binding:()=>undefined},'source'),{code:'HANDOFF_SOURCE_UNCONFIRMED'})
})
test('invalid explicit model, effort, Fast and changed profile all reject before native session creation',async()=>{
 const f=fixture()
 for(const selection of [{model:'missing'},{model:'first',reasoningEffort:'unknown'},{model:'first',fast:'true'},{model:'first',permission:'never'}])await assert.rejects(prepareNativeHandoff(f.bridge,{profile_id:f.profile.id,selection}))
 const prepared=await prepareNativeHandoff(f.bridge,{profile_id:f.profile.id})
 f.profile.executable='/fixture/changed'
 await assert.rejects(f.bridge.execute({id:'handoff:fixed:create',kind:'create_session',payload:{cwd:tmpdir(),backend_key:'dsh:'+f.profile.id,profile_revision:prepared.profile_revision,selection:prepared.selection}}),/revision changed/)
 assert.equal(f.counts().creates,0)
})
test('existing create_session consumes frozen native selection and promotes the same real session identity',async()=>{
 const f=fixture(),prepared=await prepareNativeHandoff(f.bridge,{profile_id:f.profile.id,selection:{model:'first',reasoningEffort:'high',fast:false}})
 f.setDefault('second')
 // Use an ordinary non-Fast fixture to keep this test independent of plugin-record internals.
 delete prepared.selection.fast
 f.services.kodeAgents.adapter.listModels=async()=>[{id:'first',reasoningEfforts:[{id:'high'}],defaultReasoningEffort:'high'}]
 f.bridge.publish=async()=>{for(const row of f.rows)f.bridge.ids.set(row.sessionId,10)}
 const result=await f.bridge.execute({id:'handoff:fixed:create',kind:'create_session',payload:{cwd:tmpdir(),backend_key:'dsh:'+f.profile.id,profile_revision:prepared.profile_revision,selection:prepared.selection,handoff_source_session_id:'source'}})
 assert.equal(f.counts().creates,1)
 assert.deepEqual(f.selections,[{provider:'kode-agent-native-tclaude',model:'first',reasoningEffort:'high'}])
 assert.match(result.runtime_session_id,/^mobile-/)
 assert.equal(f.counts().inputs,0,'creation does not submit the transcript itself')
})
test('existing owner handoff route forwards independent selection and refuses managed sources before side effects',async()=>{
 const f=fixture(),calls=[];let handler,published=0
 const ctx={get:key=>key==='kodeRuntimeBridge'?{publish:async()=>{published++}}:f.services[key],connection:{admit:req=>({peer:{principal:{kind:req.owner?'owner':'guest'}}})},webServer:{register:route=>{handler=route.handler;return()=>{}}}}
 registerAgentHubApi(ctx,{hub:{},service:f.services.kodeAgents,backend:{call:async(path,body)=>{calls.push({path,body});return{sessionId:'created'}}}})
 const request=async(body,owner=true)=>{const req=Readable.from([JSON.stringify(body)]);req.method='POST';req.url='/api/kode/agent-hub';req.headers={'content-type':'application/json'};req.owner=owner;const res={setHeader(){},end(value){this.value=JSON.parse(value)}};await handler(req,res);return res}
 const input={action:'handoff',sessionId:'source',profileId:'native-tclaude',requestId:'request',selection:{model:'first',reasoningEffort:'high',fast:false}}
 assert.equal((await request(input,false)).statusCode,403)
 assert.equal((await request(input)).statusCode,200)
 assert.deepEqual(calls[0].body.selection,input.selection)
 f.source.managedOperation={id:'managed'}
 const denied=await request(input);assert.equal(denied.statusCode,409);assert.equal(denied.value.code,'MANAGED_HANDOFF_REQUIRED')
 assert.equal(calls.length,1);assert.equal(published,1)
})

test('late source ownership change is checked again at original input delivery, not only a stale publication',async()=>{
 const f=fixture();f.source.managedCoordinator={team_id:'team'}
 await assert.rejects(f.bridge.execute({id:'handoff:late:input',kind:'input',session_id:'target',payload:{text:'Transferred context',handoff_source_session_id:'source'}}),{code:'MANAGED_HANDOFF_REQUIRED'})
 assert.equal(f.counts().inputs,0)
})


test('frozen Fast service-tier choice reaches the original native Session record and retry keeps identity',async()=>{
 const f=fixture()
 f.services.kodeAgents.adapter.listModels=async()=>['first','second'].map(id=>({id,reasoningEfforts:[{id:'high'}],defaultReasoningEffort:'high',fastCapability:{transport:'service-tier',tier:'priority',defaultEnabled:false}}))
 const prepared=await prepareNativeHandoff(f.bridge,{profile_id:f.profile.id,selection:{model:'first',reasoningEffort:'high',fast:true}})
 const create=f.services.sessionController.create
 f.services.sessionController.create=async(args)=>{const result=await create(args);const initial=Session.create(args.sessionId);f.agents.get(args.sessionId).session=Session.create(args.sessionId,[],{...initial.header,cwd:tmpdir()});return result}
 f.bridge.publish=async()=>{for(const row of f.rows)f.bridge.ids.set(row.sessionId,10)}
 const command={id:'handoff:frozen-fast:create',kind:'create_session',payload:{cwd:tmpdir(),backend_key:'dsh:'+f.profile.id,profile_revision:prepared.profile_revision,selection:prepared.selection,handoff_source_session_id:'source'}}
 const result=await f.bridge.execute(command)
 f.setDefault('second')
 assert.deepEqual(await f.bridge.execute(command),result)
 assert.equal(f.counts().creates,1)
 const fast=f.agents.get(result.runtime_session_id).session.snapshotEvents().filter(event=>event.type==='plugin:kode/model-fast')
 assert.ok(fast.length>0);assert.ok(fast.every(event=>event.data.fast===true&&event.data.serviceTier==='priority'))
 assert.ok(f.selections.every(selection=>selection.model==='first'&&selection.reasoningEffort==='high'))
})

test('inactive Agent cache cannot hide published running state or scoped journal source',()=>{
 const f=fixture()
 for(const row of [{running:true},{busy:true},{status:'running'},{status:'busy'}])assert.throws(()=>assertOrdinaryHandoffSource(f.services.kodeAgents.profiles,'source',undefined,row),{code:'HANDOFF_SOURCE_BUSY'})
 for(const type of ['plugin:kode/scoped-builder-journal','plugin:kode/scoped-coordinator-journal'])assert.throws(()=>assertOrdinaryHandoffSource(f.services.kodeAgents.profiles,'source',{status:'idle',session:{snapshotEvents:()=>[{type}]}},{}),{code:'MANAGED_HANDOFF_REQUIRED'})
})

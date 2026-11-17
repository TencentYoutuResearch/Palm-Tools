import test from 'node:test'
import assert from 'node:assert/strict'
import {Session,appendPluginRecord} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {contextScopeKey,discussionScopeId} from '../src/context-scope.js'
import {validatePublicManifest,bindPublicManifest,publicTextHash,canonicalManifestHash} from '../src/scoped-coordinator-prompt.js'
import {createScopedConversationCallProof} from '../src/scoped-conversation-call-proof.js'
function fixture(kind='discussion_thread'){
  const context_scope={version:2,home_hub:'home',team_id:'team',kind,scope_id:discussionScopeId('surface','thread'),context_epoch:1}
  const key=contextScopeKey(context_scope),session=Session.create(`context-${key}`),worker={node_id:'home',session_id:session.id}
  const authority={context_scope,context_key:key,session_id:session.id,journal_id:'journal',operation_id:'op',attempt:1,epoch:1,worker,origin:{host_id:'home'}}
  const entry={id:'entry',claim_id:'claim',state:'claimed',context_key:key,journal_id:'journal',operation_id:'op',source_message_id:'source',source_content_sha256:publicTextHash('SOURCE_A')}
  const claim={authority,entry,message:{id:'source',content:'SOURCE_A'}}
  appendPluginRecord(session,'plugin:kode/scoped-coordinator-journal',{version:1,authority:{context_scope,session_id:session.id,journal_id:'journal'},header:{...session.header,delegationDepth:0}})
  const publicManifest=validatePublicManifest({version:1,context_key:key,procedure:{text:'PUBLIC',sha256:publicTextHash('PUBLIC')},shared:[],tools:[]},key)
  bindPublicManifest(session,publicManifest,'fresh')
  const user=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'SOURCE_A'}]})
  appendPluginRecord(session,'plugin:kode/scoped-local-input',{version:1,context_key:key,input_id:'source',content_sha256:entry.source_content_sha256,message_id:user.id,execution_authorized:false,claim:{authority,entry}})
  session.append('turn/start',{turn:1});session.append('step/start',{turn:1,step:1})
  session.append('user/message',user,{surfaceOp:'append'})
  const route={provider:'fixture',model:'model'}
  session.append('request/header',{reason:'initial',header:{config:route}})
  const manifest={profile:'conversation_reply_v1',version:1,tools:[]}
  const hostBinding={binding_id:'binding',revision:1,state:'bound_not_admitted',context_key:key,claim_allowed:false,execution_authorized:false,runtime_ready:false,
    frozen:{context:{key,context_scope},control:{context_key:key,context_scope,journal_id:'journal',request:{operation_id:'op'}},
      operation:{id:'op',attempt:1,epoch:1,worker},enrollment:{revoked:false,home:'home',host_id:'home'},manifest,manifest_sha256:canonicalManifestHash(manifest)}}
  const options={session,authority,claim,publicManifest,hostBinding,assertOwned:async()=>{},flush:async()=>true}
  const request=()=>({...route,sessionId:session.id,messages:session.deriveMessages(),toolHistory:session.toolHistory(),tools:[]})
  return {options,request,session,run:()=>createScopedConversationCallProof(options).prove(request())}
}
test('actual Session and exact source produce only strict hashes/identity DTO',async()=>{
  const f=fixture(),proof=await f.run()
  assert.equal(proof.scoped_call.entry_id,'entry');assert.equal(proof.scoped_call.host_binding_id,'binding')
  assert.equal(Object.keys(proof.scoped_call).length,13)
  assert.equal(proof.scoped_call.request_sha256,proof.request_sha256)
  assert.doesNotMatch(JSON.stringify(proof),/SOURCE_A|PUBLIC/)
})
test('private scope has a complete independent proof; same text cannot substitute a discussion journal',async()=>{
  const dm=fixture('team_private'),thread=fixture(),privateProof=await dm.run(),threadProof=await thread.run()
  assert.notEqual(privateProof.scoped_call.context_key,threadProof.scoped_call.context_key)
  assert.notEqual(privateProof.request_sha256,threadProof.request_sha256)
  await assert.rejects(createScopedConversationCallProof(dm.options).prove(thread.request()))
  await assert.rejects(createScopedConversationCallProof({...dm.options,session:thread.session}).prove(dm.request()))
  await assert.rejects(fixture('builder_draft').run())
})
test('cross-scope, stale epoch, foreign journal and Host binding reject',async()=>{
  for(const mutate of [f=>f.options.authority.context_scope.context_epoch=2,f=>f.options.authority.journal_id='old',
    f=>f.options.hostBinding.frozen.context.context_scope={...f.options.authority.context_scope,team_id:'other'},
    f=>f.options.hostBinding.frozen.enrollment.revoked=true,f=>f.options.claim.entry.claim_id='other']){
    const f=fixture();mutate(f);await assert.rejects(async()=>f.run())
  }
})
test('external history, unreceipted user and tool injection cannot be attested',async()=>{
  for(const patch of [{tools:[{name:'foreign'}]},{toolHistory:{tools:[{name:'private'}],updates:[]}},
    {messages:[{role:'user',content:'PRIVATE'}]},{sessionId:'foreign'}]){
    const f=fixture();await assert.rejects(createScopedConversationCallProof(f.options).prove({...f.request(),...patch}))
  }
  const f=fixture();f.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'PRIVATE'}]}),{surfaceOp:'append'})
  await assert.rejects(f.run(),/Unreceipted/)
})
test('actual journal mutation/revocation during durability denies proof',async()=>{
  const f=fixture();f.options.flush=async()=>{appendPluginRecord(f.session,'plugin:mutation',{});return true}
  await assert.rejects(f.run(),/changed during/)
  const g=fixture();let checks=0;g.options.assertOwned=async()=>{if(++checks===2)throw Error('revoked')}
  await assert.rejects(g.run(),/revoked/)
  const h=fixture();h.options.flush=async()=>false;await assert.rejects(h.run(),/durability/)
})

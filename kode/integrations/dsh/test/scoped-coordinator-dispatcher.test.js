import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createScopedCoordinatorRoot} from '../src/scoped-coordinator-root.js'
import {publicTextHash,canonicalManifestHash} from '../src/scoped-coordinator-prompt.js'
import {conversationRequestEvidence} from '../src/scoped-conversation-request.js'
import {createScopedCoordinatorModel} from '../src/scoped-coordinator-model.js'
import {createScopedCoordinatorDispatcher} from '../src/scoped-coordinator-dispatcher.js'
import {contextScopeKey,discussionScopeId} from '../src/context-scope.js'
function fixture(){
  const scope={version:2,home_hub:'home',team_id:'team',kind:'discussion_thread',scope_id:discussionScopeId('surface','thread'),context_epoch:1}
  const key=contextScopeKey(scope),worker={node_id:'home',session_id:`context-${key}`}
  const origin={home_hub:'home',host_id:'home',workspace_id:'workspace',root_ref:'root'}
  const authority={context_key:key,context_scope:scope,journal_id:'generation',session_id:worker.session_id,worker,origin,
    operation_id:'operation',operation_revision:1,attempt:1,epoch:1,control_revision:1,team_revision:1,audience_revision:1}
  const flags={runtime_ready:true,dispatch_allowed:true,stage:'runtime'}
  const message={id:'source',surface_id:'surface',thread_id:'thread',kind:'discussion',actor:{kind:'human',id:'local_owner'},scope:origin,content:'ONLY_THIS_SCOPE'}
  const entry={id:'entry',context_key:key,revision:2,reply:null,state:'claimed',claim_id:'claim',operation_id:'operation',journal_id:'generation',worker,
    operation_revision:1,operation_attempt:1,operation_epoch:1,control_revision:1,source_message_id:'source',
    source_content_sha256:createHash('sha256').update(message.content).digest('hex')}
  const envelope={...flags,authority},claim={...envelope,new_claim:true,receipt:{entry},message}
  const calls={claim:0,followup:[],finish:[]}
  const backend={authority:async()=>structuredClone(envelope),claim:async()=>{calls.claim++;return structuredClone(claim)},
    finish:async(_key,value)=>{calls.finish.push(value);return {...structuredClone(envelope),entry:{...structuredClone(entry),revision:entry.revision+1,state:value.outcome,reply:value.reply}}}}
  const root={followupClaim:async(k,claim)=>{calls.followup.push([k,{inputId:claim.message.id,text:claim.message.content}]);return {state:'completed',finalText:'Local result'}}}
  return {key,envelope,claim,calls,backend,root,run:()=>createScopedCoordinatorDispatcher({backend,root}).deliver(key,{entry_id:'entry',request_id:'request'})}
}
test('prepared-only authoritative backend refuses before claim or model input',async()=>{
  const f=fixture();Object.assign(f.envelope,{runtime_ready:false,dispatch_allowed:false,stage:'prepared_only'})
  await assert.rejects(f.run(),/not ready/);assert.equal(f.calls.claim,0);assert.deepEqual(f.calls.followup,[])
})
test('exact claim sends only its source and records local outcome without publication claim',async()=>{
  const f=fixture(),result=await f.run()
  assert.deepEqual(f.calls.followup,[[f.key,{inputId:'source',text:'ONLY_THIS_SCOPE'}]])
  assert.equal(result.publication_confirmed,false);assert.equal(f.calls.finish[0].outcome,'completed')
})
test('idempotent claim read never redelivers source',async()=>{
  const f=fixture();f.claim.new_claim=false;delete f.claim.message
  assert.equal((await f.run()).state,'already_claimed');assert.equal(f.calls.followup.length,0)
})
test('foreign scope, content, operation or source rejected before root',async()=>{
  for(const mutate of [f=>f.claim.message.thread_id='other',f=>f.claim.message.content='PRIVATE',
    f=>f.claim.receipt.entry.operation_attempt=2,f=>f.claim.authority.journal_id='foreign',
    f=>f.claim.message.actor.id='someone_else']){
    const f=fixture();mutate(f);await assert.rejects(f.run());assert.equal(f.calls.followup.length,0)
  }
})
test('authority revoked after claim records uncertain and never delivers',async()=>{
  const f=fixture();let reads=0
  f.backend.authority=async()=>({...structuredClone(f.envelope),runtime_ready:++reads===1})
  await assert.rejects(f.run(),/revoked/);assert.equal(f.calls.followup.length,0);assert.equal(f.calls.finish[0].outcome,'uncertain')
})
test('root failure records uncertain once; failed reconciliation stays explicit',async()=>{
  const f=fixture();f.root.followupClaim=async()=>{throw Error('stream failed')}
  await assert.rejects(f.run(),/stream failed/);assert.equal(f.calls.finish.length,1);assert.equal(f.calls.finish[0].reply,null)
  f.backend.finish=async()=>{throw Error('revoked')}
  await assert.rejects(f.run(),AggregateError)
})
test('unconfirmed uncertain receipt remains typed reconciliation required',async()=>{
  const f=fixture();f.root.followupClaim=async()=>{throw Error('partial stream')}
  f.backend.finish=async()=>({entry:{state:'uncertain'}})
  await assert.rejects(f.run(),error=>error instanceof AggregateError&&error.code==='SCOPED_OUTCOME_UNCERTAIN'&&error.reconciliation_required===true)
})
test('uncertain finish transport outcome is not retried or overwritten',async()=>{
  const f=fixture();f.backend.finish=async()=>{f.calls.finish.push('attempt');throw Error('response lost')}
  await assert.rejects(f.run(),/response lost/);assert.equal(f.calls.finish.length,1)
})
test('command snapshot cannot change across authority await',async()=>{
  const f=fixture(),original=f.backend.authority
  const command={entry_id:'entry',request_id:'request'}
  f.backend.authority=async()=>{command.entry_id='foreign';command.request_id='foreign';return original()}
  const result=await createScopedCoordinatorDispatcher(f).deliver(f.key,command)
  assert.equal(result.entry_id,'entry');assert.equal(f.calls.finish[0].request_id,'finish:request')
})
test('foreign or unready terminal receipt never reports completion',async()=>{
  for(const response of [{runtime_ready:false},{entry:{state:'completed',context_key:'foreign'}}]){
    const f=fixture();f.backend.finish=async()=>response
    await assert.rejects(f.run(),error=>error.code==='SCOPED_OUTCOME_UNCERTAIN'&&error.reconciliation_required)
  }
})
test('lost claim response is uncertain and never invokes root',async()=>{
  const f=fixture();f.backend.claim=async()=>{throw Error('response lost')}
  await assert.rejects(f.run(),error=>error.code==='SCOPED_OUTCOME_UNCERTAIN'&&error.request_id==='request')
  assert.equal(f.calls.followup.length,0);assert.equal(f.calls.finish.length,0)
})
test('busy context cannot dispatch concurrently',async()=>{
  const f=fixture();let release
  f.root.followupClaim=()=>new Promise(resolve=>{release=()=>resolve({state:'completed',finalText:'done'})})
  const dispatcher=createScopedCoordinatorDispatcher(f),command={entry_id:'entry',request_id:'request'}
  const first=dispatcher.deliver(f.key,command)
  while(!release)await new Promise(resolve=>setImmediate(resolve))
  await assert.rejects(dispatcher.deliver(f.key,command),/already active/)
  release();await first
})
test('local claim fixture reaches independent real factory, journal and strict model boundary',async t=>{
  const f=fixture(),directory=await mkdtemp(join(tmpdir(),'kode-dispatch-slice-')),requests=[]
  const a=f.envelope.authority,procedure='EXPLICIT_PUBLIC_PROCEDURE'
  const evidence=[],route={provider:'fixture',model:'local'}
  const catalog={profile:'conversation_reply_v1',version:1,tools:[]},callProofs=[]
  const hostBinding={binding_id:'host-binding',revision:1,state:'bound_not_admitted',context_key:f.key,
    claim_allowed:false,execution_authorized:false,runtime_ready:false,
    frozen:{context:{key:f.key,context_scope:a.context_scope},
      control:{context_key:f.key,journal_id:a.journal_id,context_scope:a.context_scope,request:{operation_id:a.operation_id}},
      operation:{id:a.operation_id,attempt:a.attempt,epoch:a.epoch,worker:a.worker},
      enrollment:{home:'home',host_id:'home',revoked:false},manifest:catalog,manifest_sha256:canonicalManifestHash(catalog)}}
  const modelBridge=createScopedCoordinatorModel({authority:a,resolveAuthority:()=>structuredClone(f.envelope),
    acquirePermit:async()=>({authority:a,route,lease:{signal:new AbortController().signal,assertActive:async()=>{}},
      policy:{callId:'slice-call',admit:async()=>evidence.push('admitted'),record:async e=>evidence.push(e.kind)}}),
    dispatch:async function*(request){requests.push(request)
      yield{type:'block-start',index:0,blockType:'text'}
      yield{type:'block-end',index:0,block:{type:'text',text:'LOCAL_SLICE_RESULT'}}
      yield{type:'finish',reason:{kind:'stop'}}}})
  const root=await createScopedCoordinatorRoot({persistenceRoot:directory,modelRoute:{provider:'fixture',model:'local'},
    resolveAuthority:()=>({context_scope:a.context_scope,session_id:a.session_id,journal_id:a.journal_id}),
    resolveClaimAuthority:()=>structuredClone({...f.envelope,entry:f.claim.receipt.entry,message:f.claim.message}),
    resolveHostBinding:()=>structuredClone(hostBinding),
    resolvePublicManifest:()=>({version:1,context_key:f.key,procedure:{text:procedure,sha256:publicTextHash(procedure)},shared:[],tools:[]}),
    dispatch:(request,proof)=>{callProofs.push(proof);return modelBridge(request)}})
  t.after(async()=>{await root.close();await rm(directory,{recursive:true,force:true})})
  await root.create(f.key)
  const result=await createScopedCoordinatorDispatcher({backend:f.backend,root}).deliver(f.key,{entry_id:'entry',request_id:'local-slice'})
  assert.equal(result.state,'completed');assert.equal(result.publication_confirmed,false)
  assert.equal(requests.length,1);assert.equal(requests[0].sessionId,a.session_id)
  assert.deepEqual(requests[0].tools,[])
  assert.match(JSON.stringify(requests[0].messages),/ONLY_THIS_SCOPE/)
  assert.match(JSON.stringify(requests[0].messages),/EXPLICIT_PUBLIC_PROCEDURE/)
  assert.equal(f.calls.finish[0].reply,'LOCAL_SLICE_RESULT')
  assert.deepEqual(evidence,['admitted','started','finished'])
  assert.equal(callProofs.length,1);assert.equal(callProofs[0].scoped_call.entry_id,'entry')
  assert.equal(callProofs[0].scoped_call.source_message_id,'source')
  assert.equal(callProofs[0].scoped_call.request_sha256,conversationRequestEvidence(requests[0],{sessionId:a.session_id,route}).request_sha256)
  assert.equal(Object.hasOwn(requests[0],'scoped_call'),false)
})

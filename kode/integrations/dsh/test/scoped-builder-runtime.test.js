/** Mock ledger/provider only. Actual Cordis roots, AgentLoop, JSONL, lease,
 * selection and official call outboxes. No credential, live worker or model use.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,readdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime,{LlmAdapter} from '@deepseek-ai/dsh-llm'
import {builderContextKey,validateBuilderContext,validateBuilderAuthority} from '../src/builder-context-scope.js'
import {createScopedBuilderRoot,BUILDER_JOURNAL_RECORD} from '../src/scoped-builder-root.js'
import {builderPublicManifest} from '../src/scoped-builder-manifest.js'
import {BUILDER_INPUT_RECORD} from '../src/scoped-builder-input.js'
import {openScopedBuilderProfiles} from '../src/scoped-builder-profiles.js'
import {createScopedBuilderModel,createIndependentBuilderProvider} from '../src/scoped-builder-model.js'
import {acquireOperationLease} from '../src/operation-lease.js'
import {OfficialCallOutbox} from '../src/official-call-outbox.js'
import {SelectionOutbox} from '../src/selection-outbox.js'
const route={provider:'local-fixture',model:'fixture'}
function authority(name='draft-A',epoch=1){
  const builder_context={version:1,kind:'builder_draft',home_hub:'fixture',draft_id:name,context_epoch:epoch}
  const context_key=builderContextKey(builder_context)
  return {builder_context,context_key,session_id:`builder-context-${context_key}`,journal_id:`journal-${name}`,operation:{id:`op-${name}`,attempt:1,epoch:1}}
}
const source=(a,id='input')=>({request:{request_id:id,draft_id:a.builder_context.draft_id,...{attempt:a.operation.attempt,epoch:a.operation.epoch},content:`ONLY_${a.builder_context.draft_id}_${id}`},
  receipt:{operation_id:a.operation.id,message_id:`message-${id}`,worker:{node_id:a.builder_context.home_hub,session_id:a.session_id},home_hub:a.builder_context.home_hub,actor:{kind:'human',id:'local_owner'},state:'queued',created_at:1}})
const tool={name:'kode_builder_read_draft',description:'Only the fixed draft',parameters:{type:'object',properties:{},required:[],additionalProperties:false}}
async function fixture(t,mode='normal',a=authority()){
  const dir=await mkdtemp(join(tmpdir(),'kode-builder-context-')),file=join(dir,'accounting.json'),key=a.context_key,session=a.session_id,operation=a.operation
  const selectionPolicy={scope:'executor_configuration',profile_revision:1,model:'fixture',effort:null}
  const worker={node_id:'fixture',session_id:session,grant_enforcement:true}
  const state={row:{...operation,worker,revision:1,state:'prepared',selection_policy:selectionPolicy,grant_required:true,grant_available:true,
    budget_required:true,budget_available:mode!=='budget',lease_duration_ms:30000},provider:0,parentHooks:0,calls:new Map(),commands:[],toolCalls:[],sources:new Map(),captures:[],ready:true}
  const options={path:file,authority:a,binding:{revision:1,managedOperation:operation}}
  let profiles=await openScopedBuilderProfiles({...options,mode:'fresh'})
  const client={async call(path,body){
    if(path===`/api/v1/messaging/operations/${operation.id}`){
      if(!body)return structuredClone(state.row)
      assert.equal(body.attempt,1);assert.equal(body.epoch,1);assert.equal(body.expected_revision,state.row.revision)
      state.commands.push(body.action.kind)
      if(body.action.kind!=='report'){assert.deepEqual(body.selection_ack,selectionPolicy);if(!state.row.budget_available)throw Error('fixture budget denied')}
      state.row={...state.row,revision:state.row.revision+1,state:body.action.kind==='report'?'reported':'active'}
      return {applied:true,operation:structuredClone(state.row)}
    }
    if(path==='/api/v1/messaging/selection-evidence')return {sequence:1,rejected:body.model.observed!=='fixture',evidence:structuredClone(body)}
    if(path==='/api/v1/messaging/official-calls'){
      assert.equal(body.worker_session,session);assert.equal(body.operation_id,operation.id);assert.equal(state.row.state,'active')
      assert.equal(state.calls.has(body.call_id),false)
      const call={request:structuredClone(body),sequence:0,events:[]};state.calls.set(body.call_id,call)
      if(mode==='lost_begin')throw Error('fixture begin response lost')
      return {duplicate:false,call:structuredClone(call)}
    }
    const match=path.match(/^\/api\/v1\/messaging\/official-calls\/([^/]+)(\/events)?$/)
    if(match){const call=state.calls.get(match[1]);assert.ok(call);if(!match[2])return structuredClone(call)
      assert.equal(body.sequence,call.sequence+1);assert.ok(!call.events.some(e=>e.kind!=='usage'));call.events.push(structuredClone(body));call.sequence++
      return {call:structuredClone(call)}
    }
    throw Error(`Unexpected endpoint ${path}`)
  }}
  const parent=new Context();await parent.plugin(SystemPrompt);await parent.plugin(LlmRuntime)
  parent.systemPrompt.section({name:'private',order:0,text:'PARENT_PRIVATE_CANARY'})
  parent.systemPrompt.variable('secret',()=>{state.parentHooks++;throw Error('PARENT_PRIVATE_VARIABLE')})
  for(const event of ['llm/stream','agent/pre-step','session/event','internal/dispatch','system-prompt/assemble'])parent.on(event,()=>{state.parentHooks++;throw Error('PARENT_PRIVATE_HOOK')},{global:true})
  class Mock extends LlmAdapter{async *stream(request){
    state.provider++;assert.equal(request.sessionId,session);assert.doesNotMatch(JSON.stringify(request),/PARENT_PRIVATE/)
    yield {type:'usage',usage:{inputTokens:2,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}
    if(mode==='revoke')state.row.epoch++
    if(state.provider===1){
      assert.deepEqual(request.tools,[tool]);yield {type:'block-start',index:0,blockType:'tool-call'}
      yield {type:'block-end',index:0,block:{type:'tool-call',id:'call-1',name:tool.name,arguments:'{}'}}
      yield {type:'finish',reason:{kind:'tool-calls'}}
    }else{
      yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:'PLANNING_COMPLETE'}}
      yield {type:'finish',reason:{kind:'stop'}}
    }
  }}
  const provider=await createIndependentBuilderProvider({installProvider:api=>api.registerAdapter([route.provider],new Mock())})
  const outbox=new OfficialCallOutbox(client,profiles),selection=new SelectionOutbox(client,profiles)
  let lease,prepared
  const model=createScopedBuilderModel({authority:a,resolveAdmission:async()=>({dispatch_allowed:state.ready,authority:a}),
    acquirePermit:async()=>{
      lease??=await acquireOperationLease(client,operation,worker,{beforeClaim:async p=>{assert.deepEqual(p,selectionPolicy);return true}})
      prepared=await provider.prepareCall(route,lease.signal)
      const policy=outbox.policy(session,operation,()=>lease.assertActive())
      await selection.record(session,{operation,profile_revision:1,threadId:session,turnId:policy.callId,inputIds:['input'],scope:selectionPolicy.scope,observed_at:1,
        source:'official_prepared_call',model:{requested:'fixture',observed:mode==='selection'?'wrong':prepared.config.model,status:'reported'},effort:{requested:null,observed:null,status:'unverifiable'}})
      selection.assertSettled(session,operation,selectionPolicy)
      return {authority:mode==='authority'?{...a,journal_id:'foreign'}:a,lease,route,policy}
    },dispatch:r=>prepared.stream(r)})
  const manifest=builderPublicManifest(key),tools=[tool]
  const make=()=>createScopedBuilderRoot({persistenceRoot:join(dir,'journals'),modelRoute:route,
    resolveAuthority:()=>a,resolvePublicManifest:()=>manifest,resolveToolManifest:()=>tools,
    resolveInput:(_key,id)=>state.sources.get(id),testCapture:(_key,value)=>state.captures.push(value),dispatch:model,
    invokeGranted:async request=>{
      // This is a strict mock of the Host's atomic official tool admission.
      // It is NOT the production grant enforcement implementation.
      await lease.assertActive();assert.deepEqual(request.authority,a);assert.deepEqual(request.args,{})
      assert.equal(request.invocation.source_message_id,state.sources.get(request.source.request.request_id).receipt.message_id)
      assert.equal(request.name,tool.name);state.toolCalls.push(request)
      if(mode==='tool_unknown')throw Error('fixture tool outcome unknown')
      return {id:a.builder_context.draft_id,status:'draft',context:'ONLY_THIS_DRAFT'}
    }})
  const root=await make();state.sources.set('input',source(a));await root.create(key)
  t.after(async()=>{try{await root.close();lease?.dispose();await selection.close();await provider.close();await parent.fiber.dispose();await profiles.close()}finally{await rm(dir,{recursive:true,force:true})}})
  return {root,state,key,a,dir,file,manifest,tools,make,run:(id='input')=>root.followupReceipt(key,state.sources.get(id)),client,
    reopen:async()=>{await profiles.close();profiles=await openScopedBuilderProfiles({...options,mode:'restore'});return profiles}}
}
test('Builder identity has no team and separates drafts/server epochs',()=>{
  const a=authority();assert.deepEqual(validateBuilderAuthority(a),a)
  for(const field of ['team_id','scope_id','grant_enforcement'])assert.throws(()=>validateBuilderContext({...a.builder_context,[field]:'forged'}))
  assert.notEqual(a.context_key,authority('draft-B').context_key);assert.notEqual(a.context_key,authority('draft-A',2).context_key)
})
test('actual Builder root: isolated prompt/bus, controlled tool, selection and call accounting, restore without replay',async t=>{
  const f=await fixture(t),result=await f.run()
  assert.equal(result.finalText,'PLANNING_COMPLETE');assert.equal(result.published,false);assert.equal(result.runtime_ready,undefined)
  assert.equal(f.state.parentHooks,0);assert.equal(f.state.provider,2);assert.equal(f.state.toolCalls.length,1)
  assert.deepEqual([...f.state.calls.values()].map(c=>c.events.map(e=>e.kind)),[['usage','finished'],['usage','finished']])
  const events=f.state.captures[0].events
  assert.equal(events[0].type,BUILDER_JOURNAL_RECORD);assert.equal(events.filter(e=>e.type===BUILDER_INPUT_RECORD).length,1)
  assert.doesNotMatch(JSON.stringify(events),/PARENT_PRIVATE/)
  const other=await f.make();await assert.rejects(other.restore(f.key));await other.close()
  await f.root.close(f.key);await f.root.restore(f.key);await assert.rejects(f.run(),/already recorded/)
  const saved=JSON.parse(await readFile(f.file,'utf8'));assert.equal(saved.domain,'builder-v1');assert.deepEqual(Object.keys(saved.bindings),[f.a.session_id])
  assert.equal(f.state.provider,2)
})
for(const mode of ['budget','selection','authority'])test(`${mode} denies before real provider dispatch`,async t=>{
  const f=await fixture(t,mode);await assert.rejects(f.run());assert.equal(f.state.provider,0);assert.equal(f.state.parentHooks,0)
})
test('untrusted source and absent Host dispatch verdict fail closed',async t=>{
  const f=await fixture(t)
  const wrong=source(f.a);wrong.receipt.actor.id='foreign';await assert.rejects(f.root.followupReceipt(f.key,wrong))
  const forgery=source(f.a);forgery.request.content='FORGED';await assert.rejects(f.root.followupReceipt(f.key,forgery),/source changed/)
  f.state.ready=false;await assert.rejects(f.run(),/admission unavailable/);assert.equal(f.state.provider,0)
})
test('lease revocation and uncertain tool outcome fence further inference',async t=>{
  for(const mode of ['revoke','tool_unknown']){
    const f=await fixture(t,mode);await assert.rejects(f.run());await assert.rejects(f.run());assert.equal(f.state.provider,1)
    assert.equal([...f.state.calls.values()][0].events.at(-1).kind,mode==='revoke'?'interrupted':'finished')
  }
})
test('lost call begin restores evidence, never inference or another begin',async t=>{
  const f=await fixture(t,'lost_begin');await assert.rejects(f.run());assert.equal(f.state.provider,0)
  const replay=new OfficialCallOutbox(f.client,await f.reopen());await replay.recover()
  assert.equal(f.state.calls.size,1);assert.equal([...f.state.calls.values()][0].events.at(-1).kind,'interrupted')
  await assert.rejects(f.run());assert.equal(f.state.provider,0)
})
test('planning tools cannot widen to activation; restore pins manifest and journal domain',async t=>{
  const f=await fixture(t);await f.run();await f.root.close(f.key)
  f.tools.push({...tool,name:'kode_activate_team'});await assert.rejects(f.root.restore(f.key),/planning tools/);f.tools.pop()
  f.tools[0]={...tool,description:'CHANGED'};await assert.rejects(f.root.restore(f.key),/manifest.*changed/);f.tools[0]=tool
  async function replaceMarker(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
    const path=join(dir,entry.name);if(entry.isDirectory())await replaceMarker(path)
    else if(entry.name.endsWith('.jsonl')){const content=await readFile(path,'utf8');await writeFile(path,content.replaceAll(BUILDER_JOURNAL_RECORD,'plugin:kode/scoped-coordinator-journal'))}
  }}
  await replaceMarker(join(f.dir,'journals'));await assert.rejects(f.root.restore(f.key),/origin or generation/)
})

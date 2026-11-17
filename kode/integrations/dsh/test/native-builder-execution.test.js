import test from 'node:test'
import assert from 'node:assert/strict'
import {CodexSession} from '../src/codex-session.js'
import {admitNativeBuilderTurn,nativeBuilderThreadParams} from '../src/native-builder-execution.js'
import {builderContextKey} from '../src/builder-context-scope.js'
function fixture(){
  const builder_context={version:1,kind:'builder_draft',home_hub:'home',draft_id:'draft',context_epoch:1},key=builderContextKey(builder_context)
  const authority={builder_context,context_key:key,session_id:`builder-context-${key}`,journal_id:'journal',operation:{id:'op',attempt:1,epoch:1}}
  const selection={provider:'kode-agent-existing',model:'native-model',reasoningEffort:'high'},agent={id:authority.session_id,session:{id:authority.session_id,header:{cwd:'/fixture'}}}
  let admitted=0,closed=0
  const service={sessionAdmission:()=>({authority,selection,cwd:'/fixture'}),assertSession:async()=>{},admitTurn:async()=>{admitted++;return {assertActive:async()=>{},executeTool:async()=>{},close:async()=>{closed++}}}}
  const input={agent,admission:{authority,selection,cwd:'/fixture'},selection,messages:[{id:'input',role:'user',content:[{type:'text',text:'SOURCE'}]}],tools:[],binding:{}}
  return {service,input,counts:()=>({admitted,closed})}
}
test('trusted native admission is not CLI enforcement and cannot infer',async()=>{
  const f=fixture();await assert.rejects(admitNativeBuilderTurn(f.service,f.input),{code:'NATIVE_BUILDER_ENFORCEMENT_UNSUPPORTED'})
  assert.deepEqual(f.counts(),{admitted:1,closed:1})
})
test('foreign selection, inherited native thread and external history reject before turn owner',async()=>{
  for(const mutate of [f=>f.input.selection={...f.input.selection,model:'other'},f=>f.input.binding.threadId='legacy',
    f=>f.input.options={nativeContinuation:true},f=>f.input.messages.push({role:'system',content:[]})]){
    const f=fixture();mutate(f);await assert.rejects(admitNativeBuilderTurn(f.service,f.input));assert.equal(f.counts().admitted,0)
  }
  await assert.rejects(admitNativeBuilderTurn(undefined,fixture().input),/factory admission/)
})
test('actual CodexSession mocked RPC preflight uses native route without ambient session instructions; never starts turn',async()=>{
  const calls=[],session=new CodexSession({type:'codex'},'/fixture',{nativeBuilder:{}})
  session.initialize=async()=>{}
  session.rpc={request:async(method,params)=>{calls.push({method,params});return {thread:{id:'fresh'},cwd:'/fixture',model:'native-model',reasoningEffort:'high'}}}
  const input={selection:{model:'native-model',reasoningEffort:'high'},procedure:'PUBLIC_BUILDER_ONLY',tools:[{name:'plan',description:'APPROVED',parameters:{type:'object'}}]}
  const result=await session.preflightBuilder(input)
  assert.equal(result.runtime_ready,false);assert.equal(result.model,'native-model')
  assert.deepEqual(calls.map(c=>c.method),['thread/start'])
  assert.deepEqual(calls[0].params,nativeBuilderThreadParams({cwd:'/fixture',...input}))
  assert.equal(calls[0].params.config['features.goals'],false)
  assert.equal(calls[0].params.approvalPolicy,'never');assert.equal(calls[0].params.sandbox,'read-only')
  assert.doesNotMatch(JSON.stringify(calls),/kode_sessions_|shared session directory/)
  await assert.rejects(async()=>{for await(const _ of session.turn([{type:'text',text:'NO'}])){}},{code:'NATIVE_BUILDER_ENFORCEMENT_UNSUPPORTED'})
  assert.equal(calls.length,1)
})
test('unknown or mismatched native metadata never permits turn; native discovery remains original',async()=>{
  for(const response of [{model:'wrong',reasoningEffort:'high'},{model:'native-model'},{}]){
    const s=new CodexSession({},'/fixture',{nativeBuilder:{}});s.initialize=async()=>{}
    const calls=[];s.rpc={request:async(method)=>{calls.push(method);return {thread:{id:'fresh'},cwd:'/fixture',...response}}}
    await assert.rejects(s.preflightBuilder({selection:{model:'native-model',reasoningEffort:'high'},procedure:'PUBLIC',tools:[]}))
    assert.deepEqual(calls,['thread/start'])
  }
  const ordinary=new CodexSession({},'/fixture');ordinary.initialize=async()=>{}
  ordinary.rpc={request:async(method)=>{assert.ok(['model/list','collaborationMode/list'].includes(method));return {data:method==='model/list'?[{id:'actual-native',isDefault:true}]:[],nextCursor:null}}}
  assert.equal((await ordinary.listModels())[0].id,'actual-native')
})
test('uncertain preflight creation is fenced and never retries or resumes another thread',async()=>{
  const session=new CodexSession({},'/fixture',{nativeBuilder:{}});session.initialize=async()=>{}
  let calls=0;session.rpc={request:async()=>{calls++;throw Error('lost response')}}
  const input={selection:{model:'native-model'},procedure:'PUBLIC',tools:[]}
  await assert.rejects(session.preflightBuilder(input),/lost response/)
  await assert.rejects(session.preflightBuilder(input),/Fresh trusted/)
  await assert.rejects(session.open({threadId:'legacy'},[]),{code:'NATIVE_BUILDER_ENFORCEMENT_UNSUPPORTED'})
  assert.equal(calls,1)
})

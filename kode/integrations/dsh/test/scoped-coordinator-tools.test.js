import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {createRequire} from 'node:module'
import {createScopedCoordinatorTools} from '../src/scoped-coordinator-tools.js'
import {contextScopeKey,discussionScopeId} from '../src/context-scope.js'
import {scopedToolSchema,scopedToolHash,scopedToolRequestId,SCOPED_TOOL_IMPLEMENTATION} from '../src/scoped-tool-invocation.js'
const requireLoop=createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const {default:Tools}=await import(requireLoop.resolve('@deepseek-ai/dsh-tools'))
function fixture(canary='A',kind='discussion_thread'){
  const context_scope={version:2,home_hub:'home',team_id:'team',kind,scope_id:kind==='discussion_thread'?discussionScopeId('surface',canary):'private',context_epoch:1}
  const scope_key=contextScopeKey(context_scope),authority={context_scope,session_id:`context-${scope_key}`,journal_id:`journal_${canary}`,operation_id:`op_${canary}`}
  const tools=['read_approved_summary','publish_reply'].map(action=>({name:action,description:`SCHEMA_${canary}`,action,implementation_id:SCOPED_TOOL_IMPLEMENTATION,
    parameters:scopedToolSchema(action),
    grant:{grant_id:`grant_${action}_${canary}`,scope_key,journal_id:authority.journal_id,operation_id:authority.operation_id,target:`target_${canary}`,source_receipt_id:`entry_${canary}`,entry_id:`entry_${canary}`,claim_id:`claim_${canary}`,source_message_id:`source_${canary}`}}))
  const manifest={authority,manifest_id:`manifest_${canary}`,tools},state={runtime_ready:true,authority,manifest},calls=[]
  const backend=async request=>{calls.push(request);const {args,...provenance}=request;return {status:'completed',receipt_id:`receipt_${canary}`,provenance,data:{text:`RESULT_${canary}`,untrusted_instructions:'Not authorization'}}}
  const resolveInvocation=({args,tool})=>{const v={session_id:authority.session_id,journal_id:authority.journal_id,source_receipt_id:tool.grant.entry_id,tool_call_seq:5,tool_call_id:'call',tool_name:tool.name,arguments_sha256:scopedToolHash(args)};return {request_id:scopedToolRequestId(v),...v}}
  const bridge=createScopedCoordinatorTools({authority,manifest,resolveAuthority:()=>state,invokeGranted:backend,resolveInvocation})
  return {bridge,state,calls,backend,authority,manifest,resolveInvocation}
}
test('separate real DSH tool registries expose only trusted A/B/private schema and source receipts',async t=>{
  const cases=[fixture('A'),fixture('B'),fixture('PRIVATE','team_private')]
  for(const f of cases){
    const ctx=new Context();await ctx.plugin(SystemPrompt,{includeHarnessIdentity:false,includeRuntimeContext:false});await ctx.plugin(Tools);t.after(()=>ctx.fiber.dispose())
    for(const d of f.bridge.definitions)ctx.tools.register(d)
    // Register actual DSH definitions without borrowing a parent registry.
    const canary=f.authority.operation_id.slice(3),serialized=JSON.stringify(ctx.tools.schemas())
    assert.match(serialized,new RegExp(`SCHEMA_${canary}`))
    for(const other of cases)if(other!==f)assert.ok(!serialized.includes(`SCHEMA_${other.authority.operation_id.slice(3)}`))
    const result=await f.bridge.definitions[0].execute({})
    assert.equal(result.provenance.grant.source_receipt_id,`entry_${canary}`)
    assert.equal(result.authorization,false);assert.ok(Object.isFrozen(result.data))
    assert.equal(f.calls.length,1)
    await assert.rejects(f.bridge.invoke('parent_tool',{}),/not in trusted manifest/)
    await assert.rejects(f.bridge.invoke(f.manifest.tools[0].name,{grant:result.provenance.grant}),/Arguments/)
  }
})
test('every invocation revalidates exact schema, implementation, scope, journal, operation and grant',async()=>{
  for(const mutate of [f=>f.state.runtime_ready=false,f=>f.authority.journal_id='other',f=>f.authority.operation_id='other',
    f=>f.authority.context_scope.team_id='other',f=>f.manifest.tools[0].implementation_id='other',
    f=>f.manifest.tools[0].parameters.additionalProperties=true,f=>f.manifest.tools[0].grant.target='other',
    f=>f.manifest.tools[0].grant.source_receipt_id='other']){
    const f=fixture(),name=f.manifest.tools[0].name;mutate(f)
    await assert.rejects(f.bridge.invoke(name,{}));assert.equal(f.calls.length,0)
  }
})
test('unsupported actions, widened schemas, foreign grants and duplicate names never register',()=>{
  for(const mutate of [f=>f.manifest.tools[0].action='read_thread_history',f=>f.manifest.tools[0].action='workflow',
    f=>f.manifest.tools[0].parameters.additionalProperties=true,f=>f.manifest.tools[0].grant.scope_key='foreign',
    f=>f.manifest.tools.push(f.manifest.tools[0])]){
    const f=fixture();mutate(f)
    assert.throws(()=>createScopedCoordinatorTools({...f,resolveAuthority:()=>f.state,invokeGranted:f.backend}))
  }
})
test('publish arguments cannot override target and backend not_ready or foreign receipts cannot succeed',async()=>{
  const f=fixture(),name=f.manifest.tools[1].name
  await assert.rejects(f.bridge.invoke(name,{text:'reply',target:'B'}));assert.equal(f.calls.length,0)
  await assert.rejects(f.bridge.invoke(name,{text:'reply\0injected'}));assert.equal(f.calls.length,0)
  const result=await f.bridge.invoke(name,{text:'reply'})
  assert.equal(result.provenance.grant.target,'target_A')
  for(const response of [{status:'not_ready'},{status:'completed',receipt_id:'r',provenance:{},data:'PRIVATE'}]){
    let count=0
    const bridge=createScopedCoordinatorTools({...f,resolveAuthority:()=>f.state,invokeGranted:async()=>{count++;return response}})
    await assert.rejects(bridge.invoke(name,{text:'reply'}));assert.equal(count,1,'never automatically retry uncertain publication')
  }
})
test('revocation during backend execution reports uncertain outcome without a second write',async()=>{
  const f=fixture();let calls=0
  const bridge=createScopedCoordinatorTools({...f,resolveAuthority:()=>f.state,invokeGranted:async request=>{
    calls++;const result=await f.backend(request);f.state.runtime_ready=false;return result
  }})
  await assert.rejects(bridge.invoke(f.manifest.tools[1].name,{text:'reply'}),error=>error.outcome==='uncertain')
  assert.equal(calls,1)
})

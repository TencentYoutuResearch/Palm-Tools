/** Unwired scoped tool contract. Only an independently authenticated Hub resolver
 * and atomic grant-enforcing backend can authorize production use. JS callbacks,
 * manifests, result provenance and local fixture receipts are not security grants.
 * Never register these definitions in a shared/parent tools registry.
 */
import {isDeepStrictEqual} from 'node:util'
import {contextScopeKey,validateContextScope} from './context-scope.js'
import {SCOPED_TOOL_IMPLEMENTATION,scopedToolSchema,scopedToolHash,scopedToolRequestId} from './scoped-tool-invocation.js'
const fail=message=>Object.assign(Error(message),{code:'SCOPED_TOOL_REJECTED'})
const freeze=value=>{if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value)}return value}
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(value)
const shape=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Reflect.ownKeys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k))
function checked(authority,manifest){
  if(!shape(authority,['context_scope','session_id','journal_id','operation_id']))throw fail('Exact trusted tool authority required')
  const scope=validateContextScope(authority.context_scope),key=contextScopeKey(scope)
  if(scope.kind==='builder_draft'||authority.session_id!==`context-${key}`||!token(authority.journal_id)||!token(authority.operation_id))throw fail('Tool authority identity mismatch')
  if(!shape(manifest,['authority','manifest_id','tools'])||!isDeepStrictEqual(manifest.authority,authority)||!token(manifest.manifest_id)||!Array.isArray(manifest.tools))throw fail('Trusted manifest mismatch')
  const names=new Set()
  for(const tool of manifest.tools){
    if(!shape(tool,['name','description','parameters','implementation_id','action','grant'])||!token(tool.name)||names.has(tool.name)||typeof tool.description!=='string'||!token(tool.implementation_id))throw fail('Invalid or duplicate tool identity')
    names.add(tool.name)
    if(!['read_approved_summary','publish_reply'].includes(tool.action)||tool.name!==tool.action||tool.implementation_id!==SCOPED_TOOL_IMPLEMENTATION)throw fail('Unsupported scoped tool action or implementation')
    const grant=tool.grant
    if(!shape(grant,['grant_id','scope_key','journal_id','operation_id','target','source_receipt_id','entry_id','claim_id','source_message_id'])
      ||!token(grant.grant_id)||grant.scope_key!==key||grant.journal_id!==authority.journal_id||grant.operation_id!==authority.operation_id
      ||!token(grant.target)||!token(grant.source_receipt_id)||grant.entry_id!==grant.source_receipt_id||!token(grant.claim_id)||!token(grant.source_message_id))throw fail('Scope-bound grant mismatch')
    const schema=structuredClone(tool.parameters)
    // A deliberately small supported schema contract, not a partial JSON Schema
    // evaluator. Preserve descriptions verbatim in exposed descriptors.
    const expected=scopedToolSchema(tool.action)
    if(!isDeepStrictEqual(schema,expected))throw fail('Unsupported or widened tool schema')
  }
  return freeze({authority,manifest})
}

export function createScopedCoordinatorTools({authority,manifest,resolveAuthority,invokeGranted,resolveInvocation}){
  if(typeof resolveAuthority!=='function'||typeof invokeGranted!=='function')throw fail('Trusted resolver and grant-enforcing backend required')
  const admitted=checked(structuredClone(authority),structuredClone(manifest))
  const revalidate=async()=>{
    const current=await resolveAuthority()
    if(current?.runtime_ready!==true)throw fail('Scoped tools backend not_ready')
    if(!shape(current,['runtime_ready','authority','manifest'])||!isDeepStrictEqual(checked(structuredClone(current.authority),structuredClone(current.manifest)),admitted))throw fail('Tool authority or manifest changed')
  }
  const invoke=async(name,args,execution)=>{
    const tool=admitted.manifest.tools.find(t=>t.name===name)
    if(!tool)throw fail('Tool is not in trusted manifest')
    const input=structuredClone(args)
    if(!shape(input,tool.action==='publish_reply'?['text']:[])||tool.action==='publish_reply'&&(typeof input.text!=='string'||!input.text.trim()||input.text.includes('\0')||[...input.text].length>65536))throw fail('Arguments differ from supported schema')
    freeze(input)
    await revalidate()
    if(typeof resolveInvocation!=='function')throw fail('Trusted journal invocation resolver required')
    const invocation=structuredClone(await resolveInvocation({execution,args:input,tool,authority:admitted.authority}))
    if(!shape(invocation,['request_id','session_id','journal_id','source_receipt_id','tool_call_seq','tool_call_id','tool_name','arguments_sha256'])
      ||invocation.session_id!==admitted.authority.session_id||invocation.journal_id!==admitted.authority.journal_id
      ||invocation.source_receipt_id!==tool.grant.entry_id||!Number.isSafeInteger(invocation.tool_call_seq)||invocation.tool_call_seq<1
      ||typeof invocation.tool_call_id!=='string'||!invocation.tool_call_id||invocation.tool_name!==name
      ||invocation.arguments_sha256!==scopedToolHash(input)||invocation.request_id!==scopedToolRequestId(invocation))throw fail('Invalid journal invocation identity')
    await revalidate()
    const request=freeze(structuredClone({authority:admitted.authority,manifest_id:admitted.manifest.manifest_id,
      name:tool.name,implementation_id:tool.implementation_id,action:tool.action,grant:tool.grant,args:input,
      invocation,schema_hash:scopedToolHash(tool.parameters)}))
    // Backend must atomically verify this exact authority, grant, target, source
    // receipt and implementation. A preflight read alone cannot authorize a write.
    let result
    try{result=await invokeGranted(request)}catch(cause){
      throw Object.assign(fail('Scoped backend failed; outcome may be uncertain; do not retry automatically'),{cause,outcome:'uncertain'})
    }
    if(result?.status==='not_ready')throw fail('Scoped tools backend not_ready')
    const provenance={authority:admitted.authority,manifest_id:admitted.manifest.manifest_id,name:tool.name,
      implementation_id:tool.implementation_id,action:tool.action,grant:tool.grant,invocation,schema_hash:scopedToolHash(tool.parameters)}
    if(!shape(result,['status','receipt_id','provenance','data'])||result.status!=='completed'||!token(result.receipt_id)||!isDeepStrictEqual(result.provenance,provenance))throw fail('Backend tool receipt mismatch; outcome may be uncertain')
    try{await revalidate()}catch(cause){
      throw Object.assign(fail('Authority changed after backend call; outcome may be uncertain; do not retry automatically'),{cause,outcome:'uncertain'})
    }
    return freeze(structuredClone({...result,authorization:false}))
  }
  const descriptors=freeze(admitted.manifest.tools.map(({name,description,parameters})=>({name,description,parameters})))
  const definitions=Object.freeze(descriptors.map(d=>Object.freeze({...d,
    output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
    execute:(args,execution)=>invoke(d.name,args,execution)})))
  return Object.freeze({descriptors,definitions,invoke})
}

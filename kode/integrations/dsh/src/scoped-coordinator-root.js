/** Experimental local-only root. No production router, runtime readiness, or tool
 * authority is enabled here. Dependencies/resolvers are trusted Host code, never
 * user options. Every context owns a distinct event bus and actual factory writer.
 */
import {Context,symbols} from '@deepseek-ai/cordis'
import {createRequire} from 'node:module'
import {isDeepStrictEqual} from 'node:util'
import {isAbsolute} from 'node:path'
import SessionStore,{appendPluginRecord} from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime,{LlmAdapter,createUserMessage} from '@deepseek-ai/dsh-llm'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import {createScope} from '@deepseek-ai/dsh-scope'
import {contextScopeKey,validateContextScope,discussionScopeId} from './context-scope.js'
import {createScopedCoordinatorSessionAdapter} from './scoped-coordinator-session-adapter.js'
import {createScopedCoordinatorTools} from './scoped-coordinator-tools.js'
import {deriveScopedToolInvocation} from './scoped-tool-invocation.js'
import {validatePublicManifest,bindPublicManifest,mountPublicManifest,publicTextHash} from './scoped-coordinator-prompt.js'
import {createScopedConversationCallProof} from './scoped-conversation-call-proof.js'
export const SCOPED_LOCAL_INPUT_RECORD='plugin:kode/scoped-local-input'
const requireLoop=createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const {default:Tools}=await import(requireLoop.resolve('@deepseek-ai/dsh-tools'))
const fail=message=>Object.assign(Error(message),{code:'SCOPED_ROOT_REJECTED'})
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value)}return value}

/**
 * Resolvers are independently authenticated Host dependencies, not request data.
 * resolveAuthority(key): {context_scope, session_id, journal_id}.
 * resolveClaimAuthority(key, {entry_id, claim_id}): exact current backend
 * {runtime_ready, dispatch_allowed, stage, authority, entry, message}; absence
 * never falls back to labels carried by the submitted claim.
 * With a claim resolver installed, ordinary followup is disabled. Without one,
 * followup is an offline experiment only, not an authorized production inbox.
 * Tool manifests are separate from public prompt manifests; their complete
 * authority/schema/implementation/grants are pinned in the journal. This slice
 * deliberately permits only one exact source receipt in a tool-bearing journal.
 * inspect returns metadata only. testCapture is an explicit fixture diagnostic,
 * never a UI bridge. finalText records a local outcome, never publication.
 */
export async function createScopedCoordinatorRoot({persistenceRoot,resolveAuthority,resolvePublicManifest,modelRoute,dispatch,testCapture,resolveToolManifest,invokeGranted,resolveClaimAuthority,resolveHostBinding}){
  if(typeof persistenceRoot!=='string'||!isAbsolute(persistenceRoot)||typeof resolveAuthority!=='function'
    ||typeof resolvePublicManifest!=='function'||typeof dispatch!=='function')throw fail('Explicit local persistence and trusted resolvers/transport required')
  const route=structuredClone(modelRoute)
  if(!route||Object.keys(route).some(k=>!['provider','model','reasoningEffort'].includes(k))
    ||!['provider','model'].every(k=>typeof route[k]==='string'&&route[k].length>0)
    ||route.reasoningEffort!==undefined&&typeof route.reasoningEffort!=='string')throw fail('Explicit trusted model route required')
  freeze(route)
  if(resolveToolManifest!==undefined&&(typeof resolveToolManifest!=='function'||typeof invokeGranted!=='function'))throw fail('Trusted tool resolver and backend must be provided together')
  if(resolveHostBinding!==undefined&&(typeof resolveHostBinding!=='function'||typeof resolveClaimAuthority!=='function'||resolveToolManifest!==undefined))throw fail('Conversation call proof requires exact claim and empty tool profile')
  const rows=new Map(),pending=new Map();let closed=false
  const resolve=key=>{
    if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))throw fail('Invalid context key')
    const a=structuredClone(resolveAuthority(key))
    if(!a||Object.keys(a).length!==3||!['context_scope','session_id','journal_id'].every(k=>Object.hasOwn(a,k)))throw fail('Invalid trusted authority')
    a.context_scope=validateContextScope(a.context_scope)
    if(contextScopeKey(a.context_scope)!==key||a.context_scope.kind==='builder_draft'||a.session_id!==`context-${key}`
      ||typeof a.journal_id!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(a.journal_id))throw fail('Trusted authority identity mismatch')
    const tools=resolveToolManifest===undefined?null:structuredClone(resolveToolManifest(key))
    if(tools!==null){
      if(tools?.runtime_ready!==true)throw fail('Scoped tools backend not_ready')
      const toolAuthority=tools.authority??{}, {operation_id,...journalAuthority}=toolAuthority
      if(!isDeepStrictEqual(journalAuthority,a))throw fail('Tool manifest journal differs from root authority')
      createScopedCoordinatorTools({authority:toolAuthority,manifest:tools.manifest,resolveAuthority:()=>tools,invokeGranted,
        resolveInvocation:()=>{throw fail('Validation-only tool manifest has no invocation authority')}})
    }
    return {authority:freeze(a),public:validatePublicManifest(resolvePublicManifest(key),key),tools:freeze(tools)}
  }
  const validate=row=>{if(!isDeepStrictEqual(resolve(row.key),row.accepted))throw fail('Trusted authority or public manifest changed')}
  const describe=row=>freeze({contextKey:row.key,sessionId:row.accepted.authority.session_id,runtime_ready:false})
  const inspect=key=>{
    const row=rows.get(key);if(!row||row.busy)throw fail('Context unavailable or busy')
    validate(row)
    return freeze({...describe(row),eventCount:row.handle.agent.session.snapshotEvents().length})
  }
  async function open(key,mode){
    if(closed||rows.has(key)||pending.has(key))throw fail('Context closed or already owned')
    const accepted=resolve(key),ctx=new Context(),row={key,accepted,ctx,busy:false,errors:[]}
    const task=(async()=>{
      try{
        await ctx.plugin(SessionStore);await ctx.plugin(AgentRegistry);await ctx.plugin(Projections)
        await ctx.plugin(Jsonl,{root:persistenceRoot,compression:'none'})
        await ctx.plugin(SystemPrompt,{includeHarnessIdentity:false,includeRuntimeContext:false})
        mountPublicManifest(ctx.systemPrompt,accepted.public)
        await ctx.plugin(Tools);await ctx.plugin(LlmRuntime)
        if(accepted.tools){
          const toolBridge=createScopedCoordinatorTools({authority:accepted.tools.authority,manifest:accepted.tools.manifest,
            resolveAuthority:async()=>{validate(row);await row.claimCheck?.();return resolveToolManifest(key)},invokeGranted,
            resolveInvocation:async({execution,args,tool,authority})=>{
              const agent=row.handle?.agent,actual=agent?.[symbols.original]??agent
              if(!row.busy||!row.claimCheck||!agent||(execution?.agent?.[symbols.original]??execution?.agent)!==actual
                ||execution.agent.session!==agent.session)throw fail('Tool invocation has no exact owned Agent and active claim')
              validate(row);await row.claimCheck()
              const parameters={session:agent.session,authority,grant:tool.grant,toolName:tool.name,args,execution}
              const invocation=deriveScopedToolInvocation(parameters)
              if(await original.flush(agent.session)!==true)throw fail('Tool invocation durability unavailable')
              validate(row);await row.claimCheck()
              if(!isDeepStrictEqual(invocation,deriveScopedToolInvocation(parameters)))throw fail('Tool invocation changed during durability barrier')
              return invocation
            }})
          for(const definition of toolBridge.definitions)ctx.tools.register(definition)
        }
        const original=ctx.sessions,backend=ctx.sessionPersistence
        const adapter=createScopedCoordinatorSessionAdapter(original,id=>{validate(row);if(id!==accepted.authority.session_id)throw fail('Foreign session admission');return{mode,authority:accepted.authority}})
        class LocalTransport extends LlmAdapter{
          async *stream(request){
            validate(row)
            await row.claimCheck?.()
            if(request.provider!==route.provider||request.model!==route.model||request.reasoningEffort!==route.reasoningEffort)throw fail('Model route changed')
            const session=original.get(request.sessionId)
            const guarded=await adapter.dispatch(session,request,input=>(async function*(){
              let evidence
              if(resolveHostBinding){
                if(!row.claimProof||!row.claimCheck)throw fail('Conversation call has no current source claim')
                const hostBinding=structuredClone(await resolveHostBinding(key))
                const stable=value=>{const {receipt_replay,...rest}=value??{};return rest}
                const assertOwned=async()=>{
                  validate(row)
                  if(!row.busy||row.handle?.agent.session!==session||!row.claimProof||!row.claimCheck)throw fail('Call proof lost its owned Session')
                  await row.claimCheck()
                  if(!isDeepStrictEqual(stable(await resolveHostBinding(key)),stable(hostBinding)))throw fail('Host scope binding changed during call proof')
                }
                const prover=createScopedConversationCallProof({session,authority:row.claimProof.authority,
                  claim:row.claimProof,hostBinding,publicManifest:row.accepted.public,assertOwned,
                  flush:owned=>original.flush(owned)})
                evidence=await prover.prove(input)
              }
              yield* dispatch(input,evidence)
            })())
            if(!guarded?.[Symbol.asyncIterator])throw fail('Local transport must return an async stream')
            for await(const chunk of guarded){await row.claimCheck?.();yield chunk}
          }
        }
        ctx.llm.registerAdapter([route.provider],new LocalTransport())
        ctx.on('agent/error',event=>row.errors.push(String(event.error?.message??event.error)))
        const scope=ctx.isolate('sessions').isolate('sessionPersistence')
        const service=await scope.plugin(function exactContextServices(c){
          c.provide('sessions',adapter.sessions)
          c.provide('sessionPersistence',{
            create(header,options){validate(row);if(mode!=='fresh'||header.id!==accepted.authority.session_id)throw fail('Foreign persistence create');return backend.create(header,options)},
            open(id,access){validate(row);if(mode!=='restore'||id!==accepted.authority.session_id||access!=='write')throw fail('Foreign persistence open');return backend.open(id,access)},
          })
        })
        const loop=await service.ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:1})
        const factory=loop.ctx.get('agentLoop')
        const setup=async(c,agent)=>{
          validate(row);bindPublicManifest(agent.session,accepted.public,mode,accepted.tools)
          const scoped=createScope(c,agent[symbols.original]??agent).ctx
          agent.ctx=scoped.extend({sessions:scoped.reflect.trace(adapter.sessions)})
        }
        row.handle=mode==='fresh'?await factory.createAgent(service.ctx,{sessionId:accepted.authority.session_id,agentOptions:route,setup})
          :await factory.resume(service.ctx,{resumeSessionId:accepted.authority.session_id,agentOptions:route,setup})
        row.store=original
        rows.set(key,row)
        return describe(row)
      }catch(error){await row.handle?.dispose().catch(()=>{});await ctx.fiber.dispose().catch(()=>{});throw error}
    })()
    pending.set(key,task)
    try{return await task}finally{pending.delete(key)}
  }
  async function followup(key,input,claimProof,expectedRow){
    input=structuredClone(input)
    const row=rows.get(key)
    if(closed||!row||row.busy||row.failed||row.claimCheck&&!claimProof)throw fail('Context unavailable, failed or busy')
    if(claimProof&&(expectedRow!==row||!row.claimCheck))throw fail('Claim ownership changed before delivery')
    if(!claimProof&&resolveClaimAuthority!==undefined)throw fail('Claim-only root forbids ordinary local followup')
    if(!input||Object.keys(input).length!==2||typeof input.inputId!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(input.inputId)
      ||typeof input.text!=='string'||!input.text.trim()||input.text.length>65536||input.text.includes('\0'))throw fail('Exact local input required')
    validate(row)
    const events=row.handle.agent.session.snapshotEvents(),digest=publicTextHash(input.text)
    const previous=events.find(e=>e.type===SCOPED_LOCAL_INPUT_RECORD&&e.data.input_id===input.inputId)
    if(previous)throw fail(previous.data.content_sha256===digest?'Input already recorded; outcome may be uncertain; no automatic replay':'Input identity content hash conflict')
    if(row.accepted.tools&&(!claimProof||events.some(e=>e.type===SCOPED_LOCAL_INPUT_RECORD||e.type==='user/message')
      ||row.accepted.tools.manifest.tools.some(t=>t.grant.source_receipt_id!==claimProof.entry.id||t.grant.entry_id!==claimProof.entry.id
        ||t.grant.claim_id!==claimProof.entry.claim_id||t.grant.source_message_id!==input.inputId)))throw fail('Fixed tool grants permit only their exact first claim/source receipt')
    row.busy=true
    const startSequence=row.handle.agent.session.seq
    try{
      // Local experiment only: this marker is not a Hub claim or execution mandate.
      // An uncertain append/flush remains a no-replay fence, including on restore.
      const message=createUserMessage({source:{kind:'user'},content:[{type:'text',text:input.text}]})
      appendPluginRecord(row.handle.agent.session,SCOPED_LOCAL_INPUT_RECORD,{version:1,context_key:key,
        input_id:input.inputId,content_sha256:digest,message_id:message.id,execution_authorized:false,
        ...(claimProof?{claim:claimProof}:{})})
      if(await row.store.flush(row.handle.agent.session)!==true)throw fail('Input receipt durability unavailable; no delivery')
      validate(row)
      await row.claimCheck?.()
      row.handle.agent.followup(message)
      await row.handle.agent.whenIdle()
      if(row.errors.length)throw fail(row.errors.at(-1))
      if(await row.store.flush(row.handle.agent.session)!==true)throw fail('Missing durability listener')
      validate(row)
    }catch(error){row.failed=true;throw error}finally{row.busy=false}
    // Explicit fixture-only capture. Never a model tool or UI payload.
    testCapture?.(key,freeze({events:structuredClone(row.handle.agent.session.snapshotEvents()),messages:structuredClone(row.handle.agent.session.deriveMessages())}))
    const final=row.handle.agent.session.snapshotEvents().filter(e=>e.seq>=startSequence&&e.type==='assistant/message').at(-1)
    const finalText=final?.data?.message?.content?.filter(block=>block.type==='text').map(block=>block.text).join('')
    return freeze({...inspect(key),state:'completed',published:false,inputId:input.inputId,...(finalText?{finalText}:{})})
  }
  async function followupClaim(key,proof){
    if(typeof resolveClaimAuthority!=='function')throw fail('Trusted claim authority resolver unavailable')
    proof=structuredClone(proof)
    const row=rows.get(key),a=proof?.authority,e=proof?.entry,m=proof?.message
    if(!row||row.busy||row.claimCheck)throw fail('Context unavailable or busy')
    const accepted=row.accepted.authority,id=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(value)
    if(!a||!e||!m||a.context_key!==key||!isDeepStrictEqual(a.context_scope,accepted.context_scope)
      ||a.session_id!==accepted.session_id||a.journal_id!==accepted.journal_id||!id(a.operation_id)
      ||a.worker?.session_id!==accepted.session_id||a.worker?.node_id!==accepted.context_scope.home_hub
      ||a.origin?.home_hub!==accepted.context_scope.home_hub
      ||!['operation_revision','attempt','epoch','control_revision','team_revision','audience_revision'].every(k=>Number.isSafeInteger(a[k])&&a[k]>0)
      ||!id(e.id)||e.context_key!==key||e.state!=='claimed'||!id(e.claim_id)||e.operation_id!==a.operation_id||e.journal_id!==a.journal_id
      ||!isDeepStrictEqual(e.worker,a.worker)||e.operation_revision!==a.operation_revision||e.operation_attempt!==a.attempt
      ||e.operation_epoch!==a.epoch||e.control_revision!==a.control_revision||!id(e.source_message_id)||m.id!==e.source_message_id
      ||m.kind!=='discussion'||discussionScopeId(m.surface_id,m.thread_id)!==accepted.context_scope.scope_id
      ||!isDeepStrictEqual(m.actor,{kind:'human',id:'local_owner'})||!isDeepStrictEqual(m.scope,a.origin)
      ||typeof m.content!=='string'||publicTextHash(m.content)!==e.source_content_sha256
      ||row.accepted.tools&&row.accepted.tools.authority.operation_id!==a.operation_id)throw fail('Claim source or owned authority mismatch')
    const check=async()=>{
      const latest=await resolveClaimAuthority(key,{entry_id:e.id,claim_id:e.claim_id})
      if(rows.get(key)!==row||latest?.runtime_ready!==true||latest?.dispatch_allowed!==true||latest?.stage!=='runtime'
        ||!isDeepStrictEqual(latest.authority,a)||!isDeepStrictEqual(latest.entry,e)||!isDeepStrictEqual(latest.message,m))throw fail('Claim authority/source receipt changed or runtime not ready')
    }
    row.claimCheck=check
    row.claimProof=freeze(structuredClone(proof))
    try{await check();return await followup(key,{inputId:e.source_message_id,text:m.content},{authority:a,entry:e},row)}
    finally{delete row.claimCheck;delete row.claimProof}
  }
  async function close(key){
    if(key===undefined){
      if([...rows.values()].some(row=>row.busy||row.claimCheck))throw fail('Active claim or turn cannot close; wait for settlement')
      closed=true;await Promise.allSettled([...pending.values()]);for(const id of [...rows.keys()])await close(id);return
    }
    if(pending.has(key))await pending.get(key)
    const row=rows.get(key);if(!row)return
    if(row.busy||row.claimCheck)throw fail('Active claim or turn cannot close; wait for settlement')
    rows.delete(key)
    try{await row.handle.dispose()}finally{await row.ctx.fiber.dispose()}
  }
  return Object.freeze({create:key=>open(key,'fresh'),restore:key=>open(key,'restore'),followup:(key,input)=>followup(key,input),followupClaim,inspect,close})
}

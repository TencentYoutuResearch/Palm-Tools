/** Offline independent Builder draft reference root. Host resolvers are trusted code, not request
 * parameters. No parent Context, profiles, prompt variables or bus are accepted.
 * Opening a root is not enrollment/readiness; all execution still needs the
 * authenticated Host's official model and tool admission chain. Production uses
 * the existing native factory/driver, not this reference AgentLoop implementation.
 */
import {Context,symbols} from '@deepseek-ai/cordis'
import {createRequire} from 'node:module'
import {isAbsolute} from 'node:path'
import {isDeepStrictEqual} from 'node:util'
import SessionStore,{appendPluginRecord} from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime,{LlmAdapter,createUserMessage} from '@deepseek-ai/dsh-llm'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import {createScope} from '@deepseek-ai/dsh-scope'
import {validateBuilderAuthority} from './builder-context-scope.js'
import {createScopedBuilderSessionAdapter} from './scoped-builder-session-adapter.js'
import {validateBuilderManifest,validateBuilderToolManifest,bindPublicManifest,mountPublicManifest,canonicalManifestHash} from './scoped-builder-manifest.js'
import {BUILDER_INPUT_RECORD,validateBuilderInput,deriveBuilderToolInvocation} from './scoped-builder-input.js'
export {BUILDER_JOURNAL_RECORD} from './scoped-builder-session-adapter.js'
const requireLoop=createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const {default:Tools}=await import(requireLoop.resolve('@deepseek-ai/dsh-tools'))
const fail=message=>Object.assign(Error(message),{code:'BUILDER_ROOT_REJECTED'})
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value)}return value}
const journal=a=>({builder_context:a.builder_context,session_id:a.session_id,journal_id:a.journal_id})
export async function createScopedBuilderRoot({persistenceRoot,modelRoute,resolveAuthority,resolvePublicManifest,resolveInput,resolveToolManifest=()=>[],invokeGranted,dispatch,testCapture}){
  if(typeof persistenceRoot!=='string'||!isAbsolute(persistenceRoot)
    ||![resolveAuthority,resolvePublicManifest,resolveInput,resolveToolManifest,dispatch].every(fn=>typeof fn==='function'))throw fail('Trusted Builder resolvers, provider and local persistence required')
  const route=freeze(structuredClone(modelRoute))
  if(!route||Object.keys(route).some(k=>!['provider','model','reasoningEffort'].includes(k))
    ||!['provider','model'].every(k=>typeof route[k]==='string'&&route[k])||route.reasoningEffort!==undefined&&typeof route.reasoningEffort!=='string')throw fail('Exact Builder model route required')
  const rows=new Map(),pending=new Map();let closed=false
  const resolve=key=>{
    if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))throw fail('Invalid Builder context key')
    const authority=validateBuilderAuthority(resolveAuthority(key))
    if(authority.context_key!==key)throw fail('Foreign Builder authority')
    const tools=validateBuilderToolManifest(resolveToolManifest(key))
    if(tools.length&&typeof invokeGranted!=='function')throw fail('Grant-enforcing Builder tool dispatcher required')
    return freeze({authority,public:validateBuilderManifest(resolvePublicManifest(key),key),tools})
  }
  const validate=row=>{
    if(row.failed)throw fail('Builder root fenced after uncertain execution')
    if(!isDeepStrictEqual(resolve(row.key),row.accepted))throw fail('Builder authority or manifest changed')
  }
  const describe=row=>freeze({contextKey:row.key,sessionId:row.accepted.authority.session_id,state:'opened'})
  const inspect=key=>{
    const row=rows.get(key);if(!row||row.busy)throw fail('Builder unavailable or busy')
    validate(row);return {...describe(row),eventCount:row.handle.agent.session.snapshotEvents().length}
  }
  async function open(key,mode){
    if(closed||rows.has(key)||pending.has(key))throw fail('Builder closed or already owned')
    const accepted=resolve(key),ctx=new Context(),row={key,accepted,ctx,busy:false,failed:false,errors:[]}
    const task=(async()=>{
      try{
        await ctx.plugin(SessionStore);await ctx.plugin(AgentRegistry);await ctx.plugin(Projections)
        await ctx.plugin(Jsonl,{root:persistenceRoot,compression:'none'})
        await ctx.plugin(SystemPrompt,{includeHarnessIdentity:false,includeRuntimeContext:false})
        mountPublicManifest(ctx.systemPrompt,accepted.public)
        await ctx.plugin(Tools);await ctx.plugin(LlmRuntime)
        const original=ctx.sessions,backend=ctx.sessionPersistence
        const adapter=createScopedBuilderSessionAdapter(original,id=>{
          validate(row);if(id!==accepted.authority.session_id)throw fail('Foreign Builder session')
          return {mode,authority:journal(accepted.authority)}
        })
        for(const descriptor of accepted.tools)ctx.tools.register({...descriptor,
          output:{schema:{type:'object'},render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
          execute:async(args,execution)=>{
            try{
              validate(row);await row.sourceCheck?.()
              const agent=row.handle?.agent,actual=agent?.[symbols.original]??agent
              if(!row.busy||!row.sourceCheck||!agent||(execution?.agent?.[symbols.original]??execution?.agent)!==actual)throw fail('Builder tool has no owned active source')
              const parameters={session:agent.session,authority:accepted.authority,source:row.source,execution,name:descriptor.name,args:structuredClone(args)}
              const invocation=deriveBuilderToolInvocation(parameters)
              if(await original.flush(agent.session)!==true)throw fail('Builder tool durability unavailable')
              validate(row);await row.sourceCheck()
              if(!isDeepStrictEqual(invocation,deriveBuilderToolInvocation(parameters)))throw fail('Builder tool changed during flush')
              const request=freeze(structuredClone({authority:accepted.authority,source:row.source,invocation,
                schema_sha256:canonicalManifestHash(descriptor),name:descriptor.name,args:parameters.args}))
              // Must execute the existing official grant/lock/admission path. An
              // arbitrary RPC response, client flag or schema is not permission.
              const result=await invokeGranted(request)
              validate(row);await row.sourceCheck()
              return result
            }catch(error){row.failed=true;throw error}
          }})
        class BuilderTransport extends LlmAdapter{
          async *stream(request){
            validate(row)
            if(!row.busy||!row.sourceCheck)throw fail('Builder model has no owned source')
            await row.sourceCheck()
            if(request.provider!==route.provider||request.model!==route.model||request.reasoningEffort!==route.reasoningEffort)throw fail('Builder model selection changed')
            const stream=await adapter.dispatch(original.get(request.sessionId),request,input=>dispatch(input))
            if(!stream?.[Symbol.asyncIterator])throw fail('Builder model must return async stream')
            for await(const chunk of stream){validate(row);await row.sourceCheck();yield chunk}
          }
        }
        ctx.llm.registerAdapter([route.provider],new BuilderTransport())
        ctx.on('agent/error',event=>row.errors.push(String(event.error?.message??event.error)))
        const scope=ctx.isolate('sessions').isolate('sessionPersistence')
        const service=await scope.plugin(function builderOwnedServices(c){
          c.provide('sessions',adapter.sessions)
          c.provide('sessionPersistence',{
            create(header,options){validate(row);if(mode!=='fresh'||header.id!==accepted.authority.session_id)throw fail('Foreign Builder persistence create');return backend.create(header,options)},
            open(id,access){validate(row);if(mode!=='restore'||id!==accepted.authority.session_id||access!=='write')throw fail('Foreign Builder persistence open');return backend.open(id,access)},
          })
        })
        const loop=await service.ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:1}),factory=loop.ctx.get('agentLoop')
        const setup=async(c,agent)=>{
          validate(row);bindPublicManifest(agent.session,accepted.public,mode,{authority:accepted.authority,tools:accepted.tools})
          const scoped=createScope(c,agent[symbols.original]??agent).ctx
          agent.ctx=scoped.extend({sessions:scoped.reflect.trace(adapter.sessions)})
        }
        row.handle=mode==='fresh'?await factory.createAgent(service.ctx,{sessionId:accepted.authority.session_id,agentOptions:route,setup})
          :await factory.resume(service.ctx,{resumeSessionId:accepted.authority.session_id,agentOptions:route,setup})
        row.store=original;rows.set(key,row);return describe(row)
      }catch(error){await row.handle?.dispose().catch(()=>{});await ctx.fiber.dispose().catch(()=>{});throw error}
    })()
    pending.set(key,task)
    try{return await task}finally{pending.delete(key)}
  }
  async function followupReceipt(key,value){
    const row=rows.get(key)
    if(closed||!row||row.busy||row.failed)throw fail('Builder unavailable, failed or busy')
    const source=freeze(validateBuilderInput(row.accepted.authority,value)),request=source.request
    validate(row)
    row.busy=true
    row.source=source
    row.sourceCheck=async()=>{
      validate(row)
      const current=validateBuilderInput(row.accepted.authority,await resolveInput(key,request.request_id))
      if(!isDeepStrictEqual(current,source))throw fail('Builder owner source changed')
    }
    let appended=false
    try{
      await row.sourceCheck()
      const events=row.handle.agent.session.snapshotEvents(),prior=events.find(e=>e.type===BUILDER_INPUT_RECORD&&e.data.source.request.request_id===request.request_id)
      if(prior)throw fail(isDeepStrictEqual(prior.data.source,source)?'Builder input already recorded; recover outcome, never replay':'Builder input identity conflict')
      const message=createUserMessage({source:{kind:'user'},content:[{type:'text',text:request.content}]})
      const start=row.handle.agent.session.seq
      appendPluginRecord(row.handle.agent.session,BUILDER_INPUT_RECORD,{version:1,authority:row.accepted.authority,source,message_id:message.id})
      appended=true
      if(await row.store.flush(row.handle.agent.session)!==true)throw fail('Builder input durability unavailable')
      await row.sourceCheck();row.handle.agent.followup(message);await row.handle.agent.whenIdle()
      if(row.errors.length)throw fail(row.errors.at(-1))
      if(await row.store.flush(row.handle.agent.session)!==true)throw fail('Builder outcome durability unavailable')
      await row.sourceCheck()
      const snapshot=row.handle.agent.session.snapshotEvents(),last=snapshot.filter(e=>e.seq>=start&&e.type==='assistant/message').at(-1)
      const finalText=last?.data?.message?.content?.filter(block=>block.type==='text').map(block=>block.text).join('')
      testCapture?.(key,freeze({events:structuredClone(snapshot),messages:structuredClone(row.handle.agent.session.deriveMessages())}))
      return freeze({...describe(row),state:'completed',published:false,inputId:request.request_id,...(finalText?{finalText}:{})})
    }catch(error){if(appended)row.failed=true;throw error}
    finally{row.busy=false;delete row.source;delete row.sourceCheck}
  }
  async function close(key){
    if(key===undefined){
      if([...rows.values()].some(row=>row.busy))throw fail('Active Builder turn cannot close')
      closed=true;await Promise.allSettled([...pending.values()]);for(const id of [...rows.keys()])await close(id);return
    }
    if(pending.has(key))await pending.get(key)
    const row=rows.get(key);if(!row)return
    if(row.busy)throw fail('Active Builder turn cannot close')
    rows.delete(key);try{await row.handle.dispose()}finally{await row.ctx.fiber.dispose()}
  }
  return Object.freeze({create:key=>open(key,'fresh'),restore:key=>open(key,'restore'),followupReceipt,inspect,close})
}

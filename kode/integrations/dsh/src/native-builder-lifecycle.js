/** Trusted draft mode in the existing native lifecycle. No new executor/profile,
 * catalog, credential store or role-specific model definition is created here.
 * The Host must install kodeBuilderRuntime only in a fresh independent Context.
 */
import {symbols} from '@deepseek-ai/cordis'
import {isDeepStrictEqual} from 'node:util'
import {isAbsolute} from 'node:path'
import {appendPluginRecord,Session} from '@deepseek-ai/dsh-session'
import {validateBuilderAuthority} from './builder-context-scope.js'
import {createScopedBuilderSessionAdapter} from './scoped-builder-session-adapter.js'
import {validateBuilderManifest,validateBuilderToolManifest,bindPublicManifest} from './scoped-builder-manifest.js'
import {validateBuilderInput,BUILDER_INPUT_RECORD} from './scoped-builder-input.js'
import {deliveryInputId} from './delivery-tracker.js'
const bindings=new WeakMap(),roots=new WeakMap()
const fail=message=>Object.assign(Error(message),{code:'NATIVE_BUILDER_REJECTED'})
const actual=agent=>agent?.[symbols.original]??agent
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value)}return value}
export const isBuilderSessionId=id=>typeof id==='string'&&/^builder-context-[a-f0-9]{64}$/.test(id)
export const nativeBuilderBinding=agent=>bindings.get(actual(agent))
const messagesOf=session=>Session.prototype.snapshotEvents.call(session)
const model=value=>{
  if(!value||Object.keys(value).some(k=>!['provider','model','reasoningEffort'].includes(k))
    ||typeof value.provider!=='string'||!/^kode-agent-[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value.provider)
    ||typeof value.model!=='string'||!value.model||value.model==='default'
    ||value.reasoningEffort!==undefined&&(typeof value.reasoningEffort!=='string'||!value.reasoningEffort))throw fail('Exact original native model selection required')
  return structuredClone(value)
}
function inputMatches(message,source){
  return message?.id===deliveryInputId(source.receipt.message_id)&&message.role==='user'
    &&isDeepStrictEqual(message.source,{kind:'user'})
    &&isDeepStrictEqual(message.content,[{type:'text',text:source.request.content}])
}
function history(row,session,{restoring=false}={}){
  const events=messagesOf(session),records=events.filter(e=>e.type===BUILDER_INPUT_RECORD),seen=new Set()
  for(const record of records){
    const data=record.data,source=validateBuilderInput(row.authority,data?.source)
    if(data.version!==1||!isDeepStrictEqual(data.authority,row.authority)||data.message_id!==deliveryInputId(source.receipt.message_id)
      ||seen.has(source.request.request_id))throw fail('Native Builder source journal changed')
    seen.add(source.request.request_id)
    const users=events.filter(e=>e.type==='user/message'&&e.data.id===data.message_id)
    if(users.length>1||users.some(e=>e.seq<=record.seq||!inputMatches(e.data,source)))throw fail('Native Builder input journal mismatch')
    if(restoring){
      const user=users[0],end=user&&events.find(e=>e.seq>user.seq&&e.type==='turn/end')
      if(!user||!end||end.data.reason?.kind!=='completed')throw fail('Native Builder interrupted or pending source requires reconciliation; no replay')
    }
  }
  for(const event of events.filter(e=>e.type==='user/message'))if(!records.some(r=>r.data.message_id===event.data.id))throw fail('Native Builder has an unowned input')
}
export async function prepareNativeBuilderSession(ctx,options,restore){
  const id=options.resumeSessionId??options.sessionId
  const existing=ctx.get('kodeAgents')?.profiles?.binding?.(id)
  if(!isBuilderSessionId(id)&&!existing?.managedBuilder)return null
  const service=ctx.get('kodeBuilderRuntime'),mode=restore?'restore':'fresh'
  if(!service||!['sessionAdmission','setupAgent','assertSession','inputReceipt','revalidateInput'].every(k=>typeof service[k]==='function'))throw fail('Native Builder Host authority unavailable')
  if(options.seed!==undefined||options.parentAgent!==undefined||options.inheritedEventCount!==undefined
    ||options.meta?.parentSession!==undefined||options.meta?.isSeeded===true||options.builder_context!==undefined||options.context_scope!==undefined)throw fail('Native Builder forbids inherited or caller-authored context')
  const snapshot=structuredClone(await service.sessionAdmission(id,{mode})),authority=validateBuilderAuthority(snapshot?.authority)
  if(Object.keys(snapshot).sort().join(',')!=='authority,cwd,public_manifest,selection,tool_manifest'
    ||authority.session_id!==id||!isAbsolute(snapshot.cwd??'')||options.meta?.cwd!==undefined&&options.meta.cwd!==snapshot.cwd)throw fail('Native Builder admission identity or workspace mismatch')
  const selection=model(snapshot.selection)
  if(!isDeepStrictEqual(model(options.agentOptions),selection))throw fail('Native Builder selection differs from owner configuration')
  const root=ctx.root,old=roots.get(root)
  if(old&&old!==authority.context_key||ctx.sessions.list().some(s=>s.id!==id)||ctx.agents.list().some(a=>a.id!==id))throw fail('Native Builder requires a draft-only independent root')
  roots.set(root,authority.context_key)
  const row={service,authority:freeze(authority),snapshot:freeze(snapshot),selection:freeze(selection),
    public:validateBuilderManifest(snapshot.public_manifest,authority.context_key),tools:freeze(validateBuilderToolManifest(snapshot.tool_manifest)),pending:Promise.resolve(),failed:false}
  const adapter=createScopedBuilderSessionAdapter(ctx.sessions,sessionId=>{
    if(sessionId!==id)throw fail('Foreign session in Native Builder root')
    return {mode,authority:{builder_context:authority.builder_context,session_id:id,journal_id:authority.journal_id}}
  })
  const fiber=await ctx.isolate('sessions').plugin({name:'native-builder-sessions',
    inject:['sessionPersistence','sessionProjections','agents','kodeAgents','tools'],
    apply(scope){scope.provide('sessions',adapter.sessions)},
  })
  return {
    ctx:fiber.ctx,cwd:snapshot.cwd,
    bind(session){bindPublicManifest(session,row.public,mode,{authority,tools:row.tools});history(row,session,{restoring:restore})},
    async setup(agent){
      bindings.set(actual(agent),row)
      await service.setupAgent(agent,{authority,mode})
      await this.check(agent)
    },
    async check(agent){
      if(await service.assertSession(agent,{authority})===false)throw fail('Native Builder authority unavailable')
      if(!isDeepStrictEqual(await service.sessionAdmission(id,{mode}),snapshot))throw fail('Native Builder admission changed')
      if(!isDeepStrictEqual(validateBuilderToolManifest(agent.ctx.tools.schemas(agent)),row.tools))throw fail('Native Builder tools differ from approved manifest')
      history(row,agent.session)
    },
    async close(agent){if(agent)bindings.delete(actual(agent));await fiber.dispose()},
  }
}
export function assertNativeBuilderAction(agent,action){if(nativeBuilderBinding(agent))throw fail(`Native Builder cannot ${action}`)}
export function enqueueNativeBuilderInput(agent,message){
  const row=nativeBuilderBinding(agent)
  if(!row)throw fail('Native Builder input has no owner')
  const input=structuredClone(message),source=freeze(validateBuilderInput(row.authority,row.service.inputReceipt(agent,input)))
  if(!inputMatches(input,source))throw fail('Native Builder input is not its staged owner receipt')
  const work=row.pending.then(async()=>{
    if(row.failed||agent.disposed)throw fail('Native Builder input fenced after uncertain submission or disposal')
    const check=async()=>{
      if(await row.service.assertSession(agent,{authority:row.authority})===false)throw fail('Native Builder authority unavailable')
      if(await row.service.revalidateInput(agent,source)===false)throw fail('Native Builder owner source unavailable')
    }
    await check()
    const prior=messagesOf(agent.session).find(e=>e.type===BUILDER_INPUT_RECORD&&e.data.source.request.request_id===source.request.request_id)
    if(prior)throw fail('Native Builder input already recorded; reconcile without replay')
    let appended=false
    try{
      appendPluginRecord(agent.session,BUILDER_INPUT_RECORD,{version:1,authority:row.authority,source,message_id:input.id});appended=true
      if(await agent.ctx.sessions.flush(agent.session)!==true)throw fail('Native Builder source durability unavailable')
      await check()
      agent.inbox.append('next-turn',input)
      if(await agent.ctx.sessions.flush(agent.session)!==true)throw fail('Native Builder inbox durability unavailable')
      agent.parked=false;agent.wake()
      return {input_id:input.id,source_message_id:source.receipt.message_id,state:'queued'}
    }catch(error){if(appended)row.failed=true;throw error}
  })
  row.pending=work.catch(()=>{});return work
}
export async function awaitNativeBuilderInput(agent){await nativeBuilderBinding(agent)?.pending}
export async function assertNativeBuilderTurn(agent,{selection,messages,tools,nativeContinuation}){
  const row=nativeBuilderBinding(agent);if(!row)return
  if(row.failed||nativeContinuation||messages.length!==1||!isDeepStrictEqual(model(selection),row.selection)
    ||!isDeepStrictEqual(validateBuilderToolManifest(tools),row.tools))throw fail('Native Builder turn exceeds exact owner configuration')
  const message=messages[0],record=messagesOf(agent.session).find(e=>e.type===BUILDER_INPUT_RECORD&&e.data.message_id===message.id)
  if(!record||!inputMatches(message,record.data.source))throw fail('Native Builder input has no durable source')
  if(await row.service.assertSession(agent,{authority:row.authority})===false||await row.service.revalidateInput(agent,record.data.source)===false)throw fail('Native Builder source authority changed')
  if(await agent.ctx.sessions.flush(agent.session)!==true)throw fail('Native Builder turn durability unavailable')
}

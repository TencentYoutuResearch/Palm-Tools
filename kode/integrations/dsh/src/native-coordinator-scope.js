/** Scope ownership inside the existing native factory/driver. Not a provider,
 * model catalog or Hub grant. Native CLI policy/accounting remain unchanged. */
import {symbols} from '@deepseek-ai/cordis'
import {Session,appendPluginRecord} from '@deepseek-ai/dsh-session'
import {isDeepStrictEqual} from 'node:util'
import {isAbsolute} from 'node:path'
import {createHash} from 'node:crypto'
import {contextScopeKey,discussionScopeId} from './context-scope.js'
import {createScopedCoordinatorSessionAdapter} from './scoped-coordinator-session-adapter.js'
import {deliveryInputId} from './delivery-tracker.js'
const owners=new WeakMap(),SOURCE='plugin:kode/native-scoped-input'
const actual=a=>a?.[symbols.original]??a
const fail=m=>Object.assign(Error(m),{code:'NATIVE_SCOPE_REJECTED'})
const hash=s=>createHash('sha256').update(s).digest('hex')
const events=s=>Session.prototype.snapshotEvents.call(s)
export const isNativeCoordinatorId=id=>typeof id==='string'&&/^context-[a-f0-9]{64}$/.test(id)
export const nativeCoordinatorBinding=agent=>owners.get(actual(agent))
function source(row,message,proof){
  const p=structuredClone(proof),a=row.snapshot.authority,e=p?.entry,m=p?.message
  if(!isDeepStrictEqual(p?.authority,a)||e?.context_key!==a.context_key||e.journal_id!==a.journal_id||e.operation_id!==a.operation_id
    ||e.state!=='claimed'||typeof e.id!=='string'||!e.id||typeof e.claim_id!=='string'||!e.claim_id
    ||m?.id!==e.source_message_id||typeof m?.content!=='string'||hash(m.content)!==e.source_content_sha256
    ||!isDeepStrictEqual(m.actor,{kind:'human',id:'local_owner'})||!isDeepStrictEqual(m.scope,a.origin)
    ||discussionScopeId(m.surface_id,m.thread_id)!==a.context_scope.scope_id
    ||message?.id!==deliveryInputId(e.id)||message.role!=='user'||!isDeepStrictEqual(message.source,{kind:'user'})
    ||!isDeepStrictEqual(message.content,[{type:'text',text:m.content}]))throw fail('Native scope input differs from exact owner claim')
  return p
}
function checkHistory(row,session,restore=false){
  const log=events(session),records=log.filter(e=>e.type===SOURCE),seen=new Set()
  for(const record of records){
    const {message,proof}=record.data;source(row,message,proof)
    if(seen.has(proof.entry.id))throw fail('Duplicate native scope input receipt');seen.add(proof.entry.id)
    const users=log.filter(e=>e.type==='user/message'&&e.data.id===message.id)
    if(users.length>1||users.some(e=>e.seq<=record.seq||!isDeepStrictEqual(e.data,message)))throw fail('Native scope journal input mismatch')
    if(restore&&(!users.length||!log.some(e=>e.seq>users[0].seq&&e.type==='turn/end'&&e.data.reason?.kind==='completed')))throw fail('Uncertain native input cannot replay on restore')
  }
  if(log.some(e=>e.type==='user/message'&&!records.some(r=>r.data.message.id===e.data.id)))throw fail('Foreign native user history')
}
export async function prepareNativeCoordinatorSession(ctx,options,restore){
  const id=options.resumeSessionId??options.sessionId
  if(!isNativeCoordinatorId(id))return null
  const service=ctx.get('kodeCoordinatorScopeRuntime'),mode=restore?'restore':'fresh'
  if(!service||!['sessionAdmission','setupAgent','assertSession','inputReceipt','revalidateInput'].every(k=>typeof service[k]==='function'))throw fail('Native scope Host unavailable')
  if(options.seed!==undefined||options.parentAgent!==undefined||options.inheritedEventCount!==undefined||options.meta?.parentSession!==undefined||options.meta?.isSeeded===true)throw fail('Native scope forbids inherited history')
  const snapshot=structuredClone(await service.sessionAdmission(id,{mode})),a=snapshot?.authority
  if(!a||Object.keys(snapshot).sort().join(',')!=='authority,cwd,selection'||a.context_key!==contextScopeKey(a.context_scope)
    ||a.session_id!==id||id!==`context-${a.context_key}`||!['discussion_thread','team_private'].includes(a.context_scope.kind)
    ||typeof a.journal_id!=='string'||!a.journal_id||!isAbsolute(snapshot.cwd??'')
    ||options.meta?.cwd!==undefined&&options.meta.cwd!==snapshot.cwd||!isDeepStrictEqual(options.agentOptions,snapshot.selection)
    ||!snapshot.selection?.provider?.startsWith('kode-agent-')||!snapshot.selection.model||snapshot.selection.model==='default')throw fail('Exact original native scope selection required')
  const row={snapshot,service,pending:Promise.resolve(),failed:false}
  const adapter=createScopedCoordinatorSessionAdapter(ctx.sessions,sid=>{if(sid!==id)throw fail('Foreign scope Session');return {mode,authority:{context_scope:a.context_scope,session_id:id,journal_id:a.journal_id}}})
  const scopedTools=Object.freeze({schemas:()=>[]})
  const fiber=await ctx.isolate('sessions').isolate('tools').plugin({name:'native-coordinator-sessions',inject:['sessionPersistence','sessionProjections','agents','kodeAgents'],apply(c){c.provide('sessions',adapter.sessions);c.provide('tools',scopedTools)}})
  const check=async agent=>{
    if(await service.assertSession(agent,{authority:a})===false||!isDeepStrictEqual(await service.sessionAdmission(id,{mode}),snapshot))throw fail('Native scope authority changed')
    if(agent.ctx.tools.schemas(agent).length)throw fail('Native conversation cannot inherit parent DSH tools')
    checkHistory(row,agent.session)
  }
  row.check=check
  return {ctx:fiber.ctx.extend({tools:scopedTools}),cwd:snapshot.cwd,bind:s=>checkHistory(row,s,restore),
    async setup(agent){owners.set(actual(agent),row);await service.setupAgent(agent,{authority:a,mode});await check(agent)},check,
    async close(agent){if(agent)owners.delete(actual(agent));await fiber.dispose()}}
}
export function assertNativeCoordinatorAction(agent,action){if(nativeCoordinatorBinding(agent))throw fail(`Native scope cannot ${action}`)}
export function enqueueNativeCoordinatorInput(agent,message){
  const row=nativeCoordinatorBinding(agent);if(!row)throw fail('No native scope owner')
  const input=structuredClone(message),proof=source(row,input,row.service.inputReceipt(agent,input))
  const task=row.pending.then(async()=>{
    if(row.failed||agent.disposed)throw fail('Native scope input is fenced')
    await row.check(agent)
    if(await row.service.revalidateInput(agent,proof)===false)throw fail('Native source revoked')
    if(events(agent.session).some(e=>e.type===SOURCE&&e.data.proof.entry.id===proof.entry.id))throw fail('Input already recorded; no replay')
    try{
      appendPluginRecord(agent.session,SOURCE,{version:1,message:input,proof})
      if(await agent.ctx.sessions.flush(agent.session)!==true)throw fail('Native scope source not durable')
      await row.check(agent);if(await row.service.revalidateInput(agent,proof)===false)throw fail('Native source revoked')
      agent.inbox.append('next-turn',input)
      if(await agent.ctx.sessions.flush(agent.session)!==true)throw fail('Native scope inbox not durable')
      agent.parked=false;agent.wake();return {state:'queued',entry_id:proof.entry.id}
    }catch(error){row.failed=true;throw error}
  });row.pending=task.catch(()=>{});return task
}
export async function awaitNativeCoordinatorInput(agent){await nativeCoordinatorBinding(agent)?.pending}
export async function assertNativeCoordinatorTurn(agent,{selection,messages,tools,nativeContinuation}){
  const row=nativeCoordinatorBinding(agent);if(!row)return
  if(row.failed||nativeContinuation||messages.length!==1||tools.length||!isDeepStrictEqual(selection,row.snapshot.selection))throw fail('Native scope turn differs from exact selection/source')
  const record=events(agent.session).find(e=>e.type===SOURCE&&e.data.message.id===messages[0].id)
  if(!record)throw fail('Missing native scope source receipt')
  source(row,messages[0],record.data.proof);await row.check(agent)
  if(await row.service.revalidateInput(agent,record.data.proof)===false)throw fail('Native scope source revoked')
  if(await agent.ctx.sessions.flush(agent.session)!==true)throw fail('Native scope turn not durable')
}

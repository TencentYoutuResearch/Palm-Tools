/** Unwired pre-init adapter for the real AgentLoop's single persistence writer.
 * resolveAdmission is a trusted Host callback, not user options or journal data.
 * Host owns all Session writes. This does not authorize tools or enable v2 runtime.
 */
import {isDeepStrictEqual} from 'node:util'
import {symbols} from '@deepseek-ai/cordis'
import {Session,appendPluginRecord,pluginRecordOf} from '@deepseek-ai/dsh-session'
import {snapshotProviderRequest,verifyProviderRequest,scopedProviderLifetime} from './scoped-provider-transport.js'

const fail=message=>Object.assign(Error(message),{code:'SCOPED_SESSION_REJECTED'})
const eventsOf=session=>Session.prototype.snapshotEvents.call(session)
const canonicalHeader=header=>({...header,delegationDepth:header.delegationDepth??0})
const freeze=value=>{
  if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value)}
  return value
}
function verify(session,authority,MARKER){
  if(!(session instanceof Session)||session.id!==authority.session_id||session.header.isSeeded!==false
    ||session.header.parentSession!==undefined||session.inheritedEventCount!==0)throw fail('Session lineage or identity mismatch')
  const events=eventsOf(session),markers=events.filter(e=>pluginRecordOf(e)?.type===MARKER)
  if(markers.length!==1||markers[0].seq!==0||!isDeepStrictEqual(markers[0].data,{version:1,authority,header:canonicalHeader(session.header)})
    ||events.some(e=>e.type==='session/end-seed'&&e.data.inherited))throw fail('Scoped journal origin or generation mismatch')
  return events
}

export function createIsolatedRuntimeSessionAdapter(originalSessions,resolveAdmission,{recordName:MARKER,normalizeAuthority,isReservedId}){
  if(typeof MARKER!=='string'||!MARKER.startsWith('plugin:')||typeof normalizeAuthority!=='function'||typeof isReservedId!=='function')throw fail('Trusted domain journal policy required')
  const trusted=(value,id)=>{
    const admission=structuredClone(value)
    if(!admission||!['fresh','restore'].includes(admission.mode)||Object.keys(admission).some(k=>!['mode','authority'].includes(k)))throw fail('Missing trusted scoped admission')
    admission.authority=structuredClone(normalizeAuthority(admission.authority,id))
    if(admission.authority?.session_id!==id||typeof admission.authority.journal_id!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(admission.authority.journal_id))throw fail('Trusted domain session mismatch')
    return freeze(admission)
  }
  if(typeof originalSessions?.prepare!=='function'||typeof originalSessions?.flush!=='function'||typeof resolveAdmission!=='function')throw fail('Real SessionStore and trusted resolver required')
  const owned=new WeakMap(),busy=new WeakSet(),failed=new WeakSet()
  const prepare=(id,options)=>{
    const source=resolveAdmission(id)
    // A trusted registry may identify an existing legacy session even when its
    // historical name collides with the reserved v2 identity shape.
    if(source?.mode==='legacy'&&Object.keys(source).length===1)return originalSessions.prepare(id,options)
    if(source===undefined){
      if(isReservedId(id))throw fail('Reserved scoped identity has no Host admission')
      return originalSessions.prepare(id,options)
    }
    const admission=trusted(source,id),a=admission.authority
    if(options&&Object.hasOwn(options,'context_scope'))throw fail('User-provided context authority is forbidden')
    if(admission.mode==='fresh'&&(options?.seed!==undefined||options?.eventState!==undefined
      ||options?.inheritedEventCount!==undefined||options?.meta?.parentSession!==undefined||options?.meta?.isSeeded===true)){
      throw fail('Fresh scope forbids seed, restore and parent options')
    }
    if(admission.mode==='restore'&&(!['detached','shared-frozen'].includes(options?.eventState)||!Array.isArray(options?.seed)))throw fail('Restore requires factory-owned restored events')
    const session=originalSessions.prepare(id,options)
    if(admission.mode==='fresh'){
      if(!(session instanceof Session)||session.id!==id||session.header.isSeeded!==false||session.header.parentSession!==undefined
        ||session.inheritedEventCount!==0||session.firstLiveSeq!==0||session.firstLifecycleSeq!==0||eventsOf(session).length!==0)throw fail('Fresh scope requires empty real Session')
      appendPluginRecord(session,MARKER,{version:1,authority:a,header:canonicalHeader(session.header)})
    }
    verify(session,a,MARKER);owned.set(session,a)
    return session
  }
  // Cordis discovers services through property descriptors. Getter-only proxies
  // lose the injected service contract on the Agent's child scope. Keep the
  // real service prototype, with explicit forwarding methods on this facade.
  const raw=originalSessions[symbols.original]??originalSessions
  const sessions=Object.create(raw)
  // Cordis createShadow inspects an OWN ctx descriptor when carrying method
  // ownership; an inherited ctx would lose the Agent's scope tag on enter().
  Object.defineProperty(sessions,'ctx',{configurable:true,value:raw.ctx})
  for(let prototype=raw;prototype&&prototype!==Object.prototype;prototype=Object.getPrototypeOf(prototype)){
    for(const key of Object.getOwnPropertyNames(prototype)){
      if(key==='constructor'||key==='prepare'||Object.hasOwn(sessions,key))continue
      const descriptor=Object.getOwnPropertyDescriptor(prototype,key)
      if(typeof descriptor?.value==='function')Object.defineProperty(sessions,key,{configurable:true,value:function(...args){
        // Rebind the SAME store to the caller's Cordis context. Binding permanently
        // to the root would lose agent-scoped session/event and flush carriers.
        return this.ctx.reflect.trace(raw)[key](...args)
      }})
    }
  }
  Object.defineProperty(sessions,'prepare',{configurable:true,value:prepare})
  const inspect=session=>{
    const authority=owned.get(session)
    if(!authority||failed.has(session)||originalSessions.get(session.id)!==session)throw fail('Scoped session is not the live owned object')
    const latest=trusted(resolveAdmission(session.id),session.id).authority
    if(!isDeepStrictEqual(latest,authority))throw fail('Host journal authority changed')
    return verify(session,authority,MARKER)
  }
  const dispatch=async(session,candidate,provider)=>{
    if(busy.has(session))throw fail('Scoped session dispatch already in progress')
    if(typeof provider!=='function')throw fail('Provider callback required')
    // Snapshot caller values before any await; later mutations cannot inject history.
    const input=snapshotProviderRequest(candidate)
    busy.add(session)
    let transferred=false
    try{
      const before=inspect(session)
      try{if(await originalSessions.flush(session)!==true)throw fail('No session durability listener')}
      catch(error){failed.add(session);throw error}
      if(!isDeepStrictEqual(inspect(session),before))throw fail('Session changed during durability barrier')
      const header=Session.prototype.requestHeader.call(session)
      if(!header)throw fail('Committed request header required')
      const expected={...header.config,sessionId:session.id,messages:Session.prototype.deriveMessages.call(session),
        toolHistory:Session.prototype.toolHistory.call(session),tools:header.tools??[]}
      const request=verifyProviderRequest(input,expected)
      transferred=true
      return await scopedProviderLifetime({invoke:()=>provider(request),signal:input.signal,
        release:()=>busy.delete(session),failed:()=>failed.add(session),validate:()=>inspect(session)})
    }finally{if(!transferred)busy.delete(session)}
  }
  return {sessions,dispatch}
}

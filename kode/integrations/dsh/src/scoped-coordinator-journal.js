/** Unwired v2 journal primitive. Does NOT enable scoped Coordinator execution.
 * Authority must come from the Host's independently verified scope registry, never
 * a model request, event label, or the journal being restored. The Host must own
 * all writes to the Session; this is not a sandbox against a malicious Host.
 * Detached DSH sessions are used here. Do not attach a second persistence writer.
 */
import { isDeepStrictEqual } from 'node:util'
import { Session, appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { validateContextScope, contextScopeKey } from './context-scope.js'
import {scopedProviderLifetime} from './scoped-provider-transport.js'

export const SCOPED_COORDINATOR_JOURNAL_RECORD = 'plugin:kode/scoped-coordinator-journal'
const token = Symbol('owned scoped journal'), owners = new WeakMap()
const fail = message => Object.assign(Error(message), {code:'SCOPED_JOURNAL_REJECTED'})
const eventsOf = session => Session.prototype.snapshotEvents.call(session)
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
// DSH JSONL materializes the documented absent (zero) delegation depth on read.
const durableHeader = header => ({...header,delegationDepth:header.delegationDepth??0})
const freezeRequest = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeRequest(child)
    Object.freeze(value)
  }
  return value
}

function authorityOf(value) {
  const authority = structuredClone(value)
  if (!authority || Object.keys(authority).length !== 3
      || !['context_scope','session_id','journal_id'].every(key => Object.hasOwn(authority,key))
      || !id(authority.session_id) || !id(authority.journal_id)) throw fail('Invalid trusted journal authority')
  authority.context_scope = validateContextScope(authority.context_scope)
  if (authority.context_scope.kind === 'builder_draft') throw fail('Builder context is not a Coordinator journal')
  if (authority.session_id !== `context-${contextScopeKey(authority.context_scope)}`) throw fail('Session identity differs from trusted context key')
  return Object.freeze(authority)
}

function assertHeader(header, inherited, authority) {
  if (!header || header.id !== authority.session_id || header.isSeeded !== false
      || header.parentSession !== undefined || inherited !== 0) throw fail('Journal session identity or lineage mismatch')
}

function assertRecords(events, header, authority) {
  const markers = events.filter(event => pluginRecordOf(event)?.type === SCOPED_COORDINATOR_JOURNAL_RECORD)
  if (markers.length !== 1 || markers[0].seq !== 0
      || !isDeepStrictEqual(markers[0].data,{version:1,authority,header:durableHeader(header)})) {
    throw fail('Journal scope, generation, header or unique origin marker mismatch')
  }
  if (events.some(event => event.type === 'session/end-seed' && event.data.inherited)) {
    throw fail('Inherited journal history is forbidden')
  }
}

export class ScopedCoordinatorJournal {
  #session; #authority; #handle; #persisted; #closed = false; #busy = false; #failed = false
  constructor(secret,session,authority,handle,persisted) {
    if (secret !== token) throw fail('Use the journal creation or restoration boundary')
    this.#session=session; this.#authority=authority; this.#handle=handle; this.#persisted=persisted
    owners.set(session,this)
  }
  /** Return the actual owned DSH session for trusted Host append operations only. */
  get session() { return this.#session }

  static async create({session,persistence,authority}) {
    authority=authorityOf(authority)
    if (!(session instanceof Session) || owners.has(session)) throw fail('A fresh unowned DSH Session is required')
    const assertFresh=()=>{
      assertHeader(session.header,session.inheritedEventCount,authority)
      if (session.firstLiveSeq !== 0 || session.firstLifecycleSeq !== 0 || eventsOf(session).length !== 0) {
        throw fail('New scope requires empty, unseeded, non-restored history')
      }
    }
    assertFresh(); owners.set(session,token)
    let handle
    try {
      handle=await persistence.create(session.header,{inheritedEventCount:0})
      assertFresh()
      appendPluginRecord(session,SCOPED_COORDINATOR_JOURNAL_RECORD,{version:1,authority,header:durableHeader(session.header)})
      const journal=new ScopedCoordinatorJournal(token,session,authority,handle,0)
      await journal.flush(session)
      return journal
    } catch(error) {
      // Keep ownership fenced after an uncertain storage effect. No automatic retry.
      await handle?.close().catch(()=>{})
      throw error
    }
  }

  static async restore({persistence,authority}) {
    authority=authorityOf(authority)
    const handle=await persistence.open(authority.session_id,'write')
    try {
      assertHeader(handle.header,handle.inheritedEventCount,authority)
      const {events,eventState}=await handle.read()
      assertRecords(events,handle.header,authority)
      const session=Session.fromRestore(authority.session_id,events,handle.header,handle.inheritedEventCount,eventState)
      const journal=new ScopedCoordinatorJournal(token,session,authority,handle,events.length)
      // DSH appends an untagged restore boundary. Persist it, too.
      await journal.flush(session)
      return journal
    } catch(error) { await handle.close().catch(()=>{}); throw error }
  }

  #inspect(session) {
    if (this.#closed || this.#failed || session !== this.#session || owners.get(session) !== this
        || !(session instanceof Session)) throw fail('Journal is closed, failed or belongs to another Session')
    assertHeader(session.header,session.inheritedEventCount,this.#authority)
    const events=eventsOf(session)
    assertRecords(events,session.header,this.#authority)
    if (events.length < this.#persisted) throw fail('Journal history moved backwards')
    return events
  }

  async #flush(session) {
    const events=this.#inspect(session)
    try {
      if (events.length > this.#persisted) await this.#handle.append(events.slice(this.#persisted))
      await this.#handle.flush()
      this.#persisted=events.length
    } catch(error) { this.#failed=true; throw error }
    // No request assembled from an unflushed or concurrently modified tail.
    if (!isDeepStrictEqual(this.#inspect(session),events)) throw fail('Journal changed during durability checkpoint')
  }

  async flush(session) {
    if (this.#busy) throw fail('Journal action already in progress')
    this.#busy=true
    try { await this.#flush(session) } finally { this.#busy=false }
  }

  /** Build after durability; retain the lease through deferred stream completion. */
  async dispatch(session,route,provider,transport={}) {
    if (this.#busy) throw fail('Journal action already in progress')
    if(!transport||Object.keys(transport).some(key=>key!=='signal')
      ||transport.signal!==undefined&&!(transport.signal instanceof AbortSignal))throw fail('Only native transport signal is accepted')
    const signal=transport.signal
    const config=structuredClone(route)
    if (!config || Object.keys(config).some(key=>!['provider','model','reasoningEffort'].includes(key))
        || !['provider','model'].every(key=>typeof config[key]==='string' && config[key].length>0)
        || config.reasoningEffort !== undefined && typeof config.reasoningEffort !== 'string'
        || typeof provider !== 'function') throw fail('Only model routing is accepted; external request history is forbidden')
    this.#busy=true
    let transferred=false
    try {
      await this.#flush(session)
      this.#inspect(session)
      // Call concrete DSH methods, not caller-overridden methods or per-row labels.
      const header=Session.prototype.requestHeader.call(session)
      if (!header || !isDeepStrictEqual(header.config,config)) throw fail('Model route differs from committed request header')
      const request={...config,sessionId:session.id,
        messages:Session.prototype.deriveMessages.call(session),
        toolHistory:Session.prototype.toolHistory.call(session),tools:header.tools??[]}
      transferred=true
      return await scopedProviderLifetime({invoke:()=>provider(Object.freeze({...freezeRequest(structuredClone(request)),...(signal===undefined?{}:{signal})})),signal,
        release:()=>{this.#busy=false},failed:()=>{this.#failed=true},validate:()=>this.#inspect(session)})
    } finally { if(!transferred)this.#busy=false }
  }

  async close() {
    if (this.#closed) return
    if (this.#busy) throw fail('Journal action already in progress')
    this.#busy=true
    try { if (!this.#failed) await this.#flush(this.#session) }
    finally { this.#closed=true;this.#busy=false;await this.#handle.close() }
  }
}

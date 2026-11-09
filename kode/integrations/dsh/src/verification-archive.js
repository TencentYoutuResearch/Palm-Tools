/** Durable result upload; recovery replays observations and never executes commands. */
import { createHash } from 'node:crypto'
import { open, mkdir, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const digest = text => createHash('sha256').update(text).digest('hex')
export class VerificationArchive {
  constructor(client, profiles) { this.client=client; this.profiles=profiles; this.root=profiles.path ? join(dirname(profiles.path),'verification-archives') : null; this.pending=new Map(); this.stop=new AbortController() }
  async read(hash) {
    if(!this.root || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Verification archive storage required')
    const file=await open(join(this.root,`${hash}.json`),constants.O_RDONLY|constants.O_NOFOLLOW)
    try { const stat=await file.stat(); if(!stat.isFile() || stat.size>3*1024*1024) throw new Error('Verification archive bounds')
      const raw=await file.readFile('utf8'); if(digest(raw)!==hash) throw new Error('Verification archive changed');return raw
    } finally { await file.close() }
  }
  async put(raw) {
    if(!this.root) throw new Error('Verification archive storage required')
    await mkdir(this.root,{recursive:true,mode:0o700})
    if(!(await lstat(this.root)).isDirectory()) throw new Error('Verification archive directory changed')
    const hash=digest(raw)
    let file
    try { file=await open(join(this.root,`${hash}.json`),'wx',0o600) }
    catch(error) { if(error.code!=='EEXIST') throw error; if(await this.read(hash)!==raw) throw new Error('Verification archive identity conflict');return hash }
    try { await file.writeFile(raw);await file.sync() } finally { await file.close() }
    const directory=await open(this.root,'r');try {await directory.sync()}finally{await directory.close()}
    return hash
  }
  async record(session, operation, result) {
    const result_json=JSON.stringify(result), key=digest(JSON.stringify([operation.id,result.request_id]))
    if (Buffer.byteLength(result_json)>3*1024*1024) throw new Error('Verification record archive bounds')
    const record_hash=await this.put(result_json)
    await this.profiles.update(state=>{
      const binding=state.bindings[session]
      if (binding?.managedOperation?.id!==operation.id || binding.managedOperation.attempt!==operation.attempt || binding.managedOperation.epoch!==operation.epoch || binding.operationClosed) throw new Error('Verification archive operation changed')
      const rows=binding.verificationRecords??={}
      if (rows[key]) { if(rows[key].record_hash!==record_hash) throw new Error('Verification archive identity conflict'); return }
      if(Object.keys(rows).length>=128) throw new Error('Verification record archival compaction required')
      rows[key]={operation:structuredClone(operation),evidence_id:result.request_id,record_hash,home_reconciled:false}
    })
    await this.send(session,key)
    return structuredClone(this.profiles.binding(session).verificationRecords[key])
  }
  send(session,key) {
    const active=`${session}:${key}`
    if(this.pending.has(active)) return this.pending.get(active)
    const row=this.profiles.binding(session)?.verificationRecords?.[key]
    if(!row || row.home_reconciled || this.stop.signal.aborted) return Promise.resolve()
    const task=(async()=>{
      try {
        const observation=Object.values(this.profiles.binding(session).artifactOutbox??{}).find(r=>r.evidence.id===row.evidence_id && r.evidence.operation_id===row.operation.id && r.evidence.attempt===row.operation.attempt && r.evidence.epoch===row.operation.epoch)
        if(!observation?.home_reconciled || !Number.isSafeInteger(observation.home_sequence)) return
        const sequence=observation.home_sequence, result_json=await this.read(row.record_hash)
        const receipt=row.operation.home_node
          ? await deliverRemoteVerification(this.client, session, row.operation, sequence, result_json, this.stop.signal)
          : await this.client.call(`/api/v1/messaging/verification-records/${sequence}`,{result_json},this.stop.signal)
        if(receipt.sequence!==sequence || receipt.record_hash!==row.record_hash || (row.operation.home_node ? receipt.archived!==true : receipt.result_json!==result_json) || receipt.completion_authorized!==false) throw new Error('Verification archive receipt mismatch')
        await this.profiles.update(state=>{
          const saved=state.bindings[session]?.verificationRecords?.[key]
          if(saved?.record_hash!==row.record_hash) throw new Error('Verification archive changed')
          saved.home_reconciled=true;saved.sequence=sequence
        })
      } catch { /* Keep the exact durable record pending; never relaunch. */ }
    })().finally(()=>this.pending.delete(active))
    this.pending.set(active,task);return task
  }
  async flush() {
    for(const [session,binding] of Object.entries(this.profiles.bindings)) for(const key of Object.keys(binding.verificationRecords??{})) await this.send(session,key)
  }
  assertSettled(session,operation) {
    if(Object.values(this.profiles.binding(session)?.verificationRecords??{}).some(r=>r.operation.id===operation.id && r.operation.attempt===operation.attempt && !r.home_reconciled)) throw new Error('Verification command record requires home archival')
  }
  async awaitSettled(session,operation,{signal,assertOwner=async()=>{},timeoutMs=10000}={}){
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('Invalid verification archival deadline')
    const stop=signal?AbortSignal.any([signal,this.stop.signal]):this.stop.signal,deadline=performance.now()+timeoutMs
    while(true){
      stop.throwIfAborted();await assertOwner()
      const rows=Object.entries(this.profiles.binding(session)?.verificationRecords??{}).filter(([,row])=>row.operation.id===operation.id&&row.operation.attempt===operation.attempt&&row.operation.epoch===operation.epoch&&!row.home_reconciled)
      if(!rows.length)return
      // Only transmit the saved observation. This layer never launches a runner.
      for(const [key] of rows){stop.throwIfAborted();await this.send(session,key)}
      stop.throwIfAborted();await assertOwner()
      try{this.assertSettled(session,operation);return}catch(error){if(performance.now()>=deadline)throw error}
      await delay(Math.min(100,Math.max(1,deadline-performance.now())),undefined,{signal:stop})
    }
  }
  async close() { this.stop.abort(); await Promise.allSettled([...this.pending.values()]) }
}

export async function deliverRemoteVerification(client, session, operation, sequence, resultJson, signal) {
  const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
  if (![session, operation?.id, operation?.home_node].every(valid) || !Number.isSafeInteger(sequence) || sequence < 1
      || !Number.isSafeInteger(operation.attempt) || operation.attempt < 1 || typeof resultJson !== 'string') throw new Error('Invalid remote verification scope')
  const bytes = Buffer.from(resultJson), record_hash = digest(bytes)
  if (!bytes.length || bytes.length > 3 * 1024 * 1024) throw new Error('Verification record archive bounds')
  const call = action => client.call(`/api/v1/messaging/operation-accounting-relay/${encodeURIComponent(operation.home_node)}`, {
    operation_id: operation.id, worker_session: session, command: null, accounting: { attempt: operation.attempt, action },
  }, signal)
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    signal?.throwIfAborted()
    const data = bytes.subarray(offset, offset + 32768)
    const receipt = await call({ kind: 'verification_segment', sequence, segment: { record_hash, bytes: bytes.length, offset, data: data.toString('base64') } })
    if (receipt.sequence !== sequence || receipt.record_hash !== record_hash || receipt.bytes !== bytes.length || receipt.offset !== offset
        || receipt.segment_bytes !== data.length || receipt.completion_authorized !== false) throw new Error('Remote verification segment receipt mismatch')
  }
  const receipt = await call({ kind: 'verification_complete', sequence, record_hash })
  if (receipt.sequence !== sequence || receipt.record_hash !== record_hash || receipt.archived !== true || receipt.completion_authorized !== false) throw new Error('Remote verification completion receipt mismatch')
  return receipt
}

import { deliverArtifactArchive } from './artifact-transfer.js'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { captureArtifactBundle } from './artifact-snapshot.js'
import { ArtifactArchive, artifactSnapshotHash as snapshotHash } from './artifact-archive.js'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const same = (a, b) => a?.id === b?.id && a?.attempt === b?.attempt && a?.epoch === b?.epoch && (a?.home_node ?? null) === (b?.home_node ?? null)
const keyFor = (operation, id) => createHash('sha256').update(JSON.stringify([operation.id, id])).digest('hex')
/** Durable observations only. Recovery must never recapture files or execute verification. */
export class ArtifactOutbox {
  constructor(client, profiles) { this.client = client; this.profiles = profiles; this.archive = profiles.path ? new ArtifactArchive(join(dirname(profiles.path), 'artifact-archive')) : null; this.stop = new AbortController(); this.sending = new Map(); this.capturing = new Map(); this.cursor = 0 }
  async record(session, operation, id, payload, archive) {
    operation = structuredClone(operation)
    if (this.stop.signal.aborted) throw new Error('Artifact outbox closed')
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(id ?? '') || !operation?.id) throw new Error('Stable artifact identity required')
    const evidence = structuredClone({ id, operation_id: operation.id, attempt: operation.attempt, epoch: operation.epoch, payload })
    if (Buffer.byteLength(JSON.stringify(evidence)) > 65536) throw new Error('Artifact evidence too large')
    if (archive && (!this.archive || payload.kind !== 'artifact' || archive.snapshot_hash !== snapshotHash(payload))) throw new Error('Artifact archive reference mismatch')
    const key = keyFor(operation, id)
    await this.profiles.update(state => {
      const binding = state.bindings[session]
      if (!same(binding?.managedOperation, operation) || binding.operationClosed) throw new Error('Artifact operation changed')
      const rows = binding.artifactOutbox ??= {}
      if (rows[key]) { if (!isDeepStrictEqual(rows[key].evidence, evidence)) throw new Error('Artifact evidence identity conflict'); return }
      if (Object.keys(rows).length >= 128) throw new Error('Artifact outbox requires archival')
      rows[key] = { operation: structuredClone(operation), evidence, home_reconciled: false, ...(archive ? { archive: structuredClone(archive) } : {}) }
    })
    await this.send(session, key)
    return structuredClone(this.profiles.binding(session).artifactOutbox[key])
  }
  capture(session, operation, id, options) {
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(id ?? '') || !operation?.id) return Promise.reject(new Error('Stable artifact identity required'))
    const key = keyFor(operation, id), pendingKey = `${session}:${key}`
    if (this.capturing.has(pendingKey)) return this.capturing.get(pendingKey)
    const fixedOperation = structuredClone(operation), fixedOptions = { ...options }
    const task = (async () => {
      const binding = this.profiles.binding(session)
      if (this.stop.signal.aborted || !same(binding?.managedOperation, fixedOperation) || binding.operationClosed) throw new Error('Artifact capture binding unavailable')
      const saved = binding.artifactOutbox?.[key]
      if (saved) {
        if (!same(saved.operation, fixedOperation) || saved.evidence.payload.kind !== 'artifact') throw new Error('Artifact capture identity conflict')
        if (saved.archive) await this.archive.read(saved.archive.snapshot_hash, saved.archive)
        await this.send(session, key)
        return structuredClone(this.profiles.binding(session).artifactOutbox[key])
      }
      const signal = fixedOptions.signal ? AbortSignal.any([fixedOptions.signal, this.stop.signal]) : this.stop.signal
      if (!this.archive) throw new Error('Durable artifact archive storage required')
      const bundle = await captureArtifactBundle({ ...fixedOptions, signal })
      const archive = await this.archive.put(bundle)
      signal.throwIfAborted()
      return this.record(session, fixedOperation, id, { kind: 'artifact', snapshot: bundle.snapshot }, archive)
    })().finally(() => this.capturing.delete(pendingKey))
    this.capturing.set(pendingKey, task); return task
  }
  assertSettled(session, operation) {
    if (Object.values(this.profiles.binding(session)?.artifactOutbox ?? {}).some(row => same(row.operation, operation) && (!row.home_reconciled || (row.archive && !row.home_archive_reconciled)))) throw new Error('Artifact evidence requires home reconciliation')
  }
  async awaitSettled(session,operation,{signal,assertOwner=async()=>{},timeoutMs=10000}={}){
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('Invalid artifact reconciliation deadline')
    const stop=signal?AbortSignal.any([signal,this.stop.signal]):this.stop.signal,deadline=performance.now()+timeoutMs
    while(true){
      stop.throwIfAborted();await assertOwner()
      const pending=Object.entries(this.profiles.binding(session)?.artifactOutbox??{}).filter(([,row])=>same(row.operation,operation)&&(!row.home_reconciled||(row.archive&&!row.home_archive_reconciled)))
      if(!pending.length)return
      // A background tick may have snapshotted its queue before capture. Await
      // this operation's exact rows, resending frozen evidence only, never capture.
      for(const [key] of pending){stop.throwIfAborted();await this.send(session,key)}
      stop.throwIfAborted();await assertOwner()
      try{this.assertSettled(session,operation);return}catch(error){if(performance.now()>=deadline)throw error}
      await delay(Math.min(100,Math.max(1,deadline-performance.now())),undefined,{signal:stop})
    }
  }
  send(session, key) {
    const pendingKey = `${session}:${key}`
    if (this.sending.has(pendingKey)) return this.sending.get(pendingKey)
    const row = this.profiles.binding(session)?.artifactOutbox?.[key]
    if (!row || (row.home_reconciled && (!row.archive || row.home_archive_reconciled)) || !this.client || this.stop.signal.aborted) return Promise.resolve()
    const task = (async () => {
      try {
        if (!row.home_reconciled) {
          const receipt = row.operation.home_node
            ? await this.client.call(`/api/v1/messaging/operation-accounting-relay/${encodeURIComponent(row.operation.home_node)}`, {
              operation_id: row.operation.id, worker_session: session, command: null,
              accounting: { attempt: row.operation.attempt, action: { kind: 'artifact_evidence', evidence: structuredClone(row.evidence) } },
            }, this.stop.signal)
            : await this.client.call('/api/v1/messaging/artifact-evidence', structuredClone(row.evidence), this.stop.signal)
          if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence <= 0 || receipt.completion_authorized !== false
              || receipt.record?.kind !== 'artifact_evidence' || receipt.record?.producer?.session_id !== session
              || receipt.record?.snapshot_hash !== snapshotHash(row.evidence.payload)
              || !isDeepStrictEqual(receipt.record?.evidence, row.evidence)) throw new Error('Artifact receipt mismatch')
          await this.profiles.update(state => {
            const saved = state.bindings[session]?.artifactOutbox?.[key]
            if (!saved || !isDeepStrictEqual(saved.evidence, row.evidence)) throw new Error('Artifact evidence changed')
            saved.home_reconciled = true; saved.home_sequence = receipt.sequence; saved.snapshot_hash = receipt.record.snapshot_hash
          })
        }
        if (row.archive) {
          const saved = this.profiles.binding(session).artifactOutbox[key]
          const receipt = await deliverArtifactArchive(this.client, saved.home_sequence, this.archive, saved.archive, this.stop.signal, row.operation.home_node ? { home: row.operation.home_node, operation: row.operation, worker: session } : undefined)
          await this.profiles.update(state => {
            const current = state.bindings[session]?.artifactOutbox?.[key]
            if (!current || !isDeepStrictEqual(current.archive, saved.archive) || current.home_sequence !== receipt.sequence) throw new Error('Artifact archive binding changed')
            current.home_archive_reconciled = true
          })
        }
        if(this.lastError?.session===session&&this.lastError.key===key)this.lastError=undefined
      } catch(error) {
        // One bounded in-memory diagnostic; durable observations still own recovery.
        this.lastError={session,key,error}
      }
    })().finally(() => this.sending.delete(pendingKey))
    this.sending.set(pendingKey, task); return task
  }
  tick() {
    if (this.running) return this.running
    this.running = (async () => {
      const pending = Object.entries(this.profiles.bindings).flatMap(([session, binding]) => Object.entries(binding.artifactOutbox ?? {}).filter(([, row]) => !row.home_reconciled || (row.archive && !row.home_archive_reconciled)).map(([key]) => [session, key]))
      const count = Math.min(16, pending.length), start = this.cursor % (pending.length || 1)
      this.cursor = (start + count) % (pending.length || 1)
      for (let i = 0; i < count && !this.stop.signal.aborted; i++) await this.send(...pending[(start + i) % pending.length])
    })().finally(() => { this.running = null })
    return this.running
  }
  start() { if (this.timer || this.stop.signal.aborted) return; void this.tick().catch(() => {}); this.timer = setInterval(() => { void this.tick().catch(() => {}) }, 2000); this.timer.unref?.() }
  async close() { clearInterval(this.timer); this.stop.abort(); await this.running?.catch(() => {}); await Promise.allSettled([...this.sending.values(), ...this.capturing.values()]) }
}

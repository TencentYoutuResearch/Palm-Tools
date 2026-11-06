import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
/** Persist observations before relay; recovery replays evidence, never inference. */
const same = (a, b) => a?.id === b?.id && a?.attempt === b?.attempt && a?.epoch === b?.epoch && (a?.home_node ?? null) === (b?.home_node ?? null)
const observation = (value, source) => ({ requested: value?.requested ?? null, observed: value?.observed ?? null,
  status: value?.status === 'acknowledged' ? 'pending' : value?.status ?? 'unverifiable', source: value?.source ?? source ?? null })
export class SelectionOutbox {
  constructor(client, profiles) { this.client = client; this.profiles = profiles; this.stop = new AbortController(); this.cursor = 0; this.sending = new Map() }
  async record(session, params) {
    const operation = params.operation
    if (!operation) return
    const body = { operation_id: operation.id, worker_session: session, attempt: operation.attempt, epoch: operation.epoch,
      profile_revision: params.profile_revision, thread_id: params.threadId, turn_id: params.turnId,
      input_ids: params.inputIds, scope: params.scope, observed_at: params.observed_at,
      model: observation(params.model, params.source), effort: observation(params.effort, params.source), rejected: params.admission === 'rejected' }
    const id = createHash('sha256').update(JSON.stringify({ home: operation.home_node ?? null, body })).digest('hex')
    const evidence = { record_id: id, ...body }
    await this.profiles.update(state => {
      const binding = state.bindings[session]
      if (!same(binding?.managedOperation, operation) || binding.revision !== params.profile_revision) throw new Error('Selection evidence binding changed')
      const rows = binding.selectionOutbox ??= {}
      if (rows[id]) { if (!isDeepStrictEqual(rows[id].evidence, evidence)) throw new Error('Selection evidence conflict'); return }
      // Keep current attempt evidence and all unresolved records. Home audit owns older receipts.
      for (const [key, row] of Object.entries(rows)) if (row.home_reconciled && !same(row.operation, operation)) delete rows[key]
      if (Object.keys(rows).length >= 128) throw new Error('Selection evidence backlog requires reconciliation')
      rows[id] = { operation: structuredClone(operation), evidence: structuredClone(evidence), home_reconciled: false }
    })
    await this.send(session, id)
  }
  assertSettled(session, operation, policy) {
    const rows = Object.values(this.profiles.binding(session)?.selectionOutbox ?? {}).filter(row => same(row.operation, operation))
    if (!rows.length || rows.some(row => !row.home_reconciled)) throw new Error('Selection evidence requires home reconciliation')
    if (rows.some(row => row.rejected)) throw new Error('Native executor rejected the requested model/effort configuration')
    if (policy && !rows.some(({ evidence: e }) => e.profile_revision === policy.profile_revision && e.scope === policy.scope && e.model.status === 'reported' && e.model.requested === policy.model && e.model.observed === policy.model && (policy.effort == null || e.effort.status === 'reported' && e.effort.requested === policy.effort && e.effort.observed === policy.effort))) throw new Error('Selection policy requires matching reported evidence')
  }
  tick() {
    if (this.running) return this.running
    if (!this.client || this.stop.signal.aborted) return Promise.resolve()
    this.running = this.replay().finally(() => { this.running = undefined })
    return this.running
  }
  async replay() {
    const pending = Object.entries(this.profiles.bindings).flatMap(([session, b]) => Object.entries(b.selectionOutbox ?? {}).filter(([, row]) => !row.home_reconciled).map(([id, row]) => ({ session, id, row })))
    if (!pending.length) return
    const start = this.cursor % pending.length, count = Math.min(16, pending.length)
    this.cursor = (start + count) % pending.length
    for (let i = 0; i < count && !this.stop.signal.aborted; i++) {
      const { session, id } = pending[(start + i) % pending.length]
      await this.send(session, id)
    }
  }
  send(session, id) {
    const key = `${session}:${id}`
    if (this.sending.has(key)) return this.sending.get(key)
    const row = this.profiles.binding(session)?.selectionOutbox?.[id]
    if (!row || row.home_reconciled || !this.client || this.stop.signal.aborted) return Promise.resolve()
    const task = (async () => {
      try {
        const { evidence, operation } = row
        const receipt = operation.home_node
          ? await this.client.call(`/api/v1/messaging/operation-accounting-relay/${encodeURIComponent(operation.home_node)}`, { operation_id: operation.id, worker_session: session, command: null, accounting: { attempt: operation.attempt, action: { kind: 'selection_evidence', evidence } } }, this.stop.signal)
          : await this.client.call('/api/v1/messaging/selection-evidence', evidence, this.stop.signal)
        if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence <= 0 || typeof receipt.rejected !== 'boolean' || !isDeepStrictEqual(receipt.evidence, evidence)) throw new Error('Selection receipt mismatch')
        const rejected = evidence.rejected || [evidence.model, evidence.effort].some(v => v.status === 'mismatch' || v.requested !== null && v.observed !== null && v.requested !== v.observed)
        if (receipt.rejected !== rejected) throw new Error('Selection decision mismatch')
        await this.profiles.update(state => {
          const saved = state.bindings[session]?.selectionOutbox?.[id]
          if (!saved || !isDeepStrictEqual(saved.evidence, evidence)) throw new Error('Selection record changed')
          saved.home_reconciled = true; saved.home_sequence = receipt.sequence; saved.rejected = receipt.rejected
        })
      } catch { /* Pending evidence remains durable; no execution retry. */ }
    })().finally(() => this.sending.delete(key))
    this.sending.set(key, task)
    return task
  }

  start() { if (this.timer) return; void this.tick().catch(() => {}); this.timer = setInterval(() => { void this.tick().catch(() => {}) }, 2000); this.timer.unref?.() }
  async close() { clearInterval(this.timer); this.timer = null; this.stop.abort(); await this.running?.catch(() => {}); await Promise.allSettled([...this.sending.values()]) }
}

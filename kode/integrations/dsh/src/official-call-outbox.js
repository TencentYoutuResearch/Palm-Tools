/** Durable local evidence transport. Recovery never invokes a model or retries begin. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
const prefix = '/api/v1/messaging/official-calls'
const sameRequest = (a, b) => a && b && Object.keys(b).every(key => isDeepStrictEqual(a[key], b[key]))
export class OfficialCallOutbox {
  constructor(client, profiles) { this.client = client; this.profiles = profiles; this.active = new Set(); this.sending = new Map() }
  row(session, id) { return this.profiles.binding(session)?.officialCalls?.[id] }
  async change(session, id, update) {
    return this.profiles.update(state => {
      const row = state.bindings[session]?.officialCalls?.[id]
      if (!row) throw new Error('Official call record missing')
      return update(row)
    })
  }
  policy(session, operation, authorize, provenance) {
    if (typeof authorize !== 'function') throw new Error('Authorized official call required')
    const callId = randomUUID()
    return { callId, admit: async identity => {
      if (identity.session_id !== session || identity.call_id !== callId) throw new Error('Official call identity mismatch')
      await authorize(identity)
      const request = { call_id: callId, operation_id: operation.id, attempt: operation.attempt, epoch: operation.epoch,
        worker_session: session, provider: identity.provider, model: identity.requested_model,
        ...(provenance?{prompt_provenance:structuredClone(provenance)}:{}) }
      await this.profiles.update(state => {
        const binding = state.bindings[session]
        if (!binding || binding.managedOperation?.id !== operation.id || binding.managedOperation?.attempt !== operation.attempt || binding.managedOperation?.epoch !== operation.epoch || (binding.managedOperation?.home_node ?? null) !== (operation.home_node ?? null)) throw new Error('Official operation binding changed')
        const rows = binding.officialCalls ??= {}
        const done = Object.keys(rows).filter(id => rows[id].done)
        for (const id of done.slice(0, Math.max(0, done.length - 15))) delete rows[id]
        if (Object.keys(rows).length >= 128 || rows[callId]) throw new Error('Official call backlog or duplicate admission')
        rows[callId] = { request, home_node: operation.home_node ?? null, purpose: identity.purpose, events: [], acknowledged: 0, status: 'prepared', done: false }
      })
      this.active.add(callId)
      try {
        const receipt = await this.transport(this.row(session, callId), { kind: 'official_begin', request })
        if (!sameRequest(receipt.call?.request, request) || receipt.duplicate !== false) throw new Error('Official begin requires recovery; dispatch refused')
        await this.change(session, callId, row => { row.status = 'admitted' })
      } catch (error) { this.active.delete(callId); throw error }
    }, record: async event => {
      try {
        if (event.call_id !== callId || event.session_id !== session) throw new Error('Official event identity mismatch')
        if (event.kind === 'started') {
          await this.change(session, callId, row => { row.status = 'dispatch_admitted' })
          return
        }
        const usage = event.usage?.status === 'reported' ? { ...event.usage.counters, cache_write_input_tokens: event.usage.cache_write_input_tokens } : null
        const kind = event.kind === 'usage' ? 'usage' : event.kind === 'finished' ? 'finished' : 'interrupted'
        const reason = event.finish_reason ?? event.usage?.reason ?? 'missing_usage'
        await this.enqueue(session, callId, event.event_id, { kind, usage, reason })
        if (kind !== 'usage') this.active.delete(callId)
        await this.flush(session, callId)
      } catch (error) { this.active.delete(callId); throw error }
    } }
  }
  async enqueue(session, id, eventId, input) {
    await this.change(session, id, row => {
      const existing = row.events.find(item => item.event_id === eventId)
      if (existing) {
        const { sequence, ...old } = existing.input
        if (JSON.stringify(old) !== JSON.stringify(input)) throw new Error('Official event identity conflict')
        return
      }
      if (row.events.at(-1)?.input.kind !== undefined && row.events.at(-1).input.kind !== 'usage') throw new Error('Official call already terminal')
      row.events.push({ event_id: eventId, input: { sequence: row.events.length + 1, ...input } })
      row.status = 'pending'
    })
  }
  flush(session, id) {
    if (this.sending.has(id)) return this.sending.get(id)
    const task = this.send(session, id).finally(() => this.sending.delete(id))
    this.sending.set(id, task)
    return task
  }
  async send(session, id) {
    for (;;) {
      const row = this.row(session, id), next = row.events[row.acknowledged]
      if (!next) return
      const receipt = await this.transport(row, { kind: 'official_event', call_id: id, event: next.input })
      if (!sameRequest(receipt.call?.request, row.request) || receipt.call.sequence < next.input.sequence) throw new Error('Official event receipt mismatch')
      await this.change(session, id, saved => {
        saved.acknowledged = next.input.sequence
        saved.done = next.input.kind !== 'usage'
        saved.status = saved.done ? 'evidence_recorded_pending_accounting' : 'observing'
      })
    }
  }
  transport(row, action) {
    if (row.home_node) return this.client.call(`/api/v1/messaging/operation-accounting-relay/${encodeURIComponent(row.home_node)}`, {
      operation_id: row.request.operation_id, worker_session: row.request.worker_session, command: null,
      accounting: { attempt: row.request.attempt, action },
    })
    if (action.kind === 'official_begin') return this.client.call(prefix, action.request)
    const path = `${prefix}/${encodeURIComponent(action.call_id)}`
    return action.kind === 'official_read' ? this.client.call(path) : this.client.call(`${path}/events`, action.event)
  }
  async recover() {
    if (this.active.size || this.sending.size) throw new Error('Recover only before official execution starts')
    for (const [session, binding] of Object.entries(this.profiles.bindings)) {
      for (const [id, row] of Object.entries(binding.officialCalls ?? {})) {
        if (row.done) continue
        try {
          const call = await this.transport(row, { kind: 'official_read', call_id: id })
          if (!sameRequest(call.request, row.request)) throw new Error('Official recovery identity mismatch')
          if (!row.events.length || row.events.at(-1).input.kind === 'usage') {
            const last = row.events.at(-1)?.input
            await this.enqueue(session, id, `${id}:recovery`, { kind: 'interrupted', usage: last?.usage ?? null, reason: 'collector_restarted' })
          }
          await this.flush(session, id)
        } catch {
          await this.change(session, id, saved => { saved.status = 'recovery_pending' })
        }
      }
    }
  }
}

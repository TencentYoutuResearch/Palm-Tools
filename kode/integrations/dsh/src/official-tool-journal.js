import { OfficialToolArchive } from './official-tool-archive.js'
import { toolObservation } from './tool-observation.js'
import { isDeepStrictEqual } from 'node:util'
/** Execution-Host evidence only; uncertain side effects are never replayed. */
const same = (a, b) => a?.id === b.id && a.attempt === b.attempt && a.epoch === b.epoch && (a.home_node ?? null) === (b.home_node ?? null)
export class OfficialToolJournal {
  constructor(profiles, client) { this.profiles = profiles; this.client = client; this.archive = profiles.path ? new OfficialToolArchive(profiles.path) : null }
  async recover() {
    await this.profiles.update(state => {
      for (const binding of Object.values(state.bindings)) for (const row of Object.values(binding.officialTools ?? {})) {
        if (row.status === 'started') { row.status = 'uncertain'; row.reason = 'host_restarted'; row.ended_at = Date.now() }
      }
    })
    await this.flush()
  }
  async begin(session, operation, request) {
    if (typeof request.callId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(request.callId)) throw new Error('Stable official tool call ID required')
    if (typeof request.name !== 'string' || !request.name || request.name.length > 256) throw new Error('Official tool name required')
    await this.compact(session)
    await this.profiles.update(async state => {
      const binding = state.bindings[session]
      if (!same(binding?.managedOperation, operation) || binding.operationClosed) throw new Error('Official tool operation changed')
      if (this.archive) {
        await this.archive.assertAvailable(binding.officialToolArchive)
        if (await this.archive.contains(session, request.callId)) throw new Error('Official tool already archived; replay refused')
      }
      const rows = binding.officialTools ??= {}
      if (rows[request.callId]) throw new Error('Official tool already recorded; inspect evidence instead of replaying')
      if (Object.keys(rows).length >= 256) throw new Error('Official tool journal requires archival before more execution')
      rows[request.callId] = { call_id: request.callId, tool: request.name, operation_id: operation.id, attempt: operation.attempt, epoch: operation.epoch, home_node: operation.home_node ?? null, status: 'started', started_at: Date.now(), authority: 'execution_host', home_reconciled: false, io: {schema_version:1,input:toolObservation(request.arguments),output:null} }
    })
  }
  async compact(session) {
    if (!this.archive || Object.keys(this.profiles.binding(session)?.officialTools ?? {}).length < 128) return
    await this.profiles.update(async state => {
      const binding = state.bindings[session]
      if (!binding) return
      const rows = Object.values(binding.officialTools ?? {})
      if (rows.length < 128) return
      const candidates = rows.filter(row => row.home_reconciled && Number.isSafeInteger(row.home_sequence) && (row.status === 'returned' || row.resolution?.decision === 'verified_applied')).slice(0, Math.max(0, rows.length - 32))
      if (!candidates.length) return
      const metadata = await this.archive.create(binding.officialToolArchive)
      for (const row of candidates) {
        await this.archive.put(session, row)
        delete binding.officialTools[row.call_id]
        metadata.count++
      }
      binding.officialToolArchive = metadata
    })
  }
  async end(session, id, status, reason, result) {
    const observed=arguments.length>=5
    await this.profiles.update(state => {
      const row = state.bindings[session]?.officialTools?.[id]
      if (!row || row.status !== 'started') throw new Error('Official tool record is not active')
      if(row.io&&observed)row.io.output=toolObservation(result)
      row.status = status; row.reason = reason; row.ended_at = Date.now()
    })
    await this.flush()
  }
  async flush() {
    if (!this.client) return
    for (const [session, binding] of Object.entries(this.profiles.bindings)) for (const row of Object.values(binding.officialTools ?? {})) {
      if (row.status === 'started' || (row.home_reconciled && (row.status === 'returned' || row.resolution))) continue
      const evidence = { call_id: row.call_id, tool: row.tool, operation_id: row.operation_id, worker_session: session, attempt: row.attempt, epoch: row.epoch, status: row.status, started_at: row.started_at, ended_at: row.ended_at, ...(row.io?{io:row.io}:{}) }
      try {
        const receipt = row.home_node
          ? await this.client.call(`/api/v1/messaging/operation-accounting-relay/${encodeURIComponent(row.home_node)}`, { operation_id: row.operation_id, worker_session: session, command: null, accounting: { attempt: row.attempt, action: { kind: 'tool_evidence', evidence } } })
          : await this.client.call('/api/v1/messaging/tool-evidence', evidence)
        if (!Number.isSafeInteger(receipt.sequence) || !Object.keys(evidence).every(key => isDeepStrictEqual(receipt.evidence?.[key],evidence[key]))) throw new Error('Tool evidence receipt mismatch')
        await this.profiles.update(state => {
          const saved = state.bindings[session]?.officialTools?.[row.call_id]
          if (saved?.status !== row.status || saved?.ended_at !== row.ended_at) throw new Error('Tool evidence changed during reconciliation')
          saved.home_reconciled = true; saved.home_sequence = receipt.sequence
          const resolution = receipt.resolution
          if (resolution && resolution.actor === 'home_administrator' && resolution.replay_authorized === false && resolution.resolution?.operation_id === row.operation_id && resolution.resolution?.evidence_sequence === receipt.sequence && ['verified_applied', 'verified_not_applied', 'abandoned'].includes(resolution.resolution?.decision)) {
            saved.resolution = { decision: resolution.resolution.decision, evidence_ref: resolution.resolution.evidence_ref, request_id: resolution.resolution.request_id, recorded_at: resolution.recorded_at }
          }
        })
      } catch { /* Durable pending record is retried at recovery/next completion. */ }
    }
  }
  assertSettled(session, operation) {
    if (Object.values(this.profiles.binding(session)?.officialTools ?? {}).some(row => row.operation_id === operation.id && row.attempt === operation.attempt && ((row.status !== 'returned' && row.resolution?.decision !== 'verified_applied') || (this.client && !row.home_reconciled)))) throw new Error('Official tool outcome requires reconciliation')
  }
}
export const officialToolEvidence = binding => Object.values(binding.officialTools ?? {}).map(row => ({
  call_id: row.call_id, tool: row.tool, operation_id: row.operation_id, attempt: row.attempt, epoch: row.epoch, home_node: row.home_node,
  status: row.status, reason: row.reason ?? null, started_at: row.started_at, ended_at: row.ended_at ?? null, authority: row.home_reconciled ? 'home_hub' : 'execution_host', home_reconciled: row.home_reconciled === true, home_sequence: row.home_sequence ?? null, io:row.io??null, resolution: row.resolution ? { decision: row.resolution.decision, evidence_ref: row.resolution.evidence_ref, request_id: row.resolution.request_id, recorded_at: row.resolution.recorded_at } : null,
}))

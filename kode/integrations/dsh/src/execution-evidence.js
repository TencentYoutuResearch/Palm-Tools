import { officialToolEvidence } from './official-tool-journal.js'
/** Read-only owner inspection; never opens a runtime or makes provider requests. */
import { quotaView } from './codex-quota.js'
export function executionEvidence(binding, now = Date.now()) {
  if (!binding) throw new Error('Native session binding not found')
  return { selection_admission: binding.selectionAdmission ?? null, selection_reconciliation: Object.values(binding.selectionOutbox ?? {}).map(row => ({ record_id: row.evidence.record_id, operation_id: row.evidence.operation_id, attempt: row.evidence.attempt, epoch: row.evidence.epoch, home_node: row.operation.home_node ?? null, home_reconciled: row.home_reconciled === true, home_sequence: row.home_sequence ?? null, rejected: row.rejected ?? null })), execution_admission: binding.executionAdmission ?? null, official_tool_archive: binding.officialToolArchive ? { count: binding.officialToolArchive.count, authority: 'home_hub', local_replay_guard: true } : null, official_tools: officialToolEvidence(binding), quota_fences: { local_revision: binding.quotaFenceRevision ?? null, local_reconciled_revision: binding.quotaFenceReconciledRevision ?? null, remote: (binding.remoteQuotaFences ?? []).map(row => ({ home_node: row.home, profile: row.profile, binding_revision: row.revision, operation_id: row.operation_id, attempt: row.attempt, reconciled: row.reconciled === true })) }, accounting_admission: binding.accountingAdmission ?? null, usage_accounting: Object.entries(binding.usageOutbox ?? {}).map(([attempt, row]) => ({ attempt, home_node: row.home_node ?? null, status: row.status, reservation_id: row.context.reservation.request.id, price_id: row.context.price.id, last_receipt: row.receipt ?? null })), usage: binding.usageObservation ?? null, selection: binding.selectionEvidence ?? null, quota_publication: binding.quotaPublication ?? null, quota: quotaView(binding.quotaObservation, now) }
}
export function registerExecutionEvidence(ctx) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/session-execution-evidence', handler: async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return json(403, { error: 'Host owner required' })
    if (req.method !== 'POST' || !(req.headers['content-type'] ?? '').startsWith('application/json')) return json(405, { error: 'JSON POST required' })
    try {
      let body = ''
      for await (const part of req) { body += part; if (Buffer.byteLength(body) > 4096) throw new Error('Request too large') }
      const input = JSON.parse(body)
      if (!input || typeof input.session_id !== 'string' || !input.session_id || input.session_id.length > 160) throw new Error('Session ID required')
      const adapter = ctx.get('kodeAgents')?.adapter
      if (!adapter) throw new Error('Native runtime unavailable')
      return json(200, executionEvidence(adapter.profiles.binding(input.session_id)))
    } catch (error) { return json(400, { error: error.message }) }
  } })
}

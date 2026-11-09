/** Drain already-owned local execution; home never impersonates a remote Host. */
export async function advanceWorkRunCancellation(controller, run, call) {
  const takeover = run.state === 'taking_over'
  const stop = takeover ? run.intervention : run.cancellation
  if (run.home_hub !== controller.runtime.host || !Array.isArray(stop?.assignment_ids)) throw new Error('Invalid home stop context')
  try {
    const final = await call(`/api/v1/messaging/work-runs/${encodeURIComponent(run.id)}`, {
      action: takeover ? 'finalize_takeover' : 'finalize_cancel', request_id: `host-${takeover ? 'pause' : 'cancel'}-${run.revision}`, expected_revision: run.revision,
    })
    const receipt = takeover ? final.intervention : final.cancellation
    if (final.state !== (takeover ? 'paused' : 'cancelled') || receipt?.stop_confirmed !== true || receipt?.resources_released !== true) throw new Error('Invalid final stop receipt')
    return { state: final.state, run_id: run.id, receipt: receipt.receipt }
  } catch (error) {
    if (!error.message.includes('cancellation pending:')) throw error
  }
  const ids = stop.assignment_ids
  if (!ids.length) return { state: 'waiting_cancellation_accounting', run_id: run.id }
  const index = (controller.cursor.get(run.id) ?? 0) % ids.length
  controller.cursor.set(run.id, index + 1)
  const id = ids[index]
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(id)) throw new Error('Invalid cancellation Assignment identity')
  const assignment = await call(`/api/v1/messaging/work-assignments/${encodeURIComponent(id)}`)
  if (assignment.id !== id || assignment.run_id !== run.id) throw new Error('Cancellation Assignment belongs to another Run')
  const result = state => ({ state, run_id: run.id, assignment_id: id })
  if (assignment.stop?.receipt) {
    if (!assignment.accounting?.receipt) {
      try {
        await call(`/api/v1/messaging/work-assignments/${encodeURIComponent(id)}/accounting`, assignment.accounting?.request ?? {
          request_id: `host-account-${id}`, expected_revision: assignment.revision,
        })
      } catch (error) {
        if (/^kode backend \(400\): (official usage remains unresolved|Assignment usage charge needs reconciliation|mixed usage accounting requires reconciliation)$/.test(error.message)) {
          return { ...result('waiting_cancellation_accounting'), reason: 'usage_reconciliation_required' }
        }
        throw error
      }
      return result('cancellation_accounted')
    }
    return result('waiting_cancellation_accounting')
  }
  if (assignment.creation?.state !== 'created') return result('waiting_cancellation_disposition')
  if (assignment.worker.node_id !== controller.runtime.host) return result('waiting_remote_cancellation')
  const binding = controller.runtime.profiles.binding(assignment.worker.session_id)
  if (!controller.host.handles.has(assignment.worker.session_id) && binding?.assignmentStop?.state !== 'drained') return result('cancel_unconfirmed')
  await controller.dispatcher.stop(id)
  return result('cancellation_execution_drained')
}

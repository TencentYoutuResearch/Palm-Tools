import { isDeepStrictEqual } from 'node:util'
/** Conclude only consecutive, solitary quiet-status steps. Never cancel work or consume input. */
export function mountCoordinatorEventWait(ctx, agent) {
  let previousRun, pendingCallId, solitaryStatus = false
  const reset = () => { previousRun = undefined; pendingCallId = undefined; solitaryStatus = false }
  const dispose = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (event.type === 'turn/start' || event.type === 'user/message'
        && (['human', 'user'].includes(event.data?.source?.kind) || event.data?.id?.startsWith('kode-message-'))) reset()
    if (event.type === 'tool/result' && event.data?.message?.isError === true) reset()
    if (event.type === 'assistant/message') {
      const calls = event.data?.message?.content?.filter(block => block.type === 'tool-call') ?? []
      solitaryStatus = calls.length === 1 && calls[0].name === 'kode_coordinator_workflow_status'
      pendingCallId = solitaryStatus ? calls[0].id : undefined
      // A batch containing any other result may need another model step to
      // process it. A conclusion from one call must never hide that result.
      if (!solitaryStatus) previousRun = undefined
    }
  })
  return {
    dispose,
    observe(result, execution) {
      const quiet = ['active', 'running', 'queued', 'waiting_resource'].includes(result.state)
        && !result.worker_clarification && !(result.worker_clarifications?.count > 0)
        && result.worker_clarifications?.next_cursor == null
        && !result.execution_accounting?.blocked
        && !result.cancellation && !result.intervention && !result.human_acceptance
      if (!quiet || !solitaryStatus || !pendingCallId || execution.callId !== pendingCallId) { previousRun = undefined; return result }
      const snapshot = structuredClone(result)
      delete snapshot.revision; delete snapshot.observed_at
      if (snapshot.assigned_execution) delete snapshot.assigned_execution.observed_at
      if (snapshot.execution_accounting) { delete snapshot.execution_accounting.observed_at; delete snapshot.execution_accounting.run_revision }
      const observation = {snapshot, arguments: structuredClone(execution.arguments)}
      const repeated = isDeepStrictEqual(previousRun, observation)
      previousRun = observation
      if (repeated) execution.concludeTurn()
      return {...result, observation_control: {
        action: repeated ? 'turn_concluded_wait_for_hub_notice' : 'publish_useful_progress_then_end_turn',
        wake_source: 'existing_durable_work_run_terminal_or_blocked_notice_or_new_human_input',
        grants_execution: false,
      }}
    },
  }
}

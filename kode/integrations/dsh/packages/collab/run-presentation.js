// Status comes from the Hub projection. A finished executor alone is not delivery.
// Older Hubs may return a truncated serialized request instead of a display summary.
export function runTitle(run) {
  const preview = run.request_preview
  return typeof preview === 'string' && preview.trim()
    && !/^\s*\{[\s\S]*"format"\s*:\s*"kode\.collaboration\.task-context\.v[12]"/.test(preview)
    ? preview : '团队任务'
}
export function needsDecision(run) {
  return run.state === 'waiting_user' || ['human_delivery_acceptance_required', 'rework_limit_exhausted'].includes(run.waiting_reason)
}
export function runPresentation(run) {
  if (run.completion_authorized) return { tone: 'success', icon: 'check' }
  if (['failed', 'blocked'].includes(run.state)) return { tone: 'error', icon: 'alert' }
  if (needsDecision(run) || ['cancelling', 'cancel_unconfirmed', 'taking_over'].includes(run.state)) return { tone: 'warning', icon: 'alert' }
  if (run.state === 'running') return { tone: 'active', icon: 'activity' }
  if (run.state === 'paused') return { tone: 'neutral', icon: 'pause' }
  return { tone: 'neutral', icon: 'clock' }
}

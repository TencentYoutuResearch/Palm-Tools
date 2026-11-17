/** Execution evidence is separate from presence. Idle is never proof of completion. */
export function sessionExecutionState({ agent, events, unavailable = false, waiting = false, saved = false } = {}) {
  if (agent?.disposed) return 'unknown'
  if (waiting) return 'waiting'
  if (agent?.status === 'running') return 'running'
  if (agent?.parked && agent?.lastError) return 'failed'
  if (agent?.inbox?.nextTurn?.length || agent?.inbox?.nextStep?.length) return 'waiting'
  if (unavailable || !Array.isArray(events)) return 'unknown'
  const lastBoundary = events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
  if (lastBoundary?.type === 'turn/start') return 'unknown' // Recovery has not proved a live execution.
  if (lastBoundary?.type === 'turn/end') {
    const reason = lastBoundary.data?.reason?.kind
    if (reason === 'completed') return 'completed'
    if (reason === 'error') return 'failed'
    if (reason === 'aborted' || reason === 'interrupted') return 'interrupted'
    return 'unknown'
  }
  // Imported history and a prompt awaiting recovery are not empty/new sessions.
  if (saved || events.some(event => ['user/message', 'assistant/message', 'request/header'].includes(event.type))) return 'unknown'
  return 'not_started'
}

/** Observe blocking prompts without changing their policy, request, or answer. */
export function trackSessionWaiting(ctx) {
  const counts = new Map()
  const disposers = ['approval/request', 'user-questions/request'].map(event => ctx.on(event, async (request, next) => {
    const id = request.agent?.id
    if (!id) return next()
    counts.set(id, (counts.get(id) ?? 0) + 1)
    try { return await next() }
    finally { const remaining = counts.get(id) - 1; if (remaining) counts.set(id, remaining); else counts.delete(id) }
  }, { global: true }))
  return { has: id => counts.has(id), dispose: () => { for (const dispose of disposers) dispose?.(); counts.clear() } }
}

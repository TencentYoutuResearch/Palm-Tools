/** Setup events alone do not make a conversation, even if dsh's cold cache says otherwise. */
export function isSetupOnlySession(row, observed, binding, agent) {
  if (observed?.unavailable || !observed?.events?.length || row.savedTab || binding?.threadId
    || row.running || agent?.status === 'running'
    || row.projections?.values?.userQuestions?.questions?.active?.length
    || ['inbox', 'kodeInbox'].some(key => Object.values(row.projections?.values?.[key] ?? {}).some(queue => Array.isArray(queue) && queue.length))) return false
  return !observed.events.some(event => ['user/message', 'assistant/message', 'tool/call', 'plugin:kode/shared-interaction'].includes(event.type))
}

export async function setupOnlySessionIds(ctx, controller, items) {
  const hidden = new Set(), profiles = ctx.get('kodeAgents')?.profiles
  const archived = new Set(ctx.get('workspaceRegistry')?.archivedSessionIds ?? [])
  for (const row of items) {
    const binding = profiles?.binding(row.sessionId), agent = ctx.get('agents')?.get(row.sessionId)
    if (archived.has(row.sessionId) || row.blank || row.running || binding?.threadId || agent?.status === 'running' || !controller.inspect) continue
    try {
      const observed = agent ? { events: agent.session.snapshotEvents() } : await controller.inspect(row.sessionId)
      if (isSetupOnlySession(row, observed, binding, agent)) hidden.add(row.sessionId)
    } catch { /* A failed history read must never hide a real conversation. */ }
  }
  return hidden
}

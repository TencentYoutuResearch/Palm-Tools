/** Use the desktop's cold directory for mobile; listing never starts an Agent. */
import { hostDirectory } from './workspace-directory.js'
import { importedSessionId } from './saved-session-state.js'
import { buildHistorySeed } from './native-history.js'

export async function runtimeDirectory(ctx, backend, items, { includeArchived = false } = {}) {
  const directory = await hostDirectory(ctx, { backendClient: backend, sessionItems: items })
  const archived = new Set(directory.archivedSessionIds)
  const rows = new Map(items.map(row => [row.sessionId, row]))
  const result = []
  for (const entry of directory.sessions) {
    if (!includeArchived && archived.has(entry.id)) continue
    const tab = entry.savedTab
    const id = tab ? tab.dsh_session_id ?? importedSessionId(tab) : entry.id
    if (!includeArchived && archived.has(id)) continue
    result.push({ ...(rows.get(id) ?? {}), sessionId: id, cwd: entry.cwd, title: entry.title,
      ...(!rows.has(id) && tab ? { savedTab: tab } : {}) })
  }
  return result
}

export async function savedRuntimeEvents(backend, tab) {
  const transcript = await backend.call('/api/v1/messaging/workbench/transcript', {
    backend_key: tab.backend_key, session_id: tab.session_id, cwd: tab.cwd,
  })
  if (!transcript.available) return []
  return buildHistorySeed(transcript, { model: tab.model ?? 'default' })
}

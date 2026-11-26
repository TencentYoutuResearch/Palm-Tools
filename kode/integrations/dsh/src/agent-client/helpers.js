function groupProjectWorkspaces(items, parents = {}) {
  const grouped = new Map(items.map(row => [row.workspaceId, { ...row, sessionIds: [...(row.sessionIds ?? [])] }]))
  const hidden = new Set()
  for (const row of items) {
    let id = row.workspaceId; const seen = new Set()
    while (parents[id] && !seen.has(id)) { seen.add(id); id = parents[id] }
    if (seen.has(id) || id === row.workspaceId || !grouped.has(id)) continue
    const parent = grouped.get(id)
    parent.sessionIds = [...new Set([...parent.sessionIds, ...(row.sessionIds ?? [])])]; hidden.add(row.workspaceId)
  }
  return [...grouped].filter(([id]) => !hidden.has(id)).map(([, row]) => row)
}
// A saved SSH connection is not consent to pin its entire loose history.
// Keep complete host directories for explicit resume/search; scope only the sidebar.
function remoteSidebarSessions(host) {
  const visible = new Set([...(host.workspaces ?? []).flatMap(row => row.sessionIds ?? []), ...(host.pinnedSessionIds ?? [])])
  for (const id of host.archivedSessionIds ?? []) visible.add(id)
  const hidden = new Set(host.hiddenSessionIds ?? [])
  return (host.sessions ?? []).filter(row => visible.has(row.id) && !hidden.has(row.id))
}
function resumeCandidates(hosts, target, query = '', nativeSessions = []) {
  if (!target?.profile) return []
  const indexed = (hosts.find(host => host.id === target.hostId)?.sessions ?? []).filter(row => row.nativeThreadId && row.agent?.id === target.profile.id)
  const current = indexed.find(row => row.id === target.sessionId)?.nativeThreadId
  const candidates = new Map()
  for (const row of [...nativeSessions, ...indexed]) {
    if (row.id === target.sessionId || row.nativeThreadId === current || candidates.has(row.nativeThreadId)) continue
    candidates.set(row.nativeThreadId, row)
  }
  const text = query.trim().toLocaleLowerCase()
  return [...candidates.values()]
    .filter(row => `${row.title} ${row.cwd} ${row.nativeThreadId}`.toLocaleLowerCase().includes(text))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}
// Composer recall: ↑ at the draft start walks back through this conversation's
// sent messages and cleared drafts; ↓ at the end walks forward, then restores
// what was being typed. Cleared drafts live in sessionStorage, best effort.
const COMPOSER_HISTORY_PREFIX = 'kode.composer-history:v1:', COMPOSER_HISTORY_LIMIT = 40
function composerHistoryStorage() { try { return globalThis.sessionStorage } catch { return undefined } }
function readComposerHistory(sessionId, storage = composerHistoryStorage()) {
  try {
    const rows = JSON.parse(storage?.getItem(COMPOSER_HISTORY_PREFIX + sessionId) ?? '[]')
    return Array.isArray(rows) ? rows.filter(row => typeof row?.text === 'string' && row.text.trim() && Number.isFinite(row.time) && ['sent', 'draft'].includes(row.source)) : []
  } catch { return [] }
}
function archiveComposerText(sessionId, text, source, time = Date.now(), storage = composerHistoryStorage()) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (!sessionId || !trimmed || !storage) return
  try {
    const rows = [{ text: trimmed, time, source }, ...readComposerHistory(sessionId, storage).filter(row => row.text.trim() !== trimmed)]
    storage.setItem(COMPOSER_HISTORY_PREFIX + sessionId, JSON.stringify(rows.slice(0, COMPOSER_HISTORY_LIMIT)))
  } catch { /* Recall must never block editing or sending. */ }
}
function composerRecallEntries(sessionId, nodes, current = '', storage = composerHistoryStorage()) {
  const sent = []
  for (const node of nodes ?? []) {
    const data = node?.data
    if (!['user', 'steering'].includes(node?.kind) || !['user', 'human'].includes(data?.source?.kind)) continue
    const text = (data.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n').trim()
    if (text) sent.push({ text, time: data.time ?? 0, source: 'sent' })
  }
  const seen = new Set([current.trim()])
  return [...readComposerHistory(sessionId, storage), ...sent].sort((a, b) => b.time - a.time)
    .filter(row => !seen.has(row.text) && seen.add(row.text)).slice(0, COMPOSER_HISTORY_LIMIT)
}
/** One ↑/↓ step: shows `text` and consumes the key when present; otherwise the editor keeps the key. Typing ends navigation. */
function composerRecallStep(nav, key, draft, caret, load) {
  if (nav && draft.trim() !== nav.entries[nav.index]?.text) nav = null
  if (caret.start !== caret.end) return { nav }
  if (key === 'up') {
    if (!nav) {
      const entries = caret.start === 0 ? load() : []
      if (entries.length === 0) return { nav }
      nav = { entries, index: -1, scratch: draft }
    }
    const index = Math.min(nav.index + 1, nav.entries.length - 1)
    return { nav: { ...nav, index }, text: nav.entries[index].text }
  }
  if (key !== 'down' || !nav || caret.end !== draft.length) return { nav }
  const index = nav.index - 1
  return index < 0 ? { nav: null, text: nav.scratch } : { nav: { ...nav, index }, text: nav.entries[index].text }
}
const composerRecallLabel = nav => nav && `${nav.entries[nav.index].source === 'draft' ? '已删除草稿' : '历史消息'} ${nav.index + 1}/${nav.entries.length}`
var directoryBindingCache = new WeakMap()
function stableDirectoryBindings(entry, host) {
  const cached = directoryBindingCache.get(entry)
  if (cached?.host === host) return cached.bindings
  const bindings = entry.inject?.() ?? {}
  directoryBindingCache.set(entry, { host, bindings })
  return bindings
}
async function parseHostJson(response) {
  if (response.status === 404) throw Object.assign(new Error('所选主机的接口不存在（HTTP 404），请更新或重新连接该主机的 Kode 服务。'), { code: 'KODE_SERVICE_UPDATE_REQUIRED' })
  try { return await response.json() } catch {
    throw new Error(`主机返回了无效响应（HTTP ${response.status ?? '未知'}），请检查连接后重试。`)
  }
}
async function recoverHostService(host, { request, readSettings, delay, signal, progress, confirmedSessions }) {
  signal.throwIfAborted()
  let job = await request({ action: 'recover-service', id: host, ...(confirmedSessions ? { confirmedSessions } : {}) })
  if (job.status === 'confirmation-required') return job
  const deadline = Date.now() + (host === 'local' ? 90000 : 1800000)
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    progress(job)
    if (['failed', 'cancelled'].includes(job.status)) throw new Error(job.error || '服务恢复未完成，请重试。')
    if (job.status === 'done' || (host === 'local' && !job.id)) {
      try { return await readSettings() } catch (error) {
        if (error.status === 401 || error.status === 403) throw error
      }
      await delay(1500, signal)
    } else {
      await delay(1500, signal)
      job = await request(undefined, job.id)
    }
  }
  throw new Error('等待服务恢复超时，请检查服务状态后重新连接。')
}
function changedFileSummary({ path, paths, changes, patch }) {
  const files = [...new Set([...(typeof path === 'string' ? [path] : []), ...(Array.isArray(paths) ? paths : []), ...(Array.isArray(changes) ? changes.map(change => change.path) : [])].filter(value => typeof value === 'string' && value && value !== '/dev/null'))]
  if (!files.length && typeof patch === 'string') {
    for (const line of patch.split('\n')) {
      const match = /^(?:\*\*\* (?:Update File|Add File|Delete File|Move to): |\+\+\+ (?:b\/)?)(.+)$/.exec(line)
      const file = match?.[1]?.split('\t')[0]
      if (file && file !== '/dev/null' && !files.includes(file)) files.push(file)
    }
  }
  return files.length > 1 ? `${files[0]} 等 ${files.length} 个文件` : files[0] ?? '文件'
}
/** Native dsh menus and modal; Agent occupies the preset seat, model stays in the composer. */

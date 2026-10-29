/** Cold native-session metadata shares the canonical Kode documents. No Agent required. */
import { createHash } from 'node:crypto'
import { BackendDocument } from './backend-state.js'
export const importedSessionId = tab => `session-kode-${createHash('sha256').update(`${tab.backend_key}:${tab.session_id}`).digest('hex').slice(0, 32)}`
export const savedDirectoryId = (node, tab) => `saved:${createHash('sha256').update(`${node}:${tab.backend_key}:${tab.session_id}`).digest('hex').slice(0, 32)}`
export function savedSessionTime(tab) {
  for (const value of [tab.updatedAt, tab.updated_at, tab.createdAt, tab.created_at]) {
    let time = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : typeof value === 'string' ? Date.parse(value) : NaN
    if (time > 0 && time < 1e11) time *= 1000
    if (Number.isSafeInteger(time) && time >= 946684800000 && time <= Date.now() + 86400000) return time
  }
  // UUIDv7 carries an actual creation timestamp; UUIDv4 and arbitrary IDs do not.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tab.session_id ?? '')) {
    const time = parseInt(tab.session_id.slice(0, 13).replace('-', ''), 16)
    if (time >= 946684800000 && time <= Date.now() + 86400000) return time
  }
  return null
}
export function savedImportIdentity(tab, profileId, bindings, archivedIds = []) {
  const archived = new Set(archivedIds)
  const matches = Object.entries(bindings ?? {}).filter(([, binding]) => binding.threadId === tab.session_id && binding.profile.id === profileId).map(([id]) => id)
  const active = matches.filter(id => !archived.has(id))
  return active.find(id => id === tab.dsh_session_id) ?? active[0] ?? matches.find(id => id === tab.dsh_session_id) ?? matches[0] ?? tab.dsh_session_id ?? importedSessionId(tab)
}
const local = tab => !tab.endpoint_id || tab.endpoint_id.kind === 'local'
export function localSavedTabs(index) {
  const seen = new Set()
  return [...(index?.native_sessions ?? []), ...(index?.gui?.tabs ?? [])].filter(tab => {
    const key = `${tab.backend_key}:${tab.session_id}`
    if (!local(tab) || !tab.session_id || !tab.backend_key || !tab.cwd || seen.has(key)) return false
    seen.add(key); return true
  }).map(tab => Object.fromEntries(['backend_key', 'session_id', 'cwd', 'title', 'dsh_session_id', 'endpoint_id', 'agent_id', 'avatar_id', 'model', 'title_pinned', 'transport_kind', 'updatedAt', 'updated_at', 'createdAt', 'created_at'].filter(key => tab[key] !== undefined).map(key => [key, tab[key]])))
}
async function edit(client, key, change) {
  const document = new BackendDocument(client, key)
  for (let attempt = 0; attempt < 6; attempt++) {
    const value = await document.read()
    change(value)
    try { return await document.write(value) } catch (error) { if (attempt === 5 || !/configuration changed/.test(error.message)) throw error }
  }
}
export async function savedSessionOperation(client, input) {
  const { backend_key, session_id } = input.nativeSession ?? {}, operation = input.operation
  if (!['archive-session', 'unarchive-session', 'pin-session', 'unpin-session', 'rename-session', 'session-avatar'].includes(operation)) throw new Error('不支持此历史会话操作。')
  let id
  await edit(client, 'session-index', index => {
    const tab = localSavedTabs(index).find(tab => tab.backend_key === backend_key && tab.session_id === session_id)
    if (!tab) throw new Error('当前主机没有此历史会话。')
    id = tab.dsh_session_id ?? importedSessionId(tab)
    // Allocate the same metadata identity a future import would use. This
    // creates no transcript, runtime, profile, or native CLI process.
    index.native_sessions ??= []
    let row = index.native_sessions.find(row => row.backend_key === backend_key && row.session_id === session_id && local(row))
    if (!row) { row = { ...tab }; index.native_sessions.push(row) }
    row.dsh_session_id = id
    if (operation === 'rename-session') {
      const title = String(input.args?.title ?? '').trim()
      if (!title || title.length > 512) throw new Error('会话名称不能为空，且不能超过 512 个字符。')
      row.title = title; row.title_pinned = true
    }
    if (operation === 'session-avatar') {
      const avatarId = input.args?.avatarId ?? null
      if (avatarId !== null && (!/^gallery\/[^/\\\x00]+$/.test(avatarId) || avatarId.includes('..'))) throw new Error('无效头像标识。')
      row.avatar_id = avatarId
      for (const tab of index.gui?.tabs ?? []) if (local(tab) && tab.backend_key === backend_key && tab.session_id === session_id) tab.avatar_id = avatarId
    }
  })
  if (['rename-session', 'session-avatar'].includes(operation)) return
  await edit(client, 'workspaces', state => {
    const global = state.global
    global.archivedSessionIds ??= []; global.pinnedSessionIds ??= []
    if (operation === 'archive-session') {
      if (!global.archivedSessionIds.includes(id)) global.archivedSessionIds.push(id)
      global.pinnedSessionIds = global.pinnedSessionIds.filter(key => key !== id)
    } else if (operation === 'unarchive-session') global.archivedSessionIds = global.archivedSessionIds.filter(key => key !== id)
    else if (operation === 'pin-session') {
      if (global.archivedSessionIds.includes(id)) throw new Error('请先恢复归档，再置顶会话。')
      global.pinnedSessionIds = [id, ...global.pinnedSessionIds.filter(key => key !== id)]
    } else global.pinnedSessionIds = global.pinnedSessionIds.filter(key => key !== id)
  })
}

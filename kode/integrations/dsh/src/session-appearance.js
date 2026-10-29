/** Frontend avatar resources and canonical, per-session appearance metadata. */
import { readdir, readFile, stat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BackendDocument } from './backend-state.js'
import { profilePresentations } from './agent-presentation.js'
import { importedSessionId } from './saved-session-state.js'

const states = new Set(['idle', 'running', 'awaiting', 'error'])
const icons = { codex: 'codex.png', claude: 'claudecode.png', codebuddy: 'codebuddy.png', cursor: 'cursor.png' }
export class SessionAppearance {
  constructor(client, profiles, config = {}) {
    this.client = client; this.profiles = profiles
    this.root = config.avatarDirectory ?? process.env.KODE_AVATAR_DIR ?? join(process.platform === 'darwin' ? join(homedir(), 'Library/Application Support') : process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'kode/avatars')
    if (this.root.startsWith('~/')) this.root = join(homedir(), this.root.slice(2))
  }
  profilesView() { return profilePresentations(this.profiles.list(), this.profiles.sharedState).map(profile => ({ ...profile, avatar: this.avatarForSession(undefined, profile.type, this.index, profile.id) })) }
  async load() { return this.index = await new BackendDocument(this.client, 'session-index').read() ?? { version: 1 } }
  avatarForSession(sessionId, type, index = this.index, profileId) {
    const local = row => !row.endpoint_id || row.endpoint_id.kind === 'local'
    const native = sessionId && index?.native_sessions?.find(row => local(row) && (row.dsh_session_id === sessionId || importedSessionId(row) === sessionId))
    const gui = sessionId && index?.gui?.tabs?.find(row => local(row) && (row.dsh_session_id === sessionId || importedSessionId(row) === sessionId || native && row.backend_key === native.backend_key && row.session_id === native.session_id))
    const pending = index?.presentation?.sessionAvatars
    const fallback = index?.presentation?.agentAvatars?.[profileId] ?? null
    const id = gui && Object.hasOwn(gui, 'avatar_id') ? gui.avatar_id : native && Object.hasOwn(native, 'avatar_id') ? native.avatar_id : Object.hasOwn(pending ?? {}, sessionId) ? pending[sessionId] : fallback
    return { id, url: `/api/kode/avatars/media?${id ? `avatar=${encodeURIComponent(id)}` : `type=${encodeURIComponent(type)}`}&state=idle` }
  }
  profileView(profile, sessionId, index) { return { ...profilePresentations([profile], this.profiles.sharedState)[0], avatar: this.avatarForSession(sessionId, profile.type, index, profile.id) } }
  async gallery() {
    let entries
    try { entries = await readdir(join(this.root, 'gallery'), { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    const result = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 256)) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.includes('.backup-')) continue
      const id = `gallery/${entry.name}`
      if (await this.imagePath(id, 'idle')) result.push({ id, name: entry.name, url: `/api/kode/avatars/media?avatar=${encodeURIComponent(id)}&state=idle` })
    }
    return result
  }
  async imagePath(id, state) {
    if (!/^gallery\/[^/\\\x00]+$/.test(id) || id.includes('..')) return
    const root = join(this.root, id), directories = [join(root, state), ...(state === 'idle' ? [] : [join(root, 'idle')]), root]
    for (const directory of directories) {
      let variants = []
      try { variants = (await readdir(directory, { withFileTypes: true })).filter(row => row.isDirectory()).map(row => join(directory, row.name)).sort() } catch { continue }
      for (const candidate of [join(directory, 'frame-01.png'), ...variants.map(path => join(path, 'frame-01.png'))]) {
        try {
          const file = await realpath(candidate), boundary = await realpath(this.root)
          if (relative(boundary, file).startsWith('..') || !file.startsWith(boundary + '/')) continue
          const info = await stat(file)
          if (info.isFile() && info.size <= 4 * 1024 * 1024) return file
        } catch { /* Incomplete avatar sets fall back to the native Agent mark. */ }
      }
    }
  }
  async setAgent(profileId, avatarId) {
    if (!this.profiles.list().some(profile => profile.id === profileId)) throw new Error('Agent 不存在，请刷新列表。')
    if (avatarId !== null && (!/^gallery\/[^/\\\x00]+$/.test(avatarId) || avatarId.includes('..'))) throw new Error('无效头像标识。')
    const document = new BackendDocument(this.client, 'session-index')
    for (let attempt = 0; attempt < 6; attempt++) {
      const value = await document.read() ?? { version: 1 }
      value.presentation ??= {}; value.presentation.agentAvatars ??= {}
      value.presentation.agentAvatars[profileId] = avatarId
      try { this.index = await document.write(value); return } catch (error) { if (attempt === 5 || !/configuration changed/.test(error.message)) throw error }
    }
  }
  async setSession(sessionId, avatarId) {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(sessionId)) throw new Error('无效会话。')
    // The entry frontend owns the artwork (also while executing on SSH).
    // Persist its safe gallery identity without requiring a second asset copy.
    if (avatarId !== null && (!/^gallery\/[^/\\\x00]+$/.test(avatarId) || avatarId.includes('..'))) throw new Error('无效头像标识。')
    const document = new BackendDocument(this.client, 'session-index')
    for (let attempt = 0; attempt < 6; attempt++) {
      const value = await document.read() ?? { version: 1 }, local = row => !row.endpoint_id || row.endpoint_id.kind === 'local'
      const native = (value.native_sessions ?? []).filter(row => local(row) && (row.dsh_session_id === sessionId || importedSessionId(row) === sessionId))
      const gui = (value.gui?.tabs ?? []).filter(row => local(row) && (row.dsh_session_id === sessionId || importedSessionId(row) === sessionId || native.some(tab => tab.backend_key === row.backend_key && tab.session_id === row.session_id)))
      value.presentation ??= {}; value.presentation.sessionAvatars ??= {}
      if (native.length || gui.length) { for (const row of [...native, ...gui]) row.avatar_id = avatarId; delete value.presentation.sessionAvatars[sessionId] }
      else value.presentation.sessionAvatars[sessionId] = avatarId
      try { this.index = await document.write(value); return } catch (error) { if (attempt === 5 || !/configuration changed/.test(error.message)) throw error }
    }
  }
}
export function registerAvatarApi(ctx, appearance) {
  return ctx.webServer.register({ kind: 'prefix', path: '/api/kode/avatars', handler: async (req, res) => {
    const admitted = ctx.connection.admit(req), send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'GET') return send(405, { error: 'GET required' })
    try {
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname === '/api/kode/avatars') return send(200, { avatars: await appearance.gallery() })
      if (url.pathname !== '/api/kode/avatars/media') return send(404, { error: 'Unknown image' })
      const state = url.searchParams.get('state') ?? 'idle'
      if (!states.has(state)) return send(400, { error: 'Invalid avatar state' })
      const icon = icons[url.searchParams.get('type')]
      const path = icon ? fileURLToPath(new URL(`../assets/agents/${icon}`, import.meta.url)) : await appearance.imagePath(url.searchParams.get('avatar') ?? '', state)
      if (!path) return send(404, { error: 'Avatar unavailable' })
      const bytes = await readFile(path)
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=60', 'x-content-type-options': 'nosniff' }); res.end(bytes)
    } catch { send(404, { error: 'Avatar unavailable' }) }
  } })
}

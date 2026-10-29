/** Frontend avatar resources and canonical, per-session appearance metadata. */
import { readdir, readFile, stat, realpath, lstat, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { avatarGenerationPrompt } from './avatar-generation.js'
import { BackendDocument } from './backend-state.js'
import { profilePresentations } from './agent-presentation.js'
import { importedSessionId } from './saved-session-state.js'
import { writePrivateJson } from './agent-profiles.js'

const states = new Set(['idle', 'running', 'awaiting', 'error'])
const icons = { codex: 'codex.png', claude: 'claudecode.png', codebuddy: 'codebuddy.png', cursor: 'cursor.png' }
const validAvatarId = id => typeof id === 'string' && /^gallery\/[^/\\\x00]+$/.test(id) && !id.includes('..')
function resolveGalleryId(id, catalog) {
  const seen = new Set()
  while (catalog.renamed?.[id]) { if (seen.has(id) || seen.size >= 32) return; seen.add(id); id = catalog.renamed[id] }
  return validAvatarId(id) ? id : undefined
}
export class SessionAppearance {
  constructor(client, profiles, config = {}) {
    this.client = client; this.profiles = profiles
    this.root = config.avatarDirectory ?? process.env.KODE_AVATAR_DIR ?? join(process.platform === 'darwin' ? join(homedir(), 'Library/Application Support') : process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'kode/avatars')
    if (this.root.startsWith('~/')) this.root = join(homedir(), this.root.slice(2))
    this.renameChain = Promise.resolve()
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
    // Picker visibility is entry-frontend metadata. Keep media IDs stable so
    // existing conversations can retain artwork removed from the picker.
    const catalog = await this.galleryCatalog(), hidden = Array.isArray(catalog.hidden) ? catalog.hidden : []
    let entries
    try { entries = await readdir(join(this.root, 'gallery'), { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    const result = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 256)) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.includes('.backup-')) continue
      const id = `gallery/${entry.name}`
      if (hidden.includes(id)) continue
      if (await this.imagePath(id, 'idle')) {
        const prefix = `/api/kode/avatars/media?avatar=${encodeURIComponent(id)}`
        const animations = Object.fromEntries(await Promise.all([...states].map(async state => [state, (await this.animationPaths(id, state)).map((_path, index) => `${prefix}&state=${state}&frame=${index + 1}`)])))
        const background = await this.backgroundPath(id), revision = background && await stat(background)
        result.push({ id, name: entry.name.replace(/^\d+-/, ''), aliases: Object.keys(catalog.renamed ?? {}).filter(alias => resolveGalleryId(alias, catalog) === id), url: `${prefix}&state=idle`, animations, ...(background ? { background: `/api/kode/avatars/background?avatar=${encodeURIComponent(id)}&v=${revision.mtimeMs}-${revision.size}` } : {}) })
      }
    }
    return result
  }
  async galleryCatalog() {
    try { return JSON.parse(await readFile(join(this.root, '.dsh-gallery.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return { version: 1 }; throw error }
  }
  renameAvatar(avatarId, inputName) {
    const task = this.renameChain.then(async () => {
      const name = typeof inputName === 'string' ? inputName.trim() : ''
      if (!name || name.length > 80 || Buffer.byteLength(name) > 240 || /^[.]/.test(name) || /[\/\\\x00-\x1f<>:"|?*]/.test(name) || name.includes('..') || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('名称不能包含路径或特殊字符，长度须为 1–80 字。')
      if (!validAvatarId(avatarId)) throw new Error('无效头像标识。')
      const before = await this.galleryCatalog(), oldId = resolveGalleryId(avatarId, before), newId = `gallery/${name}`
      if (!oldId || !(await this.gallery()).some(row => row.id === oldId)) throw new Error('头像不存在，请刷新头像库。')
      if (oldId === newId) return { id: newId, name }
      const source = join(this.root, oldId), destination = join(this.root, newId)
      const sourceInfo = await lstat(source)
      if (!sourceInfo.isDirectory()) throw new Error('只能重命名头像文件夹。')
      const parent = await realpath(join(this.root, 'gallery'))
      if (relative(await realpath(this.root), parent) !== 'gallery' || relative(parent, await realpath(source)) !== oldId.slice(8)) throw new Error('无效头像目录。')
      try { const existing = await lstat(destination); if (existing.ino !== sourceInfo.ino || existing.dev !== sourceInfo.dev) throw new Error('已有同名头像，请换一个名称。') } catch (error) { if (error.code !== 'ENOENT') throw error }
      const document = new BackendDocument(this.client, 'session-index')
      await document.read() // Validate metadata access before moving any artwork.
      const catalogPath = join(this.root, '.dsh-gallery.json'), next = structuredClone(before)
      next.renamed ??= {}
      for (const alias of Object.keys(next.renamed)) if (resolveGalleryId(alias, before) === oldId) next.renamed[alias] = newId
      delete next.renamed[newId]; next.renamed[oldId] = newId
      if (Array.isArray(next.hidden)) next.hidden = next.hidden.map(id => id === oldId ? newId : id)
      await rename(source, destination)
      try {
        // Old URLs (including SSH session references) continue resolving while
        // all local native/GUI/default appearance records adopt the new folder.
        await writePrivateJson(catalogPath, next)
        for (let attempt = 0; attempt < 6; attempt++) {
          const value = await document.read() ?? { version: 1 }
          for (const row of [...(value.native_sessions ?? []), ...(value.gui?.tabs ?? [])]) if (row.avatar_id === oldId) row.avatar_id = newId
          for (const key of ['agentAvatars', 'sessionAvatars']) for (const id of Object.keys(value.presentation?.[key] ?? {})) if (value.presentation[key][id] === oldId) value.presentation[key][id] = newId
          try { this.index = await document.write(value); return { id: newId, name } }
          catch (error) { if (attempt === 5 || !/configuration changed/.test(error.message)) throw error }
        }
      } catch (error) {
        await rename(destination, source)
        await writePrivateJson(catalogPath, before)
        throw error
      }
    })
    this.renameChain = task.catch(() => {})
    return task
  }
  async safeImage(candidate, limit = 4 * 1024 * 1024) {
    try {
      const file = await realpath(candidate), boundary = await realpath(this.root)
      if (relative(boundary, file).startsWith('..') || !file.startsWith(boundary + '/')) return
      const info = await stat(file)
      if (info.isFile() && info.size <= limit) return file
    } catch { /* Missing or incomplete artwork is optional. */ }
  }
  async animationPaths(id, state) {
    id = resolveGalleryId(id, await this.galleryCatalog())
    if (!/^gallery\/[^/\\\x00]+$/.test(id) || id.includes('..') || !states.has(state)) return []
    const root = join(this.root, id), directories = [join(root, state), ...(state === 'idle' ? [] : [join(root, 'idle')]), root]
    for (const directory of directories) {
      let entries
      try { entries = await readdir(directory, { withFileTypes: true }) } catch { continue }
      const folders = [directory, ...entries.filter(row => row.isDirectory() && !row.name.startsWith('.')).map(row => join(directory, row.name)).sort()]
      const frames = []
      for (const folder of folders) {
        for (let frame = 1; frame <= 4; frame++) {
          const path = await this.safeImage(join(folder, `frame-${String(frame).padStart(2, '0')}.png`))
          if (path) frames.push(path)
        }
        if (frames.length >= 24) break
      }
      if (frames.length) return frames.slice(0, 24)
    }
    return []
  }
  async imagePath(id, state, frame = 1) { return (await this.animationPaths(id, state))[frame - 1] }
  async backgroundPath(id) {
    id = resolveGalleryId(id, await this.galleryCatalog())
    if (!/^gallery\/[^/\\\x00]+$/.test(id) || id.includes('..')) return
    for (const name of ['background.png', 'background.jpg', 'background.jpeg', 'background.webp']) {
      const path = await this.safeImage(join(this.root, id, name), 16 * 1024 * 1024)
      if (path) return path
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
    try {
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'POST' && url.pathname === '/api/kode/avatars/rename') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON body required' })
        let body = ''
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 4096) return send(413, { error: '名称请求过大。' }) }
        const input = JSON.parse(body)
        return send(200, await appearance.renameAvatar(input.avatarId, input.name))
      }
      if (req.method !== 'GET') return send(405, { error: 'GET required' })
      if (url.pathname === '/api/kode/avatars') return send(200, { avatars: await appearance.gallery(), canRename: true })
      if (url.pathname === '/api/kode/avatars/generation-prompt') return send(200, await avatarGenerationPrompt(appearance, { avatarId: url.searchParams.get('avatar'), backgroundOnly: url.searchParams.get('mode') === 'background' }))
      if (url.pathname === '/api/kode/avatars/background') {
        const path = await appearance.backgroundPath(url.searchParams.get('avatar') ?? '')
        if (!path) return send(404, { error: 'Background unavailable' })
        const mime = path.endsWith('.webp') ? 'image/webp' : /\.jpe?g$/.test(path) ? 'image/jpeg' : 'image/png'
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'private, max-age=60', 'x-content-type-options': 'nosniff' }); res.end(await readFile(path)); return
      }
      if (url.pathname !== '/api/kode/avatars/media') return send(404, { error: 'Unknown image' })
      const state = url.searchParams.get('state') ?? 'idle'
      if (!states.has(state)) return send(400, { error: 'Invalid avatar state' })
      const icon = icons[url.searchParams.get('type')]
      const frame = Number(url.searchParams.get('frame') ?? 1)
      if (!Number.isInteger(frame) || frame < 1 || frame > 24) return send(400, { error: 'Invalid avatar frame' })
      const path = icon ? fileURLToPath(new URL(`../assets/agents/${icon}`, import.meta.url)) : await appearance.imagePath(url.searchParams.get('avatar') ?? '', state, frame)
      if (!path) return send(404, { error: 'Avatar unavailable' })
      const bytes = await readFile(path)
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=60', 'x-content-type-options': 'nosniff' }); res.end(bytes)
    } catch (error) { send(req.method === 'POST' ? 400 : 404, { error: req.method === 'POST' ? error.message : 'Avatar unavailable' }) }
  } })
}

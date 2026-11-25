import { admitHostRequest } from './host-admission.js'
/** Owner-scoped discovery and selection of Agent-native sessions on this Host. */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { profileRevision } from './agent-profiles.js'
import { BackendDocument } from './backend-state.js'
import { savedSessionProfile } from './saved-session-profile.js'
import { localSavedTabs, savedSessionTime } from './saved-session-state.js'
import { importSavedSession } from './workbench-import.js'

export const NATIVE_SESSIONS_PATH = '/api/kode/native-sessions'
const selectionLifetime = 30 * 60_000
const selectionLimit = 5000

export class NativeSessionDirectory {
  constructor(ctx, backend) {
    this.ctx = ctx
    this.backend = backend
    this.selections = new Map()
  }
  runtime() {
    const runtime = this.ctx.get('kodeAgents')
    if (!runtime) throw new Error('Agent 服务尚未就绪，请重试。')
    return runtime
  }
  async profile(profileId) {
    const runtime = this.runtime()
    await runtime.profiles.reload?.()
    const profile = runtime.profiles.list().find(row => row.id === profileId)
    if (!profile || profile.type === 'dsh' || !runtime.hasRuntime(profile.type)) throw new Error('所选 Agent 配置已不可用，请重新选择。')
    return profile
  }
  async list(profileId, cursor, signal) {
    if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 4096)) throw new Error('无效的会话列表游标。')
    const profile = await this.profile(profileId)
    const revision = profileRevision(profile)
    const page = await this.runtime().adapter.listSessions(profile, cursor, signal)
    for (const [key, row] of this.selections) if (row.expires <= Date.now()) this.selections.delete(key)
    const seen = new Set()
    const replaced = new Set(Object.values(this.runtime().profiles.bindings ?? {})
      .filter(binding => binding.profile.id === profile.id).flatMap(binding => binding.supersededThreads ?? []))
    const sessions = page.sessions.flatMap(row => {
      const { sessionId, cwd } = row
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || /[\x00-\x1f]/.test(sessionId)
        || typeof cwd !== 'string' || cwd.length > 4096 || cwd.includes('\0') || !isAbsolute(cwd) || seen.has(sessionId) || replaced.has(sessionId)) return []
      seen.add(sessionId)
      const title = typeof row.title === 'string' ? row.title.trim().slice(0, 512) : ''
      const selection = randomUUID()
      this.selections.set(selection, { sessionId, cwd, title, profileId, revision, expires: Date.now() + selectionLifetime })
      return [{ selection, nativeThreadId: sessionId, title: title || '未命名会话', cwd, updatedAt: savedSessionTime({ updatedAt: row.updatedAt, session_id: sessionId }) }]
    })
    while (this.selections.size > selectionLimit) this.selections.delete(this.selections.keys().next().value)
    return { supported: page.supported, sessions, nextCursor: page.nextCursor === cursor ? null : page.nextCursor }
  }
  async savedTab(profile, sessionId, cwd, title) {
    const profiles = this.runtime().profiles
    const [index, catalog] = await Promise.all([
      new BackendDocument(this.backend, 'session-index').read(),
      this.backend.call('/api/v1/messaging/workbench/catalog'),
    ])
    const saved = localSavedTabs(index).find(tab => tab.session_id === sessionId && savedSessionProfile(profiles, tab)?.id === profile.id)
    const backend = catalog.agent_ids?.[profile.id] ?? profiles.sharedState?.desktop_ids?.[profile.id]
    return {
      ...saved, agent_id: profile.id, backend_key: saved?.backend_key ?? backend ?? profile.id,
      session_id: sessionId, cwd, title: title || saved?.title,
    }
  }
  async open(input) {
    if (typeof input.selection === 'string') {
      const selected = this.selections.get(input.selection)
      if (!selected || selected.expires <= Date.now()) throw new Error('原生会话列表已过期，请重新打开后选择。')
      const profile = await this.profile(selected.profileId)
      if (profileRevision(profile) !== selected.revision) throw new Error('Agent 配置已更新，请重新打开会话列表。')
      const tab = await this.savedTab(profile, selected.sessionId, selected.cwd, selected.title)
      return importSavedSession(this.ctx, this.backend, tab, { discovered: true })
    }
    if (typeof input.sessionId !== 'string' || input.sessionId.length > 256) throw new Error('无效的会话 ID。')
    if (input.lookupOnly === true) {
      const { items } = await this.ctx.get('sessionController').list({})
      const summary = items.find(row => row.sessionId === input.sessionId)
      if (!summary) throw new Error('当前主机的 DSH 目录中找不到此会话。')
      return { sessionId: summary.sessionId, summary }
    }
    const runtime = this.runtime()
    const binding = runtime.profiles.binding(input.sessionId)
    if (!binding?.threadId || binding.profile.type === 'dsh') return { sessionId: input.sessionId }
    const controller = this.ctx.get('sessionController')
    const { items } = await controller.list({})
    const item = items.find(row => row.sessionId === input.sessionId)
    if (!item?.cwd || item.running) return { sessionId: input.sessionId }
    const tab = await this.savedTab(binding.profile, binding.threadId, item.cwd)
    return importSavedSession(this.ctx, this.backend, tab, { localSessionId: input.sessionId, refreshOnly: true })
  }
}

export function registerNativeSessionDirectory(ctx, backend) {
  const directory = new NativeSessionDirectory(ctx, backend)
  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }
  return ctx.webServer.register({ kind: 'exact', path: NATIVE_SESSIONS_PATH, handler: async (req, res, peer) => {
    const admitted = admitHostRequest(ctx, req, peer)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return json(res, 403, { error: 'Host owner required' })
    if (!backend) return json(res, 503, { error: 'Kode backend is unavailable' })
    try {
      if (req.method === 'GET') {
        const query = new URL(req.url, 'http://localhost').searchParams
        if (query.has('summary')) return json(res, 200, await directory.open({ sessionId: query.get('summary'), lookupOnly: true }))
        const request = new AbortController()
        const cancel = () => request.abort()
        res.once('close', cancel)
        try {
          const page = await directory.list(query.get('profile_id'), query.get('cursor'), request.signal)
          if (!res.destroyed) json(res, 200, page)
        } finally { res.off('close', cancel) }
        return
      }
      if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) return json(res, 405, { error: 'GET or JSON POST required' })
      let body = ''
      for await (const part of req) {
        body += part
        if (Buffer.byteLength(body) > 16_384) throw new Error('Request too large')
      }
      return json(res, 200, await directory.open(JSON.parse(body)))
    } catch (error) {
      if (!res.destroyed) json(res, 400, { error: error.message })
    }
  } })
}

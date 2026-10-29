/** Host-owned executable profiles. Type selects a protocol; ID selects a configuration. */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

export const AGENT_TYPES = Object.freeze({
  dsh: { name: 'DeepSeek Harness', executable: null },
  codex: { name: 'Codex', executable: 'codex' },
  claude: { name: 'Claude Code', executable: 'claude' },
  codebuddy: { name: 'CodeBuddy', executable: 'codebuddy' },
  cursor: { name: 'Cursor', executable: 'agent' },
  custom: { name: '自定义', executable: '' },
})
export const HOST_ONLY_ENV = new Set(['KODE_BRIDGE_TOKEN', 'KODE_MESSAGING_ADMIN_TOKEN_FILE', 'KODE_MESSAGING_TOKEN_FILE', 'KODE_SESSION_ID', 'KODE_HOOK_SOCK'])
export const profileRoute = id => `kode-agent-${id}`
const text = (value, label, max = 4096) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`invalid ${label}`)
  return value
}
export function normalizeProfile(input) {
  if (!input || !Object.hasOwn(AGENT_TYPES, input.type)) throw new Error('select an Agent type')
  const id = input.id ?? randomUUID()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(id)) throw new Error('invalid Agent profile ID')
  const profile = { id, name: text(input.name, 'Agent name', 160), type: input.type, origin: 'custom' }
  if (input.type === 'custom') {
    profile.protocol = input.protocol ?? 'acp'
    if (!['acp', 'codex'].includes(profile.protocol)) throw new Error('custom Agent protocol must be acp or codex')
  }
  if (input.type !== 'dsh') {
    profile.executable = text(input.executable ?? AGENT_TYPES[input.type].executable, 'executable')
    profile.args = input.args ?? []
    if (!Array.isArray(profile.args) || profile.args.some(v => typeof v !== 'string' || v.includes('\0'))) throw new Error('arguments must be an array of strings')
    const env = input.env ?? {}
    if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('environment must be an object')
    profile.env = Object.fromEntries(Object.entries(env).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('invalid environment entry')
      if (HOST_ONLY_ENV.has(key)) throw new Error(`${key} is owned by the Host; use the session-scoped dynamic tools`)
      return [key, value]
    }))
  }
  if (input.defaultModel !== undefined) profile.defaultModel = text(input.defaultModel, 'default model', 256)
  return structuredClone(profile)
}
export function profileRevision(profile) {
  return createHash('sha256').update(JSON.stringify({ ...profile, env: Object.entries(profile.env ?? {}).sort() })).digest('hex')
}
export async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(temporary, path)
}

export class AgentProfiles {
  constructor(path) { this.path = path; this.profiles = []; this.bindings = Object.create(null); this.chain = Promise.resolve() }
  async open(initial = []) {
    let fresh = false
    try {
      const stored = JSON.parse(await readFile(this.path, 'utf8'))
      if (stored.version !== 1 || !Array.isArray(stored.profiles) || !stored.bindings || typeof stored.bindings !== 'object' || Array.isArray(stored.bindings)) throw new Error('unsupported Agent profile file')
      this.profiles = stored.profiles.map(p => ({ ...normalizeProfile(p), ...(p.origin === 'builtin' && p.id === `builtin-${p.type}` && p.type !== 'custom' ? { origin: 'builtin' } : {}) }))
      this.bindings = Object.assign(Object.create(null), stored.bindings)
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
      this.profiles = initial.map(normalizeProfile)
      fresh = true
    }
    const ids = new Set()
    for (const p of this.profiles) { if (ids.has(p.id)) throw new Error(`duplicate Agent profile ID: ${p.id}`); ids.add(p.id) }
    if (fresh) await writePrivateJson(this.path, { version: 1, profiles: this.profiles, bindings: this.bindings })
    return this
  }
  list() { return structuredClone(this.profiles) }
  get(id) { const p = this.profiles.find(p => p.id === id); if (!p) throw new Error('unknown Agent profile'); return structuredClone(p) }
  binding(sessionId) { return this.bindings[sessionId] ? structuredClone(this.bindings[sessionId]) : undefined }
  update(operation) {
    const task = this.chain.then(async () => {
      const state = { version: 1, profiles: this.list(), bindings: structuredClone(this.bindings) }
      const result = operation(state)
      await writePrivateJson(this.path, state)
      this.profiles = state.profiles; this.bindings = Object.assign(Object.create(null), state.bindings)
      return structuredClone(result)
    })
    this.chain = task.catch(() => {})
    return task
  }
  save(input) {
    const p = normalizeProfile(input)
    return this.update(state => {
      if (p.id.startsWith('builtin-') || state.profiles.find(v => v.id === p.id)?.origin === 'builtin') throw new Error('内置 Agent 不能修改，请添加自定义配置。')
      const index = state.profiles.findIndex(v => v.id === p.id)
      if (index < 0) state.profiles.push(p); else state.profiles[index] = p
      return p
    })
  }
  remove(id) { return this.update(state => {
    const profile = state.profiles.find(p => p.id === id)
    if (!profile) throw new Error('此自定义 Agent 配置不存在或已删除。')
    if (profile.origin === 'builtin') throw new Error('内置 Agent 不能删除。')
    state.profiles = state.profiles.filter(p => p.id !== id)
    return { removed: id }
  }) }
  ensureBuiltins(profiles) { return this.update(state => {
    const builtin = profiles.map(p => ({ ...normalizeProfile(p), origin: 'builtin' }))
    if (builtin.some(p => p.id !== `builtin-${p.type}` || p.type === 'custom')) throw new Error('invalid built-in Agent identity')
    state.profiles = [...builtin, ...state.profiles.filter(p => p.origin !== 'builtin' && !builtin.some(b => b.id === p.id))]
  }) }
  bind(sessionId, profileId) {
    return this.update(state => {
      const existing = Object.hasOwn(state.bindings, sessionId) ? state.bindings[sessionId] : undefined
      if (existing) {
        if (existing.profile.id !== profileId) throw new Error('start a new conversation to change its Agent configuration')
        return existing
      }
      const profile = state.profiles.find(p => p.id === profileId)
      if (!profile) throw new Error('unknown Agent profile')
      const binding = { profile, revision: profileRevision(profile), seenInputs: [] }
      Object.defineProperty(state.bindings, sessionId, { value: binding, enumerable: true, configurable: true, writable: true })
      return binding
    })
  }
  patchBinding(sessionId, patch) {
    return this.update(state => {
      if (!Object.hasOwn(state.bindings, sessionId)) throw new Error('unknown Agent session binding')
      return Object.assign(state.bindings[sessionId], patch)
    })
  }
  bindNative(sessionId, profileId, threadId) {
    return this.update(state => {
      const existing = Object.hasOwn(state.bindings, sessionId) ? state.bindings[sessionId] : undefined
      if (existing) {
        if (existing.profile.id !== profileId || (existing.threadId && existing.threadId !== threadId)) throw new Error('native conversation identity changed')
        if (existing.threadId === threadId) return existing
        if (existing.seenInputs?.length) throw new Error('native conversation already received input')
      }
      const prior = Object.values(state.bindings).find(row => row.threadId === threadId && row.profile.id === profileId)
      const profile = prior?.profile ?? existing?.profile ?? state.profiles.find(row => row.id === profileId)
      if (!profile) throw new Error('unknown Agent profile')
      const binding = { profile: structuredClone(profile), revision: profileRevision(profile), threadId, seenInputs: [] }
      Object.defineProperty(state.bindings, sessionId, { value: binding, enumerable: true, configurable: true, writable: true })
      return binding
    })
  }
  clearUnusedBinding(sessionId) {
    return this.update(state => {
      const binding = Object.hasOwn(state.bindings, sessionId) ? state.bindings[sessionId] : undefined
      if (binding && (binding.threadId || binding.seenInputs.length)) throw new Error('start a new conversation to change its Agent configuration')
      delete state.bindings[sessionId]
      return { cleared: sessionId }
    })
  }
}

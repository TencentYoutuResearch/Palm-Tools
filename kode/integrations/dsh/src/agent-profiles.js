/** Host-owned executable profiles. Type selects a protocol; ID selects a configuration. */
import { readFile } from 'node:fs/promises'
import { writePrivateJson } from './private-json-store.js'
import { LocalAgentPreferences, normalizeTeamRoles, normalizeRoleTargets } from './local-agent-preferences.js'
export { writePrivateJson } from './private-json-store.js'
import { randomUUID, createHash } from 'node:crypto'
import { normalizeManagedInference } from './managed-codex-profile.js'

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
  if (input.defaultReasoningEffort != null) profile.defaultReasoningEffort = text(input.defaultReasoningEffort, 'default reasoning effort', 64)
  if (input.allowedModels != null) {
    if (!Array.isArray(input.allowedModels) || !input.allowedModels.length || input.allowedModels.length > 256) throw new Error('allowedModels must be a nonempty model ID list')
    profile.allowedModels = [...new Set(input.allowedModels.map(id => text(id, 'allowed model', 256)))]
  }
  if (input.managedInference != null) {
    if (!['codex', 'claude'].includes(profile.type) && profile.protocol !== 'codex') throw new Error('Managed inference requires a Codex or Claude protocol profile')
    profile.managedInference = normalizeManagedInference(input.managedInference)
    if (profile.type === 'claude' && (profile.args.length || !profile.managedInference.bootstrap?.provider
        || !profile.managedInference.bootstrap.home || profile.managedInference.bootstrap.pathVariable !== 'TCLAUDE_CLAUDE_PATH')) throw Error('Managed Claude requires a pinned wrapper bootstrap')
    if (profile.managedInference.responseModels && (profile.type !== 'claude' || Object.keys(profile.managedInference.responseModels).some(model => !(profile.allowedModels ?? [profile.defaultModel]).includes(model)))) throw Error('Response model mapping requires a Claude allowed model')
    if (profile.defaultReasoningEffort && !profile.managedInference.reasoningEfforts.includes(profile.defaultReasoningEffort)) throw new Error('Managed inference must declare the default reasoning effort')
  }
  return structuredClone(profile)
}
export function profileRevision(profile) {
  return createHash('sha256').update(JSON.stringify({ ...profile, env: Object.entries(profile.env ?? {}).sort() })).digest('hex')
}

export function normalizeModelDefaults(input) {
  if (input === undefined) return {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid default model configuration')
  return Object.fromEntries(Object.entries(input).map(([id, value]) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(id) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid default model configuration')
    const selection = { model: text(value.model, 'default model', 256) }
    if (value.reasoningEffort !== undefined) selection.reasoningEffort = text(value.reasoningEffort, 'default reasoning effort', 128)
    if (value.fast !== undefined) {
      if (typeof value.fast !== 'boolean') throw new Error('Fast 必须是布尔值。')
      selection.fast = value.fast
    }
    return [id, selection]
  }))
}
export class AgentProfiles {
  constructor(path) { this.path = path; this.localPreferences = new LocalAgentPreferences(`${path}.preferences.json`); this.defaultProfileId = null; this.modelDefaults = {}; this.coordinatorStartPlans = Object.create(null); this.profiles = []; this.bindings = Object.create(null); this.chain = Promise.resolve() }
  async open(initial = []) {
    await this.localPreferences.open()
    let fresh = false
    try {
      const stored = JSON.parse(await readFile(this.path, 'utf8'))
      if (stored.version !== 1 || !Array.isArray(stored.profiles) || !stored.bindings || typeof stored.bindings !== 'object' || Array.isArray(stored.bindings)) throw new Error('unsupported Agent profile file')
      this.profiles = stored.profiles.map(p => ({ ...normalizeProfile(p), ...(p.origin === 'builtin' && p.id === `builtin-${p.type}` && p.type !== 'custom' ? { origin: 'builtin' } : {}) }))
      this.defaultProfileId = stored.defaultProfileId ?? null
      this.modelDefaults = normalizeModelDefaults(stored.modelDefaults)
      this.bindings = Object.assign(Object.create(null), stored.bindings)
      if (stored.coordinatorStartPlans !== undefined && (!stored.coordinatorStartPlans || typeof stored.coordinatorStartPlans !== 'object' || Array.isArray(stored.coordinatorStartPlans))) throw new Error('unsupported Coordinator start plans')
      this.coordinatorStartPlans = Object.assign(Object.create(null), stored.coordinatorStartPlans ?? {})
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
      this.profiles = initial.map(normalizeProfile)
      fresh = true
    }
    const ids = new Set()
    for (const p of this.profiles) { if (ids.has(p.id)) throw new Error(`duplicate Agent profile ID: ${p.id}`); ids.add(p.id) }
    if (fresh) await writePrivateJson(this.path, { version: 1, profiles: this.profiles, bindings: this.bindings, modelDefaults: this.modelDefaults, coordinatorStartPlans: this.coordinatorStartPlans })
    return this
  }
  // Legacy runtime routes remain resolvable. Only listAgents() is the new
  // executor picker; it never changes an existing session's profile snapshot.
  nativeAgentCatalog() {
    return this.localPreferences.state.agentCatalog.flatMap(entry => {
      const source = this.profiles.find(profile => profile.id === entry.sourceProfileId)
      if (!source || profileRevision(source) !== entry.sourceProfileRevision || this.profiles.some(profile => profile.id === entry.id)) return []
      const { type, protocol, executable, args, env } = source
      return [normalizeProfile({ id: entry.id, name: entry.name, type, ...(protocol ? { protocol } : {}), ...(type === 'dsh' ? {} : { executable, args, env }) })]
    })
  }
  list() { return structuredClone([...this.profiles, ...this.nativeAgentCatalog()]) }
  listAgents() {
    const rows = this.list(), byId = new Map(rows.map(profile => [profile.id, profile]))
    return rows.filter(profile => this.localPreferences.state.archivedProfiles?.[profile.id] !== profileRevision(profile) && !this.catalogAliasTarget(profile.id, byId)).map(profile => {
      const { defaultModel, defaultReasoningEffort, ...identity } = profile
      return identity
    })
  }
  catalogAliasTarget(id, byId) {
    const alias = Object.hasOwn(this.localPreferences.state.profileAliases, id) && this.localPreferences.state.profileAliases[id]
    const source = alias && byId.get(id), target = alias && byId.get(alias.profileId)
    if (!source || !target || profileRevision(source) !== alias.sourceProfileRevision || target.managedInference || target.allowedModels) return undefined
    const cli = ({ type, protocol, executable, args, env }) => profileRevision({ type, protocol, executable, args, env })
    return cli(source) === cli(target) ? target.id : undefined
  }
  canonicalProfileId(id) { return this.catalogAliasTarget(id, new Map(this.list().map(profile => [profile.id, profile]))) ?? id }
  teamRolesFor(teamId) { return this.localPreferences.rolesFor(teamId) }
  setTeamRoles(teamId, assignments, expectedRevision) {
    const normalized = normalizeTeamRoles({ [teamId]: assignments })[teamId]
    for (const assignment of Object.values(normalized)) {
      const profile = this.get(assignment.profileId)
      if (this.canonicalProfileId(profile.id) !== profile.id) throw Error('Select a native Agent identity for the Team role')
      if (assignment.sourceProfileId && (profileRevision(this.get(assignment.sourceProfileId)) !== assignment.sourceProfileRevision || this.canonicalProfileId(assignment.sourceProfileId) !== assignment.profileId)) throw Error('Legacy role source changed')
    }
    return this.localPreferences.setTeamRoles(teamId, normalized, expectedRevision)
  }
  teamRoleTargetsFor(teamId) { return this.localPreferences.targetsFor(teamId) }
  // Detached authority view: never overwrite session snapshots or create a missing registry.
  async candidateRegistry() {
    const stored = JSON.parse(await readFile(this.path, 'utf8'))
    return this.candidateRegistryView(stored)
  }
  candidateRegistryView(stored) {
    if (stored?.version !== 1 || !Array.isArray(stored.profiles)) throw Error('Agent registry unavailable')
    const view = Object.create(this)
    view.profiles = stored.profiles.map(p => ({ ...normalizeProfile(p), ...(p.origin === 'builtin' && p.id === `builtin-${p.type}` && p.type !== 'custom' ? { origin: 'builtin' } : {}) }))
    return view
  }
  async teamRoleTargetDiagnostics(teamId) {
    const assignments = this.teamRoleTargetsFor(teamId)
    let registry
    try { registry = await this.candidateRegistry() }
    catch { return [{ code: 'registry_unavailable' }] }
    const known = new Set(registry.list().map(profile => profile.id))
    return Object.entries(assignments).flatMap(([role, candidates]) => candidates.flatMap((candidate, index) =>
      known.has(candidate.profileId) ? [] : [{ role, index, profileId: candidate.profileId, code: 'agent_missing' }]))
  }
  async setTeamRoleTargets(teamId, assignments, expectedRevision) {
    const normalized = normalizeRoleTargets({ [teamId]: assignments })[teamId]
    // Refresh from the provider's authority, not the legacy path in shared mode.
    // This check is diagnostic/configuration validation, not a cross-provider transaction.
    await this.localPreferences.open()
    const registry = await this.candidateRegistry()
    for (const candidates of Object.values(normalized)) for (const assignment of candidates) {
      const profile = registry.list().find(profile => profile.id === assignment.profileId)
      if (!profile) throw Error('agent_missing: ' + assignment.profileId)
      if (registry.canonicalProfileId(profile.id) !== profile.id) throw Error('Select a native Agent identity for the Team role')
      if (assignment.sourceProfileId && (profileRevision(registry.get(assignment.sourceProfileId)) !== assignment.sourceProfileRevision || registry.canonicalProfileId(assignment.sourceProfileId) !== assignment.profileId)) throw Error('Legacy role source changed')
    }
    return this.localPreferences.setRoleTargets(teamId, normalized, expectedRevision)
  }
  get(id) { const p = this.list().find(p => p.id === id); if (!p) throw new Error('unknown Agent profile'); return structuredClone(p) }
  binding(sessionId) { return this.bindings[sessionId] ? structuredClone(this.bindings[sessionId]) : undefined }
  update(operation) {
    const task = this.chain.then(async () => {
      const state = { version: 1, defaultProfileId: this.defaultProfileId, modelDefaults: structuredClone(this.modelDefaults), profiles: structuredClone(this.profiles), bindings: structuredClone(this.bindings), coordinatorStartPlans: structuredClone(this.coordinatorStartPlans) }
      const result = await operation(state)
      await writePrivateJson(this.path, state)
      this.defaultProfileId = state.defaultProfileId ?? null
      this.modelDefaults = normalizeModelDefaults(state.modelDefaults)
      this.coordinatorStartPlans = Object.assign(Object.create(null), state.coordinatorStartPlans)
      this.profiles = state.profiles; this.bindings = Object.assign(Object.create(null), state.bindings)
      return structuredClone(result)
    })
    this.chain = task.catch(() => {})
    return task
  }
  setDefaultProfile(id) {
    if (id !== null) this.get(id)
    return this.update(state => { state.defaultProfileId = id; return { defaultProfileId: id } })
  }
  setDefaultModel(id, selection) {
    this.get(id)
    return this.localPreferences.setModel(id, selection)
  }
  defaultModelFor(id) {
    // Read legacy shared defaults only as fallback. All new writes are local.
    const profile = this.list().find(row => row.id === id)
    if (!profile) return undefined
    const fallback = this.legacyLocalModelDefaults?.[id] ?? this.modelDefaults[id] ?? (profile?.defaultModel || profile?.defaultReasoningEffort ? { ...(profile.defaultModel ? { model: profile.defaultModel } : {}), ...(profile.defaultReasoningEffort ? { reasoningEffort: profile.defaultReasoningEffort } : {}) } : undefined)
    return this.localPreferences.selectionFor(id, fallback)
  }
  async save(input) {
    const p = normalizeProfile(input), prior = this.list().find(row => row.id === p.id)
    const hasSelection = Object.hasOwn(input, 'defaultModel') || Object.hasOwn(input, 'defaultReasoningEffort')
    let selection = this.defaultModelFor(p.id) ?? {}
    if (Object.hasOwn(input, 'defaultModel')) {
      if (input.defaultModel == null) delete selection.model
      else selection.model = p.defaultModel
    }
    if (Object.hasOwn(input, 'defaultReasoningEffort')) {
      if (input.defaultReasoningEffort == null) delete selection.reasoningEffort
      else selection.reasoningEffort = p.defaultReasoningEffort
    }
    // Model/effort preferences no longer mutate a native executable identity.
    // Preserve the exact former response allow-list if it relied on defaultModel.
    if (p.managedInference?.responseModels && !p.allowedModels && p.defaultModel) p.allowedModels = [p.defaultModel]
    delete p.defaultModel; delete p.defaultReasoningEffort
    if (this.localPreferences.state.agentCatalog.some(row => row.id === p.id)) {
      throw Error('Edit the original CLI configuration and explicitly review its Agent catalog mapping')
    } else {
      await this.update(state => {
        if (p.id.startsWith('builtin-') || state.profiles.find(v => v.id === p.id)?.origin === 'builtin') throw new Error('内置 Agent 不能修改，请添加自定义配置。')
        const index = state.profiles.findIndex(v => v.id === p.id)
        if (index < 0) state.profiles.push(p); else {
          for (const field of ['allowedModels', 'managedInference']) if (!Object.hasOwn(input, field) && Object.hasOwn(state.profiles[index], field)) p[field] = state.profiles[index][field]
          if (p.managedInference?.responseModels && !p.allowedModels && prior?.defaultModel) p.allowedModels = [prior.defaultModel]
          normalizeProfile({ ...p, ...(selection.reasoningEffort ? { defaultReasoningEffort: selection.reasoningEffort } : {}) })
          state.profiles[index] = p
        }
      })
    }
    if (hasSelection || prior?.defaultModel || prior?.defaultReasoningEffort) await this.localPreferences.setModel(p.id, Object.keys(selection).length ? selection : null)
    return structuredClone(p)
  }
  remove(id) { return this.update(async state => {
    await this.localPreferences.open()
    const local = this.localPreferences.state
    const referenced = [...Object.values(local.teamRoles).flatMap(Object.values), ...Object.values(local.roleTargets).flatMap(roles => Object.values(roles).flat())]
    const derivedIds = new Set(local.agentCatalog.filter(row => row.sourceProfileId === id).map(row => row.id))
    if (referenced.some(row => row.profileId === id || row.sourceProfileId === id || derivedIds.has(row.profileId) || derivedIds.has(row.sourceProfileId))) throw Error('Agent is referenced by local Team preferences; remove references first')
    const profile = state.profiles.find(p => p.id === id)
    if (!profile) throw new Error('此自定义 Agent 配置不存在或已删除。')
    if (profile.origin === 'builtin') throw new Error('内置 Agent 不能删除。')
    state.profiles = state.profiles.filter(p => p.id !== id)
    delete state.modelDefaults?.[id]
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
      const profile = state.profiles.find(p => p.id === profileId) ?? this.nativeAgentCatalog().find(p => p.id === profileId)
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
      const profile = prior?.profile ?? existing?.profile ?? state.profiles.find(row => row.id === profileId) ?? this.nativeAgentCatalog().find(row => row.id === profileId)
      if (!profile) throw new Error('unknown Agent profile')
      const binding = { ...existing, profile: structuredClone(profile), revision: profileRevision(profile), threadId, seenInputs: [] }
      Object.defineProperty(state.bindings, sessionId, { value: binding, enumerable: true, configurable: true, writable: true })
      return binding
    })
  }
  clearUnusedBinding(sessionId) {
    return this.update(state => {
      const binding = Object.hasOwn(state.bindings, sessionId) ? state.bindings[sessionId] : undefined
      if (binding && (binding.threadId || binding.seenInputs.length || binding.managedOperation || binding.officialToolArchive || Object.keys(binding.officialCalls ?? {}).length || Object.keys(binding.officialTools ?? {}).length || binding.quotaFenceRevision || binding.remoteQuotaFences?.length || Object.keys(binding.usageOutbox ?? {}).length)) throw new Error('start a new conversation to change its Agent configuration')
      delete state.bindings[sessionId]
      return { cleared: sessionId }
    })
  }
}

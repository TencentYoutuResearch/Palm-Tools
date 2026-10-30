import { savedImportIdentity } from './saved-session-state.js'
/** Kode saved CLI sessions: import display history once, retain the original native thread. */
import { BackendDocument } from './backend-state.js'
import { buildHistorySeed } from './native-history.js'
import { normalizeProfile, profileRevision, profileRoute } from './agent-profiles.js'
// These Kode Codex entries do not require an MCP setup declaration. Custom
// executable names still require an explicit protocol declaration.
const KODE_CODEX_BACKENDS = new Set(['codex', 'native-codex', 'gateway-codex', 'tcodex'])
export function backendProfile(key, config) {
  const style = config.mcp_setup?.style
  const type = style === 'codebuddy'||config.protocol==='codebuddy'?'codebuddy':style === 'codex' ? 'codex' : style === 'claude' ? 'claude' : !style && KODE_CODEX_BACKENDS.has(key.trim().toLowerCase()) ? 'codex' : undefined
  if (!type || config.enabled === false) return undefined
  return { id: `kode-${key}`, name: key, type, executable: config.command, args: config.args ?? [], ...(config.default_model ? { defaultModel: config.default_model } : {}) }
}
export async function importBackendProfiles(client, profiles) {
  const catalog = await client.call('/api/v1/messaging/workbench/catalog')
  const document = new BackendDocument(client, 'session-index'), state = await document.read() ?? { version: 1 }
  if (!state.gui) { state.gui = { tabs: catalog.tabs ?? [], endpoints: catalog.endpoints ?? [], session_titles: catalog.session_titles ?? {} }; await document.write(state) }
  // The shared registry already contains both desktop and dsh definitions.
  // Reimporting its own projection would create duplicate configuration owners.
  if (profiles.usesSharedRegistry) return catalog
  for (const [key, config] of Object.entries(catalog.backends ?? {})) {
    const profile = backendProfile(key, config)
    if (!profile) {
      if (profiles.list().some(row => row.id === `kode-${key}`)) await profiles.remove(`kode-${key}`)
      continue
    }
    const existing = profiles.list().find(row => row.id !== profile.id && !row.id.startsWith('kode-') && row.type === profile.type && row.name.toLocaleLowerCase() === profile.name.toLocaleLowerCase())
    if (existing) { if (profiles.list().some(row => row.id === profile.id)) await profiles.remove(profile.id); continue }
    // Refresh launch defaults for new conversations; bound conversations keep
    // the immutable profile snapshot captured by AgentProfiles.bind().
    const imported = profiles.list().find(row => row.id === profile.id)
    if (!imported || profileRevision(imported) !== profileRevision(normalizeProfile(profile))) await profiles.save(profile)
  }
  return catalog
}
export async function saveNativeTab(client, profiles, agent, title) {
  const binding = profiles.binding(agent.id)
  if (!binding?.threadId || binding.profile.type === 'dsh') return
  const document = new BackendDocument(client, 'session-index')
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = await document.read() ?? { version: 1 }; state.native_sessions ??= []
    const profile = binding.profile, catalog = await client.call('/api/v1/messaging/workbench/catalog')
    const named = profile.id.startsWith('kode-') ? profile.id.slice(5) : profile.name
    const matches = Object.keys(catalog.backends ?? {}).filter(key => catalog.backends[key].command === profile.executable)
    const backend = catalog.agent_ids?.[profile.id]
      ?? Object.keys(catalog.backends ?? {}).find(key => key.toLocaleLowerCase() === named.toLocaleLowerCase())
      ?? (matches.length === 1 ? matches[0] : undefined)
    if (!backend) return
    const index = state.native_sessions.findIndex(tab => tab.session_id === binding.threadId && tab.backend_key === backend)
    const saved=(catalog.tabs??[]).find(tab=>tab.session_id===binding.threadId && tab.backend_key===backend)
    const model=agent.session.requestHeader()?.config.model
    const updatedAt = agent.updatedAt ?? agent.session.snapshotEvents?.().at(-1)?.time ?? saved?.updated_at ?? state.native_sessions[index]?.updated_at
    const row = { ...(Number.isFinite(updatedAt) && updatedAt > 0 ? { updated_at: updatedAt } : {}), backend_key: backend, agent_id: profile.id, title: title?.trim() || saved?.title || state.native_sessions[index]?.title || '未命名会话', title_pinned: true, cwd: agent.session.header.cwd, session_id: binding.threadId, dsh_session_id: agent.id, ...(model?{model}:{}), transport_kind: 'pty', endpoint_id: null }
    const pendingAvatars = state.presentation?.sessionAvatars
    if (pendingAvatars && Object.hasOwn(pendingAvatars, agent.id)) { row.avatar_id = pendingAvatars[agent.id]; delete pendingAvatars[agent.id] }
    if (index >= 0) state.native_sessions[index] = { ...state.native_sessions[index], ...row }; else state.native_sessions.push(row)
    try { await document.write(state); return } catch (error) { if (attempt === 3 || !/configuration changed/.test(error.message)) throw error }
  }
}
/** Reconcile persisted native identities without starting or resuming any Agent. */
export async function syncNativeTabs(controller, client, profiles, signal) {
  const { items } = await controller.list({}, signal)
  const workspaces = await new BackendDocument(client, 'workspaces').read()
  const archived = new Set(workspaces?.global?.archivedSessionIds ?? [])
  const canonical = new Map()
  for (const session of items) {
    const binding = profiles.binding(session.sessionId)
    if (!binding?.threadId) continue
    const key = `${binding.profile.id}:${binding.threadId}`, prior = canonical.get(key)
    const rank = row => [Number(!archived.has(row.sessionId)), Number(Boolean(row.running)), row.updatedAt ?? 0]
    const a = rank(session), b = prior && rank(prior)
    if (!prior || a[0] > b[0] || a[0] === b[0] && (a[1] > b[1] || a[1] === b[1] && a[2] > b[2])) canonical.set(key, session)
  }
  for (const session of canonical.values()) {
    signal?.throwIfAborted()
    if (!session.cwd || !profiles.binding(session.sessionId)?.threadId) continue
    const projections = session.projections?.values
    const selection = projections?.modelSelection?.lastUsed ?? projections?.modelSelection?.pending
    await saveNativeTab(client, profiles, {
      id: session.sessionId, updatedAt: session.updatedAt,
      session: { header: { cwd: session.cwd }, requestHeader: () => ({ config: selection ?? {} }) },
    }, typeof projections?.title === 'string' ? projections.title : undefined)
  }
}
export async function importSavedSession(ctx, client, tab) {
  if (!tab.session_id || !tab.cwd || !tab.backend_key) throw new Error('Saved session is missing its native identity')
  const published = await client.call('/api/v1/messaging/runtime/sessions')
  const live = (published.sessions ?? []).find(row => row.runtime === 'gui' && row.backend_key === tab.backend_key && row.session_uuid === tab.session_id && row.status !== 'exited' && (row.owner_alive ?? row.runtime_online))
  if (live) return { sharedSession: live, imported: false }
  const runtime = ctx.get('kodeAgents'), controller = ctx.get('sessionController')
  const registry = ctx.get('workspaceRegistry')
  let workspace = await registry.resolveByPath(tab.cwd)
  const profile = runtime.profiles.list().find(row => row.id === (tab.agent_id ?? `kode-${tab.backend_key}`))
    ?? runtime.profiles.list().find(row => row.name.toLocaleLowerCase() === tab.backend_key.toLocaleLowerCase())
    ?? Object.values(runtime.profiles.bindings ?? {}).find(row => row.threadId === tab.session_id && row.profile.id === tab.agent_id)?.profile
  if (!profile) throw new Error(`This saved ${tab.backend_key} session has no installed inline protocol adapter`)
  const id = savedImportIdentity(tab, profile.id, runtime.profiles.bindings, registry.archivedSessionIds)
  const priorBinding = runtime.profiles.binding?.(id)
  if (priorBinding?.threadId && (priorBinding.threadId !== tab.session_id || priorBinding.profile.id !== profile.id)) throw new Error('Saved session identity conflicts with an existing native conversation')
  const doc = new BackendDocument(client, 'session-index'), state = await doc.read() ?? { version: 1 }
  if (priorBinding?.threadId === tab.session_id && (await controller.list({})).items.some(row => row.sessionId === id)) {
    workspace ??= await registry.create(tab.cwd)
    await workspace.attachSession(id)
    return { sessionId: id, imported: false, historyWindow: state.imports?.[id]?.historyWindow }
  }
  if (state.imports?.[id]?.formatVersion >= 2) {
    workspace ??= await registry.create(tab.cwd)
    await workspace.attachSession(id)
    return { sessionId: id, imported: true, historyWindow: state.imports[id].historyWindow }
  }
  const transcript = await client.call('/api/v1/messaging/workbench/transcript', { backend_key: tab.backend_key, session_id: tab.session_id, cwd: tab.cwd })
  if (!transcript.available) throw new Error('Native CLI transcript is unavailable on this Host')
  const selection = { provider: profileRoute(profile.id), model: tab.model ?? profile.defaultModel ?? 'default' }
  const factory=ctx.get('kodeNativeFactory')
  if(!factory)throw new Error('Native Agent history importer is unavailable')
  // Opening a saved, owner-selected conversation also restores its workspace
  // registration. create() canonicalizes and validates an existing directory;
  // it never creates a directory or starts an Agent, and retries reuse its ID.
  workspace ??= await registry.create(tab.cwd)
  await factory.importHistory(id,buildHistorySeed(transcript,selection),tab.cwd,selection)
  const previous = await controller.list({})
  let sessionId = previous.items.find(row => row.sessionId === id)?.sessionId
  if (!sessionId) sessionId = (await controller.create({ sessionId: id, workspaceId: workspace.id, agentPreset: 'kode-native' })).sessionId
  if (sessionId !== id) throw new Error('Saved session identity changed unexpectedly')
  const { agent, error } = await controller.resolveAgent(id)
  if (error) throw new Error(error.message)
  if (runtime.profiles.bindNative) await runtime.profiles.bindNative(id, profile.id, tab.session_id)
  else { await runtime.profiles.bind(id, profile.id); await runtime.profiles.patchBinding(id, { threadId: tab.session_id }) }
  runtime.recordBinding(agent, profile)
  agent.selectModel(selection)
  await controller.rename({ sessionId: id, title: tab.title || '已保存的会话' })
  await agent.ctx.sessions.flush(agent.session)
  await workspace.attachSession(id)
  for (let attempt=0;attempt<4;attempt++) {
    const latest=await doc.read() ?? {version:1}
    latest.imports ??= {}; latest.imports[id] = { formatVersion: 3, historyWindow: transcript.history_window, nativeSessionId: tab.session_id, backendKey: tab.backend_key, cwd: tab.cwd }
    try {await doc.write(latest);break} catch (error) {if(attempt===3 || !/configuration changed/.test(error.message))throw error}
  }
  return { sessionId: id, imported: true, historyWindow: transcript.history_window }
}

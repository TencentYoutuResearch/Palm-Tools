import { freshImportIdentity, savedImportIdentity } from './saved-session-state.js'
import { savedSessionProfile } from './saved-session-profile.js'
/** Kode saved CLI sessions: import display history once, retain the original native thread. */
import { BackendDocument } from './backend-state.js'
import { buildHistorySeed, nativeDelta } from './native-history.js'
import { normalizeProfile, profileRevision, profileRoute } from './agent-profiles.js'
// These Kode Codex entries do not require an MCP setup declaration. Custom
// executable names still require an explicit protocol declaration.
const pendingImports = new WeakMap()
const TRANSCRIPT = '/api/v1/messaging/workbench/transcript'
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
export async function saveNativeTab(client, profiles, agent, title, { renameNative } = {}) {
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
    const replaced = binding.supersededThreads ?? []
    const isReplaced = row => row.backend_key === backend && row.dsh_session_id === agent.id && replaced.includes(row.session_id)
    let index = state.native_sessions.findIndex(tab => tab.session_id === binding.threadId && tab.backend_key === backend)
    if (index < 0) index = state.native_sessions.findIndex(isReplaced)
    const saved=(catalog.tabs??[]).find(tab=>tab.session_id===binding.threadId && tab.backend_key===backend)
    const model=agent.session.requestHeader()?.config?.model
    const updatedAt = agent.updatedAt ?? agent.session.snapshotEvents?.().at(-1)?.time ?? saved?.updated_at ?? state.native_sessions[index]?.updated_at
    const row = { ...(Number.isFinite(updatedAt) && updatedAt > 0 ? { updated_at: updatedAt } : {}), backend_key: backend, agent_id: profile.id, title: title?.trim() || saved?.title || state.native_sessions[index]?.title || '未命名会话', title_pinned: true, cwd: agent.session.header.cwd, session_id: binding.threadId, dsh_session_id: agent.id, ...(model?{model}:{}), transport_kind: 'pty', endpoint_id: null }
    if (profile.type === 'claude' && row.title !== '未命名会话' && (state.native_sessions[index]?.session_id !== binding.threadId || state.native_sessions[index]?.native_title !== row.title)) {
      await renameNative?.(row.title)
      const result = await client.call('/api/v1/messaging/workbench/native-title', { backend_key: backend, session_id: binding.threadId, cwd: row.cwd, title: row.title })
      if (result.updated) row.native_title = row.title
    }
    const pendingAvatars = state.presentation?.sessionAvatars
    if (pendingAvatars && Object.hasOwn(pendingAvatars, agent.id)) {
      row.avatar_id = pendingAvatars[agent.id]
      // Preserve explicit default-icon intent; row nulls alone also occur in
      // imported GUI snapshots and must otherwise inherit the Agent avatar.
      if (pendingAvatars[agent.id] !== null) delete pendingAvatars[agent.id]
    }
    if (index >= 0) state.native_sessions[index] = { ...state.native_sessions[index], ...row }; else state.native_sessions.push(row)
    state.native_sessions = state.native_sessions.filter(row => !isReplaced(row))
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
/** `fresh` takes over a native session another runtime (a Kode terminal)
 * has just been driving. The stored dsh copy is reused and brought up to date
 * with the turns it missed; only when that cannot be done safely does the
 * import get a new id and re-read the whole CLI transcript. */
export async function importSavedSession(ctx, client, tab, options = {}) {
  const controller = ctx.get('sessionController')
  if (!controller) throw new Error('Session controller is unavailable')
  let pending = pendingImports.get(controller)
  if (!pending) pendingImports.set(controller, pending = new Map())
  const key = JSON.stringify([tab.backend_key, tab.session_id])
  const previous = pending.get(key)
  const task = (previous?.catch(() => {}) ?? Promise.resolve()).then(() => importSession(ctx, client, tab, options))
  pending.set(key, task)
  try { return await task }
  finally { if (pending.get(key) === task) pending.delete(key) }
}

async function importSession(ctx, client, tab, { fresh = false, discovered = false, localSessionId, refreshOnly = false } = {}) {
  if (!tab.session_id || !tab.cwd || !tab.backend_key) throw new Error('Saved session is missing its native identity')
  const published = await client.call('/api/v1/messaging/runtime/sessions')
  const live = (published.sessions ?? []).find(row => row.backend_key === tab.backend_key
    && (row.runtime === 'gui' && row.session_uuid === tab.session_id || row.runtime === 'dsh' && row.native_thread_id === tab.session_id)
    && !row.runtime_saved && row.status !== 'exited' && (row.owner_alive ?? row.runtime_online))
  if (live?.runtime === 'gui' || live && live.status !== 'idle') return { sharedSession: live, imported: false }
  const runtime = ctx.get('kodeAgents'), controller = ctx.get('sessionController')
  const registry = ctx.get('workspaceRegistry')
  const profile = savedSessionProfile(runtime.profiles, tab)
  if (!profile) throw new Error(`This saved ${tab.backend_key} session has no installed inline protocol adapter`)
  const redirected = Object.entries(runtime.profiles.bindings ?? {}).find(([, binding]) =>
    binding.profile?.id === profile.id && binding.supersededThreads?.includes(tab.session_id))
  if (redirected) {
    const sessionId = redirected[0]
    if ((await controller.list({})).items.some(row => row.sessionId === sessionId)) return { sessionId, imported: false }
  }
  // With several stored copies of the thread, continue the one it last ran in:
  // binding order carries no recency, and an older copy that cannot be brought
  // up to date forces yet another full import each time the thread comes back.
  const reuse = await latestCopy(controller, runtime.profiles.bindings, tab.session_id, profile.id, registry.archivedSessionIds)
    ?? savedImportIdentity(tab, profile.id, runtime.profiles.bindings, registry.archivedSessionIds)
  const idToRefresh = localSessionId ?? reuse
  if (live && (live.runtime_session_id ?? live.session_uuid) !== idToRefresh) return { sharedSession: live, imported: false }
  const existing = (await controller.list({})).items.find(row => row.sessionId === idToRefresh)
  const binding = runtime.profiles.binding?.(idToRefresh)
  const stored = existing && binding?.threadId === tab.session_id && binding.profile.id === profile.id
  const update = stored && !existing.running && await reloadNativeTurns(ctx, client, tab, idToRefresh)
  if (refreshOnly) return { sessionId: idToRefresh, historyPending: stored && !existing.running && !update?.aligned }
  if (fresh && live && !update?.aligned) return { sharedSession: live, imported: false }
  let workspace = registry.list().find(workspace => workspace.path === tab.cwd) ?? await registry.resolveByPath(tab.cwd)
  if (fresh && update?.aligned) {
    // Kode archived it when the conversation moved to a terminal.
    await registry.unarchiveSession(reuse)
    workspace ??= await registry.create(tab.cwd)
    await workspace.attachSession(reuse)
    await retireStaleCopies(ctx, tab.session_id, reuse)
    return { sessionId: reuse, imported: true, reloaded: true }
  }
  const id = fresh ? freshImportIdentity(tab) : reuse
  const priorBinding = runtime.profiles.binding?.(id)
  if (priorBinding?.threadId && (priorBinding.threadId !== tab.session_id || priorBinding.profile.id !== profile.id)) throw new Error('Saved session identity conflicts with an existing native conversation')
  const doc = new BackendDocument(client, 'session-index'), state = await doc.read() ?? { version: 1 }
  const locallyStored = (await controller.list({})).items.some(row => row.sessionId === id)
  // Archiving closed it; opening it again (resume, a saved tab) reopens it.
  if (locallyStored && registry.archivedSessionIds?.includes(id)) await registry.unarchiveSession(id)
  if (locallyStored && priorBinding?.threadId === tab.session_id) {
    workspace ??= await registry.create(tab.cwd)
    await workspace.attachSession(id)
    if (discovered && tab.title && existing?.projections?.values?.title !== tab.title && !existing?.running) {
      await controller.rename({ sessionId: id, title: tab.title }).catch(error => ctx.logger?.warn?.('Unable to refresh native title for %s: %s', id, error.message))
    }
    return { sessionId: id, imported: false, reloaded: Boolean(update?.appended), historyPending: !existing?.running && !update?.aligned, historyWindow: state.imports?.[id]?.historyWindow }
  }
  // Shared import markers may outlive the local artifact or come from another Host.
  if (locallyStored && state.imports?.[id]?.formatVersion >= 2) {
    workspace ??= await registry.create(tab.cwd)
    await workspace.attachSession(id)
    return { sessionId: id, imported: true, historyWindow: state.imports[id].historyWindow }
  }
  let transcript = await fetchTranscript(client, tab).catch(error => {
    if (!discovered || !/unsupported transcript format|invalid saved session/.test(error.message)) throw error
  })
  if (!transcript?.available && discovered) {
    try { transcript = await runtime.adapter?.readSessionHistory(profile, tab.session_id, tab.cwd) }
    catch (error) { ctx.logger?.warn?.('Unable to replay native history for %s: %s', tab.session_id, error.message) }
  }
  if (!transcript?.available && !discovered) throw new Error('Native CLI transcript is unavailable on this Host')
  const selection = { provider: profileRoute(profile.id), model: tab.model ?? profile.defaultModel ?? 'default' }
  const factory=ctx.get('kodeNativeFactory')
  if(!factory)throw new Error('Native Agent history importer is unavailable')
  // Opening a saved, owner-selected conversation also restores its workspace
  // registration. create() canonicalizes and validates an existing directory;
  // it never creates a directory or starts an Agent, and retries reuse its ID.
  workspace ??= await registry.create(tab.cwd)
  await factory.importHistory(id, buildHistorySeed(transcript ?? {}, selection), tab.cwd, selection)
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
    latest.imports ??= {}; latest.imports[id] = { formatVersion: 3, historyWindow: transcript?.history_window, nativeSessionId: tab.session_id, backendKey: tab.backend_key, cwd: tab.cwd }
    try {await doc.write(latest);break} catch (error) {if(attempt===3 || !/configuration changed/.test(error.message))throw error}
  }
  if (fresh) await retireStaleCopies(ctx, tab.session_id, id)
  return { sessionId: id, imported: true, historyPending: !transcript?.available, historyWindow: transcript?.history_window }
}
/** The stored dsh copy of a native thread updated last, preferring one not
 * archived. Binding order carries no recency (the shared document sorts its
 * keys), so the session list decides. */
async function latestCopy(controller, bindings, threadId, profileId, archivedIds = []) {
  const ids = Object.entries(bindings ?? {}).filter(([, binding]) => binding.threadId === threadId && binding.profile?.id === profileId).map(([id]) => id)
  if (ids.length < 2) return ids[0]
  const rows = new Map((await controller.list({})).items.map(row => [row.sessionId, row]))
  const archived = new Set(archivedIds)
  return ids.filter(id => rows.has(id)).sort((a, b) =>
    Number(!archived.has(b)) - Number(!archived.has(a)) || (rows.get(b).updatedAt ?? 0) - (rows.get(a).updatedAt ?? 0))[0]
}
function fetchTranscript(client, tab, window = {}) {
  return client.call(TRANSCRIPT, { backend_key: tab.backend_key, session_id: tab.session_id, cwd: tab.cwd, ...window })
}

/** Recheck the boundary under the factory's write handle on every attempt. */
async function reloadNativeTurns(ctx, client, tab, id) {
  const factory = ctx.get('kodeNativeFactory')
  if (!factory?.appendHistory) return null
  try {
    for (const tail of [undefined, 64 * 1024 * 1024]) {
      const transcript = await fetchTranscript(client, tab, { limit: 1000, ...(tail ? { tail_bytes: tail } : {}) })
      if (!transcript.available) return null
      let aligned = false
      const appended = await factory.appendHistory(id, events => {
        const delta = nativeDelta(transcript.timeline ?? [], events)
        const selection = events.findLast(event => event.type === 'request/header')?.data?.header?.config
        if (!delta || !selection) return null
        aligned = true
        return delta.rows.length ? buildHistorySeed({ timeline: delta.rows }, selection, { firstTurn: delta.lastTurn + 1 }) : null
      })
      if (aligned) return { aligned, appended }
      if (!transcript.history_window?.truncated) break
    }
  } catch (error) {
    ctx.logger?.warn?.('Unable to refresh native history for %s: %s', id, error.message)
  }
  return null
}
/** A native session id is shown as one dsh conversation. Session logs are
 * append-only, so a takeover imports a fresh copy; earlier copies of the same
 * native thread are stale and are archived (kept, not deleted). Only idle
 * copies are touched: the caller already checked nothing drives the thread. */
async function retireStaleCopies(ctx, threadId, keep) {
  const registry = ctx.get('workspaceRegistry'), runtime = ctx.get('kodeAgents'), factory = ctx.get('kodeNativeFactory')
  const archived = new Set(registry.archivedSessionIds)
  for (const [id, binding] of Object.entries(runtime.profiles.bindings ?? {})) {
    if (id === keep || archived.has(id) || binding.threadId !== threadId) continue
    try {
      await registry.archiveSession(id, { stopActivity: true })
      await factory?.release?.(id)
    } catch (error) { ctx.logger?.warn?.('stale copy %s of %s not archived: %s', id, threadId, error.message) }
  }
}

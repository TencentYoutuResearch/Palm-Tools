import { validConversationTarget } from './conversation-target.js'
import { conversationViewKey } from './conversation-views.js'
import { validWorkspaceScope, sameWorkspace } from './workspace-scope.js'
import { validProcessTarget } from './process-target.js'
/** UI-only state. No backend, session creation, grant or task commands belong here. */
export function createCollabViewState({ storage, key = 'kode.collab.view.v1', onConversationChange, onNavigationChange } = {}) {
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
  let saved
  try { saved = JSON.parse(storage?.getItem(key) ?? 'null') } catch {}
  let snapshot = Object.freeze({
    processTarget: null, // Transient link; never restore an unverified task target from storage.
    orbitSessionId: null, // Transient: an existing native Session shown in Orbit's canvas, never restored.
    workspace: validWorkspaceScope(saved?.workspace) ? saved.workspace : null,
    mode: saved?.mode === 'im' ? 'im' : 'session',
    lastSuperagentId: validId(saved?.lastSuperagentId) ? saved.lastSuperagentId : null,
    lastSessionId: validId(saved?.lastSessionId) ? saved.lastSessionId : null,
    lastTeamId: validId(saved?.lastTeamId) ? saved.lastTeamId : null,
    lastHomeHub: validId(saved?.lastHomeHub) ? saved.lastHomeHub : null,
  })
  const listeners = new Set(), conversations = new Map(), scopes = new Map()
  const conversationKey = value => {
    if (value && typeof value === 'object') {
      if (!['home_hub', 'id', 'conversation_id'].every(key => validId(value[key]))) throw Error('Invalid conversation scope')
      const key = conversationViewKey(value), known = scopes.get(value.conversation_id) ?? new Set()
      known.add(key); scopes.set(value.conversation_id, known); return key
    }
    if (!validId(value)) throw Error('Invalid conversation identity')
    const known = scopes.get(value)
    if (known?.size > 1) throw Error('Ambiguous conversation identity; use its full scope')
    return known?.values().next().value ?? value
  }
  const publish = (patch, persist = true) => {
    const next = { ...snapshot, ...patch }
    if (persist) onNavigationChange?.(next)
    if (Object.keys(next).every(key => next[key] === snapshot[key])) return
    snapshot = Object.freeze(next)
    try { storage?.setItem(key, JSON.stringify({ ...snapshot, processTarget: undefined, orbitSessionId: undefined })) } catch {}
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    selectWorkspace(value) {
      if(value!==null&&!validWorkspaceScope(value))throw Error('Invalid workspace scope')
      const workspace=value?{home_hub:value.home_hub,host_id:value.host_id,workspace_id:value.workspace_id,root_ref:value.root_ref}:null
      if((workspace===null&&snapshot.workspace===null)||sameWorkspace(workspace,snapshot.workspace))return false
      publish({workspace,lastSuperagentId:null,lastTeamId:null,processTarget:null,orbitSessionId:null,mode:'session'});return true
    },
    openProcess(target) {
      if (!validProcessTarget(target) || !sameWorkspace(target.scope, snapshot.workspace) || target.teamId !== snapshot.lastTeamId
        || target.scope.home_hub !== snapshot.lastHomeHub) throw Error('Invalid process navigation scope')
      publish({ processTarget: target }, false)
    },
    clearProcess() { publish({ processTarget: null }, false) },
    setMode(mode) {
      if (!['im', 'session'].includes(mode)) throw new Error('Invalid view mode')
      publish(mode === 'session' ? { mode, orbitSessionId: null } : { mode })
    },
    // Orbit shows the Session itself; Superagent/workspace selection stays as it was underneath.
    openOrbitSession(id) {
      if (id !== null && !validId(id)) throw new Error('Invalid session identity')
      publish({ orbitSessionId: id }, false)
    },
    selectSuperagent(id, { teamId = null, homeHub = null } = {}) {
      if (!validId(id)) throw new Error('Invalid Superagent identity')
      if ((teamId !== null && !validId(teamId)) || (homeHub !== null && !validId(homeHub))) throw Error('Invalid Superagent scope')
      publish({ lastSuperagentId: id, lastTeamId: teamId, lastHomeHub: homeHub, orbitSessionId: null,
        processTarget: snapshot.processTarget?.teamId === teamId && snapshot.processTarget?.scope.home_hub === homeHub ? snapshot.processTarget : null })
    },
    restoreNavigation(value) {
      if (!value || !['im', 'session'].includes(value.mode)
        || (value.workspace!=null&&!validWorkspaceScope(value.workspace))
        || ['lastSuperagentId', 'lastSessionId', 'lastTeamId', 'lastHomeHub'].some(field => value[field] !== null && !validId(value[field]))) throw Error('Invalid saved navigation')
      publish({ workspace:value.workspace??null, mode: value.mode, lastSuperagentId: value.lastSuperagentId, lastSessionId: value.lastSessionId,
        lastTeamId: value.lastTeamId, lastHomeHub: value.lastHomeHub }, false)
    },
    rememberSession(id) {
      if (id !== null && !validId(id)) throw new Error('Invalid session identity')
      publish({ lastSessionId: id })
    },
    // The separate conversation store persists scoped drafts. LocalStorage holds navigation only.
    conversation(id) {
      return conversations.get(conversationKey(id)) ?? Object.freeze({ draft: '', scrollTop: 0 })
    },
    saveConversation(id, patch, { persist = true } = {}) {
      const scopedKey = conversationKey(id)
      if (!patch || Object.keys(patch).some(key => !['draft', 'scrollTop', 'priorRunId', 'clarificationTarget'].includes(key))
        || (patch.clarificationTarget != null && !validConversationTarget(patch.clarificationTarget))
        || ('priorRunId' in patch && patch.priorRunId !== null && !validId(patch.priorRunId))
        || ('draft' in patch && (typeof patch.draft !== 'string' || patch.draft.length > 65536))
        || ('scrollTop' in patch && (!Number.isFinite(patch.scrollTop) || patch.scrollTop < 0))) throw new Error('Invalid conversation view state')
      conversations.set(scopedKey, Object.freeze({ ...this.conversation(id), ...patch }))
      if (persist) onConversationChange?.(scopedKey, conversations.get(scopedKey))
    },
  }
}

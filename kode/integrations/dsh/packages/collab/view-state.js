/** UI-only state. No backend, session creation, grant or task commands belong here. */
export function createCollabViewState({ storage, key = 'kode.collab.view.v1', onConversationChange, onNavigationChange } = {}) {
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
  let saved
  try { saved = JSON.parse(storage?.getItem(key) ?? 'null') } catch {}
  let snapshot = Object.freeze({
    mode: saved?.mode === 'im' ? 'im' : 'session',
    lastSuperagentId: validId(saved?.lastSuperagentId) ? saved.lastSuperagentId : null,
    lastSessionId: validId(saved?.lastSessionId) ? saved.lastSessionId : null,
    lastTeamId: validId(saved?.lastTeamId) ? saved.lastTeamId : null,
    lastHomeHub: validId(saved?.lastHomeHub) ? saved.lastHomeHub : null,
  })
  const listeners = new Set(), conversations = new Map()
  const publish = (patch, persist = true) => {
    const next = { ...snapshot, ...patch }
    if (persist) onNavigationChange?.(next)
    if (Object.keys(next).every(key => next[key] === snapshot[key])) return
    snapshot = Object.freeze(next)
    try { storage?.setItem(key, JSON.stringify(snapshot)) } catch {}
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    setMode(mode) {
      if (!['im', 'session'].includes(mode)) throw new Error('Invalid view mode')
      publish({ mode })
    },
    selectSuperagent(id, { teamId = null, homeHub = null } = {}) {
      if (!validId(id)) throw new Error('Invalid Superagent identity')
      if ((teamId !== null && !validId(teamId)) || (homeHub !== null && !validId(homeHub))) throw Error('Invalid Superagent scope')
      publish({ lastSuperagentId: id, lastTeamId: teamId, lastHomeHub: homeHub })
    },
    restoreNavigation(value) {
      if (!value || !['im', 'session'].includes(value.mode)
        || ['lastSuperagentId', 'lastSessionId', 'lastTeamId', 'lastHomeHub'].some(field => value[field] !== null && !validId(value[field]))) throw Error('Invalid saved navigation')
      publish({ mode: value.mode, lastSuperagentId: value.lastSuperagentId, lastSessionId: value.lastSessionId,
        lastTeamId: value.lastTeamId, lastHomeHub: value.lastHomeHub }, false)
    },
    rememberSession(id) {
      if (id !== null && !validId(id)) throw new Error('Invalid session identity')
      publish({ lastSessionId: id })
    },
    // The separate conversation store persists scoped drafts. LocalStorage holds navigation only.
    conversation(id) {
      if (!validId(id)) throw new Error('Invalid conversation identity')
      return conversations.get(id) ?? Object.freeze({ draft: '', scrollTop: 0 })
    },
    saveConversation(id, patch, { persist = true } = {}) {
      if (!validId(id) || !patch || Object.keys(patch).some(key => !['draft', 'scrollTop', 'priorRunId'].includes(key))
        || ('priorRunId' in patch && patch.priorRunId !== null && !validId(patch.priorRunId))
        || ('draft' in patch && (typeof patch.draft !== 'string' || patch.draft.length > 65536))
        || ('scrollTop' in patch && (!Number.isFinite(patch.scrollTop) || patch.scrollTop < 0))) throw new Error('Invalid conversation view state')
      conversations.set(id, Object.freeze({ ...this.conversation(id), ...patch }))
      if (persist) onConversationChange?.(id, conversations.get(id))
    },
  }
}

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
const key = home => JSON.stringify(['navigation-v1', home, 'local_owner'])

export function createNavigationStorage({ storage, view, home, selectMode, restoreTeam }) {
  let generation = 0, pending = Promise.resolve(), disposed = false
  const save = value => {
    generation++
    const hub = home()
    if (disposed || !validId(hub)) return Promise.resolve()
    const sameHome = value.lastHomeHub === hub
    const record = { format: 'kode.navigation.v1', home_hub: hub, principal_id: 'local_owner',
      mode: value.mode, lastSuperagentId: sameHome ? value.lastSuperagentId : null,
      lastTeamId: sameHome ? value.lastTeamId : null, lastHomeHub: hub,
      lastSessionId: value.lastSessionId }
    const task = pending.catch(() => {}).then(() => {
      if (disposed) return
      return storage.update(key(hub), () => record)
    })
    pending = task
    return task
  }
  return {
    save,
    async restore() {
      const hub = home()
      if (!validId(hub) || disposed) return
      if (generation !== 0) { await save(view.getSnapshot()); return }
      const saved = await storage.read(key(hub))
      if (disposed || generation !== 0) return
      if (!saved) { await save(view.getSnapshot()); return }
      if (saved.format !== 'kode.navigation.v1' || saved.home_hub !== hub || saved.lastHomeHub !== hub || saved.principal_id !== 'local_owner'
        || !['im', 'session'].includes(saved.mode)
        || ['lastSuperagentId', 'lastTeamId', 'lastSessionId'].some(field => saved[field] !== null && !validId(saved[field]))) throw Error('导航记录与当前 Home 不匹配。')
      view.restoreNavigation(saved)
      selectMode(saved.mode)
      if (saved.lastTeamId && saved.lastSuperagentId) await restoreTeam(saved.lastTeamId, saved.lastSuperagentId)
    },
    close() { disposed = true },
  }
}

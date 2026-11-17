import {validWorkspaceScope} from './workspace-scope.js'
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
const key = home => JSON.stringify(['navigation-v1', home, 'local_owner'])

export function createNavigationStorage({ storage, view, home, selectMode, restoreTeam }) {
  let generation = 0, pending = Promise.resolve(), disposed = false
  const save = value => {
    generation++
    const hub = home()
    if (disposed || !validId(hub)) return Promise.resolve()
    const sameHome = value.lastHomeHub === hub
    const record = { format: 'kode.navigation.v3', home_hub: hub, principal_id: 'local_owner',
      workspace:validWorkspaceScope(value.workspace)&&value.workspace.home_hub===hub?value.workspace:null,
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
      if (!['kode.navigation.v1','kode.navigation.v2','kode.navigation.v3'].includes(saved.format) || saved.home_hub !== hub || saved.lastHomeHub !== hub || saved.principal_id !== 'local_owner'
        || !['im', 'session'].includes(saved.mode)
        || (saved.workspace!=null&&(!validWorkspaceScope(saved.workspace)||saved.workspace.home_hub!==hub))
        || ['lastSuperagentId', 'lastTeamId', 'lastSessionId'].some(field => saved[field] !== null && !validId(saved[field]))) throw Error('导航记录与当前 Home 不匹配。')
      // v1.mode controlled which sidebar existed. Never let that obsolete flag
      // steal the native Session/plugin restored by dsh in the unified shell.
      const mode = saved.format !== 'kode.navigation.v3' ? 'session' : saved.mode
      view.restoreNavigation({...saved,mode})
      selectMode(mode)
      if(saved.format !== 'kode.navigation.v3') await save(view.getSnapshot())
      if (saved.lastTeamId && saved.lastSuperagentId) await restoreTeam(saved.lastTeamId, saved.lastSuperagentId)
    },
    close() { disposed = true },
  }
}

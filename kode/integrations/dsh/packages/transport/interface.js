/** Device-local interface preferences shared by settings and the token island. */
export function installInterfacePreferences(ctx, env = globalThis) {
  const key = 'kode.interface.v1', listeners = new Set(), periods = ['today', 'month', 'all', 'follow']
  const read = () => {
    try { const value = JSON.parse(env.localStorage?.getItem(key) ?? '{}'); return { tokenIsland: value?.tokenIsland !== false, tokenPeriod: periods.includes(value?.tokenPeriod) ? value.tokenPeriod : 'today' } }
    catch { return { tokenIsland: true, tokenPeriod: 'today' } }
  }
  let snapshot = read()
  const publish = next => {
    if (snapshot.tokenIsland === next.tokenIsland && snapshot.tokenPeriod === next.tokenPeriod) return
    snapshot = next
    for (const listener of listeners) listener()
  }
  const service = {
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => snapshot,
    update(patch) {
      if (('tokenIsland' in patch && typeof patch.tokenIsland !== 'boolean') || ('tokenPeriod' in patch && !periods.includes(patch.tokenPeriod))) throw new Error('无效的刘海显示设置。')
      const next = { ...snapshot, ...patch }
      env.localStorage?.setItem(key, JSON.stringify(next))
      publish(next)
    },
  }
  const changed = event => { if (event.key === key || event.key === null) publish(read()) }
  env.window?.addEventListener('storage', changed)
  ctx.effect(() => () => env.window?.removeEventListener('storage', changed), 'kode.interface-preferences')
  ctx.provide('kodeInterface', service)
  return service
}

/** Device-local interface preferences shared by settings and the token island. */
export function installInterfacePreferences(ctx, env = globalThis) {
  const key = 'kode.interface.v1', listeners = new Set()
  const read = () => { try { return JSON.parse(env.localStorage?.getItem(key) ?? '{}').tokenIsland !== false } catch { return true } }
  let snapshot = { tokenIsland: read() }
  const publish = enabled => {
    if (snapshot.tokenIsland === enabled) return
    snapshot = { tokenIsland: enabled }
    for (const listener of listeners) listener()
  }
  const service = {
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => snapshot,
    update({ tokenIsland }) {
      if (typeof tokenIsland !== 'boolean') throw new Error('无效的刘海显示设置。')
      env.localStorage?.setItem(key, JSON.stringify({ tokenIsland }))
      publish(tokenIsland)
    },
  }
  const changed = event => { if (event.key === key || event.key === null) publish(read()) }
  env.window?.addEventListener('storage', changed)
  ctx.effect(() => () => env.window?.removeEventListener('storage', changed), 'kode.interface-preferences')
  ctx.provide('kodeInterface', service)
  return service
}

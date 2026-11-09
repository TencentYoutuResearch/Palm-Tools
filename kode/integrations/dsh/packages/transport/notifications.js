/** Browser notifications use Electron's native notification carrier in Desktop. */
export function installSessionNotifications(ctx, transport, env = globalThis) {
  const storageKey = 'kode.session-notifications.v1', listeners = new Set(), streams = new Map(), shown = new Map(), seen = new Set()
  let preferences = { completed: true, waiting: true }
  try { const saved = JSON.parse(env.localStorage?.getItem(storageKey) ?? '{}'); for (const key of ['completed', 'waiting']) if (typeof saved[key] === 'boolean') preferences[key] = saved[key] } catch {}
  let snapshot
  const publish = () => { snapshot = { ...preferences, permission: env.Notification?.permission ?? 'unsupported' }; for (const fn of listeners) fn() }
  publish()
  const active = (host, id) => {
    if (host !== transport.current || env.document.visibilityState !== 'visible' || !env.document.hasFocus()) return false
    if (ctx.get('layout')?.panelInfo.getSnapshot().activePanelId) return false
    return (ctx.get('sessions')?.list.getSnapshot().byId[id]?.retainedBy?.mainView ?? 0) > 0
  }
  const close = key => { shown.get(key)?.close(); shown.delete(key) }
  const receive = (host, event) => {
    if (!event || typeof event.sessionId !== 'string' || typeof event.key !== 'string' || !['completed', 'question', 'approval', 'resolved'].includes(event.kind)) return
    const key = `${host}:${event.key}`
    if (event.kind === 'resolved') { close(key); return }
    const id = `${host}:${event.id}`
    if (seen.has(id)) return
    seen.add(id); if (seen.size > 512) seen.delete(seen.values().next().value)
    if (env.Notification?.permission !== 'granted' || !(event.kind === 'completed' ? preferences.completed : preferences.waiting) || active(host, event.sessionId)) return
    const label = { completed: '本轮已完成', question: '等待你回答', approval: '等待你批准' }[event.kind]
    const notification = new env.Notification(`${label} · Kode`, { body: String(event.title ?? '未命名会话').slice(0, 160), tag: key })
    notification.onclick = () => {
      env.window.focus(); close(key)
      void transport.select(host, { sessionId: event.sessionId }).catch(error => { ctx.logger?.warn?.('无法打开通知会话：%s', error.message) })
    }
    notification.onclose = () => { if (shown.get(key) === notification) shown.delete(key) }
    shown.set(key, notification)
    // Completion banners should not retain native handles indefinitely.
    if (event.kind === 'completed') { const timer = env.setTimeout(() => close(key), 60000); notification.onclose = () => { env.clearTimeout(timer); if (shown.get(key) === notification) shown.delete(key) } }
    while (shown.size > 32) close(shown.keys().next().value)
  }
  const connect = () => {
    const host = transport.current
    if (transport.getSnapshot().switching || streams.has(host) || !env.EventSource) return
    const events = new env.EventSource(transport.path('/api/kode/notifications', host))
    events.onmessage = event => { try { receive(host, JSON.parse(event.data)) } catch {} }
    streams.set(host, events)
  }
  const service = {
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) }, getSnapshot: () => snapshot,
    update(patch) {
      for (const key of ['completed', 'waiting']) if (typeof patch[key] === 'boolean') preferences[key] = patch[key]
      try { env.localStorage?.setItem(storageKey, JSON.stringify(preferences)) } catch {}
      for (const key of shown.keys()) close(key)
      publish()
    },
    async enable() { if (env.Notification) await env.Notification.requestPermission(); publish() },
    test() { if (env.Notification?.permission === 'granted') { const note = new env.Notification('Kode 通知已开启', { body: '会话完成或需要你操作时，会在这里提醒你。', tag: 'kode-notification-test' }); env.setTimeout(() => note.close(), 5000) } },
  }
  connect()
  const unsubscribe = transport.subscribe(connect)
  const onFocus = () => publish()
  env.window.addEventListener('focus', onFocus)
  ctx.provide('kodeNotifications', service)
  ctx.effect(() => () => { unsubscribe(); env.window.removeEventListener('focus', onFocus); for (const stream of streams.values()) stream.close(); for (const key of shown.keys()) close(key); listeners.clear() }, 'kode.notifications')
  return service
}

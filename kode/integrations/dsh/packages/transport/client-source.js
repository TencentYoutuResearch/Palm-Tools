import { installConnection } from '@deepseek-ai/dsh-client-connection/client'
export const inject = []
export function apply(ctx) {
  let current = 'local', switching = false, revision = 0
  let navigation
  const listeners = new Set(), publish = () => { snapshot = { current, switching, revision }; for (const fn of listeners) fn() }
  let snapshot = { current, switching, revision }
  const pathFor = (input, host = current) => {
    const url = new URL(input, window.location.href)
    if (url.origin !== window.location.origin && !['ws:', 'wss:'].includes(url.protocol)) throw new Error('Unsupported cross-origin Host path')
    return host === 'local' ? url.pathname + url.search : `/api/kode/transport/${encodeURIComponent(host)}${url.pathname}${url.search}`
  }
  const fetchHost = (input, init, host = current) => fetch(pathFor(input, host), { ...init, credentials: 'same-origin' })
  installConnection(ctx, { location: window.location, transport: {
    fetch: fetchHost,
    createWebSocket: input => {
      const original = new URL(input, window.location.origin)
      const url = current === 'local' ? original : new URL(`/api/kode/transport-ws?host=${encodeURIComponent(current)}&path=${encodeURIComponent(original.pathname + original.search)}`, window.location.origin)
      url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      return new WebSocket(url)
    },
  } })
  const ready = (previous, signal) => new Promise((resolve, reject) => {
    let unsubscribe = () => {}
    const done = error => { unsubscribe(); clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve() }
    const check = () => { const value = ctx.connection.generation.getSnapshot(); if (value && value.id !== previous) done() }
    const abort = () => done(signal.reason ?? new Error('Host switch cancelled'))
    const timer = setTimeout(() => done(new Error('连接主机超时，请重试。')), 20000)
    unsubscribe = ctx.connection.generation.subscribe(check)
    signal?.addEventListener('abort', abort, { once: true }); check()
  })
  const service = {
    get current() { return current }, path: pathFor, fetch: fetchHost,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) }, getSnapshot: () => snapshot,
    async select(host, target = {}) {
      if (switching) throw new Error('正在切换主机，请稍候。')
      const ui = ctx.get('uiWorkspace'), layout = ctx.get('layout'), sessions = ctx.get('sessions'), workspaces = ctx.get('workspaces')
      if (!ui || !layout || !sessions || !workspaces) throw new Error('工作区尚未就绪。')
      navigation?.abort(new Error('Host navigation superseded'))
      navigation = new AbortController()
      const signal = navigation.signal
      if (host !== current) {
        switching = true; publish()
        const previousHost = current
        try {
          const response = await fetch('/api/kode/project-hosts', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'prepare', id: host }), signal })
          const value = await response.json(); if (!response.ok) throw new Error(value.error ?? '无法连接主机。')
          // rc.2's public connection API supports a new Host generation. Its workspace
          // navigator lacks a public release method; this adapter owns that pinned seam.
          if (typeof ui.clearMain !== 'function') throw new Error('当前 dsh 版本不支持主机会话释放。')
          ui.clearMain()
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          const generation = ctx.connection.generation.getSnapshot()?.id
          current = host; revision++; publish()
          const connectionReady = ready(generation, signal)
          ctx.connection.reconnect(); await connectionReady
          await sessions.refresh()
          await new Promise((resolve, reject) => {
            let unsubscribe = () => {}
            const timer = setTimeout(() => { unsubscribe(); reject(new Error('工作区目录读取超时。')) }, 15000)
            const check = () => { if (workspaces.list.getSnapshot().phase === 'ready') { unsubscribe(); clearTimeout(timer); resolve() } }
            unsubscribe = workspaces.list.subscribe(check); check()
          })
        } catch (error) {
          if (current !== previousHost) { current = previousHost; revision++; publish(); ctx.connection.reconnect() }
          throw error
        } finally { switching = false; publish() }
      }
      signal.throwIfAborted()
      if (target.sessionId) ui.openSession(target.sessionId)
      else if (target.workspaceId) await ui.openWorkspace(target.workspaceId)
      else if (target.create) window.dispatchEvent(new CustomEvent('kode-create-project', { detail: { name: target.name ?? '' } }))
      else {
        const workspace = workspaces.list.getSnapshot().items[0]
        if (workspace) await ui.openWorkspace(workspace.workspaceId)
      }
    },
  }
  ctx.provide('kodeTransport', service)
  ctx.effect(() => () => { navigation?.abort(new Error('Host transport unplugged')); listeners.clear() }, 'kode.transport')
}

/** Live owner-only attention events. Never replay historical turns as new notifications. */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** This endpoint always operates on the local Desktop Host, independent of the viewed SSH Host. */
export function registerNotificationSettings(ctx, { platform = process.platform, open = promisify(execFile) } = {}) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/notification-settings', async handler(req, res) {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    const admission = ctx.connection.admit(req)
    if ('rejection' in admission || admission.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'POST') return send(405, { error: 'POST required' })
    if (platform !== 'darwin') return send(400, { error: '请在当前设备的系统设置中管理通知权限。' })
    try {
      await open('/usr/bin/open', ['x-apple.systempreferences:com.apple.Notifications-Settings.extension'], { timeout: 5000 })
      return send(200, { opened: true })
    } catch { return send(503, { error: '无法打开系统设置，请手动打开“系统设置 → 通知”。' }) }
  } })
}
export function registerSessionNotifications(ctx, { waitMs = 250 } = {}) {
  const streams = new Set(), pending = new Map(), recent = [], timers = new Set(), finished = new WeakMap()
  let sequence = 0, closed = false
  const boot = randomUUID()
  const root = agent => agent && ctx.agents.get(agent.id) === agent && (!ctx.agents.roots || ctx.agents.roots().some(row => row.id === agent.id))
  const publish = data => {
    if (closed) return
    const item = { ...data, id: `${boot}:${++sequence}` }
    recent.push(item); if (recent.length > 128) recent.shift()
    for (const res of streams) {
      try { if (!res.write(`id: ${item.id}\ndata: ${JSON.stringify(item)}\n\n`)) res.end() } catch { streams.delete(res); res.end() }
    }
    return item
  }
  const title = agent => String(ctx.get?.('sessionTitle')?.get(agent.session)?.title ?? agent.session.header.title ?? '未命名会话').slice(0, 160)
  const disposers = [
    ctx.on('session/event', (session, event) => {
      if (!['turn/start', 'turn/end'].includes(event.type)) return
      const agent = ctx.agents.get(session.id)
      if (!root(agent)) return
      if (event.type === 'turn/end' && event.data.reason?.kind === 'completed') finished.set(agent, event)
      else finished.delete(agent)
    }),
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      const event = finished.get(agent); finished.delete(agent)
      if (event && root(agent) && !agent.inbox.nextTurn.length && !agent.inbox.nextStep.length) publish({ kind: 'completed', sessionId: agent.id, title: title(agent), key: `${agent.id}:${event.seq}` })
    }),
  ]
  for (const [event, kind] of [['user-questions/request', 'question'], ['approval/request', 'approval']]) {
    disposers.push(ctx.on(event, async (request, next) => {
      if (!root(request.agent) || request.signal?.aborted) return next()
      const agent = request.agent, key = randomUUID()
      let emitted = false
      const finish = () => {
        clearTimeout(timer); timers.delete(timer); request.signal?.removeEventListener('abort', finish)
        if (emitted) { emitted = false; pending.delete(key); publish({ kind: 'resolved', sessionId: agent.id, key }) }
      }
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (closed || request.signal?.aborted || !root(agent)) return
        emitted = true
        const data = { kind, sessionId: agent.id, title: title(agent), key }
        pending.set(key, publish(data))
      }, waitMs)
      timers.add(timer); request.signal?.addEventListener('abort', finish, { once: true })
      try { return await next() } finally { finish() }
    }, { prepend: true }))
  }
  const route = ctx.webServer.register({ kind: 'exact', path: '/api/kode/notifications', handler(req, res) {
    const admission = ctx.connection.admit(req)
    if ('rejection' in admission || admission.peer.principal.kind !== 'owner') { res.writeHead(403); res.end(); return }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    streams.add(res)
    const last = recent.findIndex(item => item.id === req.headers['last-event-id'])
    const replay = last >= 0 ? recent.slice(last + 1) : [...pending.values()]
    for (const item of replay) res.write(`id: ${item.id}\ndata: ${JSON.stringify(item)}\n\n`)
    res.write(': connected\n\n')
    const heartbeat = setInterval(() => { if (!res.write(': keep-alive\n\n')) res.end() }, 15000)
    res.on('close', () => { clearInterval(heartbeat); streams.delete(res) })
  } })
  return () => {
    closed = true; route(); for (const dispose of disposers) dispose()
    for (const timer of timers) clearTimeout(timer)
    for (const res of streams) res.end()
    pending.clear(); recent.length = 0
  }
}

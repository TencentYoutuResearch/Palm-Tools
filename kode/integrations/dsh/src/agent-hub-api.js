import { admitHostRequest } from './host-admission.js'
/** Authenticated Host-local controls for power, extensions, goals and handoff. */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { enqueueCommand } from './native-commands.js'
import { selectedModel } from './native-commands.js'
import { parseGoalInput } from './codex-goal.js'
async function harnessVersion() {
  const paths = []
  if (process.resourcesPath) paths.push(join(process.resourcesPath, 'app.asar', 'package.json'))
  const argv = process.argv[1]
  if (argv) {
    paths.push(join(dirname(argv), '..', 'package.json'))
    try { paths.push(createRequire(argv).resolve('@deepseek-ai/dsh/package.json')) } catch { /* Try the installed runtime manifest. */ }
  }
  for (const path of paths) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8'))
      if (['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop', '@deepseek-ai/dsh-desktop-host'].includes(value.name)) return value.version
    } catch { /* Try the next installed manifest. */ }
  }
}

export function goalSnapshot(session) {
  return session.snapshotEvents().findLast(event => event.type === 'plugin:kode/goal-state')?.data.goal ?? null
}
export function registerAgentHubApi(ctx, { hub, backend, service }) {
  const send = (res, code, value) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(value)) }
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/agent-hub', handler: async (req, res, peer) => {
    const admitted = admitHostRequest(ctx, req, peer)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return send(res, 403, { error: 'Host owner required' })
    try {
      const query = new URL(req.url, 'http://localhost').searchParams
      if (req.method === 'GET' && query.has('logo')) {
        const asset = await hub.logo(query.get('logo'), query.get('package'))
        res.statusCode = 200
        res.setHeader('content-type', asset.contentType)
        res.setHeader('content-length', asset.body.length)
        res.setHeader('cache-control', 'private, max-age=60')
        res.setHeader('x-content-type-options', 'nosniff')
        return res.end(asset.body)
      }
      if (req.method === 'GET' && !query.get('session_id')) return send(res, 200, await hub.read())
      let input
      if (req.method === 'POST') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'JSON required' })
        let body = ''
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 128 * 1024) return send(res, 413, { error: 'Request too large' }) }
        input = JSON.parse(body)
        if (!input || typeof input !== 'object' || Array.isArray(input) || !['power', 'save-source', 'sync-source', 'remove-source', 'goal', 'handoff', 'agent-versions', 'update-agent'].includes(input.action)) throw new Error('Unknown operation')
        if (input.action === 'agent-versions' || input.action === 'update-agent') {
          if (input.action === 'update-agent' && typeof input.profileId !== 'string') throw new Error('请选择要更新的 Agent。')
          const command = input.action === 'update-agent'
            ? { update_profile: input.profileId }
            : { profile_ids: input.profileIds, refresh: input.refresh === true }
          const [versionInfo, dshVersion] = await Promise.all([
            backend.call('/api/v1/messaging/workbench/agent-versions', command)
              .then(versions => ({ versions }))
              .catch(error => {
                if (error.status !== 404 || input.action === 'update-agent') throw error
                return { versions: {}, versionError: '更新此主机的 Kode 服务后即可检查 CLI 版本。' }
              }),
            harnessVersion(),
          ])
          return send(res, 200, { ...versionInfo, dshVersion })
        }
        if (['power', 'save-source', 'sync-source', 'remove-source'].includes(input.action)) {
          const value = await hub.change(input)
          if (['sync-source', 'remove-source'].includes(input.action)) service.adapter.catalogs.clear()
          return send(res, 200, value)
        }
      } else if (req.method !== 'GET') return send(res, 405, { error: 'GET or POST required' })
      const sessionId = input?.sessionId ?? query.get('session_id')
      const controller = ctx.get('sessionController')
      const rows = (await controller.list({})).items
      if (!rows.some(row => row.sessionId === sessionId)) throw new Error('会话不存在。')
      if (input?.action === 'handoff') {
        const bridge = ctx.get('kodeRuntimeBridge')
        if (!bridge) throw new Error('会话同步服务尚未就绪，请稍后重试。')
        await bridge.publish()
        return send(res, 200, await backend.call('/api/v1/messaging/workbench/handoff', {
          source_session_id: sessionId, source_runtime: 'dsh', profile_id: input.profileId,
          target_runtime: 'dsh', request_id: input.requestId,
        }))
      }
      const binding = service.profiles.binding(sessionId)
      const supported = binding?.profile.type === 'codex' || binding?.profile.protocol === 'codex'
      if (!supported) return send(res, req.method === 'GET' ? 200 : 400, { supported: false, goal: null, ...(req.method === 'POST' ? { error: '此 Agent 未提供原生 Goal 控制。' } : {}) })
      if (req.method === 'GET') {
        const active = ctx.agents.get(sessionId)
        if (active) return send(res, 200, { supported: true, goal: goalSnapshot(active.session) })
        const handle = await ctx.get('sessionPersistence').open(sessionId, 'read')
        try { const { events } = await handle.read(); return send(res, 200, { supported: true, goal: goalSnapshot({ snapshotEvents: () => events }) }) } finally { await handle.close() }
      }
      const found = await controller.resolveAgent(sessionId)
      if (found.error) throw new Error(found.error.message)
      const agent = found.agent
      if (req.method === 'GET') return send(res, 200, { supported: true, goal: goalSnapshot(agent.session) })
      if (input.action !== 'goal') throw new Error('Unknown operation')
      parseGoalInput(input.command)
      if (service.adapter.live.get(agent.id)?.goal) await service.adapter.controlGoal(agent, input.command, AbortSignal.timeout(20000), selectedModel(agent))
      else {
        if (agent.status !== 'idle') throw new Error('原生连接尚未就绪，请稍后重试。')
        enqueueCommand(agent, '/goal ' + input.command)
        await agent.ctx.sessions.flush(agent.session)
      }
      return send(res, 200, { supported: true, goal: goalSnapshot(agent.session) })
    } catch (error) { return send(res, error.status ?? 400, { error: error.message }) }
  } })
}

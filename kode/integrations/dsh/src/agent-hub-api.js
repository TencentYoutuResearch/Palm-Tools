/** Authenticated Host-local controls for power, extensions, goals and handoff. */
import { assertOrdinaryHandoffSource, normalizeHandoffSelection, assertOrdinaryHandoffIdentity } from './native-handoff-contract.js'
import { enqueueCommand } from './native-commands.js'
import { selectedModel } from './native-commands.js'
import { parseGoalInput } from './codex-goal.js'
export function goalSnapshot(session) {
  return session.snapshotEvents().findLast(event => event.type === 'plugin:kode/goal-state')?.data.goal ?? null
}
export function registerAgentHubApi(ctx, { hub, backend, service }) {
  const send = (res, code, value) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(value)) }
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/agent-hub', handler: async (req, res) => {
    const admitted = ctx.connection.admit(req)
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
        if (!input || typeof input !== 'object' || Array.isArray(input) || !['power', 'save-source', 'sync-source', 'remove-source', 'goal', 'handoff', 'prepare-handoff'].includes(input.action)) throw new Error('Unknown operation')
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
      const planning=ctx.get('kodePlanningRuntime')
      const planningHandoff=await planning?.handoffStatus?.(sessionId) ?? null
      if(input?.action==='prepare-handoff')return send(res,200,await planning.prepareHandoff(input))
      if(input?.action==='handoff'&&planningHandoff){
        if(!input.planning)throw Object.assign(Error('请确认规划会话的身份继任；不会自动发送。'),{code:'PLANNING_HANDOFF_REQUIRED',status:409})
        return send(res,200,await planning.handoff(input))
      }
      if (input?.action === 'handoff') {
        if (Object.keys(input).some(key => !['action', 'sessionId', 'profileId', 'requestId', 'selection'].includes(key))) throw new Error('Invalid native handoff fields')
        await assertOrdinaryHandoffIdentity({service:name=>ctx.get(name)},sessionId)
        assertOrdinaryHandoffSource(service.profiles, sessionId, ctx.get('agents')?.get(sessionId), rows.find(row => row.sessionId === sessionId))
        const selection = normalizeHandoffSelection(input.selection)
        const bridge = ctx.get('kodeRuntimeBridge')
        if (!bridge) throw new Error('会话同步服务尚未就绪，请稍后重试。')
        await bridge.publish()
        return send(res, 200, await backend.call('/api/v1/messaging/workbench/handoff', {
          source_session_id: sessionId, source_runtime: 'dsh', profile_id: input.profileId,
          target_runtime: 'dsh', request_id: input.requestId, ...(selection === undefined ? {} : { selection }),
        }))
      }
      if(input?.action==='goal'&&planningHandoff&&planningHandoff.state!=='active')throw Object.assign(Error('此规划代次不可执行操作。'),{code:'PLANNING_SESSION_SUPERSEDED',status:409})
      const binding = service.profiles.binding(sessionId)
      const supported = binding?.profile.type === 'codex' || binding?.profile.protocol === 'codex'
      if (!supported) return send(res, req.method === 'GET' ? 200 : 400, { planning_handoff:planningHandoff,supported: false, goal: null, ...(req.method === 'POST' ? { error: '此 Agent 未提供原生 Goal 控制。' } : {}) })
      if (req.method === 'GET') {
        const active = ctx.agents.get(sessionId)
        if (active) return send(res, 200, { planning_handoff:planningHandoff,supported: true, goal: goalSnapshot(active.session) })
        const handle = await ctx.get('sessionPersistence').open(sessionId, 'read')
        try { const { events } = await handle.read(); return send(res, 200, { planning_handoff:planningHandoff,supported: true, goal: goalSnapshot({ snapshotEvents: () => events }) }) } finally { await handle.close() }
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
    } catch (error) { return send(res, error.status ?? 400, { error: error.message, ...(/^(PLANNING_|DRAFT_|INVALID_REQUEST)/.test(error.code??'')||['MANAGED_HANDOFF_REQUIRED', 'HANDOFF_SOURCE_UNCONFIRMED', 'HANDOFF_SOURCE_BUSY'].includes(error.code) ? { code: error.code } : {}) }) }
  } })
}

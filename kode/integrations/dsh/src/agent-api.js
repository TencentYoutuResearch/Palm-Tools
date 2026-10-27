/** Owner-only Agent configuration API over dsh's existing authenticated Web carrier. */
import { AGENT_TYPES } from './agent-profiles.js'
import { profileRoute } from './agent-runtime.js'
import { SUPPORTED_AGENT_TYPES } from './native-session.js'
const PATH = '/api/kode/agents'
const json = (res, status, value) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(value)) }
export function registerAgentApi(ctx, service) {
  const streams = new Set()
  const { profiles, adapter } = service
  const available = profile => service.hasRuntime ? service.hasRuntime(profile.type) : Object.hasOwn(service.types ?? AGENT_TYPES, profile.type)
  const selected = agent => {
    const state = ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
    return state?.pending ?? state?.next ?? state?.lastUsed ?? ctx.agentDefaultModel.currentSelection()
  }
  const modelsFor = async (profile, catalog) => profile
    ? (adapter.listModels ? await adapter.listModels(profileRoute(profile.id), profile) : catalog.groups.find(g => g.id === profileRoute(profile.id))?.models ?? []).filter(m => m.id !== 'default')
    : catalog.groups.filter(g => !g.id.startsWith('kode-agent-')).flatMap(g => g.models.map(m => ({ ...m, provider: g.id })))
  const disposeUpdates = ctx.webServer.register({ kind: 'exact', path: `${PATH}/runtimes`, handler: (req, res) => {
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') { json(res, 403, { error: 'Host owner required' }); return }
    if (req.method !== 'GET') { json(res, 405, { error: 'GET required' }); return }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    streams.add(res)
    const publish = () => res.write(`data: ${JSON.stringify({ types: service.types ?? AGENT_TYPES })}\n\n`)
    const dispose = ctx.on?.('kode/runtimes-changed', publish)
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000)
    res.on('close', () => { streams.delete(res); clearInterval(heartbeat); dispose?.() })
    publish()
  } })
  const disposeApi = ctx.webServer.register({ kind: 'exact', path: PATH, handler: async (req, res) => {
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) { json(res, admitted.rejection, { error: 'authentication required' }); return }
    if (admitted.peer.principal.kind !== 'owner') { json(res, 403, { error: 'only the Host owner may configure executable Agents' }); return }
    try {
      if (req.method === 'GET') {
        await profiles.reload?.()
        const query = new URL(req.url, 'http://localhost').searchParams
        const sessionId = query.get('session_id')
        const agent = sessionId ? ctx.agents.get(sessionId) : undefined
        const binding = sessionId ? profiles.binding(sessionId) : undefined
        const stored = sessionId && !agent ? (await ctx.sessionController.list?.({}))?.items.find(row => row.sessionId === sessionId)?.projections?.values?.modelSelection : undefined
        const selection = agent ? selected(agent) : stored?.pending ?? stored?.next ?? stored?.lastUsed ?? ctx.agentDefaultModel.currentSelection()
        const inferred = profiles.list().find(p => profileRoute(p.id) === selection?.provider)
        const selectedProfileId = binding?.profile.id ?? inferred?.id ?? profiles.list().find(p => p.type === 'dsh')?.id
        const profile = binding?.profile ?? profiles.list().find(p => p.id === selectedProfileId)
        const catalog = { groups: [] }
        if (query.get('refresh') === '1' && profile) adapter.invalidateModels?.(profileRoute(profile.id))
        let models = [], modelError
        try { if (profile && available(profile)) models = await modelsFor(profile, catalog) } catch (error) { modelError = error.message }
        const policy = agent?.ctx?.get('sandboxPolicy')?.resolve({ session: agent.session })
        const installed = profiles.list().filter(available)
        json(res, 200, { types: service.types ?? AGENT_TYPES, profiles: installed, defaultProfileId: installed.find(p => p.type === 'codex')?.id ?? installed[0]?.id, currentProfile: profile && available(profile) ? profile : null, unavailableRuntime: Boolean(profile && !available(profile)), binding: binding ? { profileId: binding.profile.id, name: binding.profile.name, type: binding.profile.type } : null,
          selectedProfileId, selection, catalog, models, modelError,
          canChangeAgent: !agent || (agent.status === 'idle' && !(ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')?.lastTurn > 0)),
          workspace: agent?.session.header?.cwd, policy, supportedTypes: SUPPORTED_AGENT_TYPES })
        return
      }
      if (req.method !== 'POST') { json(res, 405, { error: 'GET or POST required' }); return }
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) { json(res, 415, { error: 'JSON body required' }); return }
      let body = ''
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 128 * 1024) throw new Error('Agent configuration exceeds 128 KiB') }
      const input = JSON.parse(body)
      if (input.action === 'save') { if (!available(input.profile ?? {})) throw new Error('此 Agent 的执行插件尚未安装。'); const profile = await profiles.save(input.profile); service.refresh(); json(res, 200, { profile }); return }
      if (input.action === 'remove') { await profiles.remove(input.profileId); service.refresh(); json(res, 200, { ok: true }); return }
      if (input.action !== 'select') throw new Error('unknown Agent operation')
      const found = await ctx.sessionController.resolveAgent(input.sessionId)
      if (found.error) throw new Error(found.error.message)
      const agent = found.agent, binding = profiles.binding(agent.id)
      const profile = binding?.profile.id === input.profileId ? binding.profile : profiles.get(input.profileId)
      if (!available(profile)) throw new Error('此 Agent 的执行插件已拔出。')
      if (!SUPPORTED_AGENT_TYPES.includes(profile.type)) throw new Error(`Persistent ${profile.type} adapter is not installed`)
      const position = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')
      const currentProfileId = binding?.profile.id ?? profiles.list().find(p => profileRoute(p.id) === selected(agent)?.provider)?.id ?? profiles.list().find(p => p.type === 'dsh')?.id
      if (currentProfileId !== profile.id) {
        if (position?.lastTurn > 0 || agent.status !== 'idle') throw new Error('Start a new conversation to change its Agent; the current conversation retains its history and runtime.')
        await profiles.clearUnusedBinding(agent.id)
      }
      let provider, model
      {
        provider = profileRoute(profile.id)
        const models = await modelsFor(profile, { groups: [] })
        if (!models.length) throw new Error('无法读取此 Agent 的模型，请检查可执行文件和登录状态后重试。')
        const prior = selected(agent)
        model = input.model ?? (prior?.provider === provider && prior.model !== 'default' ? prior.model : undefined) ?? profile.defaultModel ?? models.find(m => m.isDefault)?.id ?? models[0].id
        if (!models.some(m => m.id === model)) throw new Error('所选模型不在此 Agent 返回的模型列表中，请重新选择。')
      }
      // Verify the route before committing the profile binding; no executable is
      // launched by changing the selector (only bounded model discovery runs).
      const selection = agent.selectModel({provider,model})
      await agent.ctx?.parallel?.('session/flush',agent.session)
      await profiles.bind(agent.id, profile.id)
      service.recordBinding?.(agent, profile)
      json(res, 200, selection)
    } catch (error) { json(res, 400, { error: error.message }) }
  } })
  return () => { for (const res of streams) res.end(); disposeApi(); disposeUpdates() }
}

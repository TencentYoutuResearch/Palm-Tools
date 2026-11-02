/** Owner-only Agent configuration API over dsh's existing authenticated Web carrier. */
import { AGENT_TYPES } from './agent-profiles.js'
import { profileRoute } from './agent-runtime.js'
import { SUPPORTED_AGENT_TYPES } from './native-session.js'
import { resolveAdvertisedModel } from './model-alias.js'
const PATH = '/api/kode/agents'
const json = (res, status, value) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(value)) }
export function registerAgentApi(ctx, service) {
  const streams = new Set()
  const controller = () => { const value = ctx.get ? ctx.get('sessionController') : ctx.sessionController; if (!value) throw new Error('会话服务暂不可用，请稍后重试。'); return value }
  const { profiles, adapter } = service
  const available = profile => service.hasRuntime ? service.hasRuntime(profile.type) : Object.hasOwn(service.types ?? AGENT_TYPES, profile.type)
  const positionOf = agent => ctx.sessionProjections.stateOf(agent.session, agent.isKodeNativeAgent ? 'kodeTurnBoundary' : 'turnBoundary')
  const selected = agent => {
    const state = ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
    return state?.pending ?? state?.next ?? state?.lastUsed ?? ctx.agentDefaultModel.currentSelection()
  }
  const modelsFor = async (profile, catalog, modelHint) => profile
    ? (adapter.listModels ? await adapter.listModels(profileRoute(profile.id), profile, modelHint) : catalog.groups.find(g => g.id === profileRoute(profile.id))?.models ?? []).filter(m => m.id !== 'default')
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
        const appearanceIndex = await service.appearance?.load()
        const query = new URL(req.url, 'http://localhost').searchParams
        const sessionId = query.get('session_id')
        const configurationOnly = query.get('configuration') === '1'
        const agent = sessionId ? ctx.agents.get(sessionId) : undefined
        const binding = sessionId ? profiles.binding(sessionId) : undefined
        const storedRow = sessionId && !agent ? (await controller().list?.({}))?.items.find(row => row.sessionId === sessionId) : undefined
        const stored = storedRow?.projections?.values?.modelSelection
        const selection = agent ? selected(agent) : stored?.pending ?? stored?.next ?? stored?.lastUsed ?? ctx.agentDefaultModel.currentSelection()
        const inferred = profiles.list().find(p => profileRoute(p.id) === selection?.provider)
        const configuredDefault = profiles.list().find(p => p.id === profiles.defaultProfileId && available(p))
        const selectedProfileId = binding?.profile.id ?? (!sessionId ? configuredDefault?.id : undefined) ?? inferred?.id ?? profiles.list().find(p => p.type === 'dsh')?.id
        const profile = binding?.profile ?? profiles.list().find(p => p.id === selectedProfileId)
        const catalog = { groups: [] }
        if (query.get('refresh') === '1' && profile) adapter.invalidateModels?.(profileRoute(profile.id))
        let models = [], modelError
        try { if (!configurationOnly && profile && available(profile)) models = await modelsFor(profile, catalog, selection?.provider === profileRoute(profile.id) ? selection.model : undefined) } catch (error) { modelError = error.message }
        const policy = agent?.ctx?.get('sandboxPolicy')?.resolve({ session: agent.session })
        const installed = (service.appearance?.profilesView() ?? profiles.list()).filter(available)
        const visibleProfile = profile && (service.appearance?.profileView(profile, sessionId, appearanceIndex) ?? profile)
        const skills = query.get('skills') === '1' && profile && available(profile) ? await adapter.listSkills(profileRoute(profile.id), profile, agent?.session.header.cwd ?? (await controller().list({})).items.find(row => row.sessionId === sessionId)?.cwd) : undefined
        json(res, 200, { types: service.types ?? AGENT_TYPES, profiles: installed, defaultProfileId: configuredDefault?.id ?? installed.find(p => p.type === 'codex')?.id ?? installed[0]?.id, configuredDefaultProfileId: configuredDefault?.id ?? null, currentProfile: profile && available(profile) ? visibleProfile : null, unavailableRuntime: Boolean(profile && !available(profile)), binding: binding ? { profileId: binding.profile.id, name: visibleProfile.name, type: binding.profile.type } : null,
          selectedProfileId, selection, catalog, models, modelError, ...(skills ? { skills: skills.skills, skillErrors: skills.errors } : {}),
          canChangeAgent: agent ? agent.status === 'idle' && !(positionOf(agent)?.lastTurn > 0) : storedRow?.blank === true,
          workspace: agent?.session.header?.cwd, policy, supportedTypes: SUPPORTED_AGENT_TYPES })
        return
      }
      if (req.method !== 'POST') { json(res, 405, { error: 'GET or POST required' }); return }
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) { json(res, 415, { error: 'JSON body required' }); return }
      let body = ''
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 128 * 1024) throw new Error('Agent configuration exceeds 128 KiB') }
      const input = JSON.parse(body)
      if (input.action === 'set-default') {
        const id = input.profileId ?? null
        if (id !== null && !available(profiles.get(id))) throw new Error('此 Agent 的执行插件尚未安装。')
        json(res, 200, await profiles.setDefaultProfile(id)); return
      }
      if (input.action === 'agent-avatar') {
        if (!service.appearance) throw new Error('头像配置服务尚未就绪。')
        await service.appearance.setAgent(input.profileId, input.avatarId ?? null); json(res, 200, { ok: true }); return
      }
      if (input.action === 'session-avatar') {
        if (!service.appearance) throw new Error('头像配置服务尚未就绪。')
        const known = ctx.agents.get(input.sessionId) || (await controller().list({})).items.some(row => row.sessionId === input.sessionId)
        if (!known) throw new Error('会话不存在，请刷新列表。')
        await service.appearance.setSession(input.sessionId, input.avatarId ?? null); json(res, 200, { ok: true }); return
      }
      const existingId = input.profile?.id ?? input.profileId
      if (['save', 'remove'].includes(input.action) && existingId && service.appearance?.profilesView().find(profile => profile.id === existingId)?.origin === 'builtin') throw new Error('内置 Agent 的执行配置由 Kode 管理；请添加另一份自定义配置。')
      if (input.action === 'save') { if (!available(input.profile ?? {})) throw new Error('此 Agent 的执行插件尚未安装。'); const profile = await profiles.save(input.profile); service.refresh(); json(res, 200, { profile }); return }
      if (input.action === 'remove') { await profiles.remove(input.profileId); service.refresh(); json(res, 200, { ok: true }); return }
      if (input.action !== 'select') throw new Error('unknown Agent operation')
      const found = await controller().resolveAgent(input.sessionId)
      if (found.error) throw new Error(found.error.message)
      let agent = found.agent
      const binding = profiles.binding(agent.id)
      const profile = binding?.profile.id === input.profileId ? binding.profile : profiles.get(input.profileId)
      if (!available(profile)) throw new Error('此 Agent 的执行插件已拔出。')
      if (!SUPPORTED_AGENT_TYPES.includes(profile.type)) throw new Error(`Persistent ${profile.type} adapter is not installed`)
      const position = positionOf(agent)
      const currentProfileId = binding?.profile.id ?? profiles.list().find(p => profileRoute(p.id) === selected(agent)?.provider)?.id ?? profiles.list().find(p => p.type === 'dsh')?.id
      if (currentProfileId !== profile.id) {
        if (position?.lastTurn > 0 || agent.status !== 'idle') throw new Error('Start a new conversation to change its Agent; the current conversation retains its history and runtime.')
        await profiles.clearUnusedBinding(agent.id)
      }
      let provider, model, reasoningEffort
      {
        provider = profileRoute(profile.id)
        const prior = selected(agent)
        const models = await modelsFor(profile, { groups: [] }, input.model ?? (prior?.provider === provider ? prior.model : undefined))
        if (!models.length) throw new Error('无法读取此 Agent 的模型，请检查可执行文件和登录状态后重试。')
        model = input.model ?? (prior?.provider === provider && prior.model !== 'default' ? prior.model : undefined) ?? profile.defaultModel ?? models.find(m => m.isDefault)?.id ?? models[0].id
        model = resolveAdvertisedModel(models, model)
        const selectedModel = models.find(row => row.id === model), efforts = selectedModel.reasoningEfforts ?? []
        reasoningEffort = input.reasoningEffort ?? (prior?.provider === provider && prior.model === model ? prior.reasoningEffort : undefined) ?? selectedModel.defaultReasoningEffort
        if (reasoningEffort && !efforts.some(row => row.id === reasoningEffort)) {
          if (input.reasoningEffort) throw new Error('此模型未公布该推理强度，请重新选择。')
          reasoningEffort = undefined
        }
      }
      // Verify the route before committing the profile binding; no executable is
      // launched by changing the selector (only bounded model discovery runs).
      const selectedRoute = {provider,model,...(reasoningEffort ? { reasoningEffort } : {})}
      let rebound = false
      if (typeof agent.selectModel !== 'function') {
        const factory = ctx.get?.('kodeNativeFactory')
        if (!factory?.promote) throw new Error('Kode Agent 执行器尚未就绪。')
        agent = await factory.promote(agent, selectedRoute)
        rebound = true
      }
      const selection = agent.selectModel(selectedRoute)
      await agent.ctx?.parallel?.('session/flush',agent.session)
      await profiles.bind(agent.id, profile.id)
      service.recordBinding?.(agent, profile)
      json(res, 200, { ...selection, ...(rebound ? {rebound:true} : {}) })
    } catch (error) { json(res, 400, { error: error.message }) }
  } })
  return () => { for (const res of streams) res.end(); disposeApi(); disposeUpdates() }
}

/** Model-facing session creation. The Host owns admission; the Kode backend owns idempotency. */
import { randomUUID, createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { BackendDocument } from './backend-state.js'
import { profileRoute } from './agent-profiles.js'
import { resolveDefaultSelection } from './model-alias.js'
import { appendFastPreference } from './model-fast.js'
const required = (value, name, max = 4096) => { if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid ${name}`); return value.trim() }
export function installSessionCreator(ctx, backend, nodeId) {
  const document = new BackendDocument(backend, 'session-index')
  let chain = Promise.resolve()
  const update = operation => {
    const task = chain.then(async () => {
      for (let retry = 0; retry < 4; retry++) {
        const state = await document.read() ?? { version: 1 }
        state.creations ??= {}
        const result = operation(state)
        try { await document.write(state); return result } catch (error) { if (retry === 3 || !/configuration changed/.test(error.message)) throw error }
      }
    }); chain = task.catch(() => {}); return task
  }
  const jobs = new Map()
  const create = (input, source) => {
    const title = required(input.title, 'title', 160), task = required(input.task, 'task', 64000)
    const key = createHash('sha256').update(`${source?.id ?? input.requester ?? 'owner'}:${required(input.idempotency_key, 'idempotency key', 160)}`).digest('hex')
    const modelRequest = input.model === undefined ? undefined : required(input.model, 'model', 256)
    const identity = { title, task, cwd: input.cwd, workspace: input.workspace, workspace_id: input.workspace_id, agent: input.agent, permission: input.permission }
    const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const fingerprint = digest({ ...identity, model: modelRequest })
    const running = jobs.get(key)
    if (running) {
      if (running.fingerprint !== fingerprint) return Promise.reject(new Error('Creation key already belongs to a different task'))
      return running.operation
    }
    const operation = (async () => {
      const record = await update(state => {
        const prior = state.creations[key]
        if (prior && prior.fingerprint !== fingerprint) {
          // Older tools could not express model. Only an unsubmitted legacy
          // request may add it while retaining the original session/input IDs.
          if (prior.requestVersion !== 2 && prior.stage === 'prepared' && !prior.result && prior.fingerprint === digest(identity)) {
            prior.fingerprint = fingerprint
          } else throw new Error('Creation key already belongs to a different task')
        }
        if (prior) prior.requestVersion = 2
        return state.creations[key] ??= { sessionId: `session-${randomUUID()}`, fingerprint, requestVersion: 2, stage: 'prepared', inputId: randomUUID() }
      })
      if (record.result) return record.result
      if (record.stage === 'submitting') throw new Error('Session task submission outcome is uncertain; inspect the saved session before retrying')
      const runtime = ctx.get('kodeAgents')
      if (!runtime) throw new Error('Agent runtime is still starting; retry after Host initialization')
      await runtime.profiles.reload?.()
      const profiles = (runtime.appearance?.profilesView() ?? runtime.profiles.list()).filter(profile => runtime.hasRuntime(profile.type))
      const wanted = input.agent?.trim().toLocaleLowerCase()
      const sensitive = wanted && profiles.filter(profile => profile.id === input.agent || profile.name === input.agent)
      const exact = wanted && (sensitive.length ? sensitive : profiles.filter(profile => profile.name.toLocaleLowerCase() === wanted))
      const matches = wanted ? exact.length ? exact : profiles.filter(profile => profile.name.toLocaleLowerCase().includes(wanted)) : []
      if (wanted && matches.length !== 1) throw new Error(`Agent configuration is ${matches.length ? 'ambiguous' : 'unavailable'}; available names: ${profiles.map(profile => profile.name).join(', ')}`)
      const inherited = source && runtime.profiles.binding(source.id)?.profile
      const profile = matches[0] ?? (inherited && runtime.hasRuntime(inherited.type) ? inherited : profiles.find(profile => profile.id === runtime.profiles.defaultProfileId) ?? profiles.find(profile => profile.type === 'codex') ?? profiles[0])
      if (!profile) throw new Error('No installed Agent runtime is available')
      let workspace
      const registry = ctx.get('workspaceRegistry')
      if (!registry) throw new Error('Kode workspace catalog is not ready')
      if (input.workspace_id) {
        workspace = registry.get(input.workspace_id)
        if (!workspace) throw new Error('Workspace does not exist on this execution Host')
      }
      const requested = input.workspace ?? input.cwd
      if (requested) {
        const candidates = registry.list().filter(row => row.title === requested || row.path === requested || row.id === requested)
        if (workspace) {
          const match = candidates.some(row => row.id === workspace.id) || (isAbsolute(requested) && (await registry.resolveByPath(requested))?.id === workspace.id)
          if (!match) throw new Error('Workspace name/path and identity refer to different execution workspaces')
        } else {
          if (candidates.length === 1) workspace = candidates[0]
          else if (isAbsolute(requested)) workspace = await registry.resolveByPath(requested)
          if (!workspace || candidates.length > 1) throw new Error('Workspace is ambiguous or unavailable on this execution Host; choose a listed Kode workspace')
        }
      }
      if (!workspace && source?.session.header.cwd) workspace = registry.list().find(row => row.path === source.session.header.cwd)
      if (!workspace && registry.list().length === 1) workspace = registry.list()[0]
      if (!workspace) throw new Error(`Select a Kode workspace on this Host. Available workspaces: ${registry.list().map(row => `${row.title} (${row.path})`).join(', ') || 'none; create a workspace first'}`)
      const policy = source?.ctx.get('sandboxPolicy')?.resolve({ session: source.session })
      const mode = input.permission ?? policy?.mode ?? 'workspace-write'
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(mode)) throw new Error('Unknown permission mode')
      if (mode === 'danger-full-access' && policy?.mode !== 'danger-full-access') throw new Error('New sessions cannot escalate the caller permission')
      const provider = profileRoute(profile.id)
      const preference = modelRequest ? { model: modelRequest } : record.selection ?? (record.model ? { model: record.model } : runtime.profiles.defaultModelFor?.(profile.id))
      const modelHint = preference?.model ?? record.model ?? profile.defaultModel
      const models = (await runtime.adapter.listModels(provider, profile, modelHint)).filter(row => row.id !== 'default')
      const selection = resolveDefaultSelection(models, preference, record.model ?? profile.defaultModel), model = selection.model
      const selectedModel = models.find(row => row.id === model), route = { provider, model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
      await update(state => { state.creations[key].model = model; state.creations[key].selection = selection })
      const controller = ctx.get('sessionController')
      if (registry.archivedSessionIds?.includes(record.sessionId)) throw new Error('The partial session was archived; inspect it before retrying')
      // Reuse partial sessions directly: controller.create may mint another ID
      // when an existing session is no longer considered a blank composition.
      const existing = ctx.get('agents')?.get(record.sessionId)
        ?? (await controller.list?.({}))?.items?.find(row => row.sessionId === record.sessionId)
      const result = existing ? { sessionId: record.sessionId }
        : await controller.create({ sessionId: record.sessionId, agentPreset: 'kode-native', workspaceId: workspace.id })
      if (result.sessionId !== record.sessionId) throw new Error('Session identity changed; refusing to start an unrelated conversation')
      const { agent: resolved, error } = await controller.resolveAgent(result.sessionId)
      if (error) throw new Error(error.message)
      if (resolved.session.header.cwd !== workspace.path) throw new Error('Partial session belongs to a different workspace')
      if (resolved.status === 'running' || resolved.session.snapshotEvents?.().some(event => ['turn/start', 'request/header', 'user/message'].includes(event.type))) {
        throw new Error('Partial session already has activity; inspect it before retrying task submission')
      }
      ctx.get('permissionPresets')?.set(resolved.session, mode)
      let agent = resolved
      if (typeof agent.selectModel !== 'function') {
        const factory = ctx.get('kodeNativeFactory')
        if (!factory?.promote) throw new Error('Kode Agent executor is not ready; retry this creation key after Host initialization')
        agent = await factory.promote(agent, route)
        ctx.get('permissionPresets')?.set(agent.session, mode)
      }
      agent.selectModel(route)
      if (selection.fast !== undefined && selectedModel.fastCapability.transport !== 'model-variant') appendFastPreference(agent.session, route, selection.fast, selectedModel.fastCapability.tier)
      await runtime.profiles.bind(agent.id, profile.id); runtime.recordBinding(agent, profile)
      await ctx.get('sessionController').rename({ sessionId: agent.id, title })
      const delegated = Boolean(source || input.requester)
      await update(state => { state.creations[key].stage = delegated ? 'ready' : 'submitting' })
      if (!delegated) agent.followup({ id: record.inputId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: task }] })
      await agent.ctx.sessions.flush(agent.session)
      const created = { address: { node_id: nodeId, session_id: agent.id }, title, agent: profile.name, model, workspace: { id: workspace.id, name: workspace.title, path: workspace.path }, cwd: agent.session.header.cwd, status: delegated ? 'ready' : 'started' }
      await update(state => { state.creations[key].stage = created.status; state.creations[key].result = created })
      return created
    })().finally(() => jobs.delete(key))
    jobs.set(key, { operation, fingerprint }); return operation
  }
  ctx.provide('kodeSessionCreator', { create })
  ctx.effect(() => () => Promise.allSettled([...jobs.values()].map(job => job.operation)), 'kode.session-create')
}

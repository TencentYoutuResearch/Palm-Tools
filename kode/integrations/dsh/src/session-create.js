/** Model-facing session creation. The Host owns admission; the Kode backend owns idempotency. */
import { randomUUID, createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { BackendDocument } from './backend-state.js'
import { profileRoute, profileRevision } from './agent-profiles.js'
import { resolveDefaultSelection } from './model-alias.js'
import { appendFastPreference } from './model-fast.js'
import { selectModelPlan } from './model-selection.js'
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
  const operationKey = (input, source) => createHash('sha256').update(`${source?.id ?? input.requester ?? 'owner'}:${required(input.idempotency_key, 'idempotency key', 160)}`).digest('hex')
  const lookup = async (input, source) => {
    const key = operationKey(input, source)
    // A separate reader must not change the revision used by a concurrent writer.
    const state = await new BackendDocument(backend, 'session-index').read()
    const record = state?.creations?.[key]
    if (!record) return { status: 'not_found' }
    return {
      status: record.result ? 'completed' : ['creating', 'submitting'].includes(record.stage) ? 'uncertain' : 'pending',
      stage: record.stage,
      address: { node_id: nodeId, session_id: record.sessionId },
      ...(record.result ? { result: record.result } : {}),
    }
  }
  const create = (input, source) => {
    const title = required(input.title, 'title', 160), task = required(input.task, 'task', 64000)
    const key = operationKey(input, source)
    const modelRequest = input.model === undefined ? undefined : required(input.model, 'model', 256)
    const effortRequest = input.reasoningEffort === undefined ? undefined : required(input.reasoningEffort, 'reasoning effort', 64)
    const identity = { title, task, cwd: input.cwd, workspace: input.workspace, workspace_id: input.workspace_id, agent: input.agent, permission: input.permission }
    const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const fingerprint = digest({ ...identity, model: modelRequest, reasoningEffort: effortRequest })
    const pending = jobs.get(key)
    if (pending) {
      if (pending.fingerprint !== fingerprint) return Promise.reject(new Error('Creation key already belongs to a different task'))
      return pending.operation
    }
    const operation = (async () => {
      const policy = source?.ctx.get('sandboxPolicy')?.resolve({ session: source.session })
      const mode = input.permission ?? policy?.mode ?? 'workspace-write'
      const modes = ['read-only', 'workspace-write', 'danger-full-access']
      if (!modes.includes(mode)) throw new Error('Unknown permission mode')
      // Until team grants exist, delegation cannot exceed the caller's own authority.
      if ((source && (!modes.includes(policy?.mode) || modes.indexOf(mode) > modes.indexOf(policy.mode)))
        || (mode === 'danger-full-access' && policy?.mode !== 'danger-full-access')) {
        throw new Error('New sessions cannot escalate the caller permission')
      }
      const record = await update(state => {
        const prior = state.creations[key]
        if (prior && prior.fingerprint !== fingerprint) {
          // Older tools could not express model. Only an unsubmitted legacy
          // request may add it while retaining the original session/input IDs.
          if (prior.requestVersion !== 3 && prior.stage === 'prepared' && !prior.result && [digest(identity), digest({ ...identity, model: modelRequest })].includes(prior.fingerprint)) {
            prior.fingerprint = fingerprint
          } else throw new Error('Creation key already belongs to a different task')
        }
        if (prior) prior.requestVersion = 3
        return state.creations[key] ??= { sessionId: `session-${randomUUID()}`, fingerprint, requestVersion: 3, stage: 'prepared', inputId: randomUUID() }
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
      const profile = (record.plan ? profiles.find(p => p.id === record.plan.profile_id) : undefined) ?? matches[0] ?? (inherited && runtime.hasRuntime(inherited.type) ? inherited : profiles.find(profile => profile.id === runtime.profiles.defaultProfileId) ?? profiles.find(profile => profile.type === 'codex') ?? profiles[0])
      if (!profile) throw new Error('No installed Agent runtime is available')
      // Defaults are already resolved into the saved selection. Retain them for
      // revision checks while still detecting executable, environment and policy changes.
      const profileDefaults = record.plan?.profile_defaults ?? { ...(profile.defaultModel === undefined ? {} : { model: profile.defaultModel }), ...(profile.defaultReasoningEffort === undefined ? {} : { reasoning_effort: profile.defaultReasoningEffort }) }
      const pinnedProfile = record.plan ? { ...profile, defaultModel: profileDefaults.model, defaultReasoningEffort: profileDefaults.reasoning_effort } : profile
      if (record.plan && (record.plan.profile_id !== profile.id || record.plan.profile_revision !== profileRevision(pinnedProfile))) throw new Error('Creation Agent configuration changed; inspect the original operation')
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
      const provider = profileRoute(profile.id)
      const sourceState = source && ctx.sessionProjections?.stateOf(source.session, 'modelSelection')
      const sourceSelection = source && (sourceState?.pending ?? sourceState?.next ?? sourceState?.lastUsed ?? source.options)
      const inheritedSelection = sourceSelection?.provider === provider && sourceSelection.model !== 'default' ? sourceSelection : undefined
      const preference = record.plan?.selection ?? record.selection ?? (!modelRequest && !inheritedSelection ? runtime.profiles.defaultModelFor?.(profile.id) : undefined)
      const modelHint = record.plan?.selection?.model ?? modelRequest ?? record.model ?? inheritedSelection?.model ?? preference?.model ?? profile.defaultModel
      const models = (await runtime.adapter.listModels(provider, profile, modelHint)).filter(row => row.id !== 'default')
      const requestedSelection = record.plan?.selection ?? { ...preference, model: modelRequest ?? record.model ?? preference?.model, reasoningEffort: effortRequest ?? preference?.reasoningEffort }
      const initialSelection = selectModelPlan(pinnedProfile, models, requestedSelection, sourceSelection)
      const resolvedSelection = resolveDefaultSelection(models, { ...initialSelection, ...(preference?.fast === undefined ? {} : { fast: preference.fast }) }, initialSelection.model)
      // Fast model variants are catalogue selections too: recheck allowedModels.
      const selection = selectModelPlan(pinnedProfile, models, resolvedSelection)
      const selectedModel = models.find(row => row.id === selection.model)
      const planSelection = { ...selection, ...(resolvedSelection.fast === undefined ? {} : { fast: resolvedSelection.fast }) }
      const plan = { profile_id: profile.id, profile_revision: profileRevision(pinnedProfile), profile_defaults: profileDefaults, selection: planSelection, workspace_id: workspace.id, permission: mode }
      await update(state => {
        const prior = state.creations[key]
        if (prior.plan && !isDeepStrictEqual({ ...prior.plan, profile_defaults: prior.plan.profile_defaults ?? profileDefaults }, plan)) throw new Error('Creation configuration changed; inspect the original operation')
        prior.plan = plan
        prior.model = selection.model
        prior.selection = resolvedSelection
      })
      // The upstream create API may mint a replacement when the requested ID
      // cannot be reused. Claim this side effect once; recovery resolves only
      // the original durable identity instead of calling create again.
      const controller = ctx.get('sessionController')
      if (registry.archivedSessionIds?.includes(record.sessionId)) throw new Error('The partial session was archived; inspect it before retrying')
      const existingSession = ctx.get('agents')?.get(record.sessionId)
        ?? (await controller.list?.({}))?.items?.find(row => row.sessionId === record.sessionId)
      const firstCreate = await update(state => {
        const prior = state.creations[key]
        if (prior.stage !== 'prepared') return false
        prior.stage = existingSession ? 'created' : 'creating'
        return !existingSession
      })
      if (firstCreate) {
        const result = await controller.create({ sessionId: record.sessionId, agentPreset: 'kode-native', workspaceId: workspace.id })
        if (result.sessionId !== record.sessionId) throw new Error('Session identity changed; creation outcome is uncertain, inspect the original operation')
        await update(state => { if (state.creations[key].stage === 'creating') state.creations[key].stage = 'created' })
      }
      const { agent: resolved, error } = await controller.resolveAgent(record.sessionId)
      if (error || !resolved || resolved.id !== record.sessionId) throw new Error('Session creation outcome is uncertain; the original session could not be resolved')
      const events = resolved.session.snapshotEvents?.()
      if (resolved.session.header.cwd !== workspace.path) throw new Error('Session creation recovery workspace changed; Partial session belongs to a different workspace')
      if (resolved.status === 'running' || events?.some(event => ['turn/start', 'request/header', 'user/message'].includes(event.type))) throw new Error('Session creation recovery requires a proven blank original session; Partial session already has activity, inspect before retrying')
      if (!firstCreate) {
        if (!Array.isArray(events) || events.some(event => ['turn/start', 'user/message'].includes(event.type))) throw new Error('Session creation recovery requires a proven blank original session; inspect before retrying')
        if (resolved.session.header.cwd !== workspace.path || registry.archivedSessionIds?.includes(resolved.id)) throw new Error('Session creation recovery workspace changed or session archived; inspect before retrying')
        if (!Array.isArray(workspace.sessionIds)) throw new Error('Session creation recovery workspace membership is unavailable')
        if (!workspace.sessionIds.includes(resolved.id)) {
          if (registry.list().some(row => row.id !== workspace.id && row.sessionIds?.includes(resolved.id))) throw new Error('Session creation recovery belongs to another workspace; inspect before retrying')
          if (typeof workspace.attachSession !== 'function') throw new Error('Session creation recovery cannot restore workspace membership')
          await workspace.attachSession(resolved.id)
          if (!workspace.sessionIds.includes(resolved.id)) throw new Error('Session creation recovery workspace attachment is unconfirmed')
        }
      }
      ctx.get('permissionPresets')?.set(resolved.session, mode)
      await runtime.profiles.bind(resolved.id, profile.id); runtime.recordBinding(resolved, profile)
      let agent = resolved
      if (typeof agent.selectModel !== 'function') {
        // The controller may hand back the official executor; promote it like the manual selector does.
        const factory = ctx.get('kodeNativeFactory')
        if (!factory?.promote) throw new Error('Kode Agent executor is not ready; retry this creation key after Host initialization')
        agent = await factory.promote(agent, selection)
        ctx.get('permissionPresets')?.set(agent.session, mode); runtime.recordBinding(agent, profile)
      }
      await agent.selectModel(selection)
      if (resolvedSelection.fast !== undefined && selectedModel.fastCapability.transport !== 'model-variant') appendFastPreference(agent.session, selection, resolvedSelection.fast, selectedModel.fastCapability.tier)
      await ctx.get('sessionController').rename({ sessionId: agent.id, title })
      const delegated = Boolean(source || input.requester)
      const existing = await update(state => {
        const prior = state.creations[key]
        if (prior.result) return prior.result
        if (prior.stage === 'submitting') throw new Error('Session task submission outcome is uncertain; inspect the saved session before retrying')
        prior.stage = delegated ? 'ready' : 'submitting'
        return null
      })
      if (existing) return existing
      if (!delegated) agent.followup({ id: record.inputId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: task }] })
      await agent.ctx.sessions.flush(agent.session)
      const created = { address: { node_id: nodeId, session_id: agent.id }, title, agent: profile.name, model: selection.model, workspace: { id: workspace.id, name: workspace.title, path: workspace.path }, cwd: agent.session.header.cwd, status: delegated ? 'ready' : 'started', selection: { ...selection, verification: 'requested' } }
      await update(state => { state.creations[key].stage = created.status; state.creations[key].result = created })
      return created
    })().finally(() => jobs.delete(key))
    jobs.set(key, { fingerprint, operation }); return operation
  }
  ctx.provide('kodeSessionCreator', { create, lookup })
  ctx.effect(() => () => Promise.allSettled([...jobs.values()].map(job => job.operation)), 'kode.session-create')
}

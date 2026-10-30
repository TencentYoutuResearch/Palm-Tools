/** Model-facing session creation. The Host owns admission; the Kode backend owns idempotency. */
import { randomUUID, createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { BackendDocument } from './backend-state.js'
import { profileRoute } from './agent-profiles.js'
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
    if (jobs.has(key)) return jobs.get(key)
    const operation = (async () => {
      const fingerprint = createHash('sha256').update(JSON.stringify({ title, task, cwd: input.cwd, workspace: input.workspace, workspace_id: input.workspace_id, agent: input.agent, permission: input.permission })).digest('hex')
      const record = await update(state => {
        const prior = state.creations[key]
        if (prior && prior.fingerprint !== fingerprint) throw new Error('Creation key already belongs to a different task')
        return state.creations[key] ??= { sessionId: `session-${randomUUID()}`, fingerprint, stage: 'prepared', inputId: randomUUID() }
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
      const profile = matches[0] ?? (inherited && runtime.hasRuntime(inherited.type) ? inherited : profiles.find(profile => profile.type === 'codex') ?? profiles[0])
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
      const result = await ctx.get('sessionController').create({ sessionId: record.sessionId, agentPreset: 'kode-native', workspaceId: workspace.id })
      if (result.sessionId !== record.sessionId) throw new Error('Session identity changed; refusing to start an unrelated conversation')
      const { agent, error } = await ctx.get('sessionController').resolveAgent(result.sessionId)
      if (error) throw new Error(error.message)
      const policy = source?.ctx.get('sandboxPolicy')?.resolve({ session: source.session })
      const mode = input.permission ?? policy?.mode ?? 'workspace-write'
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(mode)) throw new Error('Unknown permission mode')
      if (mode === 'danger-full-access' && policy?.mode !== 'danger-full-access') throw new Error('New sessions cannot escalate the caller permission')
      ctx.get('permissionPresets')?.set(agent.session, mode)
      await runtime.profiles.bind(agent.id, profile.id); runtime.recordBinding(agent, profile)
      const provider = profileRoute(profile.id), models = await runtime.adapter.listModels(provider, profile)
      const model = profile.defaultModel ?? models.find(row => row.isDefault)?.id ?? models[0]?.id
      if (!model) throw new Error('The selected Agent returned no model')
      agent.selectModel({provider,model})
      await ctx.get('sessionController').rename({ sessionId: agent.id, title })
      const delegated = Boolean(source || input.requester)
      await update(state => { state.creations[key].stage = delegated ? 'ready' : 'submitting' })
      if (!delegated) agent.followup({ id: record.inputId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: task }] })
      await agent.ctx.sessions.flush(agent.session)
      const created = { address: { node_id: nodeId, session_id: agent.id }, title, agent: profile.name, workspace: { id: workspace.id, name: workspace.title, path: workspace.path }, cwd: agent.session.header.cwd, status: delegated ? 'ready' : 'started' }
      await update(state => { state.creations[key].stage = created.status; state.creations[key].result = created })
      return created
    })().finally(() => jobs.delete(key))
    jobs.set(key, operation); return operation
  }
  ctx.provide('kodeSessionCreator', { create })
  ctx.effect(() => () => Promise.allSettled([...jobs.values()]), 'kode.session-create')
}

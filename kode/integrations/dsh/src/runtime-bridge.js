import { resolveDefaultSelection } from './model-alias.js'
import { appendFastPreference } from './model-fast.js'
import { needsEmptySessionCheck, setupOnlySession, sessionInspector } from './empty-session.js'
/** Project the existing dsh runtime into Kode. Never run a second Agent loop. */
import { randomUUID, createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { stat } from 'node:fs/promises'
import { profileRoute } from './agent-profiles.js'
import { importSavedSession } from './workbench-import.js'
import { ensureCursorCliChat } from './cursor-storage.js'
import { updateOpenTabs } from './saved-session-state.js'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { installRuntimeInteractions, questionSchema, questionAnswer } from './runtime-interactions.js'

export function permissionSnapshot(service, session, row) {
  if (!service) return {}
  return { permission_mode: session ? service.current(session) : row?.projections?.values?.permissions?.currentValue, permission_modes: service.catalog().options.map(option => ({ id: option.value, label: option.name, description: option.description ?? '' })) }
}

const PREFIX = '/api/v1/messaging/runtime/'
const textOf = content => (content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')

export function projectSessionEvent(event, messageId) {
  const key = `log:${event.seq}`, data = event.data ?? {}
  if (event.type === 'user/message' || event.type === 'assistant/message') {
    const message = event.type === 'user/message' ? data : data.message
    if (!message) return []
    return [{ key, kind: 'message', payload: { id: messageId ?? message.id ?? key, role: event.type === 'user/message' ? 'user' : 'assistant', text: textOf(message.content), content: message.content, source_kind: message.source?.kind, streaming: false } }]
  }
  if (event.type === 'tool/call') return [{ key, kind: 'tool_use', payload: { id: data.callId, name: data.name, input: data.arguments, status: 'running' } }]
  if (event.type === 'tool/result') return [{ key, kind: 'tool_use', payload: { id: data.callId, output: textOf(data.message?.content ?? data.content), status: data.message?.isError || data.isError ? 'error' : 'ok' } }]
  if (event.type === 'turn/start' || event.type === 'turn/end') return [{ key, kind: 'session.status', payload: { status: event.type === 'turn/start' ? 'busy' : 'idle' } }]
  if (event.type === 'plugin:kode/shared-interaction') return data.state === 'open'
    ? [{ key, kind: data.kind, payload: data.payload }]
    : [{ key, kind: 'interaction.resolved', payload: { request_id: data.id } }, { key: `${key}:clear`, kind: 'session.attention_cleared', payload: {} }]
  return []
}

export class RuntimeBridge {
  constructor(ctx, backend, { runtime = 'dsh', intervalMs = 500 } = {}) {
    this.ctx = ctx; this.backend = backend; this.runtime = runtime; this.intervalMs = intervalMs
    this.bootId = randomUUID(); this.stop = new AbortController(); this.cursors = new Map(); this.ids = new Map(); this.pending = new Map(); this.extra = new Map(); this.results = new Map(); this.streams = new Map(); this.known = null; this.continued = new Map(); this.answeredContinued = new Set(); this.coldStamps = new Map()
    this.longPoll = true; this.publishActive = null; this.publishQueued = null
  }
  service(name) { return this.ctx.get?.(name) ?? this.ctx[name] }
  call(name, body) { return this.backend.call(PREFIX + name, body, this.stop.signal) }
  projection(row, agent) {
    const selection = agent?.session.requestHeader?.()?.config ?? row.projections?.values?.modelSelection?.lastUsed ?? {}
    const binding = this.service('kodeAgents').profiles.binding(row.sessionId)
    const profile = binding?.profile
    return { runtime_backend_key: profile ? `dsh:${profile.id}` : undefined, ...permissionSnapshot(this.service('permissionPresets'), agent?.session, row), native_thread_id: binding?.threadId, backend_key: this.service('kodeAgents').profiles.sharedState?.desktop_ids?.[profile?.id] ?? profile?.name ?? 'dsh', title: row.projections?.values?.title ?? row.title ?? '未命名会话', model: selection.model ?? profile?.defaultModel ?? '', status: agent?.status === 'running' ? 'busy' : 'idle', cwd: row.cwd ?? agent?.session.header.cwd, session_uuid: row.sessionId, tokens: { total: 0, input: 0, output: 0, cached: 0 } }
  }
  publish() {
    if (this.publishActive) {
      return this.publishQueued ??= this.publishActive
        .catch(() => {})
        .then(() => {
          this.publishQueued = null
          return this.runPublish()
        })
    }
    return this.runPublish()
  }
  runPublish() {
    const task = this.publishSnapshot()
    this.publishActive = task
    return task.finally(() => { if (this.publishActive === task) this.publishActive = null })
  }
  async publishSnapshot() {
    const controller = this.service('sessionController'), directory = await controller.list({}, this.stop.signal)
    // Empty composer placeholders are not saved conversations. Retire older
    // publications too, so another frontend cannot persist and reimport them.
    const archived = new Set(this.service('workspaceRegistry')?.archivedSessionIds ?? [])
    const items = directory.items.filter(row => !row.blank && !archived.has(row.sessionId))
    if (!this.known) {
      const saved = await this.backend.call(PREFIX + 'sessions', undefined, this.stop.signal)
      this.known = new Map(saved.sessions.filter(row => row.runtime === this.runtime).map(row => [row.runtime_session_id, row]))
    }
    const listed = new Set(items.map(row => row.sessionId))
    const exited = []
    for (const [sessionId, dto] of this.known) if (!listed.has(sessionId) && dto.status !== 'exited') {
      exited.push({ session_id: sessionId, dto: { ...dto, status: 'exited' }, events: [] })
    }
    if (exited.length) {
      await this.call('publish', { runtime: this.runtime, boot_id: this.bootId, sessions: exited })
      for (const row of exited) this.known.set(row.session_id, row.dto)
    }
    for (const row of items) {
      this.stop.signal.throwIfAborted()
      const agent = this.service('agents').get(row.sessionId)
      // An unloaded conversation changes only through its catalog row; skip
      // re-reading its whole log every pass while that row is unchanged.
      // A row that returns from the archive was published as exited; republish.
      const stamp = agent ? null : JSON.stringify([row, this.service('kodeAgents')?.profiles.binding(row.sessionId) ?? null])
      if (stamp && this.coldStamps.get(row.sessionId) === stamp && this.known.get(row.sessionId)?.status !== 'exited' && this.known.has(row.sessionId)
        && !this.extra.get(row.sessionId)?.length && !this.continued.get(row.sessionId)?.size
        && ![...this.pending.values()].some(request => request.sessionId === row.sessionId)) continue
      if (stamp) this.coldStamps.set(row.sessionId, stamp); else this.coldStamps.delete(row.sessionId)
      const observed = agent ? { events: agent.session.snapshotEvents() } : await sessionInspector(controller, this.service('sessionQuery'))(row.sessionId, this.stop.signal)
      if (!agent && needsEmptySessionCheck(row) && setupOnlySession(observed)) {
        const previous = this.known.get(row.sessionId)
        if (previous && previous.status !== 'exited') {
          await this.call('publish', { runtime: this.runtime, boot_id: this.bootId, sessions: [{ session_id: row.sessionId, dto: { ...previous, status: 'exited' }, events: [] }] })
          this.known.set(row.sessionId, { ...previous, status: 'exited' })
        }
        continue
      }
      const events = observed.events.filter(event => event.seq > (this.cursors.get(row.sessionId) ?? -1))
      const segments = new Map(), interactions = new Set()
      const projected = observed.events.flatMap(event => {
        let messageId
        if (event.type === 'assistant/message') {
          const group = `${event.data.turn}:${event.data.step}`, index = segments.get(group) ?? 0
          messageId = `dsh:${row.sessionId}:${group}:${index}`; segments.set(group, index + 1)
        }
        if (event.type === 'plugin:kode/shared-interaction') {
          if (event.data.state === 'open') interactions.add(event.data.id); else interactions.delete(event.data.id)
        }
        return event.seq > (this.cursors.get(row.sessionId) ?? -1) ? projectSessionEvent(event, messageId).filter(event => event.kind !== 'session.attention_cleared' || interactions.size === 0) : []
      })
      for (const id of interactions) if (!this.pending.has(id)) {
        projected.push({ key: `recovered:${id}`, kind: 'interaction.resolved', payload: { request_id: id } })
      }
      if (interactions.size && [...interactions].every(id => !this.pending.has(id))) projected.push({ key: `recovered-clear:${[...interactions].sort().join(':')}`, kind: 'session.attention_cleared', payload: {} })
      const questions = agent ? this.service('userQuestions')?.continued?.(agent) ?? [] : (row.projections?.values?.userQuestions?.questions?.active ?? []).filter(question => question.state === 'continued')
      const activeContinued = new Set()
      for (const question of questions) {
        const id = `dsh-question:${row.sessionId}:${question.callId}`
        activeContinued.add(id)
        if (this.answeredContinued.has(id)) continue
        if (!this.pending.has(id)) this.pending.set(id, {
          sessionId: row.sessionId,
          answer: async payload => {
            const { agent, error } = await controller.resolveAgent(row.sessionId)
            if (error) throw new Error(error.message)
            const answer = questionAnswer(question.questions, payload.response ?? payload)
            if (!this.service('userQuestions').answer(agent, question.callId, answer)) throw new Error('This question has already settled')
            this.answeredContinued.add(id); this.pending.delete(id)
            this.emit(row.sessionId, { key: `continued-answer:${question.callId}`, kind: 'interaction.resolved', payload: { request_id: id } })
            return { accepted: true }
          },
        })
        projected.push({ key: `continued-open:${question.callId}`, kind: 'ask_user_question', payload: { request_id: id, question_id: id, source: 'acp_form', message: 'Agent 已继续运行，你仍可以回答这个问题。', requested_schema: questionSchema(question.questions) } })
      }
      for (const id of this.continued.get(row.sessionId) ?? []) if (!activeContinued.has(id)) {
        this.pending.delete(id); this.answeredContinued.delete(id)
        projected.push({ key: `continued-closed:${id}`, kind: 'interaction.resolved', payload: { request_id: id } })
      }
      if ((this.continued.get(row.sessionId)?.size || activeContinued.size) && ![...this.pending.values()].some(request => request.sessionId === row.sessionId)) projected.push({ key: `continued-clear:${[...activeContinued].join(':')}`, kind: 'session.attention_cleared', payload: {} })
      this.continued.set(row.sessionId, activeContinued)
      const extra = [...(this.extra.get(row.sessionId) ?? [])]
      const committed = new Set(projected.filter(event => event.kind === 'message' && event.payload.streaming === false).map(event => event.payload.id))
      const publication = [...projected, ...extra.filter(event => !committed.has(event.payload.id))]
      const dto = this.projection(row, agent)
      this.known.set(row.sessionId, dto)
      for (let offset = 0; offset < Math.max(1, publication.length); offset += 128) {
        const response = await this.call('publish', { runtime: this.runtime, boot_id: this.bootId, sessions: [{ session_id: row.sessionId, dto, events: publication.slice(offset, offset + 128) }] })
        this.ids.set(row.sessionId, response.sessions[0].id)
      }
      if (events.length) this.cursors.set(row.sessionId, events.at(-1).seq)
      this.extra.set(row.sessionId, (this.extra.get(row.sessionId) ?? []).filter(event => !extra.includes(event)))
    }
    if (!items.length) await this.call('publish', { runtime: this.runtime, boot_id: this.bootId, sessions: [] })
    await this.syncOpenList(listed, archived)
  }
  /** Conversations opened here (created, sent their first turn, unarchived)
   *  join Kode's open list; archived ones leave it. The first pass only takes
   *  the baseline: what was open before this run is Kode's to reconcile. */
  async syncOpenList(listed, archived) {
    if (!this.openSeen) { this.openSeen = listed; return }
    const open = [...listed].filter(id => !this.openSeen.has(id)).map(id => {
      const dto = this.known.get(id)
      return dto && { backend_key: dto.backend_key, transport_kind: 'runtime', title: dto.title, title_pinned: false, cwd: dto.cwd, workspace_title: null,
        session_id: dto.native_thread_id ?? id, dsh_session_id: id, model: dto.model || null, permission_mode: null, endpoint_id: null, avatar_id: null }
    }).filter(row => row?.cwd)
    const closed = [...this.openSeen].filter(id => !listed.has(id) && archived.has(id))
    if (open.length || closed.length) {
      try { await updateOpenTabs(this.backend, { open, closed }) }
      catch (error) { this.ctx.logger?.warn?.('Kode open list update failed; retrying: %s', error.message); return }
    }
    this.openSeen = listed
  }
  async execute(command, { deferPublish = false } = {}) {
    const { id, session_id: sessionId, kind, payload } = command, controller = this.service('sessionController')
    const runtime = this.service('kodeAgents')
    if (kind === 'backends') return { home: homedir(), backends: runtime.profiles.list().filter(profile => runtime.hasRuntime(profile.type)).map(profile => ({ key: `dsh:${profile.id}`, display_name: `${profile.name} · dsh`, enabled: true, model_flag: '--model' })) }
    if (kind === 'models') {
      const profile = runtime.profiles.list().find(profile => `dsh:${profile.id}` === payload.backend_key)
      if (!profile) throw new Error('Agent configuration unavailable')
      const models = await runtime.adapter.listModels(profileRoute(profile.id), profile)
      return { models: models.map(model => ({ id: model.id, label: model.name })), custom_allowed: true }
    }
    if (kind === 'create_session') {
      const profile = runtime.profiles.list().find(profile => `dsh:${profile.id}` === payload.backend_key && runtime.hasRuntime(profile.type))
      if (!profile) throw new Error('Agent configuration unavailable')
      if (!isAbsolute(payload.cwd ?? '') || !(await stat(payload.cwd)).isDirectory()) throw new Error('Choose an existing absolute directory on the execution Host')
      const provider = profileRoute(profile.id)
      const preference = payload.model
        ? { model: payload.model, reasoningEffort: payload.reasoning_effort }
        : runtime.profiles.defaultModelFor?.(profile.id)
      const models = await runtime.adapter.listModels(provider, profile, preference?.model ?? profile.defaultModel)
      const selection = resolveDefaultSelection(models, preference, profile.defaultModel), model = selection.model
      const selectedModel = models.find(row => row.id === model), route = { provider, model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
      const registry = this.service('workspaceRegistry')
      const workspace = await registry.resolveByPath(payload.cwd) ?? await registry.create(payload.cwd)
      // The backend request id also names the session. An uncertain creation is
      // inspected/reused, never replaced by a fresh CLI thread.
      const sessionId = `mobile-${createHash('sha256').update(id).digest('hex')}`
      const existing = this.service('agents')?.get(sessionId) ?? (await controller.list({})).items.find(row => row.sessionId === sessionId)
      const created = existing ? { sessionId } : await controller.create({ sessionId, workspaceId: workspace.id, agentPreset: 'kode-native' })
      if (created.sessionId !== sessionId) throw new Error('Session identity changed during creation')
      const { agent: resolved, error } = await controller.resolveAgent(sessionId)
      if (error) throw new Error(error.message)
      if (resolved.status === 'running' || resolved.session.snapshotEvents?.().some(event => ['turn/start', 'user/message', 'request/header'].includes(event.type))) throw new Error('Partial session already has activity; inspect it before retrying creation')
      let agent = resolved
      if (typeof agent.selectModel !== 'function') {
        const factory = this.service('kodeNativeFactory')
        if (!factory?.promote) throw new Error('Kode Agent executor is not ready')
        agent = await factory.promote(agent, route)
      }
      agent.selectModel(route)
      if (selection.fast !== undefined && selectedModel.fastCapability.transport !== 'model-variant') appendFastPreference(agent.session, route, selection.fast, selectedModel.fastCapability.tier)
      await runtime.profiles.bind(agent.id, profile.id); runtime.recordBinding(agent, profile)
      await agent.ctx.sessions.flush(agent.session)
      await this.publish()
      let publicId = this.ids.get(created.sessionId)
      if (!Number.isSafeInteger(publicId) || publicId <= 0) {
        const row = (await controller.list({})).items.find(row => row.sessionId === created.sessionId)
        if (!row) throw new Error('Created session is no longer available')
        // Reserve routing before the first prompt without exposing a blank
        // conversation. Normal content publication revives this retired DTO.
        const dto = { ...this.projection(row, agent), status: 'exited' }
        const mapped = await this.call('publish', { runtime: this.runtime, boot_id: this.bootId, sessions: [{ session_id: created.sessionId, dto, events: [] }] })
        publicId = mapped.sessions?.find(row => row.session_id === created.sessionId)?.id
        if (!Number.isSafeInteger(publicId) || publicId <= 0) throw new Error('Backend did not allocate the created session routing identity')
        this.ids.set(created.sessionId, publicId)
        this.known.set(created.sessionId, dto)
      }
      return { id: publicId, runtime_session_id: created.sessionId }
    }
    if (kind === 'bot_run') {
      const { runBotForWatch } = await import('./bots-api.js')
      const sessionId = await runBotForWatch(this.ctx, this.backend, payload, id)
      // Kode follows the run by its routing id; wait for the first publication.
      for (let attempt = 0; attempt < 40 && !this.ids.get(sessionId); attempt++) {
        await this.publish()
        if (!this.ids.get(sessionId)) await new Promise(resolve => setTimeout(resolve, 250))
      }
      const publicId = this.ids.get(sessionId)
      if (!Number.isSafeInteger(publicId) || publicId <= 0) throw new Error('Run session was not published')
      return { id: publicId, runtime_session_id: sessionId }
    }
    if (kind === 'bot_report') {
      if (typeof payload.session_id !== 'string' || !payload.session_id.trim()) throw new Error('Bot main session identity required')
      if (typeof payload.text !== 'string' || !payload.text.trim()) throw new Error('Report text required')
      return controller.prompt({ sessionId: payload.session_id, requestId: id, mode: 'queue', content: [{ type: 'text', text: payload.text }] }, this.stop.signal)
    }
    if (kind === 'import_session') {
      // Kode GUI hands over a native session it has just stopped running in a
      // PTY; it waits until its own projection is gone before asking.
      const tab = { backend_key: payload.backend_key, session_id: payload.session_id, cwd: payload.cwd, title: payload.title, model: payload.model }
      const result = await importSavedSession(this.ctx, this.backend, tab, { fresh: true })
      if (result.sharedSession) throw new Error('This session is still running in another Kode runtime')
      if (!deferPublish) await this.publish()
      return { id: this.ids.get(result.sessionId) ?? null, runtime_session_id: result.sessionId }
    }
    if (!sessionId) throw new Error('Session identity required')
    if (kind === 'input') {
      if (typeof payload.text !== 'string' || !payload.text.trim()) throw new Error('Message must contain text')
      const accepted = await controller.prompt({ sessionId, requestId: id, mode: 'queue', content: [{ type: 'text', text: payload.text }] }, this.stop.signal)
      this.coldStamps.delete(sessionId)
      return accepted
    }
    if (kind === 'interrupt') return controller.cancel({ sessionId })
    if (kind === 'delete') {
      const binding = runtime?.profiles?.binding?.(sessionId)
      const cwd = binding?.profile?.type === 'cursor' && binding.threadId
        ? (this.service('agents')?.get(sessionId)?.session.header.cwd
          ?? (await controller?.list?.({}))?.items?.find(row => row.sessionId === sessionId)?.cwd)
        : null
      await this.service('workspaceRegistry').archiveSession(sessionId, { stopActivity: true })
      // An archived session must not keep its CLI writing the native thread:
      // Kode may resume that thread in a PTY right after.
      await this.service('kodeNativeFactory')?.release?.(sessionId)
      if (binding?.profile?.type === 'cursor' && binding.threadId && cwd) {
        await ensureCursorCliChat(binding.threadId, cwd, { ...process.env, ...binding.profile.env }).catch(() => {})
      }
      if (!deferPublish) await this.publish()
      return { accepted: true }
    }
    if (kind === 'answer' || kind === 'plan_response') return this.answer(sessionId, payload, kind)
    const { agent, error } = await controller.resolveAgent(sessionId)
    if (error) throw new Error(error.message)
    if (kind === 'model') {
      const profile = runtime.profiles.binding(sessionId)?.profile
      if (!profile) throw new Error('Session Agent configuration unavailable')
      const result = agent.selectModel({ provider: profileRoute(profile.id), model: payload.model })
      await agent.ctx.sessions.flush(agent.session); return result
    }
    if (kind === 'mode') {
      const service = this.service('permissionPresets')
      if (!service?.names.includes(payload.mode)) throw new Error('Unsupported permission preset on this Host')
      service.set(agent.session, payload.mode)
      await agent.ctx.sessions.flush(agent.session)
      return { accepted: true, mode: service.current(agent.session) }
    }
    throw new Error(`Unsupported dsh session operation: ${kind}`)
  }
  emit(sessionId, event) { const rows = this.extra.get(sessionId) ?? []; this.extra.set(sessionId, [...rows.filter(prior => !(event.payload.streaming && prior.payload.streaming && prior.payload.id === event.payload.id)), event]) }
  answer(sessionId, payload, kind) {
    const requestId = payload.request_id ?? payload.question_id ?? payload.plan_id
    const request = this.pending.get(requestId)
    if (!request || request.sessionId !== sessionId) throw new Error('This interaction has already settled or belongs to a different session')
    return request.answer(payload, kind)
  }
  async settleOne(id, result) {
    this.results.set(id, result)
    await this.call('settle', { runtime: this.runtime, boot_id: this.bootId, id, result })
    this.results.delete(id)
  }
  async claimCommands() {
    const base = { runtime: this.runtime, boot_id: this.bootId }
    if (!this.longPoll) return (await this.call('claim', base)).commands
    try {
      return (await this.call('claim', { ...base, wait_ms: this.intervalMs })).commands
    } catch (error) {
      if (!/wait_ms/.test(error.message)) throw error
      this.longPoll = false
      return (await this.call('claim', base)).commands
    }
  }
  async tick() {
    if (!this.known) await this.publish()
    if (Date.now() - (this.lastPolicyCheck ?? 0) > 5000) {
      const [cloud, directory] = await Promise.all([this.backend.call('/api/v1/messaging/cloud/status', undefined, this.stop.signal), this.backend.call(PREFIX + 'sessions', undefined, this.stop.signal)])
      this.mobileEnabled = cloud.sync_enabled === true && cloud.binding_count > 0; this.guiEnabled = directory.runtimes?.gui === true; this.lastPolicyCheck = Date.now()
    }
    // Commands first: Kode waits on them during mode switches and must not
    // queue behind a publication pass. A lost settlement response is retried
    // without re-executing the command.
    for (const [id, result] of [...this.results]) { await this.call('settle', { runtime: this.runtime, boot_id: this.bootId, id, result }); this.results.delete(id) }
    const started = Date.now()
    const commands = await this.claimCommands()
    // Group consecutive batch-parallelizable commands of the same kind
    // (`import_session` or `delete`) so a mode switch runs them concurrently
    // and publishes once per batch while preserving strict order across kinds.
    const runs = []
    for (const command of commands) {
      const batchable = command.kind === 'import_session' || command.kind === 'delete'
      const prev = runs.at(-1)
      if (batchable && prev && prev.kind === command.kind) prev.items.push(command)
      else runs.push({ kind: batchable ? command.kind : null, items: [command] })
    }
    let lastPublished = false
    for (const run of runs) {
      if (run.kind && run.items.length > 1) {
        const outcomes = await Promise.all(run.items.map(async command => {
          try { return { command, result: { value: await this.execute(command, { deferPublish: true }) } } }
          catch (error) { return { command, result: { error: error.message } } }
        }))
        if (outcomes.some(entry => 'value' in entry.result)) {
          try {
            await this.publish()
            if (run.kind === 'import_session') {
              for (const entry of outcomes) {
                if ('value' in entry.result) entry.result.value.id = this.ids.get(entry.result.value.runtime_session_id) ?? null
              }
            }
          } catch (error) {
            for (const entry of outcomes) {
              if ('value' in entry.result) entry.result = { error: error.message }
            }
          }
          lastPublished = true
        } else {
          lastPublished = false
        }
        await Promise.all(outcomes.map(({ command, result }) => this.settleOne(command.id, result)))
      } else {
        for (const command of run.items) {
          let result
          try { result = { value: await this.execute(command) } } catch (error) { result = { error: error.message } }
          await this.settleOne(command.id, result)
          lastPublished = command.kind === 'import_session' || command.kind === 'delete' || command.kind === 'create_session'
        }
      }
    }
    if (!commands.length || !lastPublished) await this.publish()
    return { hadCommands: commands.length > 0, elapsed: Date.now() - started }
  }
  start() {
    this.heartbeat = setInterval(() => { if (!this.heartbeatPending) this.heartbeatPending = this.call('publish', { runtime: this.runtime, boot_id: this.bootId, sessions: [] }).catch(error => { if (!this.stop.signal.aborted) this.ctx.logger.warn('Kode runtime heartbeat: %s', error.message) }).finally(() => { this.heartbeatPending = null }) }, 4000)
    this.task = (async () => {
      while (!this.stop.signal.aborted) {
        let delay = this.intervalMs
        try {
          const outcome = await this.tick()
          delay = outcome?.hadCommands ? 0 : Math.max(0, this.intervalMs - (outcome?.elapsed ?? 0))
        } catch (error) { if (!this.stop.signal.aborted) this.ctx.logger.warn('Kode runtime synchronization: %s', error.message) }
        if (delay > 0 && !this.stop.signal.aborted) {
          await new Promise(resolve => { const timer = setTimeout(done, delay); const signal = this.stop.signal; function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }; signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done() })
        }
      }
    })()
    return this
  }
  async close() { clearInterval(this.heartbeat); this.stop.abort(); for (const request of new Set(this.pending.values())) request.cancel?.(); await this.task; await this.heartbeatPending; await this.backend.call(PREFIX + 'release', { runtime: this.runtime, boot_id: this.bootId }).catch(() => {}) }
}

export function installRuntimeBridge(ctx, backend, options) {
  const bridge = new RuntimeBridge(ctx, backend, options)
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'start') {
      const index = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message' && event.data.turn === frame.turn && event.data.step === frame.step).length
      bridge.streams.set(frame.attemptId, { sessionId: agent.id, id: `dsh:${agent.id}:${frame.turn}:${frame.step}:${index}`, assembler: new BlockAssembler() })
    } else if (frame.type === 'chunk') {
      const stream = bridge.streams.get(frame.attemptId)
      if (stream) { stream.assembler.push(frame.chunk); bridge.emit(stream.sessionId, { key: `stream:${frame.attemptId}:${frame.revision}`, kind: 'message', payload: { id: stream.id, role: 'assistant', text: textOf(stream.assembler.blocks()), streaming: true } }) }
    } else if (frame.type === 'end') bridge.streams.delete(frame.attemptId)
  }, { global: true })
  bridge.start()
  ctx.provide('kodeRuntimeBridge', bridge)
  const disposeInteractions = installRuntimeInteractions(ctx, bridge)
  ctx.effect(() => disposeInteractions, 'kode.runtime-interactions')
  ctx.effect(() => () => bridge.close(), 'kode.runtime-bridge')
  return bridge
}

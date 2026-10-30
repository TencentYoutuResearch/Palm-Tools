/** Project the existing dsh runtime into Kode. Never run a second Agent loop. */
import { randomUUID, createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { stat } from 'node:fs/promises'
import { profileRoute } from './agent-profiles.js'
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
    return [{ key, kind: 'message', payload: { id: messageId ?? message.id ?? key, role: event.type === 'user/message' ? 'user' : 'assistant', text: textOf(message.content), content: message.content, streaming: false } }]
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
    this.bootId = randomUUID(); this.stop = new AbortController(); this.cursors = new Map(); this.ids = new Map(); this.pending = new Map(); this.extra = new Map(); this.results = new Map(); this.streams = new Map(); this.known = null; this.continued = new Map(); this.answeredContinued = new Set()
  }
  service(name) { return this.ctx.get?.(name) ?? this.ctx[name] }
  call(name, body) { return this.backend.call(PREFIX + name, body, this.stop.signal) }
  projection(row, agent) {
    const selection = agent?.session.requestHeader?.()?.config ?? row.projections?.values?.modelSelection?.lastUsed ?? {}
    const binding = this.service('kodeAgents').profiles.binding(row.sessionId)
    const profile = binding?.profile
    return { runtime_backend_key: profile ? `dsh:${profile.id}` : undefined, ...permissionSnapshot(this.service('permissionPresets'), agent?.session, row), native_thread_id: binding?.threadId, backend_key: this.service('kodeAgents').profiles.sharedState?.desktop_ids?.[profile?.id] ?? profile?.name ?? 'dsh', title: row.projections?.values?.title ?? row.title ?? '未命名会话', model: selection.model ?? profile?.defaultModel ?? '', status: agent?.status === 'running' ? 'busy' : 'idle', cwd: row.cwd ?? agent?.session.header.cwd, session_uuid: row.sessionId, tokens: { total: 0, input: 0, output: 0, cached: 0 } }
  }
  async publish() {
    const controller = this.service('sessionController'), { items } = await controller.list({}, this.stop.signal)
    if (!this.known) {
      const saved = await this.backend.call(PREFIX + 'sessions', undefined, this.stop.signal)
      this.known = new Map(saved.sessions.filter(row => row.runtime === this.runtime).map(row => [row.runtime_session_id, row]))
    }
    const listed = new Set(items.map(row => row.sessionId))
    for (const [sessionId, dto] of this.known) if (!listed.has(sessionId) && dto.status !== 'exited') {
      await this.call('publish', { runtime: this.runtime, boot_id: this.bootId, sessions: [{ session_id: sessionId, dto: { ...dto, status: 'exited' }, events: [] }] })
      this.known.set(sessionId, { ...dto, status: 'exited' })
    }
    for (const row of items) {
      this.stop.signal.throwIfAborted()
      const agent = this.service('agents').get(row.sessionId)
      const observed = agent ? { events: agent.session.snapshotEvents() } : await controller.inspect(row.sessionId, this.stop.signal)
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
  }
  async execute(command) {
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
      const registry = this.service('workspaceRegistry')
      const workspace = await registry.resolveByPath(payload.cwd) ?? await registry.create(payload.cwd)
      // The backend request id also names the session. An uncertain creation is
      // inspected/reused, never replaced by a fresh CLI thread.
      const created = await controller.create({ sessionId: `mobile-${createHash('sha256').update(id).digest('hex')}`, workspaceId: workspace.id, agentPreset: 'kode-native' })
      const { agent, error } = await controller.resolveAgent(created.sessionId)
      if (error) throw new Error(error.message)
      await runtime.profiles.bind(agent.id, profile.id); runtime.recordBinding(agent, profile)
      const models = await runtime.adapter.listModels(profileRoute(profile.id), profile)
      const model = payload.model || profile.defaultModel || models.find(model => model.isDefault)?.id || models[0]?.id
      if (!model) throw new Error('Agent returned no models')
      agent.selectModel({ provider: profileRoute(profile.id), model })
      await agent.ctx.sessions.flush(agent.session)
      await this.publish()
      const snapshots = await this.backend.call(PREFIX + 'sessions', undefined, this.stop.signal)
      return snapshots.sessions.find(row => row.id === this.ids.get(created.sessionId))
    }
    if (!sessionId) throw new Error('Session identity required')
    if (kind === 'input') {
      if (typeof payload.text !== 'string' || !payload.text.trim()) throw new Error('Message must contain text')
      return controller.prompt({ sessionId, requestId: id, mode: 'queue', content: [{ type: 'text', text: payload.text }] }, this.stop.signal)
    }
    if (kind === 'interrupt') return controller.cancel({ sessionId })
    if (kind === 'delete') { await this.service('workspaceRegistry').archiveSession(sessionId, { stopActivity: true }); await this.publish(); return { accepted: true } }
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
  async tick() {
    if (Date.now() - (this.lastPolicyCheck ?? 0) > 5000) {
      const [cloud, directory] = await Promise.all([this.backend.call('/api/v1/messaging/cloud/status', undefined, this.stop.signal), this.backend.call(PREFIX + 'sessions', undefined, this.stop.signal)])
      this.mobileEnabled = cloud.sync_enabled === true && cloud.binding_count > 0; this.guiEnabled = directory.runtimes?.gui === true; this.lastPolicyCheck = Date.now()
    }
    await this.publish()
    // A lost settlement response is retried without re-executing the command.
    for (const [id, result] of this.results) { await this.call('settle', { runtime: this.runtime, boot_id: this.bootId, id, result }); this.results.delete(id) }
    const { commands } = await this.call('claim', { runtime: this.runtime, boot_id: this.bootId })
    for (const command of commands) {
      let result
      try { result = { value: await this.execute(command) } } catch (error) { result = { error: error.message } }
      this.results.set(command.id, result)
      await this.call('settle', { runtime: this.runtime, boot_id: this.bootId, id: command.id, result }); this.results.delete(command.id)
    }
  }
  start() {
    this.heartbeat = setInterval(() => { if (!this.heartbeatPending) this.heartbeatPending = this.call('publish', { runtime: this.runtime, boot_id: this.bootId, sessions: [] }).catch(error => { if (!this.stop.signal.aborted) this.ctx.logger.warn('Kode runtime heartbeat: %s', error.message) }).finally(() => { this.heartbeatPending = null }) }, 4000)
    this.task = (async () => {
      while (!this.stop.signal.aborted) {
        try { await this.tick() } catch (error) { if (!this.stop.signal.aborted) this.ctx.logger.warn('Kode runtime synchronization: %s', error.message) }
        await new Promise(resolve => { const timer = setTimeout(done, this.intervalMs); const signal = this.stop.signal; function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }; signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done() })
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

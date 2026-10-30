/** Native CLI protocols and model discovery; the Kode driver owns inbox scheduling and the shell renders canonical events. */
import { randomUUID } from 'node:crypto'
import { AgentProfiles, profileRevision, profileRoute } from './agent-profiles.js'
import { createNativeSession } from './native-session.js'
import { agentDefaults, builtinProfiles } from './agent-defaults.js'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { BackendAgentProfiles } from './backend-state.js'
import { nativeToolDescriptor } from './native-tools.js'
import { mountNativeCommands } from './native-commands.js'
import { humanInput, terminalOnlyCommands } from './native-commands.js'
import { pendingShellContext } from './native-shell.js'
import { classifyCommands } from './command-skills.js'
import { nativeInput } from './native-input.js'
import { SessionAppearance } from './session-appearance.js'

export { profileRoute } from './agent-profiles.js'
export { nativeToolDescriptor } from './native-tools.js'
export class AgentRuntimeAdapter {
  constructor(ctx, profiles, { recordNative = (session, data) => appendPluginRecord(session, 'plugin:kode/native-event', data), resolveProfile = async profile => profile, onThread = async () => {} } = {}) {
    this.ctx = ctx; this.profiles = profiles; this.live = new Map(); this.busy = new Set(); this.catalogs = new Map(); this.positions = new WeakMap(); this.stop = new AbortController(); this.probes = new Set()
    this.recordNative = recordNative
    this.resolveProfile = resolveProfile
    this.onThread = onThread
    ctx.on?.('session/event', (session, event) => {
      if (event.type === 'step/start') this.positions.set(session, { turn: event.data.turn, step: event.data.step })
      if (event.type === 'step/end' || event.type === 'turn/end') this.positions.delete(session)
    })
  }
  profile(provider) {
    const id = provider.slice('kode-agent-'.length)
    const profile = this.profiles.list().find(p => p.id === id) ?? Object.values(this.profiles.bindings).find(b => b.profile.id === id)?.profile
    if (!profile) throw new Error('unknown Agent configuration')
    return profile
  }
  providerInfo(provider) { return { id: provider, name: this.profile(provider).name } }
  providerRetryPolicy() { return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 } }
  imageRequestPricing() {}
  imageRequestTarget(_provider, _model, image) { return { width: image.width, height: image.height, maxBytes: image.bytes } }
  async resolveModel(provider, model) {
    const profile = this.profile(provider), models = await this.listModels(provider)
    const listed = models.find(row => row.id === model)
    // Native harnesses own model routing (including aliases and image tools).
    // Missing/stale outer model metadata must not block a supported input type.
    const acceptsImages = profile.type === 'codex' || profile.protocol === 'codex' || profile.type === 'claude' || models.some(row => row.inputModalities?.includes('image'))
    return { ...(listed ?? { provider, id: model, name: model }), inputModalities: acceptsImages ? ['text', 'image'] : listed?.inputModalities ?? ['text'] }
  }
  async prepareCall(provider, model, signal) { return { model: await this.resolveModel(provider, model, signal), stream: options => this.stream(options) } }
  invalidateModels(provider) { for (const key of this.catalogs.keys()) if (key === provider || key.startsWith(`${provider}:`)) this.catalogs.delete(key) }
  async capabilities(provider, profileOverride, cwd = process.cwd(), modelHint) {
    this.stop.signal.throwIfAborted()
    const profile = profileOverride ?? this.profile(provider)
    if (profile.type === 'codex' || profile.protocol === 'codex') modelHint = undefined
    const key = `${provider}:${profileRevision(profile)}:${cwd}:${modelHint ?? ''}`
    if (!this.catalogs.has(key)) {
      const task = (async () => {
        const session = await createNativeSession(await this.resolveProfile(profile), cwd)
        this.probes.add(session)
        try {
          const models = await session.listModels(AbortSignal.any([this.stop.signal, AbortSignal.timeout(45000)]), { model: modelHint })
          const commands = await classifyCommands(session.commands ?? [], profile, cwd)
          if (profile.type === 'codex' || profile.protocol === 'codex') {
            try {
              const { skills } = await session.listSkills(AbortSignal.any([this.stop.signal, AbortSignal.timeout(20000)]))
              commands.push(...skills.map(skill => ({ name: skill.name, description: skill.description, kind: 'skill', input: { hint: '技能参数或任务' } })))
            } catch (error) { this.stop.signal.throwIfAborted(); this.ctx.logger?.warn('Codex skill discovery failed: %s', error.message) }
          }
          return { models: models.filter(m => (m.model ?? m.id) !== 'default').map(m => ({ provider, id: m.model ?? m.id, name: m.displayName ?? m.model ?? m.id, isDefault: Boolean(m.isDefault), inputModalities: profile.type === 'codex' || profile.protocol === 'codex' || profile.type === 'claude' ? ['text', 'image'] : m.inputModalities ?? ['text'], reasoningEfforts: m.reasoningEfforts ?? (m.supportedReasoningEfforts ?? []).map(effort => ({ id: effort.reasoningEffort, name: effort.reasoningEffort, description: effort.description })), ...(m.defaultReasoningEffort ? { defaultReasoningEffort: m.defaultReasoningEffort } : {}) })), commands, modes: session.state?.modes?.availableModes ?? [] }
        } finally { this.probes.delete(session); await session.close() }
      })().catch(error => { if (this.catalogs.get(key) === task) this.catalogs.delete(key); throw error })
      this.catalogs.set(key, task)
    }
    return this.catalogs.get(key)
  }
  async listModels(provider, profile, modelHint) { return (await this.capabilities(provider, profile, process.cwd(), modelHint)).models }
  async listCommands(provider, profile) { return (await this.capabilities(provider, profile)).commands }
  async listSkills(provider, profile, cwd) {
    if (profile.type !== 'codex' && profile.protocol !== 'codex') return { skills: [], errors: [] }
    const session = await createNativeSession(await this.resolveProfile(profile), cwd ?? process.cwd())
    this.probes.add(session)
    try { return await session.listSkills(AbortSignal.any([this.stop.signal, AbortSignal.timeout(20000)])) }
    finally { this.probes.delete(session); await session.close() }
  }
  boundary(agent) {
    const observed = this.positions.get(agent.session)
    if (observed) return observed
    const position = this.ctx.sessionProjections.stateOf(agent.session, 'kodeTurnBoundary') ?? this.ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')
    if (position?.lastStepBoundary?.kind !== 'start') throw new Error('external Agent call requires an open dsh step')
    return { turn: position.lastTurn, step: position.lastStepBoundary.step ?? 1 }
  }
  logCall(agent, callId, name, args) {
    this.stepPreparers?.get(agent.id)?.()
    const boundary = this.boundary(agent)
    const argumentsJson = JSON.stringify(args ?? {})
    const route = agent.session.requestHeader?.()?.config ?? { provider: profileRoute(this.profiles.binding(agent.id).profile.id), model: 'default' }
    // dsh's durable reader requires assistant advertisement before tool/call.
    // These calls are already owned by the native runtime; the outer loop's
    // returned stream contains only answer text and never executes them again.
    agent.session.append('assistant/message', { ...boundary, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: route.provider, model: route.model }, content: [{ type: 'tool-call', id: callId, name, arguments: argumentsJson }] }, stream: [] }, { surfaceOp: 'append' })
    agent.session.append('tool/call', { ...boundary, callId, name, arguments: argumentsJson })
  }
  logResult(agent, callId, content, isError = false) {
    agent.session.append('tool/result', { ...this.boundary(agent), message: { id: randomUUID(), role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content, isError } }, { surfaceOp: 'append' })
  }
  async createRuntime(agent, binding, tools, signal) {
    const nativeCalls = new Set()
    const epoch = randomUUID()
    const callIdentity = (turnId, itemId) => `kode:${epoch}:${turnId}:${itemId}`
    const autoCompact = binding.profile.type === 'claude' ? agent.session.snapshotEvents?.().findLast(event => event.type === 'plugin:kode/autocompact') : undefined
    const resolved = await this.resolveProfile(binding.profile, agent)
    const runtime = await createNativeSession({ ...resolved, ...(autoCompact ? { autoCompactEnabled: autoCompact.data.enabled } : {}) }, agent.session.header.cwd ?? process.cwd(), {
      policy: () => agent.ctx.get('sandboxPolicy')?.resolve({ session: agent.session }) ?? { mode: 'read-only' },
      approvalPolicy: () => agent.ctx.get('approval')?.effectivePolicy?.(agent.session) ?? 'ask',
      mode: () => {
        const row = agent.session.snapshotEvents?.().findLast(event => event.type === 'plugin:kode/native-mode')?.data
        return row && row.policy === agent.ctx.get('sandboxPolicy')?.resolve({ session: agent.session })?.mode ? row.mode : undefined
      },
      commands: commands => { void classifyCommands(commands, binding.profile, agent.session.header.cwd ?? process.cwd()).then(rows => { if (!this.stop.signal.aborted) this.onCommands?.(agent, rows) }).catch(error => this.ctx.logger?.warn('Native command classification failed: %s', error.message)) },
      continuation: () => queueMicrotask(() => agent.wake?.()),
      collaborationMode: () => agent.session.snapshotEvents?.().findLast(event => event.type === 'plugin:kode/collaboration-mode')?.data.enabled,
      tool: async (request, signal) => {
        if (!tools.some(t => t.name === request.tool)) throw new Error('native Agent requested an unadvertised dsh tool')
        const callId = callIdentity(request.turnId, request.callId)
        this.logCall(agent, callId, request.tool, request.arguments)
        nativeCalls.add(callId)
        const result = await agent.ctx.tools.execute({ callId, name: request.tool, arguments: request.arguments, agent, signal })
        signal.throwIfAborted()
        this.logResult(agent, callId, result.content, result.isError)
        nativeCalls.delete(callId)
        return { success: !result.isError, contentItems: result.content.filter(c => c.type === 'text').map(c => ({ type: 'inputText', text: c.text })) }
      },
      approve: async (method, request, signal) => {
        const callId = callIdentity(request.turnId, request.itemId)
        if (!nativeCalls.has(callId)) { this.logCall(agent, callId, 'kode_native_operation', request); nativeCalls.add(callId) }
        const approval = agent.ctx.get('approval')
        if (!approval) return false
        // The native CLI may still ask even when the user explicitly chose
        // full access without prompts. Grant only this operation in that mode;
        // `never` under a confined mode continues to mean deny escalation.
        const policy = agent.ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
        if (policy?.mode === 'danger-full-access' && approval.effectivePolicy?.(agent.session) === 'never') return true
        const decision = await approval.request({ agent, callId, toolName: method.includes('fileChange') ? 'kode_native_file_change' : 'kode_native_command', reason: request.reason ?? request.command ?? 'Native Agent requests permission', signal })
        return decision === 'allowed-once'
      },
      question: async (request, signal) => {
        const questions = agent.ctx.get('userQuestions')
        if (!questions) throw new Error('dsh user question service is unavailable')
        const response = await questions.ask({ agent, signal, questions: request.questions.map(q => ({ id: q.id, question: q.question, ...(q.header ? { header: q.header } : {}), ...(q.multiSelect ? { multiSelect: true } : {}), ...(q.options ? { options: q.options.map(o => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })) } : {}) })) })
        return { answers: Object.fromEntries(response.answers.map(a => [a.id, { answers: [...a.selected, ...(a.custom ? [a.custom] : [])], ...(request.structured ? { selected: a.selected, ...(a.custom ? { custom: a.custom } : {}) } : {}) }])) }
      },
    })
    runtime.nativeCalls = nativeCalls
    runtime.autoCompactRevision = autoCompact?.seq ?? -1
    runtime.callIdentity = callIdentity
    try {
      const threadId = await runtime.open(binding, tools, signal)
      await this.profiles.patchBinding(agent.id, { threadId, ...(binding.threadId ? {} : { nativeToolNames: tools.map(tool => tool.name) }) })
      await this.onThread(agent)
      return runtime
    } catch (error) { await runtime.close(); throw error }
  }
  async *stream(options) {
    this.stop.signal.throwIfAborted()
    const signal = options.signal ? AbortSignal.any([options.signal, this.stop.signal]) : this.stop.signal
    if (!options.sessionId || options.purpose) throw new Error('external Agent routes require an ordinary dsh conversation')
    const agent = this.ctx.agents.get(options.sessionId)
    if (!agent) throw new Error('dsh conversation is not active')
    if (this.busy.has(agent.id)) throw new Error('Agent conversation already has an active native request')
    this.busy.add(agent.id)
    this.stepPreparers ??= new Map()
    if (options.prepareStep) this.stepPreparers.set(agent.id, options.prepareStep)
    let runtime, completed = false
    try {
      const profile = this.profile(options.provider)
      const binding = await this.profiles.bind(agent.id, profile.id)
      const seen = new Set(binding.seenInputs)
      const messages = options.messages.filter(m => m.role === 'user' && m.id && !seen.has(m.id))
      if (!messages.length && !options.nativeContinuation) throw new Error('No new user input; refusing to replay a native Agent turn')
      const human = messages.length === 1 ? humanInput(messages[0]) : undefined
      const match = human && /^\/([a-z][a-z0-9_:-]*)(?:\s|$)/.exec(human)
      const command = match ? { name: match[1], input: human.slice(match[0].length).trim() } : undefined
      const context = command || options.nativeContinuation ? [] : pendingShellContext(agent.session)
      const input = await nativeInput([...context, ...messages], { attachments: (agent.ctx.get ? agent.ctx.get('attachments') : agent.ctx.attachments) ?? (this.ctx.get ? this.ctx.get('attachments') : this.ctx.attachments), codex: profile.type === 'codex' || profile.protocol === 'codex', signal })
      const tools = options.tools ?? []
      runtime = this.live.get(agent.id)
      const autoCompactRevision = profile.type === 'claude' ? agent.session.snapshotEvents?.().findLast(event => event.type === 'plugin:kode/autocompact')?.seq ?? -1 : -1
      if (runtime && runtime.autoCompactRevision !== autoCompactRevision) { await runtime.close(); this.live.delete(agent.id); runtime = undefined }
      if (runtime?.rpc.closed) { this.live.delete(agent.id); runtime = undefined }
      if (!runtime && options.nativeContinuation) throw new Error('原生目标连接已关闭，不能重放继续事件。')
      if (!runtime) { runtime = await this.createRuntime(agent, binding, tools, signal); this.live.set(agent.id, runtime) }
      const skillNames = messages.flatMap(message => [...(['user', 'human'].includes(message.source?.kind) ? message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '').matchAll(/(?:^|\s)\$([a-zA-Z][a-zA-Z0-9_:-]*)\b/g)].map(match => match[1]))
      if (command?.name === 'resume') throw new Error('请在 dsh 的 /resume 菜单中选择要恢复的原生会话。')
      if (command && terminalOnlyCommands.has(command.name)) throw new Error(`/${command.name} 需要原生 CLI 窗口或切换会话，请使用侧栏的新建会话和 Agent 设置。`)
      // Commit admission before sending. A crash cannot automatically repeat a
      // native turn with potentially irreversible tools; the user may follow up.
      await this.profiles.patchBinding(agent.id, { seenInputs: [...seen, ...messages.map(m => m.id)], inFlight: { inputIds: messages.map(m => m.id), startedAt: Date.now() } })
      if (context.length) appendPluginRecord(agent.session, 'plugin:kode/shell-context-consumed', { ids: context.map(row => row.id) })
      await agent.ctx.parallel('session/flush', agent.session)
      let text = '', reasoning = '', textIndex, reasoningIndex, textItemId, nextIndex = 0
      const streamed = new Set(), reasoningChannels=new Map()
      function* closeSegment() {
        if (reasoningIndex === undefined && textIndex === undefined) return
        if (reasoningIndex !== undefined) yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoning } }
        if (textIndex !== undefined) yield { type: 'block-end', index: textIndex, block: { type: 'text', text } }
        options.onAssistantMessageBoundary?.()
        text = ''; reasoning = ''; textIndex = undefined; reasoningIndex = undefined; textItemId = undefined
        if (options.onAssistantMessageBoundary) nextIndex = 0
      }
      for await (const event of runtime.turn(input, { model: options.model, effort: options.reasoningEffort, signal, command, skillNames, observe: options.nativeContinuation })) {
        const { method, params } = event
        if (method === 'turn/started') options.onNativeTurnReady?.()
        const messageOutput = method === 'item/agentMessage/delta' && params.delta || method === 'item/completed' && params.item?.type === 'agentMessage' && !streamed.has(params.item.id) && params.item.text
        const thoughtOutput = ['item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'].includes(method) && params.delta && (!reasoningChannels.has(params.itemId ?? 'reasoning') || reasoningChannels.get(params.itemId ?? 'reasoning') === method)
        const toolOutput = params.item && ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'imageView', 'collabAgentToolCall'].includes(params.item.type)
        if (messageOutput || thoughtOutput || toolOutput) options.prepareStep?.()
        this.recordNative(agent.session, { ...this.boundary(agent), event })
        if (['item/reasoning/summaryTextDelta','item/reasoning/textDelta'].includes(method) && params.delta) {
          const id=params.itemId ?? 'reasoning'
          if(!reasoningChannels.has(id))reasoningChannels.set(id,method)
          if(reasoningChannels.get(id)===method){
            if (reasoningIndex === undefined) { reasoningIndex = nextIndex++; yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' } }
            reasoning += params.delta; yield { type: 'reasoning-delta', index: reasoningIndex, text: params.delta }
          }
        }
        let delta
        if (method === 'item/agentMessage/delta') { delta = params.delta; streamed.add(params.itemId) }
        if (method === 'item/completed' && params.item?.type === 'agentMessage' && !streamed.has(params.item.id)) delta = params.item.text
        if (delta) {
          const itemId = params.itemId ?? params.item?.id
          if (textIndex !== undefined && itemId && textItemId && itemId !== textItemId) yield* closeSegment()
          if (textIndex === undefined) { textIndex = nextIndex++; yield { type: 'block-start', index: textIndex, blockType: 'text' } }
          textItemId = itemId
          text += delta; yield { type: 'text-delta', index: textIndex, text: delta }
        }
        const item = params?.item
        if (method === 'item/completed' && item?.type === 'agentMessage') yield* closeSegment()
        if (item && ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'imageView', 'collabAgentToolCall'].includes(item.type)) {
          yield* closeSegment()
          const callId = runtime.callIdentity(params.turnId, item.id)
          const descriptor=nativeToolDescriptor(item)
          if (method === 'item/started' && !runtime.nativeCalls.has(callId)) { this.logCall(agent, callId, descriptor.name, descriptor.args); runtime.nativeCalls.add(callId) }
          if (method === 'item/completed') {
            if (!runtime.nativeCalls.has(callId)) this.logCall(agent, callId, descriptor.name, descriptor.args)
            this.logResult(agent, callId, [{ type: 'text', text: item.kind || item.input ? JSON.stringify(item) : item.aggregatedOutput ?? JSON.stringify(item) }], ['failed', 'declined'].includes(item.status))
            runtime.nativeCalls.delete(callId)
          }
        }
      }
      for (const callId of runtime.nativeCalls) this.logResult(agent, callId, [{ type: 'text', text: 'The Agent ended its turn without reporting the operation outcome.' }], true)
      runtime.nativeCalls.clear()
      yield* closeSegment()
      await this.profiles.patchBinding(agent.id, { inFlight: null, lastOutcome: 'completed' })
      completed = true
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      this.busy.delete(agent.id)
      this.stepPreparers.delete(agent.id)
      if (!completed) {
        if (runtime) {
          await runtime.close(); this.live.delete(agent.id)
          for (const callId of runtime.nativeCalls) this.logResult(agent, callId, [{ type: 'text', text: 'Native operation interrupted; its outcome may be uncertain. Inspect the workspace before retrying.' }], true)
          runtime.nativeCalls.clear()
        }
        if (this.profiles.binding(agent.id)?.inFlight) await this.profiles.patchBinding(agent.id, { inFlight: null, lastOutcome: 'uncertain' })
      }
    }
  }
  async closeSession(id) { const runtime = this.live.get(id); this.live.delete(id); await runtime?.close() }
  supportsSteering(agent) {
    const profile = this.profiles.binding(agent.id)?.profile ?? this.profiles.list().find(profile => profileRoute(profile.id) === agent.options?.provider)
    return Boolean(profile && (profile.type === 'codex' || profile.protocol === 'codex') && !this.live.get(agent.id)?.steeringUnsupported)
  }
  canSteer(id) { return this.live.get(id)?.canSteer?.() === true }
  async steer(agent, message, signal, { admit, accepted }) {
    const runtime = this.live.get(agent.id)
    if (!runtime?.canSteer?.()) return { status: 'not-ready' }
    let input = await nativeInput([message], { codex: true, signal, attachments: agent.ctx.get?.('attachments') ?? this.ctx.get?.('attachments') })
    const text = ['user', 'human'].includes(message.source?.kind) ? message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : ''
    const names = [...text.matchAll(/(?:^|\s)\$([a-zA-Z][a-zA-Z0-9_:-]*)\b/g)].map(match => match[1])
    if (names.length) {
      const { skills } = await runtime.listSkills(signal)
      for (const name of new Set(names)) {
        const matches = skills.filter(skill => skill.name === name)
        if (matches.length > 1) throw new Error(`技能 ${name} 对应多个路径。`)
        if (matches.length === 1) input.push({ type: 'skill', name, path: matches[0].path })
      }
    }
    if (!runtime.canSteer() || !await admit()) return { status: 'not-ready' }
    const binding = this.profiles.binding(agent.id)
    try { await this.profiles.patchBinding(agent.id, { seenInputs: [...new Set([...(binding.seenInputs ?? []), message.id])], ...(binding.inFlight ? { inFlight: { ...binding.inFlight, inputIds: [...binding.inFlight.inputIds, message.id] } } : {}) }) }
    catch (error) { return { status: 'rejected', error } }
    try {
      const result = await runtime.steer(input, signal)
      accepted()
      appendPluginRecord(agent.session, 'plugin:kode/steering', { inputId: message.id, status: 'accepted', nativeTurnId: result.turnId })
      await agent.ctx.sessions.flush(agent.session)
      return { status: 'accepted' }
    } catch (error) {
      if (error.rpcRejected) {
        const latest = this.profiles.binding(agent.id)
        await this.profiles.patchBinding(agent.id, { seenInputs: latest.seenInputs.filter(id => id !== message.id), ...(latest.inFlight ? { inFlight: { ...latest.inFlight, inputIds: latest.inFlight.inputIds.filter(id => id !== message.id) } } : {}) })
        return { status: 'rejected', error }
      }
      accepted()
      appendPluginRecord(agent.session, 'plugin:kode/steering', { inputId: message.id, status: 'uncertain' })
      await agent.ctx.sessions.flush(agent.session)
      return { status: 'uncertain', error }
    }
  }
  hasContinuation(id) { return this.live.get(id)?.hasContinuation?.() ?? false }
  async controlGoal(agent, input, signal, selection = {}) {
    const runtime = this.live.get(agent.id)
    if (!runtime?.goal || runtime.rpc.closed) throw new Error('原生会话尚未就绪，请稍后重试 /goal。')
    const result = await runtime.goal(input, signal, { model: selection.model, effort: selection.reasoningEffort })
    appendPluginRecord(agent.session, 'plugin:kode/goal-command', { input, result: result.text })
    await agent.ctx.sessions.flush(agent.session)
    return result.text
  }
  async renameSession(agent, title, signal) {
    const binding = this.profiles.binding(agent.id)
    if (!binding?.threadId || binding.profile.type !== 'codex') return
    const live = this.live.get(agent.id)
    if (live?.rename) return live.rename(title, signal)
    const runtime = await createNativeSession(await this.resolveProfile(binding.profile, agent), agent.session.header.cwd ?? process.cwd())
    this.probes.add(runtime)
    try { await runtime.initialize(signal); runtime.threadId = binding.threadId; await runtime.rename(title, signal) }
    finally { this.probes.delete(runtime); await runtime.close() }
  }
  async closeType(type) { await Promise.all([...this.live.keys()].filter(id => this.profiles.binding(id)?.profile.type === type).map(id => this.closeSession(id))) }
  async close() {
    this.stop.abort(new Error('Agent adapter closed'))
    await Promise.all([...this.live.keys()].map(id => this.closeSession(id)).concat([...this.probes].map(s => s.close())))
    await Promise.allSettled([...this.catalogs.values()])
  }
}

export async function installAgentRuntime(ctx, config) {
  const bindingSchema = z.object({ profileId: z.string(), name: z.string(), type: z.string(), uiChannel: z.string() }).nullable()
  ctx.effect(() => ctx.sessionProjections.register({ key: 'kodeAgent', stateVersion: 1, stateSchema: bindingSchema, init: () => null,
    apply: (state, event) => event.type === 'plugin:kode/agent-binding' ? event.data : state,
    wire: { viewSchema: bindingSchema, view: state => state },
  }), 'kode.agent-binding-projection')
  const profiles = await (config.sharedBackendState && config.backendClient ? new BackendAgentProfiles(config.backendClient, config.agentProfilesFile) : new AgentProfiles(config.agentProfilesFile)).open(config.agentProfiles ?? [])
  if (config.sharedBackendState && config.backendClient) {
    const { importBackendProfiles } = await import('./workbench-import.js')
    await importBackendProfiles(config.backendClient, profiles)
  }
  const types = await agentDefaults()
  await profiles.ensureBuiltins(builtinProfiles(types))
  const runtimes = new Map(Object.entries(types).filter(([key]) => key !== 'dsh'))
  const adapter = new AgentRuntimeAdapter(ctx, profiles, { onThread: async agent => {
    if (config.sharedBackendState && config.backendClient) { const { saveNativeTab } = await import('./workbench-import.js'); await saveNativeTab(config.backendClient, profiles, agent, ctx.get('sessionTitle')?.get(agent.session)?.title ?? '未命名会话') }
  }, resolveProfile: async (profile, agent) => {
    const runtime = runtimes.get(profile.type)
    if (!runtime) throw new Error('此 Agent 的执行插件已拔出。')
    return runtime.nativeProfile ? runtime.nativeProfile(profile, agent) : profile
  } })
  const routes = () => [...new Set([...profiles.list(), ...Object.values(profiles.bindings).map(b => b.profile)].filter(p => runtimes.has(p.type)).map(p => profileRoute(p.id)))]
  let registration
  const refresh = () => {
    adapter.catalogs.clear()
    if (registration) registration.replace(routes())
    else if (routes().length) registration = ctx.llm.registerAdapter(routes(), adapter)
  }
  refresh()
  const service = { profiles, adapter, refresh, commandOwners: new Map(), appearance: config.backendClient ? new SessionAppearance(config.backendClient, profiles, config) : undefined,
    get types() { return Object.fromEntries([...runtimes].map(([id, spec]) => [id, { name: spec.name, executable: spec.executable, available: spec.available }])) },
    hasRuntime: type => runtimes.has(type), driver: type => runtimes.get(type)?.driver,
    channelFor: type => runtimes.get(type)?.uiChannel ?? 'native',
    mountCommands: agent => {
      const selection = agent.options?.provider
      const profile = profiles.binding(agent.id)?.profile ?? profiles.list().find(row => profileRoute(row.id) === selection)
      void mountNativeCommands(agent, service, profile).catch(error => ctx.logger.warn('Native command mount failed: %s', error.message))
    },
    recordBinding: (agent, profile) => {
      appendPluginRecord(agent.session, 'plugin:kode/agent-binding', { profileId: profile.id, name: profile.name, type: profile.type, uiChannel: runtimes.get(profile.type)?.uiChannel ?? 'native' })
      void mountNativeCommands(agent, service, profile).catch(error => ctx.logger.warn('Native command mount failed: %s', error.message))
    },
    registerRuntime(type, spec) {
      if (runtimes.has(type)) throw new Error(`Agent runtime already installed: ${type}`)
      runtimes.set(type, spec)
      refresh()
      ctx.emit('kode/runtimes-changed')
      return async () => {
        if (runtimes.get(type) !== spec) return
        runtimes.delete(type)
        refresh()
        await ctx.parallel('kode/runtime-removed', type)
        ctx.emit('kode/runtimes-changed')
      }
    },
  }
  adapter.onCommands = (agent, commands) => service.commandOwners.get(agent.id)?.update?.(commands)
  ctx.provide('kodeAgents', service)
  ctx.on('agent/disposed', ({ agent }) => { service.commandOwners.delete(agent.id); void adapter.closeSession(agent.id).catch(error => ctx.logger.warn('Kode Agent cleanup failed: %s', error.message)) })
  ctx.effect(() => async () => { registration?.(); await adapter.close(); await profiles.chain }, 'kode.agent-runtimes')
  return service
}

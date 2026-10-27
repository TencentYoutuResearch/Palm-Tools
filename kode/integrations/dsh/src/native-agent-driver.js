/** Native Agent scheduling. No harness prompt assembly or model-request loop. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolCallRecovery } from '@deepseek-ai/dsh-session'
import { AssistantStreamAccumulator, BlockAssembler } from '@deepseek-ai/dsh-llm'
import { humanInput } from './native-commands.js'
import { runHumanShell } from './native-shell.js'

export const boundaryProjection = {
  key: 'turnBoundary', stateVersion: 2,
  stateSchema: z.object({ openTurnStartSeq: z.number().nullable(), lastStepStartSeq: z.number().nullable(), lastStepBoundary: z.object({ kind: z.enum(['start', 'end']), seq: z.number() }).nullable(), lastTurn: z.number() }),
  init: () => ({ openTurnStartSeq: null, lastStepStartSeq: null, lastStepBoundary: null, lastTurn: 0 }),
  apply: (state, event) => {
    if (event.type === 'turn/start') return { ...state, openTurnStartSeq: event.seq, lastTurn: Math.max(state.lastTurn,event.data.turn) }
    if (event.type === 'turn/end') return { ...state, openTurnStartSeq: null }
    if (event.type === 'step/start') return { ...state, lastStepStartSeq: event.seq, lastStepBoundary: { kind: 'start', seq: event.seq } }
    if (event.type === 'step/end') return { ...state, lastStepBoundary: { kind: 'end', seq: event.seq } }
    return state
  },
}
const inboxSchema = z.object({ 'next-turn': z.array(z.any()), 'next-step': z.array(z.any()) })
export const inboxProjection = {
  key: 'inbox', stateVersion: 1, stateSchema: inboxSchema,
  init: () => ({ 'next-turn': [], 'next-step': [] }),
  apply: (state, event) => {
    if (event.type !== 'agent/inbox/spliced') return state
    const { target, start, removedCount = 0, inserted } = event.data
    const rows = [...state[target]]; rows.splice(start, removedCount, ...inserted)
    return { ...state, [target]: rows }
  }, wire: { viewSchema: inboxSchema, view: state => state },
}
class Inbox {
  constructor(agent) { this.agent = agent }
  get state() { return this.agent.ctx.sessionProjections.stateOf(this.agent.session, 'inbox') ?? inboxProjection.init() }
  get nextTurn() { return this.state['next-turn'] }
  get nextStep() { return this.state['next-step'] }
  splice(target, start, count, inserted, canceled = false) {
    const rows = this.state[target], index = start < 0 ? Math.max(0, rows.length + start) : Math.min(start, rows.length)
    const removed = rows.slice(index, index + count)
    const event = this.agent.session.append('agent/inbox/spliced', { target, start: index, removedCount: removed.length, inserted, ...(canceled ? { outcome: 'canceled' } : {}) })
    for (const message of removed) if (canceled) this.agent.events.emit('agent/inbox/discarded', { message })
    for (const message of event.data.inserted) this.agent.events.emit('agent/inbox/inserted', { message })
    return removed
  }
  append(target, message) { this.splice(target, this.state[target].length, 0, [message]) }
  prepend(target, message) { this.splice(target, 0, 0, [message]) }
  replace(id, message) { for (const target of ['next-turn', 'next-step']) { const index = this.state[target].findIndex(row => row.id === id); if (index >= 0) { this.splice(target, index, 1, [message]); return true } } return false }
  remove(id) { for (const target of ['next-turn', 'next-step']) { const index = this.state[target].findIndex(row => row.id === id); if (index >= 0) { this.splice(target, index, 1, [], true); return true } } return false }
  clear() { for (const target of ['next-step', 'next-turn']) this.splice(target, 0, this.state[target].length, [], true) }
  claim(turn) {
    const messages = [...this.splice('next-step', 0, this.nextStep.length, []), ...this.splice('next-turn', 0, 1, [])]
    for (const message of messages) this.agent.events.emit('agent/inbox/claimed', { message, turn })
    return messages
  }
}
export class NativeAgentDriver {
  constructor(ctx, id, options, session, runtime) {
    this.id = id; this.options = options; this.session = session; this.runtime = runtime
    this.scope = createScope(ctx, this); this.ctx = this.scope.ctx; this.events = agentEvents(ctx, this)
    this.inbox = new Inbox(this); this.status = 'idle'; this.activity = Promise.resolve(); this.ready = false; this.disposed = false; this.revision = 0
    this.turn = ctx.sessionProjections.stateOf(session, 'turnBoundary')?.lastTurn ?? 0
  }
  setStatus(status) { if (this.status !== status) { this.status = status; this.events.emit('agent/status', { status }) } }
  selectModel({provider,model,reasoningEffort}) {
    if(!provider?.startsWith('kode-agent-')||typeof model!=='string'||!model)throw new Error('Select a native Agent model')
    const selected={provider,model,...(reasoningEffort?{reasoningEffort}:{})}
    this.session.append('model/selection',selected)
    this.options={...selected}
    return{selected}
  }
  send(message, target, wakeup) { if (this.disposed) throw new Error('Agent runtime has been unplugged'); this.inbox.append(target, message); if (wakeup) { this.parked = false; this.wake() } }
  followup(message) { this.send(message, 'next-turn', true) }
  steer(message) { this.send(message, 'next-step', true) }
  inject(message) { this.send(message, 'next-step', false) }
  cancel(cause, options = {}) { if (!options.keepInbox) this.inbox.clear(); this.abort?.abort(cause) }
  async whenIdle() { let pending; do { await (pending = this.activity) } while (pending !== this.activity) }
  async runMaintenance(job) {
    if (this.status !== 'idle' || this.maintenance) throw new Error('Agent already has active work')
    this.maintenance = true; this.abort = new AbortController()
    const operation = Promise.resolve().then(() => job(this.abort.signal))
    this.activity = operation.catch(() => {})
    try { return await operation } finally { this.maintenance = false; this.wake() }
  }
  start() { this.ready = true; this.wake() }
  wake() {
    if (!this.ready || this.disposed || this.parked || this.maintenance || this.status === 'running' || !(this.inbox.nextTurn.length || this.inbox.nextStep.length)) return
    this.setStatus('running'); this.abort = new AbortController()
    this.activity = this.ctx.agents.withInitiator(this, () => this.drive(this.abort.signal)).catch(error => { this.parked = true; this.lastError = error; this.ctx.logger?.warn('Kode Agent could not start: %s', error.stack ?? error.message); this.events.emit('agent/error', { turn: this.turn, step: 1, error }) }).finally(() => { this.setStatus('idle'); this.wake() })
  }
  async drive(signal) {
    let binding = this.runtime.profiles?.binding(this.id)
    if (!binding && this.runtime.profiles) {
      const state = this.ctx.sessionProjections.stateOf(this.session, 'modelSelection')
      const selection = state?.next ?? state?.lastUsed ?? this.options
      const profile = this.runtime.profiles.list().find(profile => selection.provider === `kode-agent-${profile.id}`)
        ?? (!selection.provider?.startsWith('kode-agent-') && this.runtime.hasRuntime('dsh') ? this.runtime.profiles.list().find(profile => profile.type === 'dsh') : undefined)
      if (profile) { binding = await this.runtime.profiles.bind(this.id, profile.id); this.runtime.recordBinding(this, profile) }
    }
    while (!signal.aborted && !this.disposed && (this.inbox.nextTurn.length || this.inbox.nextStep.length)) {
      // A driver may be attached before an owner imports its historical seed.
      // Allocate from the current log projection, not the constructor snapshot.
      this.turn = Math.max(this.turn, this.ctx.sessionProjections.stateOf(this.session, 'turnBoundary')?.lastTurn ?? 0)
      const turn = ++this.turn, step = 1
      this.session.append('turn/start', { turn })
      let reason = { kind: 'completed' }, opened = false
      const recovery = new ToolCallRecovery()
      const stop = this.ctx.on('session/event', (session, event) => { if (session === this.session) recovery.observe(event) })
      try {
        const messages = this.inbox.claim(turn)
        if (!messages.length) continue
        const state = this.ctx.sessionProjections.stateOf(this.session, 'modelSelection')
        const selection = state?.pending ?? state?.next ?? state?.lastUsed ?? this.options
        if (!selection.provider?.startsWith('kode-agent-')) throw new Error('Select an installed Agent before sending a message')
        const human = messages.length === 1 ? humanInput(messages[0]) : undefined
        if (human?.startsWith('!')) {
          this.session.append('step/start', { turn, step }); opened = true
          for (const message of messages) this.session.append('user/message', message, { surfaceOp: 'append' })
          await runHumanShell(this, human.slice(1), signal)
          continue
        }
        const tools = this.ctx.tools.schemas(this)
        const previous = this.session.requestHeader()
        this.session.append('request/header', { header: { config: selection, ...(tools.length ? { tools } : {}) }, reason: previous ? 'resume' : 'initial' })
        this.session.append('step/start', { turn, step }); opened = true
        for (const message of messages) this.session.append('user/message', message, { surfaceOp: 'append' })
        const stream = new AssistantStreamAccumulator(), assembler = new BlockAssembler(); let chunkCount = 0
        const attemptId = `kode-native:${randomUUID()}`
        this.events.emit('agent/assistant-stream', { frame: { type: 'start', attemptId, revision: ++this.revision, turn, step } })
        let settlement
        try {
          for await (const chunk of this.runtime.adapter.stream({ ...selection, sessionId: this.id, messages, tools, signal })) {
            const time = Date.now(), index = chunkCount++
            stream.push({ time, chunk })
            assembler.push(chunk)
            this.events.emit('agent/assistant-stream', { frame: { type: 'chunk', attemptId, revision: ++this.revision, index, time, chunk } })
          }
          const content = assembler.blocks()
          if (content.length) settlement = this.session.append('assistant/message', { turn, step, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: selection.provider, model: selection.model }, content }, stream: [...stream.snapshot()] }, { surfaceOp: 'append' })
        } catch (error) {
          const content = assembler.interruptedBlocks()
          if (content.length) settlement = this.session.append('assistant/message', { turn, step, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: selection.provider, model: selection.model }, content }, interrupted: true, stream: [...stream.snapshot()] }, { surfaceOp: 'append' })
          throw error
        } finally {
          this.events.emit('agent/assistant-stream', { frame: { type: 'end', attemptId, revision: ++this.revision, index: chunkCount, outcome: settlement ? { kind: 'committed', eventType: 'assistant/message', seq: settlement.seq } : { kind: 'abandoned' } } })
        }
      } catch (error) {
        reason = signal.aborted ? { kind: 'aborted', reason: signal.reason?.kind ? signal.reason : { kind: 'disposed' } } : { kind: 'error', error: { code: 'NATIVE_AGENT', message: error.message } }
        if (!signal.aborted) this.events.emit('agent/error', { turn, step, error })
      } finally {
        stop()
        for (const event of recovery.results()) this.session.append('tool/result', event.data, { surfaceOp: 'append' })
        if (opened) this.session.append('step/end', { turn, step })
        this.session.append('turn/end', { turn, reason })
        await this.ctx.sessions.flush(this.session)
      }
    }
  }
  async close() { this.disposed = true; this.cancel({ kind: 'disposed' }, { keepInbox: true }); await this.whenIdle(); await this.runtime.adapter.closeSession(this.id); await this.scope.dispose() }
}

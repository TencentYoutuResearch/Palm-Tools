/** Cordis-owned Agent factory. Storage and lifecycle are independent of dsh's LLM loop. */
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import { NativeAgentDriver, boundaryProjection, inboxProjection } from './native-agent-driver.js'
export const name = 'kode-native-agent-factory'
export const inject = ['agents', 'sessions', 'sessionProjections', 'sessionPersistence', 'kodeAgents', 'tools', 'agentPresets']
export class NativeAgentFactory {
  constructor(ctx) { this.ctx = ctx; this.live = new Set(); this.byId = new Map(); this.pending = new Set(); this.stopping = false; this.stop = new AbortController() }
  createAgent(owner, options) { return this.track(() => this.attach(owner, options, false)) }
  resume(owner, options) { return this.track(() => this.attach(owner, options, true)) }
  track(start) { if (this.stopping) return Promise.reject(new Error('Agent runtime is unplugged')); const task = start(); this.pending.add(task); return task.finally(() => this.pending.delete(task)) }
  async attach(owner, options, resume) {
    const ctx = this.ctx, id = options.resumeSessionId ?? options.sessionId
    let handle, driver, detachSession, detachAgent, releaseOwner, published = false, closing
    let closed = false
    const setupDone = Promise.withResolvers(), ownerAbort = new AbortController()
    const signal = AbortSignal.any([this.stop.signal, ownerAbort.signal, ...(options.signal ? [options.signal] : [])])
    const dispose = () => closing ??= (async () => {
      closed = true
      ownerAbort.abort(new Error('Agent owner disposed'))
      await setupDone.promise
      try { await driver?.close() } finally {
        try { await handle?.close() } finally { detachAgent?.(); detachSession?.(); this.live.delete(dispose); if (this.byId.get(id) === dispose) this.byId.delete(id) }
      }
    })()
    // Establish owner cancellation before any storage await.
    releaseOwner = owner.effect(() => dispose, `kode.native-session:${id}`)
    const check = () => { signal.throwIfAborted(); owner.fiber.assertActive(); if (closed || this.stopping) throw new Error('Agent owner was disposed during setup') }
    try {
      check()
      let session
      if (resume) {
        handle = await ctx.sessionPersistence.open(id, 'write', { signal }); check()
        const stored = await handle.read(0, undefined, { signal }); check()
        const closers = interruptedTurnClosers(stored.events)
        if (closers.length) await handle.append(closers)
        session = ctx.sessions.prepare(id, { seed: [...stored.events, ...closers], meta: handle.header, inheritedEventCount: handle.inheritedEventCount })
      } else {
        session = ctx.sessions.prepare(id, { ...(options.meta ? { meta: options.meta } : {}), ...(options.seed ? { seed: options.seed } : {}), ...(options.inheritedEventCount ? { inheritedEventCount: options.inheritedEventCount } : {}) })
        handle = await ctx.sessionPersistence.create(session.header, { signal, ...(options.inheritedEventCount ? { inheritedEventCount: options.inheritedEventCount } : {}) }); check()
      }
      driver = new NativeAgentDriver(ctx, id, options.agentOptions ?? {}, session, ctx.kodeAgents)
      const storedCount = resume ? (await handle.read()).events.length : 0
      const commit = await options.setup?.(driver.ctx, driver); check(); commit?.commit()
      const suffix = session.snapshotEvents(storedCount)
      if (suffix.length) await handle.append(suffix)
      check()
      detachSession = driver.ctx.sessions.enter(session); detachAgent = ctx.agents.enter(driver, options.parentAgent)
      driver.ctx.sessions.announce(session); await ctx.agents.announce(driver, resume ? 'resume' : 'startup', signal); check()
      published = true; this.live.add(dispose); this.byId.set(id, dispose); driver.start()
      setupDone.resolve()
      return { agent: driver, dispose: async () => { try { await dispose() } finally { await releaseOwner() } } }
    } catch (error) { setupDone.resolve(); try { await dispose() } finally { await releaseOwner() }; throw error }
    finally { if (!published) this.live.delete(dispose) }
  }
  async close() { this.stopping = true; this.stop.abort(new Error('Agent runtime unplugged')); await Promise.allSettled([...this.pending]); await Promise.all([...this.live].map(dispose => dispose())) }
}
export async function apply(ctx) {
  const unregisterPreset = await ctx.agentPresets.register({ id: 'kode-native', name: '外部 Agent', description: '由所选 Agent 负责模型、指令和工具执行。', plugins: [] })
  ctx.effect(() => unregisterPreset, 'kode.native-preset')
  // Migrate only this adapter's recorded external sessions. The original logs,
  // model inputs and CLI thread identities remain intact; no turn is replayed.
  for (const [id, binding] of Object.entries(ctx.kodeAgents.profiles?.bindings ?? {})) {
    if (binding.profile.type === 'dsh') continue
    let handle
    try {
      handle = await ctx.sessionPersistence.open(id, 'write')
      const { events } = await handle.read()
      const recorded = events.findLast(event => event.type === 'agent-preset/selected')?.data.agentPreset ?? handle.header.agentPreset
      if (recorded === 'kode-native') continue
      const closers = interruptedTurnClosers(events)
      const seq = events.length + closers.length
      await handle.append([...closers, { seq, time: Date.now(), type: 'agent-preset/selected', data: { agentPreset: 'kode-native' } }])
      await handle.flush()
    } catch (error) {
      if (error.code !== 'ENOENT' && !/not found/i.test(error.message)) ctx.logger.warn('Kode session composition migration for %s: %s', id, error.message)
    } finally { await handle?.close() }
  }
  const factory = new NativeAgentFactory(ctx)
  ctx.on('kode/runtime-removed', async type => {
    const ids = [...factory.byId.keys()].filter(id => ctx.kodeAgents.profiles.binding(id)?.profile.type === type)
    await Promise.all(ids.map(id => factory.byId.get(id)?.()))
  })
  ctx.provide('kodeNativeFactory', factory)
  ctx.effect(function* () {
    yield ctx.sessionProjections.register(boundaryProjection)
    yield ctx.sessionProjections.register(inboxProjection)
    yield ctx.agents.setFactory(factory)
    yield () => factory.close()
  }, 'kode.native-factory')
}

import { contextUsageProjection } from './context-usage.js'
/** Cordis-owned Agent factory. Storage and lifecycle are independent of dsh's LLM loop. */
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import { NativeAgentDriver, boundaryProjection, inboxProjection } from './native-agent-driver.js'
import { installQueueSteering } from './queue-steering.js'
export const name = 'kode-native-agent-factory'
export const inject = ['agents', 'sessions', 'sessionProjections', 'sessionPersistence', 'kodeAgents', 'tools', 'agentPresets', 'agentLoop']
export class NativeAgentFactory {
  constructor(ctx) { this.ctx = ctx; this.live = new Set(); this.byId = new Map(); this.pending = new Set(); this.stopping = false; this.stop = new AbortController() }
  createAgent(owner, options) { return this.track(() => this.attach(owner, options, false)) }
  resume(owner, options) { return this.track(() => this.attach(owner, options, true)) }
  track(start) { if (this.stopping) return Promise.reject(new Error('Agent runtime is unplugged')); const task = start(); this.pending.add(task); return task.finally(() => this.pending.delete(task)) }
  async importHistory(id,seed,cwd,selection) {
    const live=this.ctx.agents.get(id)
    if(live && (live.status!=='idle' || live.inbox.nextTurn.length || live.inbox.nextStep.length))throw new Error('会话正在运行，历史导入将在空闲后重试。')
    let handle,stored
    try {handle=await this.ctx.sessionPersistence.open(id,'read');stored=await handle.read()}
    catch(error){if(error.code!=='ENOENT' && !/not found/i.test(error.message))throw error}
    finally{await handle?.close()}
    if(stored?.events.some(event=>event.type==='turn/start'))return
    if(!stored){await this.ctx.agents.create({sessionId:id,agentOptions:selection,meta:{cwd,agentPreset:'kode-native'},seed});return}
    // Complete a previous empty import without changing any existing event.
    await this.byId.get(id)?.()
    handle=await this.ctx.sessionPersistence.open(id,'write')
    try{
      const latest=await handle.read()
      if(latest.events.some(event=>event.type==='turn/start'))return
      await handle.append(seed.map((event,index)=>({...event,seq:latest.events.length+index})))
      await handle.flush()
    }finally{await handle.close()}
  }
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
      published = true; this.live.add(dispose); this.byId.set(id, dispose); ctx.kodeAgents.mountCommands?.(driver); driver.start()
      setupDone.resolve()
      return { agent: driver, dispose: async () => { try { await dispose() } finally { await releaseOwner() } } }
    } catch (error) { setupDone.resolve(); try { await dispose() } finally { await releaseOwner() }; throw error }
    finally { if (!published) this.live.delete(dispose) }
  }
  async close() { this.stopping = true; this.stop.abort(new Error('Agent runtime unplugged')); await Promise.allSettled([...this.pending]); await Promise.all([...this.live].map(dispose => dispose())) }
}
/** Route only explicit Kode selections; other plugins retain the official factory. */
export function installNativeFactoryRouting(ctx, native) {
  const upstream = ctx.agents.requireFactory().target
  const create = upstream.createAgent, resume = upstream.resume
  const officialHandles = new Map()
  ctx.on('agent/disposed', ({agent}) => { if (officialHandles.get(agent.id)?.handle.agent === agent) officialHandles.delete(agent.id) })
  native.promote = async (agent, selection) => {
    const record = officialHandles.get(agent.id)
    if (!record || record.handle.agent !== agent) throw new Error('请新建会话后选择 Kode Agent。')
    const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')
    if (agent.status !== 'idle' || boundary?.lastTurn > 0 || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw new Error('已有运行历史的会话不能更换执行器，请新建会话。')
    await record.handle.dispose()
    const opened = await native.resume(record.owner, { resumeSessionId: agent.id, agentOptions: selection, setup: async (_scope, driver) => { driver.session.append('agent-preset/selected', {agentPreset:'kode-native'}) } })
    return opened.agent
  }
  const remember = (owner, handle) => { officialHandles.set(handle.agent.id, {owner,handle}); return handle }
  const owns = async (options, restoring) => {
    const id = options.resumeSessionId ?? options.sessionId
    if (ctx.kodeAgents.profiles?.binding?.(id)) return true
    const provider = options.agentOptions?.provider
    if (provider) return provider.startsWith('kode-agent-')
    if (options.meta?.agentPreset === 'kode-native') return true
    if (!restoring) return false
    let handle
    try {
      handle = await ctx.sessionPersistence.open(id, 'read')
      const stored = await handle.read()
      const selected = stored.events.findLast(event => event.type === 'model/selection')?.data
        ?? stored.events.findLast(event => event.type === 'request/header')?.data?.header?.config
      if (selected?.provider) return selected.provider.startsWith('kode-agent-')
      return (stored.header ?? handle.header)?.agentPreset === 'kode-native'
    } finally { await handle?.close() }
  }
  const createRouter = async function(owner, options) {
    return await owns(options, false) ? native.createAgent(owner, options) : remember(owner, await create.call(this, owner, options))
  }
  const resumeRouter = async function(owner, options) {
    if (await owns(options, true)) return native.resume(owner, options)
    // Earlier Kode releases tagged third-party sessions with the empty Kode
    // preset. Repair only failed, never-executed sessions; preserve real history.
    if (ctx.agentPresets.resolve && options.agentOptions?.provider) {
      let handle, stored
      try { handle = await ctx.sessionPersistence.open(options.resumeSessionId, 'read'); stored = await handle.read() }
      finally { await handle?.close() }
      const preset = stored.events.findLast(event => event.type === 'agent-preset/selected')?.data?.agentPreset ?? (stored.header ?? handle.header)?.agentPreset
      if (preset === 'kode-native' && !stored.events.some(event => event.type === 'request/header')) {
        const official = await ctx.agentPresets.resolve()
        const setup = options.setup
        options = { ...options, setup: async (agentCtx, agent) => {
          const transaction = await setup?.(agentCtx, agent)
          await ctx.agentPresets.mount(agentCtx, official.id)
          agent.session.append('agent-preset/selected', { agentPreset: official.id })
          return transaction
        } }
      }
    }
    return remember(owner, await resume.call(this, owner, options))
  }
  upstream.createAgent = createRouter; upstream.resume = resumeRouter
  return () => {
    if (upstream.createAgent === createRouter) upstream.createAgent = create
    if (upstream.resume === resumeRouter) upstream.resume = resume
  }
}
export async function apply(ctx) {
  ctx.inject(['sessionController'], scope => scope.effect(() => installQueueSteering(scope, scope.sessionController), 'kode.queue-steering'))
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
    yield ctx.sessionProjections.register(contextUsageProjection)
    yield installNativeFactoryRouting(ctx, factory)
    yield () => factory.close()
  }, 'kode.native-factory')
}

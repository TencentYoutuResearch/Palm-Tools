import { symbols } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { CoordinatorCloseRecovery } from './coordinator-close-recovery.js'
import { closeCoordinator } from './coordinator-close.js'
import { planBuilderStart } from './builder-start-plan.js'
import { installAssignmentTools, assignmentToolNames } from './assignment-tools.js'
import { mountAssignmentPrompt } from './assignment-prompt.js'
/** Own controlled official Agent handles without replacing the ordinary registry factory. */
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { OfficialDispatch } from './official-dispatch.js'
import { prepareBuilderDispatch } from './builder-preparation.js'
import { prepareCoordinatorDispatch } from './coordinator-preparation.js'
import { closeBuilder } from './builder-close.js'
import { startBuilder } from './builder-start.js'
import { CoordinatorBootstrap } from './coordinator-bootstrap.js'
import { CoordinatorTransfers } from './coordinator-transfers.js'
import { CoordinatorInbox } from './coordinator-inbox.js'
import { startCoordinator } from './coordinator-start.js'
import { resumeCoordinator } from './coordinator-resume.js'
import { planCoordinatorStart } from './coordinator-start-plan.js'
import { startPlannedCoordinator } from './coordinator-planned-start.js'
import { controlledBinding } from './managed-codex-profile.js'

export class OfficialLoopHost {
  constructor(ctx, execution) {
    this.ctx = ctx; this.execution = execution
    this.dispatches = new OfficialDispatch(this)
    this.builderStarts = new Map()
    this.coordinatorStarts = new Map()
    this.coordinatorResumes = new Map()
    this.coordinatorPlanStarts = new Map()
    this.handles = new Map(); this.pending = new Map(); this.admissions = new Map(); this.stop = new AbortController()
    this.coordinatorCloseRecovery = new CoordinatorCloseRecovery(this)
    this.coordinatorTransfers = new CoordinatorTransfers(this)
    this.coordinatorInbox = new CoordinatorInbox(this)
    this.coordinatorBootstrap = new CoordinatorBootstrap(this)
  }
  mount() {
    return this.mounting ??= (async () => {
      this.stop.signal.throwIfAborted()
      const services = this.execution.loopServices(), registry = this.ctx.get('agents')
      // Linked installations can load a second copy with different private scope
      // symbols. Use the live ordinary factory's class to share its scope protocol.
      let Loop = AgentLoop
      let ordinary
      try { ordinary = registry.requireFactory().target } catch (error) {
        if (!String(error.message).startsWith('no agent factory registered')) throw error
      }
      if (ordinary) {
        const target = ordinary[symbols.original] ?? ordinary
        const constructor = Object.getPrototypeOf(target).constructor
        // Other executors may own the ordinary factory. Only an official loop
        // advertises this injection contract; otherwise use our installed loop.
        if (typeof target.createAgent === 'function' && constructor.inject?.includes('systemPrompt')) Loop = constructor
      }
      let scope = this.ctx.isolate('llm').isolate('tools').isolate('agents').isolate('agentLoop')
      // Isolation labels alone still share the parent's fiber.store. Give the
      // controlled service aliases their own owner so ordinary ctx.llm/tools
      // cannot resolve back into this loop and recurse through admission.
      this.servicesFiber = scope.plugin(function controlledOfficialServices() {})
      await this.servicesFiber
      this.stop.signal.throwIfAborted()
      scope = this.servicesFiber.ctx
      // Cordis traces service property descriptors, so an own method (rather
      // than a Proxy getter) is required. Keep the original prompt layers and
      // caller context so role sections remain Agent-scoped.
      const prompt = this.ctx.get('systemPrompt')
      const originalPrompt = prompt[symbols.original] ?? prompt
      const controlledPrompt = Object.create(originalPrompt)
      Object.defineProperty(controlledPrompt, 'variable', { configurable: true, writable: true, value: function (name, provider) {
        const globals = this.layers.merge(undefined, layer => layer.variables)
        if ((name === 'provider' || name === 'model') && globals.has(name)) return () => {}
        return originalPrompt.variable.call(this, name, provider)
      } })
      scope = scope.isolate('systemPrompt')
      scope.provide('systemPrompt', controlledPrompt)
      const agents = new Proxy({}, { get: (_target, key) => {
        if (key === 'announce') return async (agent, source, signal) => {
          const admission = this.admissions.get(agent.id)
          if (!admission || admission.run) throw new Error('Official publication has no pending admission')
          signal?.throwIfAborted()
          admission.validate?.(agent)
          admission.run = await this.execution.open(agent, { tools: admission.tools, signal: this.stop.signal, freshContext: admission.freshContext })
          signal?.throwIfAborted()
          admission.validate?.(agent)
          return registry.announce(agent, source, signal)
        }
        if (key === 'setFactory') return factory => {
          if (this.factory) throw new Error('Controlled official factory already registered')
          this.factory = factory
          return () => { if (this.factory === factory) this.factory = undefined }
        }
        if (typeof key === 'symbol') return undefined
        const value = Reflect.get(registry, key, registry)
        return typeof value === 'function' ? value.bind(registry) : value
      } })
      scope.provide('llm', services.llm); scope.provide('tools', services.tools); scope.provide('agents', agents)
      this.scope = scope
      this.fiber = await scope.plugin(Loop, { agents: [], maxParallelToolCalls: 1 })
      this.stop.signal.throwIfAborted()
      if (!this.factory) throw new Error('Controlled official factory unavailable')
      this.coordinatorInbox.start()
      this.coordinatorTransfers.start()
      this.coordinatorCloseRecovery.start()
    })()
  }
  create(options, { tools = [] } = {}) { return this.start('createAgent', options, tools) }
  prepareBuilder(input) { return prepareBuilderDispatch(this.execution, input, { signal: this.stop.signal }) }
  prepareCoordinator(input) { return prepareCoordinatorDispatch(this.execution, input, { signal: this.stop.signal }) }
  planBuilderStart(input) { return planBuilderStart(this.execution, input, { signal: this.stop.signal }) }
  startBuilder(input) { return startBuilder(this, input) }
  closeBuilder(input) { return closeBuilder(this, input) }
  planCoordinatorStart(input) { return planCoordinatorStart(this.execution,input,{signal:this.stop.signal}) }
  startPlannedCoordinator(input) { return startPlannedCoordinator(this,input) }
  resumeCoordinator(command) { return resumeCoordinator(this,command) }
  closeCoordinator(input) { return closeCoordinator(this,input) }
  startCoordinator(input) { return startCoordinator(this,input) }
  resume(options, { tools = [] } = {}) { return this.start('resume', options, tools) }
  async start(method, options, tools) {
    this.stop.signal.throwIfAborted()
    const id = method === 'resume' ? options?.resumeSessionId : options?.sessionId, binding = this.execution.profiles.binding(id)
    if (!id || !controlledBinding(binding) || !binding.managedOperation || binding.operationClosed) throw new Error('Managed official binding required before creation')
    if (this.pending.has(id) || this.handles.has(id) || this.ctx.get('agents').get(id)) throw new Error('Official agent identity already owned')
    if (!Array.isArray(tools) || tools.some(name => typeof name !== 'string' || !name)) throw new Error('Explicit official tool names required')
    const task = this.createOwned(method, id, options, [...tools])
    this.pending.set(id, task)
    try { return await task } finally { if (this.pending.get(id) === task) this.pending.delete(id) }
  }
  async createOwned(method, id, options, tools) {
    let handle
    const admission = { tools, run: undefined, validate: options.validateAdmission, freshContext: method === 'createAgent' && options.seed === undefined && options.parentAgent === undefined && options.inheritedEventCount === undefined }
    const signal = options.signal ? AbortSignal.any([options.signal, this.stop.signal]) : this.stop.signal
    try {
      await this.mount(); signal.throwIfAborted()
      this.admissions.set(id, admission)
      const setup = async (agentCtx, agent) => {
        const actualAgent = agent[symbols.original] ?? agent
        // Linked loops can carry another copy's private scope symbol. Tag shared
        // service registrations through our scope API too, with the same Agent.
        agentCtx = createScope(agentCtx, actualAgent).ctx
        // Shipped Agent observers read agent.ctx.tools directly. Give this Agent
        // an explicit scoped view without changing root services or its scope key.
        const localTools = agentCtx.get('tools').forScope(agentCtx)
        agentCtx = agentCtx.extend({ tools: localTools })
        actualAgent.ctx = agentCtx
        const commit = await options.setup?.(agentCtx, agent)
        if (tools.some(name => assignmentToolNames.includes(name))) {
          agentCtx.effect(() => installAssignmentTools(agentCtx, agent, this.execution, tools))
          if (this.execution.profiles.binding(agent.id)?.managedAssignment) agentCtx.effect(() => mountAssignmentPrompt(agentCtx))
        }
        const view = agentCtx.get('tools'), scoped = view.forScope(agentCtx)
        // A fixed allow mask also hides global tools registered after this Agent starts.
        // Scoped tools remain subject to OfficialExecution's exact tool-name/implementation gates.
        agentCtx.effect(() => scoped.restrict({ allow: tools.filter(name => scoped.get(name) !== undefined) }))
        agentCtx.effect(() => scoped.presentAs('native'))
        return commit
      }
      handle = await this.factory[method](this.scope, { ...options, setup, signal })
      const run = admission.run
      if (!run) throw new Error('Official publication did not acquire execution ownership')
      signal.throwIfAborted()
      let disposal
      const owned = { agent: handle.agent, run, dispose: () => disposal ??= (async () => {
        run.dispose()
        await handle.dispose()
        await run.whenStopped()
        if (this.handles.get(id) === owned) this.handles.delete(id)
      })() }
      this.handles.set(id, owned)
      return owned
    } catch (error) {
      admission.run?.dispose()
      await handle?.dispose()
      throw error
    } finally { if (this.admissions.get(id) === admission) this.admissions.delete(id) }
  }
  close() {
    return this.closing ??= (async () => {
      this.stop.abort(new Error('Official loop Host closed'))
      await this.coordinatorCloseRecovery.close()
      await this.coordinatorBootstrap.close()
      await this.coordinatorTransfers.close()
      await this.coordinatorInbox.close()
      await Promise.allSettled([...this.builderStarts.values()].map(row => row.task))
      await Promise.allSettled([...this.coordinatorPlanStarts.values()].map(row => row.task))
      await Promise.allSettled([...this.coordinatorStarts.values()].map(row => row.task))
      await Promise.allSettled([...this.coordinatorResumes.values()].map(row => row.task))
      await Promise.allSettled([...this.dispatches.pending.values()].map(row => row.task))
      await Promise.allSettled([...this.pending.values()])
      const results = await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()))
      await this.mounting?.catch(() => {})
      await this.fiber?.dispose()
      await this.servicesFiber?.dispose()
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, 'Official loop cleanup failed')
    })()
  }
}

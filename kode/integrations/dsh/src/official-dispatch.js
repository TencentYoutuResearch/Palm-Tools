/** Durable, at-most-once creation commands for the controlled official loop Host. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { mountOfficialBuilderTools, OFFICIAL_BUILDER_TOOLS } from './official-builder-tools.js'
import { mountCoordinatorContext } from './coordinator-context.js'
import { mountOfficialCoordinatorTools, OFFICIAL_COORDINATOR_TOOLS, OPTIONAL_COORDINATOR_TOOLS } from './official-coordinator-tools.js'
import { controlledBinding } from './managed-codex-profile.js'
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
const string = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key))
function normalize(input) {
  if (!exact(input, ['command_id', 'session_id', 'operation', 'profile_revision', 'provider', 'model', 'effort', 'cwd', 'tools', 'builder', 'coordinator'])
      || !id(input.command_id) || !id(input.session_id)
      || !exact(input.operation, ['id', 'attempt', 'epoch', 'home_node']) || !id(input.operation.id)
      || (input.operation.home_node !== undefined && !id(input.operation.home_node))
      || !Number.isSafeInteger(input.operation.attempt) || input.operation.attempt < 1
      || !Number.isSafeInteger(input.operation.epoch) || input.operation.epoch < 1
      || !/^[a-f0-9]{64}$/.test(input.profile_revision) || !string(input.provider) || !string(input.model)
      || (input.effort != null && !string(input.effort)) || !string(input.cwd)
      || !Array.isArray(input.tools) || input.tools.length > 256 || input.tools.some(tool => !string(tool))) {
    throw new Error('Invalid official dispatch command')
  }
  const builderId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
  if (input.coordinator !== undefined && (input.builder !== undefined
      || !exact(input.coordinator,['team_id','conversation_id','control_revision'])
      || !builderId(input.coordinator.team_id) || !builderId(input.coordinator.conversation_id)
      || !Number.isSafeInteger(input.coordinator.control_revision) || input.coordinator.control_revision < 1
      || new Set(input.tools).size !== input.tools.length
      || input.tools.some(t=>![...OFFICIAL_COORDINATOR_TOOLS,...OPTIONAL_COORDINATOR_TOOLS].includes(t))
      || OFFICIAL_COORDINATOR_TOOLS.some(t=>!input.tools.includes(t)))) throw new Error('Invalid official Coordinator dispatch scope or tools')
  if (input.builder !== undefined && (!exact(input.builder, ['draft_id', 'team_id'])
      || !builderId(input.builder.draft_id) || !builderId(input.builder.team_id)
      || input.tools.length !== OFFICIAL_BUILDER_TOOLS.length
      || OFFICIAL_BUILDER_TOOLS.some(name => !input.tools.includes(name)))) {
    throw new Error('Invalid official Builder dispatch scope or tools')
  }
  return { command_id: input.command_id, session_id: input.session_id,
    operation: { id: input.operation.id, attempt: input.operation.attempt, epoch: input.operation.epoch, ...(input.operation.home_node === undefined ? {} : { home_node: input.operation.home_node }) },
    profile_revision: input.profile_revision, provider: input.provider, model: input.model, effort: input.effort ?? null,
    cwd: input.cwd, tools: [...new Set(input.tools)].sort(),
    ...(input.builder === undefined ? {} : { builder: { draft_id: input.builder.draft_id, team_id: input.builder.team_id } }),
    ...(input.coordinator === undefined ? {} : { coordinator: {...input.coordinator} }) }
}
function coordinatorMatches(binding,request) {
  return isDeepStrictEqual(binding.managedCoordinator,request.coordinator)
    && (!request.coordinator || (!binding.managedBuilder && !binding.managedAssignment))
}
export class OfficialDispatch {
  constructor(host) { this.host = host; this.pending = new Map() }
  get(session, command) {
    if (!id(session) || !id(command)) throw new Error('Invalid official dispatch identity')
    const rows = this.host.execution.profiles.binding(session)?.officialDispatch ?? {}
    if (!Object.hasOwn(rows, command)) return null
    const row = rows[command]
    return { ...row, state: row.state === 'creating' && !this.pending.has(`${session}:${command}`) ? 'uncertain' : row.state }
  }
  async reconcile(session, command) {
    const saved = this.get(session, command)
    if (!saved) throw new Error('Unknown official dispatch command')
    if (saved.state === 'created') return saved
    if (this.pending.has(`${session}:${command}`)) throw new Error('Official dispatch is still owned by an active command')
    const persistence = this.host.ctx.get('sessionPersistence')
    if (!persistence) return { ...saved, reconciliation: 'persistence_unavailable' }
    let handle, marker
    try {
      handle = await persistence.open(session, 'read', { signal: this.host.stop.signal })
      if (handle.header.id !== session || handle.header.cwd !== saved.request.cwd || handle.header.isSeeded) {
        return { ...saved, reconciliation: 'session_identity_mismatch' }
      }
      // Creation evidence is near the beginning. Bound reads; absence is never proof of no effect.
      const { events } = await handle.read(0, 4096, { signal: this.host.stop.signal })
      const markers = events.filter(event => pluginRecordOf(event)?.type === 'plugin:kode/official-creation')
      if (markers.length !== 1 || markers[0].data.command_id !== command || markers[0].data.fingerprint !== saved.fingerprint) {
        return { ...saved, reconciliation: 'creation_evidence_missing_or_mismatched' }
      }
      marker = markers[0]
    } catch {
      return { ...saved, reconciliation: 'session_read_unavailable' }
    } finally { await handle?.close() }
    return this.host.execution.profiles.update(state => {
      const row = state.bindings[session]?.officialDispatch?.[command]
      if (!row || row.fingerprint !== saved.fingerprint) throw new Error('Official dispatch receipt identity lost')
      if (row.state !== 'created') {
        row.state = 'created'; row.updated_at = Date.now()
        row.recovery = { basis: 'persisted_creation_event', sequence: marker.seq, fingerprint: saved.fingerprint }
      }
      return row
    })
  }
  dispatch(input, { setup, signal } = {}) {
    const request = normalize(input), key = `${request.session_id}:${request.command_id}`
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const pending = this.pending.get(key)
    if (pending) {
      if (pending.fingerprint !== fingerprint) return Promise.reject(new Error('Official dispatch command identity conflict'))
      return pending.task
    }
    const task = this.execute(request, fingerprint, setup, signal)
    this.pending.set(key, { fingerprint, task })
    task.finally(() => { if (this.pending.get(key)?.task === task) this.pending.delete(key) }).catch(() => {})
    return task
  }
  async execute(request, fingerprint, setup, signal) {
    const profiles = this.host.execution.profiles
    const prior = await profiles.update(state => {
      const binding = state.bindings[request.session_id]
      if (!binding) throw new Error('Managed official binding required before dispatch')
      const rows = binding.officialDispatch ??= {}
      if (Object.hasOwn(rows, request.command_id)) {
        if (rows[request.command_id].fingerprint !== fingerprint) throw new Error('Official dispatch command identity conflict')
        return rows[request.command_id]
      }
      this.host.stop.signal.throwIfAborted(); signal?.throwIfAborted()
      const op = binding.managedOperation
      if (!controlledBinding(binding) || binding.operationClosed || !coordinatorMatches(binding,request) || binding.revision !== request.profile_revision
          || !op || op.id !== request.operation.id || op.attempt !== request.operation.attempt || op.epoch !== request.operation.epoch || op.home_node !== request.operation.home_node) {
        throw new Error('Official dispatch binding mismatch')
      }
      if (Object.keys(rows).length) throw new Error('Official session already has a creation command; reconcile or resume it')
      Object.defineProperty(rows, request.command_id, { value: { request, fingerprint, state: 'creating', created_at: Date.now() }, enumerable: true, writable: true, configurable: true })
      return null
    })
    if (prior) return { ...prior, state: prior.state === 'creating' ? 'uncertain' : prior.state }
    const save = state => profiles.update(snapshot => {
      const row = snapshot.bindings[request.session_id]?.officialDispatch?.[request.command_id]
      if (!row || row.fingerprint !== fingerprint) throw new Error('Official dispatch receipt identity lost')
      row.state = state; row.updated_at = Date.now()
      return row
    })
    const validateAdmission = agent => {
      const binding = profiles.binding(request.session_id), op = binding?.managedOperation
      if (!binding || binding.operationClosed || !coordinatorMatches(binding,request) || binding.revision !== request.profile_revision || !op
          || op.id !== request.operation.id || op.attempt !== request.operation.attempt || op.epoch !== request.operation.epoch || op.home_node !== request.operation.home_node
          || agent.options.provider !== request.provider || agent.options.model !== request.model
          || (request.effort != null && agent.options.reasoningEffort !== request.effort)) {
        throw new Error('Official dispatch admission changed')
      }
    }
    try {
      const owned = await this.host.create({ sessionId: request.session_id, meta: { cwd: request.cwd },
        agentOptions: { provider: request.provider, model: request.model, ...(request.effort == null ? {} : { reasoningEffort: request.effort }) },
        setup: request.builder || request.coordinator ? async (agentCtx, agent) => {
          const commit = await setup?.(agentCtx, agent)
          const dispose = request.builder
            ? await mountOfficialBuilderTools(agentCtx, agent, this.host.execution, request.builder)
            : await mountCoordinatorContext(agentCtx, agent, this.host.execution, request.coordinator)
          agentCtx.effect(() => dispose)
          if(request.coordinator)agentCtx.effect(()=>mountOfficialCoordinatorTools(agentCtx,agent,this.host.execution,request.coordinator,request.tools))
          return commit
        } : setup, signal, validateAdmission }, { tools: request.tools })
      appendPluginRecord(owned.agent.session, 'plugin:kode/official-creation', { command_id: request.command_id, fingerprint })
      await this.host.ctx.sessions.flush(owned.agent.session)
      return await save('created')
    } catch (error) {
      // Do not retry creation after an ambiguous effect or receipt-write failure.
      await save('uncertain').catch(() => {})
      throw error
    }
  }
}

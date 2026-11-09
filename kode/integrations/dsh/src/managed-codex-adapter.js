/** Public LLM pipeline adapter. The ordinary native driver never owns these workflow calls. */
import { dirname, join } from 'node:path'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { profileRevision } from './agent-profiles.js'
import { controlledBinding, managedCodexEnabled, managedCodexRoute, normalizeManagedInference } from './managed-codex-profile.js'
import { CodexManagedDecision } from './codex-managed-decision.js'

export class ManagedCodexAdapter {
  constructor(ctx, profiles) { this.ctx = ctx; this.profiles = profiles; this.active = new Map(); this.closed = false }
  profile(provider) {
    const profile = [...this.profiles.list(), ...Object.values(this.profiles.bindings).map(binding => binding.profile)]
      .find(profile => managedCodexRoute(profile.id) === provider && managedCodexEnabled(profile))
    if (!profile) throw new Error('Managed CLI provider unavailable')
    return profile
  }
  providerInfo(provider) { return { id: provider, name: this.profile(provider).name } }
  providerRetryPolicy() { return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 } }
  async listModels(provider) {
    const profile = this.profile(provider)
    return (profile.allowedModels ?? (profile.defaultModel ? [profile.defaultModel] : [])).map(model => this.modelInfo(provider, model, profile))
  }
  modelInfo(provider, model, profile) {
    if (typeof model !== 'string' || !model || (profile.allowedModels && !profile.allowedModels.includes(model))) throw new Error('Managed CLI model is outside its configured scope')
    const inference = normalizeManagedInference(profile.managedInference)
    return { provider, id: model, name: model, inputModalities: ['text'],
      ...(inference.reasoningEfforts.length ? { reasoning: { efforts: inference.reasoningEfforts.map(id => ({ id, name: id })),
        ...(profile.defaultReasoningEffort ? { defaultEffort: profile.defaultReasoningEffort } : {}) } } : {}) }
  }
  async resolveModel(provider, model) { return this.modelInfo(provider, model, this.profile(provider)) }
  async prepareCall(provider, model) {
    const profile = structuredClone(this.profile(provider))
    return { model: this.modelInfo(provider, model, profile), stream: options => this.streamBound(profile, options) }
  }
  decision(binding, config, agent, signal, admit) {
    const profile = binding.profile
    const inference = normalizeManagedInference(profile.managedInference)
    return new CodexManagedDecision({ profile, cwd: agent.session.header.cwd,
      stateRoot: join(dirname(this.profiles.path), 'managed-codex'), model: config.model,
      effort: config.reasoningEffort, signal, admit, ...inference,
      allowUserInput: Boolean(binding.managedAssignment) })
  }
  async preflight(binding, config, agent, signal) {
    const actor = this.decision(binding, config, agent, signal, async () => { throw new Error('CLI selection preflight cannot infer') })
    try {
      const actual = await actor.prepare({ messages: [], tools: [] })
      const stop = await actor.close()
      if (!stop?.leader_exited || !stop.process_group_empty || stop.signal_failures.length) throw new Error('CLI selection preflight stop is unconfirmed')
      return { provider: config.provider, model: actual.model, reasoning_effort: actual.reasoningEffort,
        profile_revision: binding.revision, basis: 'adapter_configuration_metadata', inference_verified: false }
    } finally { await actor.close() }
  }
  async *streamBound(profile, options) {
    const agent = this.ctx.agents.get(options.sessionId), binding = this.profiles.binding(options.sessionId)
    const execution = this.ctx.get('kodeAgents')?.officialExecution
    if (this.closed || !agent || !binding?.managedOperation || !controlledBinding(binding) || binding.operationClosed || binding.stopBlocked
        || binding.revision !== profileRevision(profile) || !managedCodexEnabled(binding.profile)
        || options.provider !== managedCodexRoute(profile.id) || !execution || this.active.has(agent.id)) {
      throw new Error('Managed CLI workflow execution unavailable')
    }
    if (options.purpose || options.temperature != null || options.maxTokens != null) throw new Error('Managed CLI call controls unsupported')
    const request = await execution.assertModelRequest(agent)
    const actor = this.decision(binding, options, agent, options.signal, () => execution.assertModelRequest(agent))
    this.active.set(agent.id, actor)
    try {
      const configuration = await actor.prepare(options)
      await execution.assertModelRequest(agent)
      appendPluginRecord(agent.session, 'plugin:kode/managed-cli-start', { ...request, profile_revision: binding.revision,
        configuration, native_process: { pid: actor.rpc.child.pid, signal_scope: 'process_group' } })
      await agent.ctx.parallel('session/flush', agent.session)
      const result = await actor.execute()
      if (result.stop?.spawned && !result.stop.process_group_empty) await this.profiles.patchBinding(agent.id, { stopBlocked: true })
      appendPluginRecord(agent.session, 'plugin:kode/managed-cli-decision', {
        ...request, configuration: result.configuration,
        stop: result.stop, terminal: result.terminal ?? null, usage: result.usage ?? null,
        usage_evidence: result.usage_evidence,
        transport_completion: result.transport_completion,
        owner_question: result.owner_question,
        failure_code: result.failure?.code ?? null,
        failure_details: result.failure_details,
        outcome: result.failure?.code === 'worker_clarification_required' ? 'requires_clarification' : result.failure ? 'failed' : 'completed',
      })
      await agent.ctx.parallel('session/flush', agent.session)
      let clarificationFailure, clarificationRecorded = false
      if (result.owner_question && result.failure?.code === 'worker_clarification_required'
          && result.stop?.leader_exited && result.stop.process_group_empty && !result.stop.signal_failures.length) {
        try {
          const current = await execution.assertModelRequest(agent)
          await execution.clarifications.record(agent, current, result.owner_question)
          clarificationRecorded = true
        } catch (error) { clarificationFailure = error }
      }
      const usage = result.usage
      if (usage && usage.cache_write_input_tokens !== null) yield { type: 'usage', usage: {
        inputTokens: usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens,
        cacheReadTokens: usage.cached_input_tokens, cacheWriteTokens: usage.cache_write_input_tokens, outputTokens: usage.output_tokens,
      } }
      if (clarificationFailure) throw clarificationFailure
      // The native question has a drained actor and an exact Home receipt.
      // End this admitted decision normally so known usage remains resumable.
      // Missing usage still reaches the existing unresolved-accounting gate.
      if (clarificationRecorded) {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (result.failure) throw result.failure
      let index = 0
      for (const text of result.texts) {
        yield { type: 'block-start', index, blockType: 'text' }
        yield { type: 'block-end', index: index++, block: { type: 'text', text } }
      }
      for (const block of result.calls) {
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'block-end', index: index++, block }
      }
      yield { type: 'finish', reason: { kind: result.calls.length ? 'tool-calls' : 'stop' } }
    } finally {
      const stopped = await actor.close()
      if (stopped?.spawned && !stopped.process_group_empty) await this.profiles.patchBinding(agent.id, { stopBlocked: true })
      if (this.active.get(agent.id) === actor) this.active.delete(agent.id)
    }
  }
  async closeSession(id) { await this.active.get(id)?.close() }
  async close() { this.closed = true; await Promise.all([...this.active.values()].map(actor => actor.close())) }
}

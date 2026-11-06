/** Exact configuration validation only. No session creation, call preparation or inference. */
import { profileRevision } from './agent-profiles.js'
import { controlledBinding, managedCodexEnabled, managedCodexRoute } from './managed-codex-profile.js'

export function assertOfficialProfile(profiles, binding, policy) {
  if (!policy) return
  const current = profiles.get(binding.profile.id)
  if (!controlledBinding({ ...binding, profile: current }) || binding.revision !== policy.profile_revision
      || profileRevision(binding.profile) !== binding.revision || profileRevision(current) !== binding.revision) {
    throw new Error('Official executor profile changed from selection policy')
  }
  if (current.allowedModels && !current.allowedModels.includes(policy.model)) {
    throw new Error('Official selection policy model is outside allowedModels')
  }
}

export async function preflightOfficialSelection(ctx, profiles, binding, policy, config, signal, agent, nativeAdapter) {
  if (!policy) return null
  signal?.throwIfAborted()
  assertOfficialProfile(profiles, binding, policy)
  if (policy.scope !== 'executor_configuration' || typeof config?.provider !== 'string'
      || !config.provider || config.provider.startsWith('kode-agent-') || config.model !== policy.model
      || (policy.effort != null && config.reasoningEffort !== policy.effort)) {
    throw new Error('Official configuration does not match selection policy')
  }
  if (typeof ctx.llm?.resolveCallConfig !== 'function') throw new Error('Official exact-model configuration resolver unavailable')
  const resolved = await ctx.llm.resolveCallConfig({ provider: config.provider, model: config.model,
    ...(config.reasoningEffort == null ? {} : { reasoningEffort: config.reasoningEffort }) }, signal)
  signal?.throwIfAborted()
  assertOfficialProfile(profiles, binding, policy)
  if (resolved.provider !== config.provider || resolved.model !== policy.model
      || (policy.effort != null && resolved.reasoningEffort !== policy.effort)) {
    throw new Error('Official resolved configuration differs from selection policy')
  }
  if (managedCodexEnabled(binding.profile)) {
    if (!controlledBinding(binding) || config.provider !== managedCodexRoute(binding.profile.id) || !agent || !nativeAdapter) throw new Error('Managed CLI workflow configuration unavailable')
    const actual = await nativeAdapter.preflight(binding, resolved, agent, signal)
    signal?.throwIfAborted()
    assertOfficialProfile(profiles, binding, policy)
    if (actual.model !== policy.model || (policy.effort != null && actual.reasoning_effort !== policy.effort)) throw new Error('Managed CLI selection metadata mismatch')
    return actual
  }
  return { provider: resolved.provider, model: resolved.model, reasoning_effort: resolved.reasoningEffort ?? null,
    profile_revision: binding.revision, basis: 'adapter_configuration_metadata', inference_verified: false }
}

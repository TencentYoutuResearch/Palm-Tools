/** Requested selection policy; catalogue validation is not proof of applied inference configuration. */
import { resolveAdvertisedModel } from './model-alias.js'
import { profileRoute } from './agent-profiles.js'
export function selectModelPlan(profile, models, input = {}, inherited) {
  const provider = profileRoute(profile.id)
  if (!models.length) throw new Error('The selected Agent returned no model')
  const allowed = profile.allowedModels === undefined ? null : new Set(profile.allowedModels)
  const available = models.filter(model => !allowed || allowed.has(model.id))
  if (!available.length) throw new Error('No advertised model is permitted by this Agent configuration')
  const prior = inherited?.provider === provider && inherited.model !== 'default' ? inherited : undefined
  const requested = input.model ?? prior?.model ?? profile.defaultModel ?? available.find(m => m.isDefault)?.id ?? available[0].id
  if (typeof requested !== 'string' || !requested.trim()) throw new Error('Invalid requested model')
  const model = resolveAdvertisedModel(models, requested)
  if (allowed && !allowed.has(model)) throw new Error('Requested model is outside the configured allowedModels')
  const row = available.find(m => m.id === model)
  const explicitEffort = input.reasoningEffort !== undefined
  const inheritedEffort = prior?.model === model ? prior.reasoningEffort : undefined
  const effort = input.reasoningEffort ?? inheritedEffort ?? profile.defaultReasoningEffort ?? row.defaultReasoningEffort
  if (effort !== undefined && (typeof effort !== 'string' || !row.reasoningEfforts?.some(e => e.id === effort))) {
    if (explicitEffort || inheritedEffort !== undefined || profile.defaultReasoningEffort !== undefined) throw new Error('The selected model does not advertise the requested reasoning effort')
    return { provider, model }
  }
  return { provider, model, ...(effort !== undefined ? { reasoningEffort: effort } : {}) }
}

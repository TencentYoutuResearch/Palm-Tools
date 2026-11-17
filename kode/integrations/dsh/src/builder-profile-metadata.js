/** Configuration eligibility only. No credentials, discovery, grants or inference. */
import { normalizeProfile, profileRevision } from './agent-profiles.js'
import { managedNativeEnabled, managedCodexRoute } from './managed-codex-profile.js'
export function builderProfileMetadata(profile, runtimeAvailable, registeredProviders = []) {
  const empty = { managed_roles: [], managed_provider_id: null, managed_route_registered: false, builder_selection_eligible: false }
  if (profile?.type === 'dsh') return { ...empty, builder_selection_eligible: runtimeAvailable === true }
  try {
    const validated = normalizeProfile(profile)
    if (!managedNativeEnabled(validated)) return empty
    const roles = validated.managedInference.roles ?? ['worker']
    const provider = managedCodexRoute(validated.id)
    const registered = registeredProviders.some(row => row.id === provider)
    return { managed_roles: [...roles], managed_provider_id: provider, managed_route_registered: registered,
      builder_selection_eligible: runtimeAvailable === true && roles.includes('builder') && registered }
  } catch { return empty }
}
export function managedBuilderSnapshot(service, llm, provider, id, revision) {
  if (!service?.profiles || !llm?.listProviders) return null
  const profile = service.profiles.list().find(row => row.id === id)
  if (!profile || profileRevision(profile) !== revision) return null
  const metadata = builderProfileMetadata(profile, service.hasRuntime(profile.type), llm.listProviders())
  if (!metadata.builder_selection_eligible || metadata.managed_provider_id !== provider) return null
  return { profile_id: id, profile_revision: revision }
}

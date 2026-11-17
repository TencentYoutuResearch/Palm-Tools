/** Catalog selection only. Host admission remains authoritative at execution time. */
export function builderProfileEligible(row) {
  if (row?.resource_kind !== 'execution_profile' || row.runtime_available !== true || row.builder_selection_eligible !== true) return false
  if (row.executor_type === 'dsh') return true
  return Array.isArray(row.managed_roles) && row.managed_roles.includes('builder') && row.managed_route_registered === true
    && typeof row.managed_provider_id === 'string' && row.managed_provider_id.length > 0 && typeof row.profile_revision === 'string' && /^[a-f0-9]{64}$/.test(row.profile_revision)
}
export function builderProviderOptions(resources, profile) {
  if (!builderProfileEligible(profile)) return []
  if (profile.executor_type !== 'dsh') return [{ id: profile.managed_provider_id, name: profile.name }]
  return resources.filter(row => row.resource_kind === 'official_loop_provider' && row.route_registered).map(row => ({id:row.provider_id,name:row.name}))
}
export function builderModelQuery(profile, provider, model) {
  if (!builderProfileEligible(profile)) return null
  if (profile.executor_type !== 'dsh' && provider !== profile.managed_provider_id) return null
  const query = new URLSearchParams({provider})
  if (profile.executor_type !== 'dsh') { query.set('profile_id',profile.profile_id); query.set('profile_revision',String(profile.profile_revision)) }
  if (model) query.set('model',model)
  return '/api/kode/builder/models?' + query
}
export function validBuilderModelScope(value, profile, provider, home) {
  return value?.home_hub === home && value.provider === provider && (profile.executor_type === 'dsh' ||
    value.profile_id === profile.profile_id && value.profile_revision === profile.profile_revision && value.eligible_for_dispatch === false)
}

/** Native owner catalogue is evidence for a saved target, never permission to run. */
const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
export function validateNativeCatalog(team, catalog, profileId) {
  if (team.spec?.execution_mode !== 'interactive_native' || catalog?.home_hub !== team.home_hub
    || catalog.execution_mode !== 'interactive_native' || catalog.eligible_for_execution !== false || !Array.isArray(catalog.profiles)
    || !team.spec.workspace_refs?.some(ref => ref.host_id === team.home_hub)) throw Error('Native catalogue scope differs')
  for (const profile of catalog.profiles) if (!valid(profile.id) || !/^[a-f0-9]{64}$/.test(profile.profile_revision) || typeof profile.provider_id !== 'string' || !profile.provider_id || profile.type === 'dsh') throw Error('Invalid native profile')
  if (new Set(catalog.profiles.map(profile => profile.id)).size !== catalog.profiles.length) throw Error('Ambiguous native profiles')
  if (profileId !== undefined) {
    const profile = catalog.selected_profile
    if (profile?.id !== profileId || !catalog.profiles.some(row => row.id === profile.id && row.profile_revision === profile.profile_revision && row.provider_id === profile.provider_id)
      || !Array.isArray(catalog.models) || catalog.models.some(model => typeof model.id !== 'string' || !model.id)
      || new Set(catalog.models.map(model => model.id)).size !== catalog.models.length) throw Error('Native model catalogue differs')
  }
  return catalog
}
export function nativeConfigurationTarget(team, { catalog, modelId, effort = null, id }) {
  validateNativeCatalog(team, catalog, catalog?.selected_profile?.id ?? '')
  const profile = catalog.selected_profile, model = catalog.models.find(row => row.id === modelId)
  if (!valid(id) || !model || effort !== null && !model.reasoningEfforts?.some(value => (typeof value === 'string' ? value : value?.id) === effort)) throw Error('Select a verified native model')
  return { id, host_id: team.home_hub, executor_profile_id: profile.id, executor_profile_revision: profile.profile_revision,
    provider_id: profile.provider_id, model_id: model.id, effort }
}
export async function readNativeCatalog(team, profileId, signal) {
  const response = await fetch('/api/kode/interactive-teams/catalog' + (profileId ? '?profile_id=' + encodeURIComponent(profileId) : ''), {
    credentials: 'same-origin', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })
  if (!response.ok) throw Error('Native catalogue unavailable')
  return validateNativeCatalog(team, await response.json(), profileId)
}

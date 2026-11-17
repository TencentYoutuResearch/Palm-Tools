/** Explicit, reversible local migration; never modifies legacy profiles or bindings.
 * Equality uses executable/args/env/protocol, never labels or model names. Managed
 * inference and allowedModels are security policies and are NEVER unioned.
 */
import { normalizeProfile, profileRevision } from './agent-profiles.js'
import { normalizeTeamRoles, preferenceDigest, preferenceId, preferencePayload } from './local-agent-preferences.js'
const identity = profile => {
  const { type, executable, args, env, protocol } = normalizeProfile(profile)
  return { type, ...(protocol ? { protocol } : {}), ...(type === 'dsh' ? {} : { executable, args, env }) }
}
export function planAgentProfileMigration(profiles, preferences, recipe, effectiveModelDefaults) {
  if (!recipe || !preferenceId(recipe.id) || !Array.isArray(recipe.groups) || recipe.groups.length > 256 || !Array.isArray(recipe.archiveProfileIds ?? []) || (recipe.archiveProfileIds?.length ?? 0) > 256 || !recipe.groups.length && !recipe.archiveProfileIds?.length) throw Error('Explicit Agent migration groups required')
  if (!Array.isArray(profiles) || new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw Error('Unique source Agent profiles required')
  const canonicalIds = new Set(recipe.groups.map(group => group?.id))
  const source = new Map(profiles.map(profile => [profile.id, profile])), before = preferencePayload(preferences), after = structuredClone(before)
  const seen = new Set(), provenance = {}, sourceRevisions = {}, sourceSelections = {}
  for (const group of recipe.groups) {
    if (!preferenceId(group.id) || !Array.isArray(group.sourceProfileIds) || !group.sourceProfileIds.length || new Set(group.sourceProfileIds).size !== group.sourceProfileIds.length || seen.has(group.id)) throw Error('Invalid or duplicate canonical Agent group')
    seen.add(group.id)
    const rows = group.sourceProfileIds.map(id => {
      const row = source.get(id)
      if (!row || Object.hasOwn(provenance, id) || canonicalIds.has(id)) throw Error('Invalid or duplicate legacy Agent source')
      return row
    })
    const executable = identity(rows[0])
    if (rows.some(row => preferenceDigest(identity(row)) !== preferenceDigest(executable))) throw Error('Cannot merge distinct CLI identities or environments')
    const existing = source.get(group.id)
    if (after.agentCatalog.some(profile => profile.id === group.id)) throw Error('Canonical Agent catalog entry already exists')
    if (existing && (preferenceDigest(identity(existing)) !== preferenceDigest(executable) || existing.managedInference || existing.allowedModels || existing.defaultModel || existing.defaultReasoningEffort)) throw Error('Canonical Agent must be a matching plain CLI identity')
    const canonical = existing ?? normalizeProfile({ id: group.id, name: group.name, ...executable })
    if (!existing) after.agentCatalog.push({ id: canonical.id, name: canonical.name, sourceProfileId: rows[0].id, sourceProfileRevision: profileRevision(rows[0]) })
    if (existing && source.has(group.id)) sourceRevisions[group.id] = profileRevision(existing)
    for (const row of rows) {
      if (Object.hasOwn(after.profileAliases, row.id) && after.profileAliases[row.id].profileId !== canonical.id) throw Error('Legacy Agent already has another canonical identity')
      Object.defineProperty(after.profileAliases, row.id, { value: { profileId: canonical.id, sourceProfileRevision: profileRevision(row) }, enumerable: true, configurable: true, writable: true })
      sourceRevisions[row.id] = profileRevision(row)
      Object.defineProperty(provenance, row.id, { value: canonical.id, enumerable: true })
      // Keep the old default under its old reference. No winner is guessed for
      // a canonical CLI with several model choices.
      const embedded = row.defaultModel || row.defaultReasoningEffort ? { ...(row.defaultModel ? { model: row.defaultModel } : {}), ...(row.defaultReasoningEffort ? { reasoningEffort: row.defaultReasoningEffort } : {}) } : null
      const selection = effectiveModelDefaults === undefined
        ? Object.hasOwn(before.modelDefaults, row.id) ? before.modelDefaults[row.id] : embedded
        : Object.hasOwn(effectiveModelDefaults, row.id) ? effectiveModelDefaults[row.id] : undefined
      if (selection === undefined) throw Error('Effective source model selection required')
      Object.defineProperty(sourceSelections, row.id, { value: structuredClone(selection), enumerable: true })
      if (!Object.hasOwn(after.modelDefaults, row.id) && selection !== null) after.modelDefaults[row.id] = structuredClone(selection)
    }
  }
  // Archiving is presentation-only. Unlike aliases it claims no executable
  // equivalence, so absolute paths and PATH-resolved commands stay distinct.
  const archived = new Set()
  for (const id of recipe.archiveProfileIds ?? []) {
    const row = source.get(id)
    if (!row || archived.has(id) || canonicalIds.has(id) || Object.hasOwn(provenance, id) || row.origin === 'builtin' || id.startsWith('builtin-')) throw Error('Invalid or duplicate archived Agent source')
    archived.add(id)
    sourceRevisions[id] = profileRevision(row)
    after.archivedProfiles[id] = sourceRevisions[id]
  }
  for (const [team, roles] of Object.entries(recipe.teamRoles ?? {})) {
    if (Object.hasOwn(after.teamRoles, team)) throw Error('Team preferences already exist; edit them explicitly')
    const assignments = Object.fromEntries(Object.entries(roles).map(([role, value]) => {
      const row = source.get(value?.sourceProfileId), profileId = provenance[value?.sourceProfileId]
      if (!row || !profileId) throw Error('Role must reference a declared migration source')
      const { sourceProfileId, model, reasoningEffort, fast, ...extra } = value
      if (Object.keys(extra).length) throw Error('Unknown role preference field')
      // Respect current local choices (including reset tombstones), not an
      // obsolete model default embedded in the legacy execution profile.
      const selection = after.modelDefaults[sourceProfileId] ?? {}
      const selectedModel = model ?? selection.model
      const sameModel = model === undefined || model === selection.model
      const selectedEffort = reasoningEffort ?? (sameModel ? selection.reasoningEffort : undefined)
      const selectedFast = fast ?? (sameModel ? selection.fast : undefined)
      return [role, { profileId, model: selectedModel, ...(selectedEffort === undefined ? {} : { reasoningEffort: selectedEffort }), ...(selectedFast === undefined ? {} : { fast: selectedFast }), sourceProfileId, sourceProfileRevision: profileRevision(row) }]
    }))
    Object.defineProperty(after.teamRoles, team, { value: normalizeTeamRoles({ [team]: assignments })[team], enumerable: true, configurable: true, writable: true })
  }
  const requestHash = preferenceDigest(recipe)
  return { id: recipe.id, requestHash, expectedRevision: preferences.revision, sourceRevisions, sourceSelections, before, after, planHash: preferenceDigest({ before, after, sourceRevisions, sourceSelections, requestHash }), scope: 'local_host', eligibleForExecution: false }
}
// Runtime callers must resolve the full legacy fallback chain, not only fields
// embedded in profiles. Pure planners may supply the same explicit snapshot.
export function planRegistryAgentProfileMigration(registry, recipe) {
  const profiles = registry.list()
  const selections = Object.fromEntries(profiles.map(row => [row.id, registry.defaultModelFor(row.id) ?? null]))
  return planAgentProfileMigration(profiles, registry.localPreferences.snapshot(), recipe, selections)
}
export async function applyAgentProfileMigration(registry, plan) {
  // The caller must not change a reviewed plan while the local writer waits.
  plan = structuredClone(plan)
  const local = registry.localPreferences
  return local.update(state => {
    const prior = Object.hasOwn(state.migrations, plan.id) && state.migrations[plan.id]
    if (prior) {
      if (prior.planHash !== plan.planHash) throw Error('Migration ID was already used for another plan')
      return { id: plan.id, status: prior.status, scope: 'local_host' }
    }
    if (state.revision !== plan.expectedRevision || preferenceDigest(preferencePayload(state)) !== preferenceDigest(plan.before)) throw Error('Local preferences changed; prepare a new migration plan')
    if (plan.planHash !== preferenceDigest({ before: plan.before, after: plan.after, sourceRevisions: plan.sourceRevisions, sourceSelections: plan.sourceSelections, requestHash: plan.requestHash })) throw Error('Migration plan changed')
    for (const [id, revision] of Object.entries(plan.sourceRevisions)) if (profileRevision(registry.get(id)) !== revision) throw Error('Legacy Agent changed; prepare a new migration plan')
    for (const [id, selection] of Object.entries(plan.sourceSelections)) {
      if (preferenceDigest(registry.defaultModelFor(id) ?? null) !== preferenceDigest(selection)) throw Error('Effective source model selection changed; prepare a new migration plan')
    }
    Object.assign(state, structuredClone(plan.after))
    Object.defineProperty(state.migrations, plan.id, { value: { status: 'applied', planHash: plan.planHash, before: structuredClone(plan.before), afterHash: preferenceDigest(plan.after) }, enumerable: true, configurable: true, writable: true })
    return { id: plan.id, status: 'applied', scope: 'local_host' }
  })
}
export async function rollbackAgentProfileMigration(registry, id, expectedRevision) {
  return registry.localPreferences.update(state => {
    const migration = Object.hasOwn(state.migrations, id) && state.migrations[id]
    if (!migration) throw Error('Unknown local Agent migration')
    if (migration.status === 'rolled_back') return { id, status: 'rolled_back', scope: 'local_host' }
    if (preferenceDigest(preferencePayload(state)) !== migration.afterHash) throw Error('Local preferences changed; rollback would overwrite newer choices')
    // New sessions may now hold canonical snapshots. Retain their exact routing
    // profile even after undoing the catalog, just as old bindings are retained.
    const retained = state.agentCatalog.filter(profile => Object.values(registry.bindings).some(binding => binding.profile?.id === profile.id))
    Object.assign(state, structuredClone(migration.before))
    for (const profile of retained) if (!state.agentCatalog.some(row => row.id === profile.id)) state.agentCatalog.push(profile)
    migration.status = 'rolled_back'
    return { id, status: 'rolled_back', scope: 'local_host' }
  }, expectedRevision)
}


/** Read-only sync diff. Call existing owner profile-save for each approved
 * addition, then preview the migration separately. Never imports user state.
 */
export function previewPlainAgentSync(sourceProfiles, targetProfiles) {
  if (!Array.isArray(sourceProfiles) || !Array.isArray(targetProfiles)) throw Error('Agent profile arrays required')
  if (new Set(sourceProfiles.map(row => row.id)).size !== sourceProfiles.length || new Set(targetProfiles.map(row => row.id)).size !== targetProfiles.length) throw Error('Unique sync profile identities required')
  const targets = new Map(targetProfiles.map(row => [row.id, row]))
  const additions = [], unchanged = [], skipped = []
  for (const row of sourceProfiles) {
    if (row.args?.length || Object.keys(row.env ?? {}).length || row.managedInference || row.allowedModels) {
      skipped.push({ profileId: row.id, reason: 'Review nonempty arguments, environment or execution policy in native settings; not copied' })
      continue
    }
    const profile = normalizeProfile({ id: row.id, name: row.name, type: row.type, ...(row.executable ? { executable: row.executable } : {}), ...(row.protocol ? { protocol: row.protocol } : {}) })
    const existing = targets.get(profile.id)
    if (existing) {
      if (!existing.args?.length && !Object.keys(existing.env ?? {}).length && !existing.managedInference && !existing.allowedModels && preferenceDigest(identity(existing)) === preferenceDigest(identity(profile))) unchanged.push(profile.id)
      else skipped.push({ profileId: profile.id, reason: 'Existing identity differs; no overwrite' })
    } else if (profile.id.startsWith('builtin-')) skipped.push({ profileId: profile.id, reason: 'Built-in identity is installed by its runtime' })
    else additions.push(profile)
  }
  return { additions, unchanged, skipped, scope: 'local_host', eligibleForExecution: false,
    copiedFields: ['id', 'name', 'type', 'executable', 'protocol'],
    excludedState: ['bindings', 'defaultProfileId', 'modelDefaults', 'managedInference', 'allowedModels', 'teamRoles'],
    warning: 'Imported identities are ordinary CLI conversations only; native tool permissions may differ from managed workflows. Review before saving; no default or history changes.' }
}

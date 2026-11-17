/** Personal model/role choices and native Agent catalog. This file never syncs to a Hub.
 * Roles are suggestions, not grants. Legacy execution profiles remain authoritative
 * for existing runs and their exact profile revisions.
 */
import { readFile, mkdir, open, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { writePrivateJson } from './private-json-store.js'
import { normalizeBuilderPrompt } from './builder-settings.js'

export const preferenceId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
const record = value => value && typeof value === 'object' && !Array.isArray(value)
const string = (value, label, max = 256) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw Error(`Invalid ${label}`)
  return value
}
export function normalizePreferenceSelection(value, requireModel = true) {
  if (!record(value) || Object.keys(value).some(key => !['model', 'reasoningEffort', 'fast'].includes(key))) throw Error('Invalid model selection')
  const selection = value.model === undefined && !requireModel ? {} : { model: string(value.model, 'model') }
  if (value.reasoningEffort != null) selection.reasoningEffort = string(value.reasoningEffort, 'reasoning effort', 128)
  if (value.fast !== undefined) {
    if (typeof value.fast !== 'boolean') throw Error('Fast 必须是布尔值。')
    selection.fast = value.fast
  }
  return selection
}
export function normalizeTeamRoles(value) {
  if (!record(value) || Object.keys(value).length > 256) throw Error('Invalid Team role preferences')
  return Object.fromEntries(Object.entries(value).map(([team, roles]) => {
    if (!preferenceId(team) || !record(roles) || Object.keys(roles).length > 64) throw Error('Invalid Team role preferences')
    return [team, Object.fromEntries(Object.entries(roles).map(([role, assignment]) => {
      if (!preferenceId(role) || !record(assignment) || !preferenceId(assignment.profileId)
          || Object.keys(assignment).some(key => !['profileId', 'model', 'reasoningEffort', 'fast', 'sourceProfileId', 'sourceProfileRevision'].includes(key))) throw Error('Invalid Team role assignment')
      const { profileId, sourceProfileId, sourceProfileRevision, ...model } = assignment
      if ((sourceProfileId === undefined) !== (sourceProfileRevision === undefined)
          || sourceProfileId !== undefined && (!preferenceId(sourceProfileId) || !/^[a-f0-9]{64}$/.test(sourceProfileRevision))) throw Error('Invalid legacy role source')
      return [role, { profileId, ...normalizePreferenceSelection(model), ...(sourceProfileId === undefined ? {} : { sourceProfileId, sourceProfileRevision }) }]
    }))]
  }))
}
// Candidate order carries no execution, fallback or concurrency semantics.
export function normalizeRoleTargets(value) {
  if (!record(value) || Object.keys(value).length > 256) throw Error('Invalid role target preferences')
  return Object.fromEntries(Object.entries(value).map(([team, roles]) => {
    if (!preferenceId(team) || !record(roles) || Object.keys(roles).length > 64) throw Error('Invalid role targets')
    return [team, Object.fromEntries(Object.entries(roles).map(([role, candidates]) => {
      if (!preferenceId(role) || !Array.isArray(candidates) || candidates.length > 64) throw Error('Invalid role candidates')
      const unique = new Map()
      for (const candidate of candidates) {
        const normalized = normalizeTeamRoles({ [team]: { [role]: candidate } })[team][role]
        unique.set(preferenceDigest(normalized), normalized)
      }
      return [role, [...unique.values()]]
    }))]
  }))
}
const migrateRoles = roles => Object.fromEntries(Object.entries(roles).map(([team, assignments]) => [team, Object.fromEntries(Object.entries(assignments).map(([role, candidate]) => [role, [candidate]]))]))
const empty = () => ({ version: 1, revision: 0, modelDefaults: {}, teamRoles: {}, roleTargets: {}, agentCatalog: [], profileAliases: {}, archivedProfiles: {}, migrations: {} })
export function preferencePayload(state) {
  const { modelDefaults, teamRoles, agentCatalog, profileAliases, archivedProfiles = {}, roleTargets = {} } = state
  return structuredClone({ modelDefaults, teamRoles, agentCatalog, profileAliases, archivedProfiles, roleTargets })
}
const stable = value => Array.isArray(value) ? value.map(stable) : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
export const preferenceDigest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
function normalize(value) {
  if (value?.builderSystemPrompt !== undefined) normalizeBuilderPrompt(value.builderSystemPrompt)
  if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !record(value.modelDefaults) || !record(value.profileAliases) || !Array.isArray(value.agentCatalog) || !record(value.migrations)) throw Error('Invalid local Agent preferences')
  const archivedProfiles = value.archivedProfiles ?? {}
  if (!record(archivedProfiles) || Object.entries(archivedProfiles).some(([id, revision]) => !preferenceId(id) || !/^[a-f0-9]{64}$/.test(revision))) throw Error('Invalid archived Agent reference')
  const modelDefaults = Object.fromEntries(Object.entries(value.modelDefaults).map(([id, selection]) => {
    if (!preferenceId(id)) throw Error('Invalid profile preference')
    // null is a reset tombstone: do not resurrect a legacy shared default.
    return [id, selection === null ? null : normalizePreferenceSelection(selection, false)]
  }))
  for (const [source, target] of Object.entries(value.profileAliases)) if (!preferenceId(source) || !record(target) || !preferenceId(target.profileId) || source === target.profileId || !/^[a-f0-9]{64}$/.test(target.sourceProfileRevision)) throw Error('Invalid Agent catalog alias')
  for (const profile of value.agentCatalog) if (!record(profile) || !preferenceId(profile.id) || !preferenceId(profile.sourceProfileId)
      || !/^[a-f0-9]{64}$/.test(profile.sourceProfileRevision) || typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 160
      || Object.keys(profile).some(key => !['id', 'name', 'sourceProfileId', 'sourceProfileRevision'].includes(key))) throw Error('Agent catalog must reference an existing CLI configuration')
  if (new Set(value.agentCatalog.map(profile => profile.id)).size !== value.agentCatalog.length) throw Error('Duplicate native Agent identity')
  return { ...structuredClone(value), archivedProfiles: structuredClone(archivedProfiles), modelDefaults, teamRoles: normalizeTeamRoles(value.teamRoles), roleTargets: normalizeRoleTargets(value.roleTargets ?? migrateRoles(normalizeTeamRoles(value.teamRoles))) }
}
export class LocalAgentPreferences {
  constructor(path) { this.path = path; this.state = empty(); this.chain = Promise.resolve() }
  async open() {
    try { this.state = normalize(JSON.parse(await readFile(this.path, 'utf8'))) }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.state = empty() }
    return this
  }
  snapshot() { return structuredClone(this.state) }
  update(operation, expectedRevision) {
    const task = this.chain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      // Independent UI/Host instances must not overwrite a newer local choice.
      let lock
      for (let attempt = 0; !lock; attempt++) {
        try { lock = await open(`${this.path}.lock`, 'wx', 0o600) }
        catch (error) { if (error.code !== 'EEXIST' || attempt >= 100) throw error; await setTimeout(10) }
      }
      try {
        await this.open()
        if (expectedRevision !== undefined && expectedRevision !== this.state.revision) throw Error('Local preferences changed; reload before saving')
        const state = this.snapshot(), before = preferenceDigest(state), result = await operation(state)
        if (preferenceDigest(state) !== before) {
          state.revision++
          const validated = normalize(state)
          await writePrivateJson(this.path, validated)
          this.state = validated
        }
        return structuredClone(result)
      } finally { await lock.close(); await rm(`${this.path}.lock`, { force: true }) }
    })
    this.chain = task.catch(() => {})
    return task
  }
  selectionFor(id, fallback) { return Object.hasOwn(this.state.modelDefaults, id) ? structuredClone(this.state.modelDefaults[id] ?? undefined) : structuredClone(fallback) }
  setModel(id, selection) {
    if (!preferenceId(id)) throw Error('Invalid profile preference')
    const normalized = selection === null ? null : normalizePreferenceSelection(selection, false)
    return this.update(state => { Object.defineProperty(state.modelDefaults, id, { value: normalized, configurable: true, writable: true, enumerable: true }); return { profileId: id, defaultModelSelection: normalized } })
  }
  setTeamRoles(teamId, assignments, expectedRevision) {
    const roles = normalizeTeamRoles({ [teamId]: assignments })[teamId]
    return this.update(state => {
      const changed = !Object.hasOwn(state.teamRoles, teamId) || preferenceDigest(state.teamRoles[teamId]) !== preferenceDigest(roles)
      Object.defineProperty(state.teamRoles, teamId, { value: roles, configurable: true, writable: true, enumerable: true })
      return { teamId, assignments: roles, preferenceRevision: state.revision + Number(changed), scope: 'local_host', eligibleForExecution: false }
    }, expectedRevision)
  }
  targetsFor(teamId) { return Object.hasOwn(this.state.roleTargets, teamId) ? structuredClone(this.state.roleTargets[teamId]) : {} }
  setRoleTargets(teamId, assignments, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw Error('Versioned local Team preferences required')
    const roles = normalizeRoleTargets({ [teamId]: assignments })[teamId]
    return this.update(state => {
      const changed = !Object.hasOwn(state.roleTargets, teamId) || preferenceDigest(state.roleTargets[teamId]) !== preferenceDigest(roles)
      Object.defineProperty(state.roleTargets, teamId, { value: roles, configurable: true, writable: true, enumerable: true })
      return { version: 1, teamId, assignments: roles, preferenceRevision: state.revision + Number(changed), scope: 'local_host', eligibleForExecution: false }
    }, expectedRevision)
  }
  rolesFor(teamId) { return Object.hasOwn(this.state.teamRoles, teamId) ? structuredClone(this.state.teamRoles[teamId]) : {} }
}

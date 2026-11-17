#!/usr/bin/env node
/** Explicit offline maintenance only. Never stop/start a Host or read credentials.
 * No online atomicity claim: the operator must keep the Host stopped throughout.
 */
import { readFile, writeFile, mkdir, mkdtemp, chmod, lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { connect } from 'node:net'
import { isDeepStrictEqual } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { AgentProfiles, normalizeProfile } from '../src/agent-profiles.js'
import { previewPlainAgentSync, planRegistryAgentProfileMigration, applyAgentProfileMigration } from '../src/agent-profile-migration.js'
import { preferenceDigest } from '../src/local-agent-preferences.js'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function snapshot(path, optional = false) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Regular configuration file required')
    const bytes = await readFile(path)
    return { bytes, hash: sha(bytes) }
  } catch (error) { if (optional && error.code === 'ENOENT') return { bytes: null, hash: null }; throw error }
}
export function readPlainSource(path, revision) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON')
    db.exec('BEGIN')
    const row = db.prepare('SELECT revision FROM workbench_documents WHERE key=?').get('agents')
    if (!row || row.revision !== revision) throw Error('Daily Agent revision changed; review again')
    // Never SELECT the whole JSON document: arguments/environment values can
    // contain credentials. Only project ordinary CLI fields and policy flags.
    return db.prepare(`SELECT json_extract(p.value,'$.id') AS id,
      json_extract(p.value,'$.name') AS name, json_extract(p.value,'$.type') AS type,
      json_extract(p.value,'$.executable') AS executable, json_extract(p.value,'$.protocol') AS protocol,
      COALESCE(json_array_length(p.value,'$.args'),0) + CASE WHEN json_type(p.value,'$.args') NOT IN ('array','null') THEN 1 ELSE 0 END AS argument_count,
      (SELECT COUNT(*) FROM json_each(p.value,'$.env')) + CASE WHEN json_type(p.value,'$.env') NOT IN ('object','null') THEN 1 ELSE 0 END AS environment_count,
      json_type(p.value,'$.managedInference') IS NOT NULL AND json_type(p.value,'$.managedInference') != 'null' AS managed,
      json_type(p.value,'$.allowedModels') IS NOT NULL AND json_type(p.value,'$.allowedModels') != 'null' AS restricted
      FROM workbench_documents d, json_each(d.value,'$.profiles') p WHERE d.key='agents'`).all().map(row => ({
        id: row.id, name: row.name, type: row.type,
        ...(row.executable == null ? {} : { executable: row.executable }), ...(row.protocol == null ? {} : { protocol: row.protocol }),
        ...(row.argument_count || row.environment_count || row.managed || row.restricted ? { args: ['REQUIRES_NATIVE_REVIEW'] } : {}),
      }))
  } finally { db.close() }
}
export async function assertHostStopped({ stoppedPid, port }) {
  if (!Number.isSafeInteger(stoppedPid) || stoppedPid <= 1 || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error('Exact stopped Host PID and port required')
  try { process.kill(stoppedPid, 0); throw Error('Host PID still exists; stop safely first') }
  catch (error) { if (error.code !== 'ESRCH') throw error }
  await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); reject(Error('Host port is still listening')) })
    socket.once('error', error => { socket.destroy(); error.code === 'ECONNREFUSED' ? resolve() : reject(error) })
    socket.setTimeout(1000, () => { socket.destroy(); reject(Error('Host stopped state is uncertain')) })
  })
}
export async function syncPlainAgentCatalog(options, { checkStopped = assertHostStopped } = {}) {
  const agentsPath = resolve(options.agents), preferencesPath = `${agentsPath}.preferences.json`
  if (!Array.isArray(options.include) || !options.include.length || new Set(options.include).size !== options.include.length) throw Error('Explicit unique import IDs required')
  const original = await snapshot(agentsPath), preferences = await snapshot(preferencesPath, true)
  const document = JSON.parse(original.bytes)
  const known = ['version', 'profiles', 'bindings', 'defaultProfileId', 'modelDefaults', 'coordinatorStartPlans']
  if (Object.keys(document).some(key => !known.includes(key))) throw Error('Unrecognized Agent document fields; manual review required')
  const registry = new AgentProfiles(agentsPath)
  // Hydrate without open(), whose fresh-file branch writes. Preview is read-only.
  if (document.version !== 1 || !Array.isArray(document.profiles) || !document.bindings) throw Error('Existing Agent registry required')
  registry.profiles = document.profiles.map(row => ({ ...normalizeProfile(row), ...(row.origin === 'builtin' ? { origin: 'builtin' } : {}) }))
  if (!isDeepStrictEqual(registry.profiles, document.profiles)) throw Error('Existing profiles require normalization; refuse implicit changes')
  registry.bindings = structuredClone(document.bindings)
  registry.defaultProfileId = document.defaultProfileId ?? null
  registry.modelDefaults = structuredClone(document.modelDefaults ?? {})
  registry.coordinatorStartPlans = structuredClone(document.coordinatorStartPlans ?? {})
  await registry.localPreferences.open()
  const source = readPlainSource(resolve(options.sourceDb), options.sourceRevision)
  if (new Set(source.map(row => row.id)).size !== source.length) throw Error('Duplicate source identity; review again')
  const selected = options.include.map(id => { const row = source.find(row => row.id === id); if (!row) throw Error('Requested source identity unavailable'); return row })
  const diff = previewPlainAgentSync(selected, registry.profiles)
  if (diff.skipped.length) throw Error('Selected identity has arguments, environment, policy or target conflict; use native settings')
  const priorDefaults = Object.fromEntries(registry.list().map(row => [row.id, registry.defaultModelFor(row.id) ?? null]))
  registry.profiles.push(...diff.additions)
  const plan = planRegistryAgentProfileMigration(registry, options.recipe)
  registry.profiles = registry.profiles.slice(0, document.profiles.length)
  const reviewed = { agentsPath, sourceDb: resolve(options.sourceDb), sourceRevision: options.sourceRevision,
    agentsHash: original.hash, preferencesHash: preferences.hash, additions: diff.additions,
    unchanged: diff.unchanged, recipe: options.recipe, migrationPlanHash: plan.planHash,
    stoppedPid: options.stoppedPid, port: options.port }
  const planHash = preferenceDigest(reviewed)
  const result = { ...reviewed, planHash, status: 'preview', eligibleForExecution: false,
    warning: 'Ordinary CLI identities only. Never modify managed policies. Native tools may differ; keep Host stopped. No defaults, bindings, team state or credentials imported.' }
  if (!options.apply) return result
  if (options.apply !== planHash) throw Error('Reviewed offline plan hash changed; preview again')
  let expectedAgents = original.hash, expectedPreferences = preferences.hash, backupDirectory
  async function check() {
    await checkStopped(options)
    readPlainSource(resolve(options.sourceDb), options.sourceRevision)
    if ((await snapshot(agentsPath)).hash !== expectedAgents || (await snapshot(preferencesPath, true)).hash !== expectedPreferences) throw Error('Configuration CAS failed; external writer detected')
  }
  function invariant() {
    if (preferenceDigest(registry.bindings) !== preferenceDigest(document.bindings) || registry.defaultProfileId !== (document.defaultProfileId ?? null)
      || !isDeepStrictEqual(registry.modelDefaults, document.modelDefaults ?? {})
      || preferenceDigest(registry.coordinatorStartPlans) !== preferenceDigest(document.coordinatorStartPlans ?? {})
      || !document.profiles.every((row, i) => isDeepStrictEqual(registry.profiles[i], row))
      || !Object.entries(priorDefaults).every(([id, value]) => isDeepStrictEqual(registry.defaultModelFor(id) ?? null, value))) throw Error('Protected Agent state changed')
  }
  try {
    await check()
    const backups = join(dirname(agentsPath), 'agent-sync-backups')
    await mkdir(backups, { recursive: true, mode: 0o700 })
    if (!(await lstat(backups)).isDirectory() || (await lstat(backups)).isSymbolicLink()) throw Error('Private backup directory required')
    backupDirectory = await mkdtemp(join(backups, 'sync-')); await chmod(backupDirectory, 0o700)
    await writeFile(join(backupDirectory, 'agents.json'), original.bytes, { mode: 0o600, flag: 'wx' })
    if (preferences.bytes) await writeFile(join(backupDirectory, 'agents.json.preferences.json'), preferences.bytes, { mode: 0o600, flag: 'wx' })
    await writeFile(join(backupDirectory, 'manifest.json'), JSON.stringify({ ...reviewed, planHash, preferencesExisted: preferences.bytes !== null }), { mode: 0o600, flag: 'wx' })
    for (const profile of diff.additions) {
      await check()
      if (registry.list().some(row => row.id === profile.id)) throw Error('Import ID now exists; refusing overwrite')
      await registry.save(profile)
      expectedAgents = sha(JSON.stringify({ version: 1, defaultProfileId: registry.defaultProfileId, modelDefaults: registry.modelDefaults, profiles: registry.profiles, bindings: registry.bindings, coordinatorStartPlans: registry.coordinatorStartPlans }, null, 2))
      invariant()
    }
    await check()
    const current = planRegistryAgentProfileMigration(registry, options.recipe)
    if (current.planHash !== plan.planHash) throw Error('Migration plan changed after import')
    await applyAgentProfileMigration(registry, current)
    expectedPreferences = sha(JSON.stringify(registry.localPreferences.state, null, 2))
    invariant(); await check()
    return { ...result, status: 'applied', backupDirectory, finalAgentsHash: expectedAgents, finalPreferencesHash: expectedPreferences }
  } catch (error) {
    // Never overwrite potentially newer data on failure. Private backups and a
    // partial-state report permit operator-reviewed recovery while still stopped.
    error.message += backupDirectory ? `; stopped maintenance incomplete; recovery copy: ${backupDirectory}` : '; no maintenance backup created'
    throw error
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), values = {}
    for (let i = 0; i < args.length; i += 2) {
      if (!args[i]?.startsWith('--') || !args[i + 1] || Object.hasOwn(values, args[i])) throw Error('Unique --option value pairs required')
      values[args[i]] = args[i + 1]
    }
    const allowed = ['--agents','--source-db','--source-revision','--include','--archive','--alias','--migration-id','--stopped-pid','--port','--apply']
    if (Object.keys(values).some(key => !allowed.includes(key))) throw Error('Unknown option')
    const groups = (values['--alias'] ?? '').split(',').filter(Boolean).map(pair => { const [source, id, extra] = pair.split('='); if (!source || !id || extra) throw Error('Alias must be source=canonical'); return { id, sourceProfileIds: [source] } })
    const output = await syncPlainAgentCatalog({ agents: values['--agents'], sourceDb: values['--source-db'], sourceRevision: Number(values['--source-revision']),
      include: values['--include']?.split(','), stoppedPid: Number(values['--stopped-pid']), port: Number(values['--port']), apply: values['--apply'],
      recipe: { id: values['--migration-id'], groups, archiveProfileIds: (values['--archive'] ?? '').split(',').filter(Boolean) } })
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}

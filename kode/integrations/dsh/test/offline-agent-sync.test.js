import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentProfiles } from '../src/agent-profiles.js'
import { syncPlainAgentCatalog, assertHostStopped } from '../scripts/sync-plain-agent-catalog.js'
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'kode-offline-sync-'))
  try {
    const agents = join(root, 'agents.json'), sourceDb = join(root, 'source.sqlite')
    const registry = await new AgentProfiles(agents).open([
      { id: 'plain', name: 'Plain', type: 'codex', executable: '/fixture/codex' },
      { id: 'role', name: 'Role', type: 'claude', executable: '/fixture/tclaude', allowedModels: ['one'], defaultModel: 'one',
        managedInference: { bootstrap: { executable: '/fixture/claude', pathVariable: 'TCLAUDE_CLAUDE_PATH', provider: 'fixture', home: '/fixture/home' } } },
    ])
    await registry.bind('historic', 'role')
    await registry.patchBinding('historic', { managedAssignment: { id: 'work' }, stopBlocked: true, usageOutbox: { pending: {} } })
    await registry.setDefaultProfile('role')
    const db = new DatabaseSync(sourceDb)
    db.exec('CREATE TABLE workbench_documents (key TEXT PRIMARY KEY, revision INTEGER, value TEXT)')
    db.prepare('INSERT INTO workbench_documents VALUES (?,?,?)').run('agents', 7, JSON.stringify({
      defaultProfileId: 'ignore-default', bindings: { secretSession: { content: 'DO_NOT_COPY_SESSION' } }, modelDefaults: { tcodex: { model: 'DO_NOT_COPY_MODEL' } },
      profiles: [{ id: 'tcodex', name: 'TCodex', type: 'codex', executable: 'tcodex' },
        { id: 'gateway', name: 'Gateway', type: 'codex', executable: '/usr/bin/env', args: ['DO_NOT_READ_ARGUMENT'] },
        { id: 'environment', name: 'Environment', type: 'codex', env: { API_SECRET: 'DO_NOT_READ_ENVIRONMENT' } }],
    }))
    db.close()
    const options = { agents, sourceDb, sourceRevision: 7, include: ['tcodex'], stoppedPid: 2147483647, port: 65530,
      recipe: { id: 'offline-sync', groups: [], archiveProfileIds: ['role'] } }
    await run({ options, registry, root })
  } finally { await rm(root, { recursive: true, force: true }) }
}
const stopped = { checkStopped: async () => {} }
test('offline plan is read-only; confirmed stopped maintenance preserves protected state and private backups', async () => fixture(async ({ options, registry, root }) => {
  const original = await readFile(options.agents, 'utf8'), before = JSON.parse(original)
  const plan = await syncPlainAgentCatalog(options)
  assert.equal(plan.status, 'preview')
  assert.ok(!JSON.stringify(plan).includes('DO_NOT_'))
  assert.equal(await readFile(options.agents, 'utf8'), original)
  await assert.rejects(stat(`${options.agents}.preferences.json`), { code: 'ENOENT' })
  await assert.rejects(stat(join(root, 'agent-sync-backups')), { code: 'ENOENT' })
  const result = await syncPlainAgentCatalog({ ...options, apply: plan.planHash }, stopped)
  assert.equal(result.status, 'applied')
  const after = JSON.parse(await readFile(options.agents, 'utf8'))
  assert.deepEqual(after.bindings, before.bindings)
  assert.deepEqual(after.profiles.slice(0, 2), before.profiles)
  assert.equal(after.defaultProfileId, before.defaultProfileId)
  assert.deepEqual(after.modelDefaults, before.modelDefaults)
  const reopened = await new AgentProfiles(options.agents).open()
  assert.deepEqual(reopened.listAgents().map(row => row.id), ['plain', 'tcodex'])
  assert.deepEqual(reopened.binding('historic'), registry.binding('historic'))
  for (const file of await readdir(result.backupDirectory)) assert.equal((await stat(join(result.backupDirectory, file))).mode & 0o777, 0o600)
  assert.equal(await readFile(join(result.backupDirectory, 'agents.json'), 'utf8'), original)
  assert.equal(JSON.parse(await readFile(join(result.backupDirectory, 'manifest.json'), 'utf8')).preferencesExisted, false)
}))
test('offline apply refuses active Host and never creates backups', async () => fixture(async ({ options, root }) => {
  const plan = await syncPlainAgentCatalog(options)
  await assert.rejects(syncPlainAgentCatalog({ ...options, apply: plan.planHash }, { checkStopped: async () => { throw Error('Host active') } }), /Host active/)
  await assert.rejects(stat(join(root, 'agent-sync-backups')), { code: 'ENOENT' })
  await assert.rejects(assertHostStopped({ stoppedPid: process.pid, port: 65530 }), /PID still exists/)
}))
test('offline apply rejects changed source revision, target hash and unsafe source identities', async () => fixture(async ({ options }) => {
  const plan = await syncPlainAgentCatalog(options)
  await assert.rejects(syncPlainAgentCatalog({ ...options, include: ['gateway'] }), /arguments, environment/)
  await assert.rejects(syncPlainAgentCatalog({ ...options, include: ['environment'] }), /arguments, environment/)
  const db = new DatabaseSync(options.sourceDb)
  db.exec('UPDATE workbench_documents SET revision=8'); db.close()
  await assert.rejects(syncPlainAgentCatalog({ ...options, apply: plan.planHash }, stopped), /revision changed/)
  const newPlan = await syncPlainAgentCatalog({ ...options, sourceRevision: 8 })
  const before = await readFile(options.agents, 'utf8')
  await writeFile(options.agents, before + '\n')
  await assert.rejects(syncPlainAgentCatalog({ ...options, sourceRevision: 8, apply: newPlan.planHash }, stopped), /plan hash changed/)
}))
test('concurrent target writer is detected before import and no automatic rollback overwrites it', async () => fixture(async ({ options }) => {
  const plan = await syncPlainAgentCatalog(options), original = await readFile(options.agents, 'utf8')
  let checks = 0
  await assert.rejects(syncPlainAgentCatalog({ ...options, apply: plan.planHash }, { checkStopped: async () => {
    if (++checks === 2) await writeFile(options.agents, original + '\n')
  } }), /CAS failed.*recovery copy/)
  assert.equal(await readFile(options.agents, 'utf8'), original + '\n')
}))

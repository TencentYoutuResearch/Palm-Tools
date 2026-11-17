import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { AgentProfiles } from '../src/agent-profiles.js'
import { registerAgentApi } from '../src/agent-api.js'
import { createAgentMigrationApi } from '../src/agent-profile-migration-api.js'
const owner = { kind: 'owner', id: 'fixture-owner' }
const recipe = () => ({ id: 'split-v1', groups: [{ id: 'native', name: 'Native CLI', sourceProfileIds: ['legacy'] }], teamRoles: { team: { worker: { sourceProfileId: 'legacy' } } } })
const confirm = (preview, rollback = false) => ({ action: rollback ? 'confirm-agent-migration-rollback' : 'confirm-agent-migration', migrationId: preview.migrationId, planHash: preview.planHash, expectedRevision: preview.expectedRevision, acknowledgeOrdinaryPermissions: true })
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'kode-migration-api-'))
  try {
    const registry = await new AgentProfiles(join(root, 'agents.json')).open([{ id: 'legacy', name: 'Worker', type: 'codex', executable: '/fixture/codex', defaultModel: 'one', allowedModels: ['one'], managedInference: { endpoint: 'https://example.com/responses' } }])
    await registry.setDefaultProfile('legacy')
    let handler, refreshes = 0
    const ctx = { webServer: { register: route => { if (route.path === '/api/kode/agents') handler = route.handler; return () => {} } },
      connection: { admit: req => req.role === 'anonymous' ? { rejection: 401 } : { peer: { principal: req.role === 'owner' ? owner : { kind: 'guest' } } } },
      agents: { get: () => undefined }, agentDefaultModel: { currentSelection: () => ({}) }, sessionProjections: { stateOf: () => undefined } }
    const dispose = registerAgentApi(ctx, { profiles: registry, hasRuntime: () => true, adapter: { listModels: async () => [] }, refresh: () => refreshes++ })
    const request = async (body, role = 'owner') => {
      const req = Readable.from(body ? [JSON.stringify(body)] : [])
      Object.assign(req, { role, method: body ? 'POST' : 'GET', url: '/api/kode/agents?configuration=1', headers: { 'content-type': 'application/json' } })
      let result
      const res = { statusCode: 0, setHeader() {}, end: text => { result = { status: res.statusCode, body: JSON.parse(text) } } }
      await handler(req, res); return result
    }
    try { await run({ registry, request, refreshes: () => refreshes }) } finally { dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
}
test('owner-only endpoint previews without writes, confirms exact plan, keeps default and rolls back safely', async () => fixture(async ({ registry, request, refreshes }) => {
  const input = { action: 'preview-agent-migration', recipe: recipe() }
  assert.equal((await request(input, 'anonymous')).status, 401)
  assert.equal((await request(input, 'guest')).status, 403)
  const bytes = await readFile(registry.path, 'utf8')
  const preview = await request(input)
  assert.equal(preview.status, 200)
  assert.equal(preview.body.eligibleForExecution, false)
  assert.match(preview.body.ordinaryToolPermissions, /may_be_broader/)
  assert.equal(preview.body.defaultAgentUnchanged, true)
  assert.equal(preview.body.teamRoleExecution, 'unavailable')
  await assert.rejects(stat(registry.localPreferences.path), { code: 'ENOENT' })
  assert.equal(refreshes(), 0)
  assert.equal((await request({ ...confirm(preview.body), acknowledgeOrdinaryPermissions: false })).status, 400)
  assert.equal((await request({ ...confirm(preview.body), planHash: 'forged' })).status, 409)
  assert.equal((await request({ ...confirm(preview.body), plan: {} })).status, 400)
  assert.equal((await request(confirm(preview.body), 'guest')).status, 403)
  assert.equal((await request(confirm(preview.body))).body.status, 'applied')
  const revision = registry.localPreferences.state.revision
  assert.equal((await request(confirm(preview.body))).body.status, 'applied')
  assert.equal(registry.localPreferences.state.revision, revision)
  assert.equal((await request()).body.configuredDefaultProfileId, 'legacy')
  assert.equal((await request()).body.selectedProfileId, 'legacy')
  assert.equal(await readFile(registry.path, 'utf8'), bytes)
  await registry.bind('new-session', 'native')
  const binding = registry.binding('new-session')
  const undo = await request({ action: 'preview-agent-migration-rollback', migrationId: preview.body.migrationId })
  assert.equal(undo.status, 200)
  assert.equal((await request(confirm(undo.body, true))).body.status, 'rolled_back')
  const undone = registry.localPreferences.state.revision
  assert.equal((await request(confirm(undo.body, true))).body.status, 'rolled_back')
  assert.equal(registry.localPreferences.state.revision, undone)
  assert.deepEqual(registry.binding('new-session'), binding)
  assert.deepEqual(registry.get('native'), binding.profile)
}))
test('previews expire, bind owner and instance, and cannot be restored from a client plan', async () => fixture(async ({ registry }) => {
  let now = 0
  const api = createAgentMigrationApi(registry, { now: () => now })
  const preview = await api.run({ action: 'preview-agent-migration', recipe: recipe() }, owner)
  await assert.rejects(api.run(confirm(preview), { kind: 'owner', id: 'another-owner' }), /preview required/)
  await assert.rejects(createAgentMigrationApi(registry).run(confirm(preview), owner), /Host restart/)
  now = preview.expiresAt
  await assert.rejects(api.run(confirm(preview), owner), /expiry/)
  assert.equal(registry.localPreferences.state.revision, 0)
}))
test('stale source, newer local choices and same-ID competing plans fail closed', async () => fixture(async ({ registry, request }) => {
  let first = (await request({ action: 'preview-agent-migration', recipe: recipe() })).body
  await registry.update(state => { state.profiles[0].name = 'edited' })
  assert.equal((await request(confirm(first))).status, 409)
  first = (await request({ action: 'preview-agent-migration', recipe: recipe() })).body
  const other = recipe(); other.groups[0].name = 'Another name'
  const second = (await request({ action: 'preview-agent-migration', recipe: other })).body
  assert.notEqual(first.planHash, second.planHash)
  assert.equal((await request(confirm(first))).status, 200)
  assert.equal((await request(confirm(second))).status, 409)
  const undo = (await request({ action: 'preview-agent-migration-rollback', migrationId: first.migrationId })).body
  await registry.setDefaultModel('native', { model: 'newer-choice' })
  assert.equal((await request(confirm(undo, true))).status, 409)
  assert.equal(registry.defaultModelFor('native').model, 'newer-choice')
}))


test('migration preserves implicit defaults when no explicit default was saved', async () => fixture(async ({ registry, request }) => {
  await registry.setDefaultProfile(null)
  const before = (await request()).body.defaultProfileId
  const preview = (await request({ action: 'preview-agent-migration', recipe: recipe() })).body
  assert.equal((await request(confirm(preview))).status, 200)
  assert.equal(registry.defaultProfileId, null)
  assert.equal((await request()).body.defaultProfileId, before)
}))


for (const source of ['modelDefaults', 'legacyLocalModelDefaults']) test(`API binds effective ${source} into preview and confirmation`, async () => fixture(async ({ registry, request }) => {
  registry[source] = { legacy: { model: 'chosen-later', reasoningEffort: 'high' } }
  const first = (await request({ action: 'preview-agent-migration', recipe: recipe() })).body
  assert.equal(first.teamRoles.team.worker.model, 'chosen-later')
  assert.equal(first.teamRoles.team.worker.reasoningEffort, 'high')
  registry[source].legacy = { model: 'newer-choice' }
  assert.equal((await request(confirm(first))).status, 409)
  const second = (await request({ action: 'preview-agent-migration', recipe: recipe() })).body
  assert.notEqual(first.planHash, second.planHash)
  assert.equal((await request(confirm(second))).status, 200)
  assert.equal(registry.defaultModelFor('legacy').model, 'newer-choice')
  assert.equal(registry.teamRolesFor('team').worker.model, 'newer-choice')
}))


test('owner archive preview supports a distinct imported identity without aliasing different paths', async () => fixture(async ({ registry, request }) => {
  const saved = await request({ action: 'save', profile: { id: 'native-from-local', name: 'Local CLI', type: 'codex', executable: 'codex' } })
  assert.equal(saved.status, 200)
  const bytes = await readFile(registry.path, 'utf8')
  const preview = await request({ action: 'preview-agent-migration', recipe: { id: 'archive-old', groups: [], archiveProfileIds: ['legacy'] } })
  assert.equal(preview.status, 200)
  assert.equal(preview.body.archivedProfiles[0].profileId, 'legacy')
  assert.equal((await request(confirm(preview.body))).status, 200)
  assert.deepEqual(registry.listAgents().map(row => row.id), ['native-from-local'])
  assert.ok(registry.get('legacy').managedInference)
  assert.equal(registry.defaultProfileId, 'legacy')
  assert.equal(await readFile(registry.path, 'utf8'), bytes)
}))

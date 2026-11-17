import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalAgentPreferences, normalizeRoleTargets } from '../src/local-agent-preferences.js'
import { AgentProfiles, profileRevision } from '../src/agent-profiles.js'

test('versioned local candidates migrate, share identities, deduplicate and CAS without changing legacy roles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-role-targets-'))
  try {
    const path = join(root, 'preferences.json')
    const old = new LocalAgentPreferences(path).snapshot()
    delete old.roleTargets
    const a = { profileId: 'codex', model: 'one' }, b = { profileId: 'codex', model: 'two' }, c = { profileId: 'claude', model: 'three' }
    old.teamRoles = { team: { reviewer: a } }
    await writeFile(path, JSON.stringify(old))
    const prefs = await new LocalAgentPreferences(path).open()
    assert.deepEqual(prefs.targetsFor('team'), { reviewer: [a] })
    const result = await prefs.setRoleTargets('team', { reviewer: [a, b, c, a], writer: [a] }, 0)
    assert.equal(result.version, 1)
    assert.equal(result.eligibleForExecution, false)
    assert.deepEqual(result.assignments.reviewer, [a, b, c])
    assert.deepEqual(prefs.rolesFor('team'), { reviewer: a })
    await assert.rejects(prefs.setRoleTargets('team', {}, 0), /changed/)
    const reopened = await new LocalAgentPreferences(path).open()
    assert.deepEqual(reopened.targetsFor('team'), result.assignments)
    await reopened.setRoleTargets('team', {}, 1)
    assert.deepEqual(reopened.targetsFor('team'), {})
    assert.throws(() => normalizeRoleTargets({ team: { reviewer: a } }), /candidates/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('referenced Agent deletion refuses without cascade; model reset leaves runtime profile unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-role-agent-'))
  try {
    const profiles = await new AgentProfiles(join(root, 'profiles.json')).open()
    const p = await profiles.save({ name: 'CLI', type: 'codex', executable: 'fixture-codex' })
    await profiles.bind('old-session', p.id)
    const before = profiles.binding('old-session')
    await profiles.setDefaultModel(p.id, { model: 'one' })
    await profiles.setDefaultModel(p.id, null)
    assert.equal(profiles.defaultModelFor(p.id), undefined)
    await profiles.setTeamRoleTargets('team', { reviewer: [{ profileId: p.id, model: 'one' }, { profileId: p.id, model: 'two' }] }, profiles.localPreferences.state.revision)
    await assert.rejects(profiles.remove(p.id), /referenced/)
    assert.equal(profiles.teamRoleTargetsFor('team').reviewer.length, 2)
    await profiles.setTeamRoleTargets('team', {}, profiles.localPreferences.state.revision)
    await profiles.remove(p.id)
    assert.deepEqual(profiles.binding('old-session'), before)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('owner API exposes versioned candidate CRUD and offline reset, rejects stale or guest writes', async () => {
  const { Readable } = await import('node:stream')
  const { registerAgentApi } = await import('../src/agent-api.js')
  const root = await mkdtemp(join(tmpdir(), 'kode-candidate-api-'))
  let dispose
  try {
    const profiles = await new AgentProfiles(join(root, 'agents.json')).open()
    const p = await profiles.save({ name: 'CLI', type: 'codex', executable: 'fixture-codex' })
    let handler
    const ctx = { webServer: { register: route => { if (route.path === '/api/kode/agents') handler = route.handler; return () => {} } }, connection: { admit: req => ({ peer: { principal: { kind: req.role, id: 'fixture' } } }) }, agents: { get: () => undefined }, agentDefaultModel: { currentSelection: () => ({}) }, sessionProjections: { stateOf: () => undefined } }
    const hints = []
    dispose = registerAgentApi(ctx, { profiles, hasRuntime: () => true, adapter: { listModels: async (_route, _profile, hint) => { hints.push(hint); return [{ id: 'native', isDefault: true }, { id: 'legacy' }] } }, refresh() {} })
    async function request(body, role = 'owner') {
      const req = Readable.from(body ? [JSON.stringify(body)] : [])
      Object.assign(req, { role, method: body ? 'POST' : 'GET', url: '/api/kode/agents?configuration=1&team_id=team', headers: { 'content-type': 'application/json' } })
      let result
      const res = { statusCode: 0, setHeader() {}, end: text => { result = { status: res.statusCode, body: JSON.parse(text) } } }
      await handler(req, res); return result
    }
    const input = { action: 'set-team-role-targets', version: 1, teamId: 'team', expectedRevision: profiles.localPreferences.state.revision, assignments: { reviewer: [{ profileId: p.id, model: 'one' }, { profileId: p.id, model: 'two' }] } }
    assert.equal((await request(input, 'guest')).status, 403)
    assert.equal((await request({ ...input, version: 2 })).status, 400)
    assert.equal((await request(input)).status, 200)
    assert.equal((await request(input)).status, 409)
    const read = await request()
    assert.equal(read.status, 200)
    assert.deepEqual(read.body.teamRoleTargets.assignments, input.assignments)
    assert.deepEqual(read.body.teamRolePreferences.assignments, {})
    assert.equal((await request({ action: 'remove', profileId: p.id })).status, 400)
    await profiles.update(state => { state.profiles.find(row => row.id === p.id).defaultModel = 'legacy' })
    await profiles.setDefaultProfile(p.id)
    await profiles.setDefaultModel(p.id, { model: 'one' })
    assert.equal((await request({ action: 'reset-default-model', profileId: p.id })).status, 200)
    assert.equal(profiles.defaultModelFor(p.id), undefined)
    const resetRead = await request()
    assert.equal(resetRead.body.defaultModelSelection.model, 'native')
    assert.equal(hints.at(-1), undefined, 'reset must not seed discovery with legacy default')
    await rm(profiles.path)
    const unavailable = await request()
    assert.equal(unavailable.status, 200)
    assert.deepEqual(unavailable.body.teamRoleTargets.assignments, input.assignments)
    assert.deepEqual(unavailable.body.teamRoleTargets.diagnostics, [{ code: 'registry_unavailable' }])
  } finally { dispose?.(); await rm(root, { recursive: true, force: true }) }
})


test('authority snapshots diagnose orphan candidates without fallback for file and Hub registries', async () => {
  const { BackendAgentProfiles } = await import('../src/backend-state.js')
  const { readFile } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'kode-candidate-authority-'))
  try {
    for (const provider of ['file', 'hub']) {
      const path = join(root, provider + '.json')
      const seed = await new AgentProfiles(path).open()
      const p = await seed.save({ name: 'Candidate', type: 'codex', executable: 'fixture-codex' })
      const fallback = await seed.save({ name: 'Other', type: 'codex', executable: 'fixture-other' })
      await seed.setDefaultProfile(fallback.id)
      await seed.bind('old', p.id)
      const stored = JSON.parse(await readFile(path, 'utf8'))
      let authority = { ...stored, dsh_migrated: true }, failed = false
      const client = { call: async (_path, body) => {
        assert.equal(body, undefined, 'snapshot must not write Hub')
        if (failed) throw Error('fixture unavailable')
        return { revision: 1, value: structuredClone(authority) }
      } }
      const profiles = provider === 'hub' ? await new BackendAgentProfiles(client, path).open() : await new AgentProfiles(path).open()
      const before = profiles.binding('old')
      const assignments = { reviewer: [{ profileId: p.id, model: 'one' }] }
      await profiles.setTeamRoleTargets('team', assignments, profiles.localPreferences.state.revision)
      authority.profiles = authority.profiles.filter(row => row.id !== p.id)
      if (provider === 'file') await writeFile(path, JSON.stringify(authority))
      // Hub mode deliberately leaves the obsolete file claiming the Agent exists.
      assert.deepEqual(await profiles.teamRoleTargetDiagnostics('team'), [{ role: 'reviewer', index: 0, profileId: p.id, code: 'agent_missing' }])
      await assert.rejects(profiles.setTeamRoleTargets('team', assignments, profiles.localPreferences.state.revision), /agent_missing/)
      assert.deepEqual(profiles.teamRoleTargetsFor('team'), assignments)
      assert.deepEqual(profiles.binding('old'), before)
      if (provider === 'file') await rm(path)
      else failed = true
      assert.deepEqual(await profiles.teamRoleTargetDiagnostics('team'), [{ code: 'registry_unavailable' }])
      await assert.rejects(profiles.setTeamRoleTargets('team', assignments, profiles.localPreferences.state.revision))
      assert.deepEqual(profiles.teamRoleTargetsFor('team'), assignments)
      assert.deepEqual(profiles.binding('old'), before)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('canonical candidate protects source deletion and builtin snapshot preserves source revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-canonical-candidates-'))
  try {
    const profiles = await new AgentProfiles(join(root, 'profiles.json')).open()
    const source = await profiles.save({ name: 'Source', type: 'codex', executable: 'fixture-codex' })
    await profiles.ensureBuiltins([{ id: 'builtin-codex', name: 'Builtin', type: 'codex', executable: 'fixture-builtin' }])
    const builtin = profiles.get('builtin-codex')
    await profiles.localPreferences.update(state => {
      state.agentCatalog.push({ id: 'canonical', name: 'Canonical', sourceProfileId: source.id, sourceProfileRevision: profileRevision(source) })
      state.agentCatalog.push({ id: 'canonical-builtin', name: 'Canonical builtin', sourceProfileId: builtin.id, sourceProfileRevision: profileRevision(builtin) })
    })
    const assignments = { review: [{ profileId: 'canonical', model: 'one' }, { profileId: 'canonical-builtin', model: 'two' }] }
    await profiles.setTeamRoleTargets('team', assignments, profiles.localPreferences.state.revision)
    assert.deepEqual(await profiles.teamRoleTargetDiagnostics('team'), [])
    const snapshot = await profiles.candidateRegistry()
    assert.equal(snapshot.get(builtin.id).origin, 'builtin')
    assert.equal(profileRevision(snapshot.get(builtin.id)), profileRevision(builtin))
    await assert.rejects(profiles.remove(source.id), /referenced/)
    assert.deepEqual(profiles.teamRoleTargetsFor('team'), assignments)
    assert.equal(profiles.get('canonical').executable, source.executable)
  } finally { await rm(root, { recursive: true, force: true }) }
})

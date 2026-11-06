/** Installed engine configuration preflight. The owned peer receives no inference. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProfiles, profileRevision } from '../src/agent-profiles.js'
import { ManagedCodexAdapter } from '../src/managed-codex-adapter.js'
import { managedCodexRoute } from '../src/managed-codex-profile.js'
import { preflightOfficialSelection } from '../src/official-selection-preflight.js'
import { nativeDecisionProvider } from './support/native-decision-provider.js'

for (const [role, field] of [['worker', 'managedAssignment'], ['builder', 'managedBuilder'], ['coordinator', 'managedCoordinator']]) {
  test(`installed native ${role} selection requires explicit role and performs no inference`, {
    skip: !process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE, timeout: 30000,
  }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kode-native-role-')))
    const peer = await nativeDecisionProvider(() => { throw new Error('preflight must not infer') })
    const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{
      id: 'native', name: 'Native fixture', type: 'codex',
      executable: process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE,
      managedInference: { endpoint: peer.endpoint, roles: [role], reasoningEfforts: ['high'] },
    }])
    const ctx = { llm: { resolveCallConfig: async config => config } }
    const adapter = new ManagedCodexAdapter(ctx, profiles)
    t.after(async () => { await adapter.close(); await peer.close(); await rm(root, { recursive: true, force: true }) })
    const profile = profiles.get('native'), revision = profileRevision(profile)
    const binding = { profile, revision, [field]: {} }
    const policy = { scope: 'executor_configuration', profile_revision: revision, model: 'fixture', effort: 'high' }
    const config = { provider: managedCodexRoute(profile.id), model: 'fixture', reasoningEffort: 'high' }
    const agent = { session: { header: { cwd: root } } }
    const actual = await preflightOfficialSelection(ctx, profiles, binding, policy, config, undefined, agent, adapter)
    assert.equal(actual.model, 'fixture')
    assert.equal(actual.reasoning_effort, 'high')
    assert.equal(actual.inference_verified, false)
    await assert.rejects(preflightOfficialSelection(ctx, profiles, { profile, revision }, policy, config, undefined, agent, adapter), /profile changed/)
    await assert.rejects(preflightOfficialSelection(ctx, profiles,
      { ...binding, [field === 'managedBuilder' ? 'managedCoordinator' : 'managedBuilder']: {} },
      policy, config, undefined, agent, adapter), /profile changed/)
    assert.equal(peer.calls, 0)
    assert.deepEqual(peer.errors, [])
  })
}

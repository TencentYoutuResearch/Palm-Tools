/** Actual Rust SQLite Team save/revision -> actual native protocol append.
 * Only disposable Hub/CLI fixtures, no live account or model inference.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session } from '@deepseek-ai/dsh-session'
import { isolatedHub } from './support/isolated-hub.js'
import { saveBuilderProposal } from '../src/builder-proposal-route.js'
import { parseBuilderProposalCandidate } from '../src/builder-proposal-candidate.js'
import { snapshotTeamRolePrompt } from '../src/team-role-prompts.js'
import { createNativeRolePromptResolver } from '../src/native-role-prompt.js'
import { AcpSession } from '../src/acp-session.js'
import { CodexSession } from '../src/codex-session.js'
import { verifyCandidateSave } from '../packages/collab/builder-candidate.js'
import { verifyConfiguration } from '../packages/collab/team-configuration.js'
test('reviewed candidate persists exact Team revision then loads only that role through native append', { skip: !process.env.KODE_TEST_HUB_BIN, timeout: 60000 }, async () => {
  const hub = await isolatedHub('role-prompt-fixture'), root = await mkdtemp(join(tmpdir(), 'kode-role-e2e-'))
  const opened = []
  try {
    const call = (path, input) => hub.client.call('/api/v1/messaging/' + path, input)
    const spec = { name: 'Fixture', purpose: 'Test prompts', kind: 'coordinator', workspace_refs: [], execution_targets: [], coordinator_targets: [], workflow_pack_refs: [],
      grant_id: null, budget_policy_id: null, scheduling_policy_id: null, limits: { max_active_assignments: 1, max_active_runs: 1 }, proactive_mode: 'off',
      coordinator_prompt: 'COORDINATOR_V1', workers: [{ id: 'review', role: 'review', responsibilities: ['Review'], allowed_target_ids: [], required_capabilities: [], workspace_refs: [], max_parallel: 1, role_prompt: 'WORKER_MODEL_DRAFT' }] }
    spec.coordinator_startup = null; spec.delivery_bindings = []
    const draft = await call('superagents/drafts', { id: 'draft', request_id: 'create', expected_revision: 0, revoked: false,
      interview: { purpose: 'Test prompts', workspace_refs: [], answers: {}, questions: [], proposed_team: null } })
    const candidate = parseBuilderProposalCandidate(JSON.stringify({ format: 'kode.team-proposal.v1', proposed_team: spec }))
    candidate.proposed_team.workers[0].role_prompt = 'WORKER_OWNER_REVIEWED_V1'
    const command = { draft_id: 'draft', request_id: 'save', expected_revision: 1, ...candidate }
    const saved = await saveBuilderProposal(hub.client, command)
    assert.equal(verifyCandidateSave(draft, command, saved), saved, 'actual frontend receipt comparison accepts the actual Rust serialization')
    assert.equal(saved.revision, 2); assert.deepEqual((await call('teams')).items, [])
    assert.deepEqual(await saveBuilderProposal(hub.client, command), saved)
    const accepted = await call('superagents/drafts/draft/accept-proposal', { request_id: 'accept', expected_revision: 2, team_id: 'team', team_revision: 0 })
    assert.equal(accepted.activation_performed, false); assert.equal(accepted.team.status, 'draft')
    const newer = structuredClone(accepted.team.spec); newer.coordinator_prompt = 'COORDINATOR_V2'; newer.workers[0].role_prompt = 'WORKER_V2'
    const edit = { id: 'team', request_id: 'edit', expected_revision: 1, spec: newer }
    const updated = await call('teams', edit)
    assert.equal(verifyConfiguration(accepted.team, edit, updated), updated)
    await assert.rejects(call('teams', { id: 'team', request_id: 'stale', expected_revision: 1, spec: newer }), /revision conflict/)
    for (const type of ['cursor', 'claude', 'codex']) for (const worker_id of [undefined, 'review']) {
      const suffix = type + '-' + (worker_id ?? 'coordinator'), log = join(root, suffix + '.jsonl'), session = Session.create(suffix)
      const resolve = async () => {
        const team = await call('teams/team/revisions/1')
        assert.equal(team.home_hub, hub.node); assert.equal(team.revision, 1)
        return snapshotTeamRolePrompt({ home_hub: team.home_hub, team_id: team.id, team_revision: team.revision, spec: team.spec, ...(worker_id ? { worker_id } : {}) })
      }
      const handler = createNativeRolePromptResolver({ session, resolve, flush: async () => true, validateIdentity: async value => { assert.equal(value.team_id, 'team'); assert.equal(value.team_revision, 1); assert.equal(value.role.kind, worker_id ? 'worker' : 'coordinator') } })
      const fixture = type === 'codex' ? 'fixture-codex-server.js' : type === 'claude' ? 'fixture-claude-stream-json.js' : 'fixture-acp-server.js'
      const profile = { type, executable: process.execPath, args: [fileURLToPath(new URL('./' + fixture, import.meta.url))], env: { KODE_ACP_ROLE_PROMPT: '1', KODE_ACP_FIXTURE_LOG: log, KODE_FIXTURE_RPC_LOG: log, KODE_CLAUDE_FIXTURE_LOG: log, CLAUDE_CONFIG_DIR: root } }
      const Native = type === 'codex' ? CodexSession : AcpSession
      const native = new Native(profile, root, { resolveRolePrompt: handler, policy: () => ({ mode: 'read-only' }) }); opened.push(native)
      await native.open({}, []); await native.close()
      const records = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
      const appended = type === 'claude' ? records.find(row => row.request?.subtype === 'initialize').request.appendSystemPrompt
        : type === 'codex' ? records.find(row => row.method === 'thread/start').params.developerInstructions
          : records.find(row => row.method === 'session/new').params.systemPrompt.content[0].text
      assert.match(appended, new RegExp(worker_id ? 'WORKER_OWNER_REVIEWED_V1' : 'COORDINATOR_V1'))
      assert.doesNotMatch(appended, /WORKER_MODEL_DRAFT|COORDINATOR_V2|WORKER_V2/)
      assert.doesNotMatch(appended, new RegExp(worker_id ? 'COORDINATOR_V1' : 'WORKER_OWNER_REVIEWED_V1'))
      assert.equal(records.some(row => ['turn/start', 'session/prompt'].includes(row.method)), false)
    }
  } finally { await Promise.all(opened.map(native => native.close())); await hub.close(); await rm(root, { recursive: true, force: true }) }
})

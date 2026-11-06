/** Real home admission plus native adapter; unsupported grants never start a CLI. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { isolatedHub } from './support/isolated-hub.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { AgentRuntimeAdapter, profileRoute } from '../src/agent-runtime.js'
import { acquireOperationLease } from '../src/operation-lease.js'
import { executionEvidence } from '../src/execution-evidence.js'

test('native executor without full grant enforcement refuses before claim or runtime startup', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let hub, adapter
  try {
    hub = await isolatedHub('native-grant')
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const op = await hub.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'native-grant', worker: { node_id: hub.node, session_id: 'worker' }, grant_required: true })
    const target = { host: hub.node, workspace: 'workspace', root: '/srv/fixture' }
    await hub.client.call('/api/v1/messaging/team-grants', { expected_revision: 0, policy: { id: 'grant', team_id: 'team', enabled: true, expires_at: Date.now() + 60000, targets: [target], capabilities: ['read'], tools: [], network: false, budget_ids: [] } })
    await hub.client.call(`/api/v1/messaging/operations/${op.id}/grant`, { expected_revision: 1, binding: { grant_id: 'grant', attempt: 1, epoch: 1, scope: { team_id: 'team', revision: 1, target, capabilities: ['read'], tools: [], network: false, budget_ids: [] } } })
    const profiles = await new AgentProfiles(join(hub.root, 'profiles.json')).open([{ id: 'fixture', name: 'Fixture', type: 'codex', executable: process.execPath, args: [] }])
    await profiles.bind('worker', 'fixture')
    const operation = { id: op.id, attempt: 1, epoch: 1 }
    await profiles.patchBinding('worker', { managedOperation: operation })
    const agent = { id: 'worker', session: { header: { cwd: hub.root }, append() {} }, ctx: { parallel: async () => {}, get: () => undefined } }
    let prepared = 0, claims = 0
    const client = { call: async (path, body, signal) => { if (body) claims++; return worker.call(path, body, signal) } }
    const ctx = { agents: { get: () => agent }, sessionProjections: { stateOf: () => ({ lastTurn: 1, lastStepBoundary: { kind: 'start', step: 1 } }) }, get: name => name === 'kodeOperationLeases' ? { acquire: (_agent, binding, signal) => acquireOperationLease(client, binding, { node_id: hub.node, session_id: 'worker', grant_enforcement: false }, { signal }) } : undefined }
    adapter = new AgentRuntimeAdapter(ctx, profiles, { resolveProfile: async profile => { prepared++; return profile } })
    await assert.rejects(async () => { for await (const _ of adapter.stream({ sessionId: 'worker', provider: profileRoute('fixture'), model: 'fixture', signal: AbortSignal.timeout(10000), messages: [{ id: 'input', role: 'user', content: [{ type: 'text', text: 'fixture request' }] }] })) {} }, error => error.code === 'grant_enforcement_unsupported')
    assert.equal(prepared, 0); assert.equal(claims, 0); assert.equal(adapter.live.size, 0)
    assert.equal((await hub.client.call(`/api/v1/messaging/operations/${op.id}`)).state, 'prepared')
    assert.equal(executionEvidence(profiles.binding('worker')).execution_admission.reason, 'grant_enforcement_unsupported')
  } finally { await adapter?.close(); await hub?.close() }
})

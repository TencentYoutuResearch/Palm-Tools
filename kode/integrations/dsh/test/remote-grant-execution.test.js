/** Two Hub processes and controlled official entry; fixture inference/tools only. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { isolatedHub, pairHubs } from './support/isolated-hub.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { OfficialExecution } from '../src/official-execution.js'
import { OfficialToolPolicies } from '../src/official-grant-guard.js'
import { acquireOperationLease } from '../src/operation-lease.js'

test('remote official entry uses home grant, scopes projection and stops after home revocation', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 40000 }, async () => {
  let home, remote, execution, run
  try {
    home = await isolatedHub('grant-home'); remote = await isolatedHub('grant-worker'); await pairHubs(home, remote)
    const root = await realpath(remote.root)
    const registration = await remote.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = remote.client.forSession(registration.owner_token)
    const policy = { id: 'grant', team_id: 'team', enabled: true, expires_at: Date.now() + 60000, targets: [{ host: remote.node, workspace: 'workspace', root }], capabilities: ['read'], tools: ['read'], network: false, budget_ids: [] }
    await home.client.call('/api/v1/messaging/team-grants', { expected_revision: 0, policy })
    const op = await home.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'remote-grant', worker: { node_id: remote.node, session_id: 'worker' }, grant_required: true })
    const scope = { team_id: 'team', revision: 1, target: policy.targets[0], capabilities: ['read'], tools: ['read'], network: false, budget_ids: [] }
    await home.client.call(`/api/v1/messaging/operations/${op.id}/grant`, { expected_revision: 1, binding: { grant_id: 'grant', attempt: 1, epoch: 1, scope } })
    const route = `/api/v1/messaging/operation-accounting-relay/${home.node}`
    const envelope = { operation_id: op.id, worker_session: 'worker', command: null, accounting: { attempt: 1, action: { kind: 'grant_context' } } }
    await assert.rejects(worker.call(route, envelope), /403/)
    await assert.rejects(worker.call(`/api/v1/messaging/operation-relay/${home.node}`, envelope), /403/)
    await assert.rejects(remote.client.call(route, { ...envelope, worker_session: 'other' }), /foreign remote operation/)
    await assert.rejects(remote.client.call(route, { ...envelope, accounting: { ...envelope.accounting, attempt: 2 } }), /foreign grant attempt/)
    assert.deepEqual((await remote.client.call(route, envelope)).binding.scope, scope)
    await assert.rejects(remote.client.call('/api/v1/messaging/team-grants/grant'), /404/)
    const operation = { id: op.id, attempt: 1, epoch: 1, home_node: home.node }
    const profiles = await new AgentProfiles(join(remote.root, 'profiles.json')).open([{ id: 'official', name: 'Fixture', type: 'dsh' }])
    await profiles.bind('worker', 'official'); await profiles.patchBinding('worker', { managedOperation: operation })
    let tools = 0, models = 0
    const agent = { id: 'worker', session: { header: { cwd: root } }, ctx: { tools: { execute: async () => { tools++; return 'result' } } } }
    const implementation = {}
    agent.ctx.tools.get = name => name === 'read' ? implementation : undefined
    const policies = new OfficialToolPolicies()
    policies.register('read', { implementation, capabilities: ['read'], network: false, authorize: async () => true })
    const services = { kodeOfficialToolPolicies: policies, workspaceRegistry: { list: () => [{ id: 'workspace', path: root }] }, kodeOperationLeases: { acquire: (_agent, binding, signal) => acquireOperationLease(worker, binding, { node_id: remote.node, session_id: 'worker', grant_enforcement: true }, { signal, leaseMs: 15000 }) } }
    const ctx = { agents: { get: () => agent }, get: key => services[key], llm: { async *stream() { models++; yield { type: 'usage', usage: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 } }; yield { type: 'finish', reason: { kind: 'stop' } } } } }
    execution = new OfficialExecution(ctx, profiles, remote.client, { host: remote.node })
    run = await execution.open(agent, { tools: ['read'] })
    for await (const _ of run.stream({ sessionId: 'worker', provider: 'fixture', model: 'model', tools: [{ name: 'read' }] })) {}
    await run.execute({ agent, name: 'read', callId: 'read-1', arguments: {} })
    assert.equal(models, 1); assert.equal(tools, 1)
    assert.equal(profiles.binding('worker').officialTools['read-1'].home_reconciled, true)
    await home.client.call('/api/v1/messaging/team-grants', { expected_revision: 1, policy: { ...policy, enabled: false } })
    assert.equal((await remote.client.call(route, envelope)).available, false)
    await assert.rejects(run.execute({ agent, name: 'read', callId: 'read-2' }), /grant is not available|grant changed|operation grant denied/)
    assert.equal(run.signal.aborted, true); assert.equal(tools, 1)
  } finally { run?.dispose(); await execution?.close(); await home?.close(); await remote?.close() }
})

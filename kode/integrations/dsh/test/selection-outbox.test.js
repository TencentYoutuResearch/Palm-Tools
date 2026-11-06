import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { AgentProfiles } from '../src/agent-profiles.js'
import { SelectionOutbox } from '../src/selection-outbox.js'
import { isolatedHub, pairHubs } from './support/isolated-hub.js'
for (const remoteMode of [false, true]) test(`selection outbox recovers lost ${remoteMode ? 'remote' : 'local'} receipts`, { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let home, remote, outbox
  try {
    home = await isolatedHub('selection-outbox-home')
    if (remoteMode) { remote = await isolatedHub('selection-outbox-remote'); await pairHubs(home, remote) }
    const host = remote ?? home
    const registration = await host.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = host.client.forSession(registration.owner_token)
    const op = await home.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'outbox', worker: { node_id: host.node, session_id: 'worker' } })
    const operation = { id: op.id, attempt: 1, epoch: 1, ...(remoteMode ? { home_node: home.node } : {}) }
    const command = { attempt: 1, epoch: 1, expected_revision: 1, action: { kind: 'claim', lease_ms: 60000 } }
    if (remoteMode) await worker.call(`/api/v1/messaging/operation-relay/${home.node}`, { operation_id: op.id, worker_session: 'worker', command })
    else await worker.call(`/api/v1/messaging/operations/${op.id}`, command)
    const file = join(host.root, 'profiles.json')
    const profiles = await new AgentProfiles(file).open([{ id: 'fixture', name: 'Fixture', type: 'custom', executable: process.execPath }])
    await profiles.bind('worker', 'fixture'); await profiles.patchBinding('worker', { managedOperation: operation })
    const params = { operation, profile_revision: profiles.binding('worker').revision, threadId: 'thread', turnId: 'turn', inputIds: ['input'], scope: 'executor_configuration', observed_at: 1,
      model: { requested: 'chosen', observed: 'chosen', status: 'reported', source: 'fixture' }, effort: { requested: 'high', status: 'acknowledged' } }
    outbox = new SelectionOutbox({ call: async (...args) => { await host.client.call(...args); throw new Error('lost acknowledgement') } }, profiles)
    await outbox.record('worker', params)
    assert.throws(() => outbox.assertSettled('worker', operation), /reconciliation/)
    assert.equal(Object.values(profiles.binding('worker').selectionOutbox)[0].evidence.effort.status, 'pending')
    await outbox.close(); await home.stop('SIGKILL'); await home.start()
    const restored = await new AgentProfiles(file).open()
    outbox = new SelectionOutbox({ call: async (...args) => { const result = await host.client.call(...args); return { ...result, evidence: { ...result.evidence, turn_id: 'foreign' } } } }, restored)
    await outbox.tick(); assert.throws(() => outbox.assertSettled('worker', operation), /reconciliation/); await outbox.close()
    outbox = new SelectionOutbox(host.client, restored)
    outbox.start(); await outbox.tick(); outbox.assertSettled('worker', operation)
    await outbox.record('worker', params)
    const audit = await home.client.call(`/api/v1/messaging/operations/${op.id}/events?after=0`)
    assert.equal(audit.events.filter(row => row.data.kind === 'selection_evidence').length, 1)
    await outbox.record('worker', { ...params, observed_at: 2, model: { ...params.model, observed: 'different' } })
    assert.throws(() => outbox.assertSettled('worker', operation), /rejected/)
    await outbox.record('worker', { ...params, observed_at: 3 })
    assert.throws(() => outbox.assertSettled('worker', operation), /rejected/)
    await assert.rejects(outbox.record('worker', { ...params, operation: { ...operation, epoch: 2 } }), /binding changed/)
  } finally { await outbox?.close(); await remote?.close(); await home?.close() }
})

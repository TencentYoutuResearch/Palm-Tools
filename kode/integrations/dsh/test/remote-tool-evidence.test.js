/** Home audit durability and collector authorization; no model or tool side effects. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { isolatedHub, pairHubs } from './support/isolated-hub.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { OfficialToolJournal } from '../src/official-tool-journal.js'

test('remote tool evidence is scoped to its home operation and survives lost acknowledgement', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let hub, remote
  try {
    hub = await isolatedHub('tool-home'); remote = await isolatedHub('tool-remote'); await pairHubs(hub, remote)
    const registration = await remote.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = remote.client.forSession(registration.owner_token)
    const op = await hub.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'tool', worker: { node_id: remote.node, session_id: 'worker' } })
    const operation = { id: op.id, attempt: 1, epoch: 1, home_node: hub.node }
    const route = `/api/v1/messaging/operation-accounting-relay/${hub.node}`
    const envelope = evidence => ({ operation_id: op.id, worker_session: 'worker', command: null, accounting: { attempt: 1, action: { kind: 'tool_evidence', evidence } } })
    const input = { call_id: 'probe', tool: 'read', operation_id: op.id, worker_session: 'worker', attempt: 1, epoch: 1, status: 'returned', started_at: 1, ended_at: 2 }
    await assert.rejects(worker.call(route, envelope(input)), /403/)
    await assert.rejects(remote.client.call(route, envelope(input)), /admitted attempt/)
    await worker.call(`/api/v1/messaging/operation-relay/${hub.node}`, { operation_id: op.id, worker_session: 'worker', command: { attempt: 1, epoch: 1, expected_revision: 1, action: { kind: 'claim', lease_ms: 60000 } } })
    await assert.rejects(remote.client.call(route, envelope({ ...input, worker_session: 'foreign' })), /foreign/)
    await assert.rejects(remote.client.call(route, envelope({ ...input, epoch: 2 })), /foreign/)
    const file = join(remote.root, 'profiles.json')
    const profiles = await new AgentProfiles(file).open([{ id: 'official', name: 'Fixture', type: 'dsh' }])
    await profiles.bind('worker', 'official'); await profiles.patchBinding('worker', { managedOperation: operation })
    const journal = new OfficialToolJournal(profiles, { call: async (path, body) => { await remote.client.call(path, body); throw new Error('lost receipt') } })
    await journal.begin('worker', operation, { callId: 'call', name: 'read' })
    await journal.end('worker', 'call', 'returned', 'tool_returned')
    assert.equal(profiles.binding('worker').officialTools.call.home_reconciled, false)
    await hub.stop('SIGKILL'); await hub.start()
    const reopened = await new AgentProfiles(file).open()
    await new OfficialToolJournal(reopened, remote.client).recover()
    const row = reopened.binding('worker').officialTools.call
    assert.equal(row.home_reconciled, true)
    const audit = await hub.client.call(`/api/v1/messaging/operations/${op.id}/events?after=0`)
    const events = audit.events.filter(row => row.data.kind === 'tool_evidence')
    assert.equal(events.length, 1); assert.equal(events[0].seq, row.home_sequence)
    await assert.rejects(remote.client.call(route, envelope({ ...events[0].data.evidence, tool: 'changed' })), /identity conflict/)
    await assert.rejects(hub.client.call('/api/v1/messaging/tool-evidence', input), /remote call collector/)
    await assert.rejects(remote.client.call(route, { ...envelope(input), accounting: { attempt: 2, action: { kind: 'tool_evidence', evidence: input } } }), /foreign tool evidence envelope/)
    await assert.rejects(worker.call(`/api/v1/messaging/operation-relay/${hub.node}`, envelope(input)), /403/)
    const restored = new OfficialToolJournal(reopened, remote.client)
    await restored.begin('worker', operation, { callId: 'uncertain', name: 'write' })
    await restored.end('worker', 'uncertain', 'uncertain', 'execution_or_recording_failed')
    const uncertain = reopened.binding('worker').officialTools.uncertain
    const resolution = { operation_id: op.id, evidence_sequence: uncertain.home_sequence, request_id: 'resolve', decision: 'verified_applied', evidence_ref: 'artifact:remote-check' }
    await assert.rejects(worker.call('/api/v1/messaging/tool-resolutions', resolution), /403/)
    await assert.rejects(remote.client.call('/api/v1/messaging/tool-resolutions', resolution), /missing/)
    await hub.client.call('/api/v1/messaging/tool-resolutions', resolution)
    await restored.flush()
    restored.assertSettled('worker', operation)
    assert.equal(reopened.binding('worker').officialTools.uncertain.status, 'uncertain')
    assert.equal(reopened.binding('worker').officialTools.uncertain.resolution.decision, 'verified_applied')

  } finally { await hub?.close(); await remote?.close() }
})

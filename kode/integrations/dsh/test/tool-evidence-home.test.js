/** Home audit durability and collector authorization; no model or tool side effects. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { isolatedHub } from './support/isolated-hub.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { OfficialToolJournal } from '../src/official-tool-journal.js'

test('home tool evidence retries a lost receipt without duplicating audit across restart', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let hub
  try {
    hub = await isolatedHub('tool-home')
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const op = await hub.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'tool', worker: { node_id: hub.node, session_id: 'worker' } })
    const operation = { id: op.id, attempt: 1, epoch: 1 }
    const input = { call_id: 'probe', tool: 'read', operation_id: op.id, worker_session: 'worker', attempt: 1, epoch: 1, status: 'returned', started_at: 1, ended_at: 2 }
    await assert.rejects(worker.call('/api/v1/messaging/tool-evidence', input), /403/)
    await assert.rejects(hub.client.call('/api/v1/messaging/tool-evidence', input), /admitted attempt/)
    await worker.call(`/api/v1/messaging/operations/${op.id}`, { attempt: 1, epoch: 1, expected_revision: 1, action: { kind: 'claim', lease_ms: 60000 } })
    await assert.rejects(hub.client.call('/api/v1/messaging/tool-evidence', { ...input, worker_session: 'foreign' }), /foreign/)
    await assert.rejects(hub.client.call('/api/v1/messaging/tool-evidence', { ...input, epoch: 2 }), /foreign/)
    const file = join(hub.root, 'profiles.json')
    const profiles = await new AgentProfiles(file).open([{ id: 'official', name: 'Fixture', type: 'dsh' }])
    await profiles.bind('worker', 'official'); await profiles.patchBinding('worker', { managedOperation: operation })
    const journal = new OfficialToolJournal(profiles, { call: async (path, body) => { await hub.client.call(path, body); throw new Error('lost receipt') } })
    await journal.begin('worker', operation, { callId: 'call', name: 'read' })
    await journal.end('worker', 'call', 'returned', 'tool_returned',{content:'fixture observation'})
    assert.equal(profiles.binding('worker').officialTools.call.home_reconciled, false)
    assert.throws(() => journal.assertSettled('worker', operation), /reconciliation/)
    await hub.stop('SIGKILL'); await hub.start()
    const reopened = await new AgentProfiles(file).open()
    await new OfficialToolJournal(reopened, hub.client).recover()
    const row = reopened.binding('worker').officialTools.call
    assert.equal(row.home_reconciled, true)
    const audit = await hub.client.call(`/api/v1/messaging/operations/${op.id}/events?after=0`)
    const events = audit.events.filter(row => row.data.kind === 'tool_evidence')
    assert.equal(events.length, 1); assert.equal(events[0].seq, row.home_sequence)
    assert.deepEqual(events[0].data.evidence.io,row.io)
    const changed=structuredClone(events[0].data.evidence);changed.io.output.sha256='f'.repeat(64)
    await assert.rejects(hub.client.call('/api/v1/messaging/tool-evidence',changed),/identity conflict/)
    changed.call_id='invalid-observation';changed.io.input.sha256='not-a-hash'
    await assert.rejects(hub.client.call('/api/v1/messaging/tool-evidence',changed),/invalid tool content observation/)
    await assert.rejects(hub.client.call('/api/v1/messaging/tool-evidence', { ...events[0].data.evidence, tool: 'changed' }), /identity conflict/)
  } finally { await hub?.close() }
})

test('home resolution retains uncertainty and never permits replay of the original tool', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let hub
  try {
    hub = await isolatedHub('tool-resolution')
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const op = await hub.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'resolution', worker: { node_id: hub.node, session_id: 'worker' } })
    await worker.call(`/api/v1/messaging/operations/${op.id}`, { attempt: 1, epoch: 1, expected_revision: 1, action: { kind: 'claim', lease_ms: 60000 } })
    const operation = { id: op.id, attempt: 1, epoch: 1 }
    const file = join(hub.root, 'profiles.json')
    const profiles = await new AgentProfiles(file).open([{ id: 'official', name: 'Fixture', type: 'dsh' }])
    await profiles.bind('worker', 'official'); await profiles.patchBinding('worker', { managedOperation: operation })
    const journal = new OfficialToolJournal(profiles, hub.client)
    await journal.begin('worker', operation, { callId: 'uncertain', name: 'write' })
    await journal.end('worker', 'uncertain', 'uncertain', 'execution_or_recording_failed')
    assert.throws(() => journal.assertSettled('worker', operation), /reconciliation/)
    const input = { operation_id: op.id, evidence_sequence: profiles.binding('worker').officialTools.uncertain.home_sequence, request_id: 'resolution', decision: 'verified_applied', evidence_ref: 'artifact:checked-result' }
    await assert.rejects(worker.call('/api/v1/messaging/tool-resolutions', input), /403/)
    const receipt = await hub.client.call('/api/v1/messaging/tool-resolutions', input)
    assert.equal(receipt.duplicate, false); assert.equal(receipt.resolution.replay_authorized, false)
    await hub.stop('SIGKILL'); await hub.start()
    assert.equal((await hub.client.call('/api/v1/messaging/tool-resolutions', input)).duplicate, true)
    await assert.rejects(hub.client.call('/api/v1/messaging/tool-resolutions', { ...input, decision: 'verified_not_applied' }), /already recorded/)
    const reopened = await new AgentProfiles(file).open()
    const restored = new OfficialToolJournal(reopened, hub.client)
    await restored.recover()
    restored.assertSettled('worker', operation)
    assert.equal(reopened.binding('worker').officialTools.uncertain.status, 'uncertain')
    assert.equal(reopened.binding('worker').officialTools.uncertain.resolution.decision, 'verified_applied')
    await assert.rejects(restored.begin('worker', operation, { callId: 'uncertain', name: 'write' }), /already recorded/)
    await assert.rejects(hub.client.call('/api/v1/messaging/tool-resolutions', { ...input, evidence_sequence: 1 }), /uncertain tool evidence/)
  } finally { await hub?.close() }
})

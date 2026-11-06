import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { AgentProfiles } from '../src/agent-profiles.js'
import { ArtifactOutbox } from '../src/artifact-outbox.js'
import { isolatedHub } from './support/isolated-hub.js'

test('artifact outbox replays frozen evidence after lost receipt and rejects altered acknowledgements', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('artifact-outbox'); let outbox, recovered
  try {
    const root = '/api/v1/messaging'
    const registration = await hub.client.call(`${root}/sessions`, { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const op = await hub.client.call(`${root}/operations`, { owner_session: 'owner', request_key: 'capture', worker: { node_id: hub.node, session_id: 'worker' } })
    await hub.client.forSession(registration.owner_token).call(`${root}/operations/${op.id}`, { attempt: 1, epoch: 1, expected_revision: 1, action: { kind: 'claim', lease_ms: 60000 } })
    const operation = { id: op.id, attempt: 1, epoch: 1 }, file = join(hub.root, 'profiles.json')
    const profiles = await new AgentProfiles(file).open([{ id: 'official', name: 'Official', type: 'dsh' }])
    await profiles.bind('worker', 'official'); await profiles.patchBinding('worker', { managedOperation: operation })
    const payload = { kind: 'artifact', snapshot: { repository_id: 'fixture', base_revision: 'a'.repeat(40), tree_hash: 'b'.repeat(64), patch_hash: 'c'.repeat(64), artifact_hashes: {} } }
    let receipt
    outbox = new ArtifactOutbox({ call: async (path, body) => { receipt = await hub.client.call(path, body); throw new Error('lost response') } }, profiles)
    const pending = await outbox.record('worker', operation, 'capture', payload)
    assert.equal(pending.home_reconciled, false)
    assert.throws(() => outbox.assertSettled('worker', operation), /reconciliation/)
    await assert.rejects(outbox.record('worker', operation, 'capture', { ...payload, snapshot: { ...payload.snapshot, patch_hash: 'd'.repeat(64) } }), /identity conflict/)
    payload.snapshot.patch_hash = 'e'.repeat(64)
    await outbox.close(); await hub.stop('SIGKILL'); await hub.start()
    const reopened = await new AgentProfiles(file).open()
    recovered = new ArtifactOutbox({ call: async (path, body) => ({ ...await hub.client.call(path, body), record: { ...receipt.record, snapshot_hash: '0'.repeat(64) } }) }, reopened)
    await recovered.tick()
    assert.throws(() => recovered.assertSettled('worker', operation), /reconciliation/)
    await recovered.close()
    recovered = new ArtifactOutbox(hub.client, reopened)
    // Existing capture identity must replay even if the workspace is now absent.
    const replay = await recovered.capture('worker', operation, 'capture', { workspaceRoot: '/nonexistent-fixture', repositoryId: 'fixture' })
    assert.equal(replay.home_reconciled, true); assert.equal(replay.home_sequence, receipt.sequence)
    assert.equal(replay.evidence.payload.snapshot.patch_hash, 'c'.repeat(64))
    recovered.assertSettled('worker', operation)
    assert.equal((await hub.client.call(`${root}/operations/${op.id}/events`)).events.filter(e => e.data.kind === 'artifact_evidence').length, 1)
    await assert.rejects(recovered.record('worker', { ...operation, home_node: 'remote' }, 'remote', payload), /operation changed/)
    await profiles.chain
  } finally { await outbox?.close(); await recovered?.close(); await hub.close() }
})

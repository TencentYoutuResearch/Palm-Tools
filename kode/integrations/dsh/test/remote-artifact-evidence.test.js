import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { isolatedHub, pairHubs } from './support/isolated-hub.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { ArtifactOutbox } from '../src/artifact-outbox.js'

test('remote artifact observations belong to home and replay without granting Worker collector authority', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const home = await isolatedHub('artifact-home'), remote = await isolatedHub('artifact-worker'); let outbox, replay
  try {
    await pairHubs(home, remote)
    const root = '/api/v1/messaging'
    const registration = await remote.client.call(`${root}/sessions`, { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = remote.client.forSession(registration.owner_token)
    const op = await home.client.call(`${root}/operations`, { owner_session: 'owner', request_key: 'artifact', worker: { node_id: remote.node, session_id: 'worker' } })
    const operation = { id: op.id, attempt: 1, epoch: 1, home_node: home.node }
    const payload = { kind: 'artifact', snapshot: { repository_id: 'fixture', base_revision: 'a'.repeat(40), tree_hash: 'b'.repeat(64), patch_hash: 'c'.repeat(64), artifact_hashes: {} } }
    const evidence = { id: 'snapshot', operation_id: op.id, attempt: 1, epoch: 1, payload }
    const route = `${root}/operation-accounting-relay/${home.node}`
    const envelope = value => ({ operation_id: op.id, worker_session: 'worker', command: null, accounting: { attempt: 1, action: { kind: 'artifact_evidence', evidence: value } } })
    await assert.rejects(worker.call(route, envelope(evidence)), /403/)
    await assert.rejects(remote.client.call(route, envelope(evidence)), /admitted attempt/)
    await worker.call(`${root}/operation-relay/${home.node}`, { operation_id: op.id, worker_session: 'worker', command: { attempt: 1, epoch: 1, expected_revision: 1, action: { kind: 'claim', lease_ms: 60000 } } })
    await assert.rejects(remote.client.call(route, envelope({ ...evidence, operation_id: 'foreign' })), /foreign artifact evidence envelope/)
    await assert.rejects(remote.client.call(route, envelope({ ...evidence, attempt: 2 })), /foreign artifact evidence envelope/)
    await assert.rejects(remote.client.call(route, envelope({ ...evidence, epoch: 2 })), /admitted attempt/)
    await assert.rejects(remote.client.call(route, { ...envelope(evidence), worker_session: 'foreign' }), /foreign/)
    await assert.rejects(home.client.call(`${root}/artifact-evidence`, evidence), /remote call collector/)
    const file = join(remote.root, 'profiles.json')
    const profiles = await new AgentProfiles(file).open([{ id: 'official', name: 'Fixture', type: 'dsh' }])
    await profiles.bind('worker', 'official'); await profiles.patchBinding('worker', { managedOperation: operation })
    outbox = new ArtifactOutbox({ call: async (path, body) => { await remote.client.call(path, body); throw new Error('lost acknowledgement') } }, profiles)
    const row = await outbox.record('worker', operation, 'snapshot', payload)
    assert.equal(row.home_reconciled, false)
    await outbox.close(); await home.stop('SIGKILL'); await home.start()
    const reopened = await new AgentProfiles(file).open()
    replay = new ArtifactOutbox(remote.client, reopened); await replay.tick()
    replay.assertSettled('worker', operation)
    const stored = Object.values(reopened.binding('worker').artifactOutbox)[0]
    const events = (await home.client.call(`${root}/operations/${op.id}/events`)).events.filter(e => e.data.kind === 'artifact_evidence')
    assert.equal(events.length, 1); assert.equal(events[0].seq, stored.home_sequence)
    assert.equal(events[0].data.producer.node_id, remote.node)
    assert.equal(events[0].data.producer.session_id, 'worker')
    await assert.rejects(remote.client.call(route, envelope({ ...evidence, payload: { ...payload, snapshot: { ...payload.snapshot, patch_hash: 'd'.repeat(64) } } })), /identity conflict/)
    await assert.rejects(worker.call(`${root}/operation-relay/${home.node}`, envelope(evidence)), /403/)
  } finally { await outbox?.close(); await replay?.close(); await home.close(); await remote.close() }
})

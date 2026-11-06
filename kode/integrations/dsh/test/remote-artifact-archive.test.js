/** Real paired-Hub byte transfer; synthetic valid archive, no model or project mutation. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { isolatedHub, pairHubs } from './support/isolated-hub.js'
import { ArtifactArchive } from '../src/artifact-archive.js'
import { deliverArtifactArchive, fetchArtifactArchive } from '../src/artifact-transfer.js'
const hash = data => createHash('sha256').update(data).digest('hex')
test('remote archive segments survive lost replies and restart without exposing partial or foreign content', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 90000 }, async () => {
  const home = await isolatedHub('archive-home'), remote = await isolatedHub('archive-worker')
  try {
    await pairHubs(home, remote)
    const root = '/api/v1/messaging', route = `${root}/operation-accounting-relay/${home.node}`
    const registration = await remote.client.call(`${root}/sessions`, { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = remote.client.forSession(registration.owner_token)
    const op = await home.client.call(`${root}/operations`, { owner_session: 'owner', request_key: 'archive', worker: { node_id: remote.node, session_id: 'worker' } })
    await worker.call(`${root}/operation-relay/${home.node}`, { operation_id: op.id, worker_session: 'worker', command: { attempt: 1, epoch: 1, expected_revision: 1, action: { kind: 'claim', lease_ms: 60000 } } })
    const content = Buffer.alloc(220000, 97), contentHash = hash(content), manifest = [['source.bin', 'file', contentHash]], base_tree = 'a'.repeat(40)
    const tree_hash = hash(`kode.workspace.manifest.v1\n${JSON.stringify(manifest)}`)
    const bundle = { version: 1, snapshot: { repository_id: 'fixture', base_revision: 'b'.repeat(40), tree_hash, patch_hash: hash(`kode.workspace.delta.v1\n${base_tree}\n${tree_hash}`), artifact_hashes: {} }, base_tree, manifest, contents: { [contentHash]: content.toString('base64') } }
    const archive = new ArtifactArchive(join(remote.root, 'archive')), reference = await archive.put(bundle)
    assert.ok(reference.bytes > 256 * 1024)
    const envelope = action => ({ operation_id: op.id, worker_session: 'worker', command: null, accounting: { attempt: 1, action } })
    const evidence = await remote.client.call(route, envelope({ kind: 'artifact_evidence', evidence: { id: 'snapshot', operation_id: op.id, attempt: 1, epoch: 1, payload: { kind: 'artifact', snapshot: bundle.snapshot } } }))
    const scope = { home: home.node, worker: 'worker', operation: { id: op.id, attempt: 1 } }
    let first, loseSegment = true, loseComplete = true
    const unreliable = { call: async (path, body, signal) => {
      assert.ok(Buffer.byteLength(JSON.stringify(body.accounting)) < 65536)
      const result = await remote.client.call(path, body, signal)
      if (body.accounting.action.kind === 'artifact_archive_segment' && loseSegment) { first = structuredClone(body); loseSegment = false; throw new Error('lost segment receipt') }
      if (body.accounting.action.kind === 'artifact_archive_complete' && loseComplete) { loseComplete = false; throw new Error('lost complete receipt') }
      return result
    } }
    const deliver = () => deliverArtifactArchive(unreliable, evidence.sequence, archive, reference, undefined, scope)
    await assert.rejects(deliver(), /lost segment receipt/)
    const path = `${root}/artifact-archives/${evidence.sequence}`
    assert.equal((await home.client.call(path)).complete, false)
    await assert.rejects(home.client.call(`${path}/chunks/0`), /not complete/)
    await assert.rejects(remote.client.call(route, envelope({ kind: 'artifact_archive_complete', sequence: evidence.sequence, identity: { archive_hash: reference.archive_hash, bytes: reference.bytes } })), /incomplete|hash mismatch/)
    await assert.rejects(worker.call(route, first), /403/)
    await assert.rejects(remote.client.call(route, { ...first, worker_session: 'foreign' }), /foreign/)
    await assert.rejects(remote.client.call(route, { ...first, accounting: { ...first.accounting, attempt: 2 } }), /foreign remote archive source/)
    const altered = structuredClone(first); altered.accounting.action.chunk.data = Buffer.alloc(32768, 98).toString('base64')
    await assert.rejects(remote.client.call(route, altered), /segment identity conflict/)
    const gap = structuredClone(first); gap.accounting.action.offset = 65536
    await assert.rejects(remote.client.call(route, gap), /contiguous/)
    const oversized = structuredClone(first); oversized.accounting.action.chunk.data = Buffer.alloc(32769).toString('base64')
    await assert.rejects(remote.client.call(route, oversized), /segment bounds|size mismatch/)
    const other = await home.client.call(`${root}/operations`, { owner_session: 'owner', request_key: 'other', worker: { node_id: remote.node, session_id: 'worker' } })
    await assert.rejects(remote.client.call(route, { ...first, operation_id: other.id }), /foreign remote archive source/)
    await home.stop('SIGKILL'); await home.start()
    const replay = await remote.client.call(route, first)
    assert.deepEqual(await remote.client.call(route, first), replay)
    await assert.rejects(deliver(), /lost complete receipt/)
    const complete = await deliver()
    assert.equal(complete.complete, true); assert.equal(complete.completion_authorized, false)
    assert.deepEqual(await remote.client.call(route, first), replay)
    await home.stop('SIGKILL'); await home.start()
    assert.deepEqual((await fetchArtifactArchive(home.client, evidence.sequence, reference.snapshot_hash)).bundle, bundle)
    const events = (await home.client.call(`${root}/operations/${op.id}/events`)).events
    assert.equal(events.filter(e => e.data.kind === 'artifact_archive_completed').length, 1)
  } finally { await home.close(); await remote.close() }
})

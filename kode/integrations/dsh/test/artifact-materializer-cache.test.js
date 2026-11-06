import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, chmod, rm, writeFile, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactMaterializer } from '../src/artifact-materializer.js'
import { artifactSnapshotHash } from '../src/artifact-archive.js'
const hash = data => createHash('sha256').update(data).digest('hex')
test('materializer revalidates cached bytes without downloading again and refuses corrupted cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'snapshot-cache-'))
  const content = Buffer.from('snapshot'), contentHash = hash(content), manifest = [['source.txt', 'file', contentHash]], base_tree = 'a'.repeat(40)
  const tree_hash = hash(`kode.workspace.manifest.v1\n${JSON.stringify(manifest)}`)
  const snapshot = { repository_id: 'fixture', base_revision: 'b'.repeat(40), tree_hash, patch_hash: hash(`kode.workspace.delta.v1\n${base_tree}\n${tree_hash}`), artifact_hashes: {} }
  const bundle = { version: 1, snapshot, base_tree, manifest, contents: { [contentHash]: content.toString('base64') } }
  const data = Buffer.from(JSON.stringify(bundle)), snapshot_hash = artifactSnapshotHash({ kind: 'artifact', snapshot })
  const receipt = { sequence: 1, snapshot_hash, archive_hash: hash(data), bytes: data.length, chunk_bytes: 262144, complete: true }
  let transfers = 0, metadata = 0, source
  const materializer = new ArtifactMaterializer(root, { async call(path) {
    if (path.endsWith('/chunks/0')) { transfers++; return { sequence: 1, index: 0, archive_hash: receipt.archive_hash, data: data.toString('base64') } }
    metadata++; return receipt
  } })
  const request = { request_id: 'read', sequence: 1, snapshot_hash }
  try {
    const first = await materializer.prepare(request); source = first.source
    assert.equal(transfers, 1)
    const count = metadata
    assert.deepEqual(await materializer.prepare(request), first)
    assert.equal(transfers, 1); assert.equal(metadata, count + 1)
    await writeFile(join(root, '.archives', `${snapshot_hash}.json`), JSON.stringify({ ...bundle, contents: {} }))
    await assert.rejects(materializer.prepare(request), /artifact content|archive|Artifact/i)
    assert.equal(transfers, 1, 'corrupt existing storage is not silently repaired from network')
    const alias = `${root}-alias`
    await symlink(root, alias)
    const linked = new ArtifactMaterializer(alias, { async call() { return receipt } })
    try { await assert.rejects(linked.prepare(request), /Artifact storage is not a directory/) }
    finally { await linked.close(); await unlink(alias) }
  } finally { await materializer.close(); if (source) await chmod(source, 0o700); await rm(root, { recursive: true, force: true }) }
})

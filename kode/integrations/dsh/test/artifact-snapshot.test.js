import { ArtifactMaterializer, verifyArtifactWorkspace } from '../src/artifact-materializer.js'
import { createHash } from 'node:crypto'
import { deliverArtifactArchive, fetchArtifactArchive } from '../src/artifact-transfer.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm, mkdir, symlink, readFile, chmod, readdir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureArtifactSnapshot, captureArtifactBundle } from '../src/artifact-snapshot.js'
import { ArtifactArchive, validateArtifactBundle } from '../src/artifact-archive.js'
import { isolatedHub } from './support/isolated-hub.js'
const exec = promisify(execFile)
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kode-artifact-'))
  const git = args => exec('/usr/bin/git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' } })
  await git(['init', '-q']); await writeFile(join(root, 'main.txt'), 'base\n'); await writeFile(join(root, '.gitignore'), 'ignored\n')
  await git(['add', '.']); await git(['commit', '-qm', 'fixture'])
  return { root, git, capture: () => captureArtifactSnapshot({ workspaceRoot: root, repositoryId: 'fixture' }) }
}
test('real Git capture binds unstaged/staged/untracked/deleted files and modes without modifying index', async () => {
  const f = await fixture()
  try {
    const index = await readFile(join(f.root, '.git/index'))
    const base = await f.capture(); assert.deepEqual(await f.capture(), base)
    await writeFile(join(f.root, 'ignored'), 'ignored contents')
    assert.deepEqual(await f.capture(), base)
    await writeFile(join(f.root, 'new.txt'), 'new content')
    const untracked = await f.capture(); assert.notEqual(untracked.tree_hash, base.tree_hash)
    assert.deepEqual(await readFile(join(f.root, '.git/index')), index)
    await f.git(['add', 'new.txt'])
    assert.deepEqual(await f.capture(), untracked, 'staging identical contents does not change the artifact')
    await writeFile(join(f.root, 'main.txt'), 'changed')
    const changed = await f.capture(); assert.notEqual(changed.patch_hash, untracked.patch_hash)
    await chmod(join(f.root, 'main.txt'), 0o755)
    const executable = await f.capture(); assert.notEqual(executable.tree_hash, changed.tree_hash)
    await rm(join(f.root, 'main.txt'))
    const deleted = await f.capture()
    assert.notEqual(deleted.tree_hash, executable.tree_hash)
    await f.git(['add', '-u'])
    assert.deepEqual(await f.capture(), deleted, 'staged deletion retains the same raw artifact')
    await mkdir(join(f.root, 'nested'))
    await assert.rejects(captureArtifactSnapshot({ workspaceRoot: join(f.root, 'nested'), repositoryId: 'fixture' }), /repository root/)
    const controller = new AbortController(); controller.abort()
    await assert.rejects(captureArtifactSnapshot({ workspaceRoot: f.root, repositoryId: 'fixture', signal: controller.signal }), /cancelled/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('capture hashes symlink text and never invokes repository clean filters', async () => {
  const f = await fixture(), outside = await mkdtemp(join(tmpdir(), 'kode-artifact-outside-'))
  try {
    await writeFile(join(outside, 'data'), 'one')
    await symlink(join(outside, 'data'), join(f.root, 'link'))
    const before = await f.capture()
    await writeFile(join(outside, 'data'), 'two')
    assert.deepEqual(await f.capture(), before, 'link target bytes are not read')
    await writeFile(join(f.root, '.gitattributes'), '*.txt filter=fixture\n')
    await f.git(['config', 'filter.fixture.clean', 'touch filter-executed'])
    await f.capture()
    await assert.rejects(readFile(join(f.root, 'filter-executed')), { code: 'ENOENT' })
  } finally { await rm(f.root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})

test('actual workspace snapshot becomes a durable home artifact observation', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const f = await fixture(); let hub
  try {
    hub = await isolatedHub('capture-home')
    const root = '/api/v1/messaging'
    const registration = await hub.client.call(`${root}/sessions`, { session_id: 'author', title: 'Fixture', runtime: 'external' })
    const op = await hub.client.call(`${root}/operations`, { owner_session: 'owner', request_key: 'capture', worker: { node_id: hub.node, session_id: 'author' } })
    await hub.client.forSession(registration.owner_token).call(`${root}/operations/${op.id}`, { attempt: 1, epoch: 1, expected_revision: 1, action: { kind: 'claim', lease_ms: 60000 } })
    const evidence = { id: 'capture', operation_id: op.id, attempt: 1, epoch: 1, payload: { kind: 'artifact', snapshot: await f.capture() } }
    const receipt = await hub.client.call(`${root}/artifact-evidence`, evidence)
    await hub.stop('SIGKILL'); await hub.start()
    assert.equal((await hub.client.call(`${root}/artifact-evidence`, evidence)).sequence, receipt.sequence)
    assert.equal(receipt.completion_authorized, false)
  } finally { await hub?.close(); await rm(f.root, { recursive: true, force: true }) }
})


test('immutable archive preserves exact file bytes, modes, deletions and link text after workspace removal', async () => {
  const f = await fixture(), storage = await mkdtemp(join(tmpdir(), 'kode-artifact-archive-'))
  try {
    await writeFile(join(f.root, 'binary'), Buffer.from([0, 255, 128, 10]))
    await chmod(join(f.root, 'binary'), 0o755)
    await symlink('missing-target', join(f.root, 'link'))
    await rm(join(f.root, 'main.txt'))
    const bundle = await captureArtifactBundle({ workspaceRoot: f.root, repositoryId: 'fixture' })
    assert.deepEqual(bundle.snapshot, await f.capture())
    const archive = new ArtifactArchive(join(storage, 'archives'))
    const refs = await Promise.all([archive.put(bundle), archive.put(bundle)])
    assert.deepEqual(refs[0], refs[1])
    await rm(f.root, { recursive: true, force: true })
    const restored = await new ArtifactArchive(join(storage, 'archives')).read(refs[0].snapshot_hash, refs[0])
    assert.deepEqual(restored, JSON.parse(JSON.stringify(bundle)))
    const binary = restored.manifest.find(row => row[0] === 'binary')
    assert.equal(binary[1], 'executable')
    assert.deepEqual(Buffer.from(restored.contents[binary[2]], 'base64'), Buffer.from([0, 255, 128, 10]))
    const link = restored.manifest.find(row => row[0] === 'link')
    assert.equal(Buffer.from(restored.contents[link[2]], 'base64').toString(), 'missing-target')
    assert.deepEqual(restored.manifest.find(row => row[0] === 'main.txt'), ['main.txt', 'deleted'])
    const changed = structuredClone(restored); changed.contents[binary[2]] = Buffer.from('tampered').toString('base64')
    assert.throws(() => validateArtifactBundle(changed), /content hash mismatch/)
    const traversal = structuredClone(restored); traversal.manifest[0][0] = '../escape'
    assert.throws(() => validateArtifactBundle(traversal), /Unsafe or unordered/)
    await writeFile(join(storage, 'archives', `${refs[0].snapshot_hash}.json`), JSON.stringify(changed))
    await assert.rejects(archive.read(refs[0].snapshot_hash, refs[0]), /content hash mismatch/)
    await assert.rejects(archive.put(bundle), /content hash mismatch/, 'corrupt existing archive must not be silently overwritten')
  } finally { await rm(f.root, { recursive: true, force: true }); await rm(storage, { recursive: true, force: true }) }
})


test('actual Hub archives chunks, rejects partial/corrupt content and survives lost completion receipt and restart', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const f = await fixture(), storage = await mkdtemp(join(tmpdir(), 'kode-artifact-transfer-'))
  let hub, materializer, recoveredMaterializer
  async function writable(path) {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    await chmod(path, 0o700)
    for (const name of await readdir(path)) await writable(join(path, name))
  }
  try {
    await writeFile(join(f.root, 'large'), Buffer.alloc(600000, 123))
    await writeFile(join(f.root, '\u{1f600}'), 'unicode order one')
    await writeFile(join(f.root, '\ue000'), 'unicode order two')
    await chmod(join(f.root, 'large'), 0o755)
    await mkdir(join(f.root, 'nested'))
    await symlink('../large', join(f.root, 'nested/link'))
    await rm(join(f.root, 'main.txt'))
    const bundle = await captureArtifactBundle({ workspaceRoot: f.root, repositoryId: 'fixture' })
    const archive = new ArtifactArchive(join(storage, 'archive')), reference = await archive.put(bundle)
    hub = await isolatedHub('artifact-transfer')
    const root = '/api/v1/messaging', registration = await hub.client.call(`${root}/sessions`, { session_id: 'author', title: 'Fixture', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const op = await hub.client.call(`${root}/operations`, { owner_session: 'owner', request_key: 'transfer', worker: { node_id: hub.node, session_id: 'author' } })
    await worker.call(`${root}/operations/${op.id}`, { attempt: 1, epoch: 1, expected_revision: 1, action: { kind: 'claim', lease_ms: 60000 } })
    const evidence = { id: 'transfer', operation_id: op.id, attempt: 1, epoch: 1, payload: { kind: 'artifact', snapshot: bundle.snapshot } }
    const observed = await hub.client.call(`${root}/artifact-evidence`, evidence), sequence = observed.sequence
    const path = `${root}/artifact-archives/${sequence}`, data = Buffer.from(JSON.stringify(bundle)), chunkSize = 256 * 1024
    const identity = { archive_hash: reference.archive_hash, bytes: reference.bytes }
    const first = { ...identity, data: data.subarray(0, chunkSize).toString('base64') }
    await assert.rejects(worker.call(`${path}/chunks/0`, first), /403/)
    await hub.client.call(`${path}/chunks/0`, first)
    await assert.rejects(worker.call(path), /403/)
    await assert.rejects(worker.call(`${path}/chunks/0`), /403/)
    await assert.rejects(worker.call(`${path}/complete`, identity), /403/)
    assert.equal((await hub.client.call(path)).complete, false)
    await assert.rejects(hub.client.call(`${path}/chunks/0`), /not complete/)
    await assert.rejects(hub.client.call(`${path}/complete`, identity), /incomplete/)
    await assert.rejects(hub.client.call(`${path}/chunks/0`, { ...first, archive_hash: '0'.repeat(64) }), /identity conflict/)
    await assert.rejects(hub.client.call(`${path}/chunks/0`, { ...first, data: Buffer.alloc(chunkSize).toString('base64') }), /chunk identity conflict/)
    let dropped = false
    const lossy = { call: async (...args) => {
      const result = await hub.client.call(...args)
      if (args[0] === `${path}/complete` && !dropped) { dropped = true; throw new Error('lost completion receipt') }
      return result
    } }
    await assert.rejects(deliverArtifactArchive(lossy, sequence, archive, reference), /lost completion receipt/)
    const receipt = await deliverArtifactArchive(hub.client, sequence, archive, reference)
    assert.equal(receipt.complete, true); assert.equal(receipt.completion_authorized, false)
    await symlink('../../outside', join(f.root, 'escape'))
    const unsafeBundle = await captureArtifactBundle({ workspaceRoot: f.root, repositoryId: 'fixture' })
    const unsafeReference = await archive.put(unsafeBundle)
    const unsafe = await hub.client.call(`${root}/artifact-evidence`, { ...evidence, id: 'unsafe-link', payload: { kind: 'artifact', snapshot: unsafeBundle.snapshot } })
    await deliverArtifactArchive(hub.client, unsafe.sequence, archive, unsafeReference)
    await rm(f.root, { recursive: true, force: true }); await rm(storage, { recursive: true, force: true })
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual((await fetchArtifactArchive(hub.client, sequence, reference.snapshot_hash)).bundle, JSON.parse(JSON.stringify(bundle)))
    const cache = join(hub.root, 'materialized')
    materializer = new ArtifactMaterializer(cache, hub.client)
    await assert.rejects(materializer.prepare({ request_id: 'unsafe', sequence: unsafe.sequence, snapshot_hash: unsafeReference.snapshot_hash }), /symlink escapes/)
    await assert.rejects(lstat(cache), { code: 'ENOENT' }, 'unsafe links reject before any destination writes')
    const request = { request_id: 'review-source', sequence, snapshot_hash: reference.snapshot_hash }
    const pending = materializer.prepare(request)
    await assert.rejects(materializer.prepare({ ...request, sequence: unsafe.sequence }), /request conflict/)
    const restored = await Promise.all([pending, materializer.prepare(request)])
    assert.deepEqual(restored[0], restored[1])
    const ready = restored[0]
    assert.equal(ready.state, 'ready'); assert.equal(ready.execution_authorized, false)
    assert.deepEqual(await readFile(join(ready.source, 'large')), Buffer.alloc(600000, 123))
    assert.equal((await lstat(join(ready.source, 'large'))).mode & 0o777, 0o500)
    await assert.rejects(lstat(join(ready.source, 'main.txt')), { code: 'ENOENT' })
    assert.deepEqual(await readFile(join(ready.source, 'nested/link')), Buffer.alloc(600000, 123))
    await verifyArtifactWorkspace(ready.source, bundle)
    await materializer.close()
    recoveredMaterializer = new ArtifactMaterializer(cache, hub.client)
    assert.deepEqual(await recoveredMaterializer.prepare(request), ready)
    const stateFile = join(ready.source, '..', 'state.json')
    await writeFile(stateFile, JSON.stringify({ ...ready, execution_authorized: true }))
    await assert.rejects(recoveredMaterializer.prepare(request), /receipt changed/)
    await writeFile(stateFile, JSON.stringify({ ...ready, state: 'preparing' }))
    await assert.rejects(recoveredMaterializer.prepare(request), /requires recovery/)
    await writeFile(stateFile, JSON.stringify(ready))
    await chmod(join(ready.source, 'large'), 0o700)
    await writeFile(join(ready.source, 'large'), 'changed')
    await chmod(join(ready.source, 'large'), 0o500)
    await assert.rejects(recoveredMaterializer.prepare(request), /content changed/)
    assert.equal((await readFile(join(ready.source, 'large'))).toString(), 'changed', 'retry never repairs or overwrites a changed workspace')
    await assert.rejects(fetchArtifactArchive(hub.client, sequence, '0'.repeat(64)), /unavailable or mismatched/)
    assert.deepEqual(await hub.client.call(`${path}/complete`, identity), receipt)
    assert.equal((await hub.client.call(`${root}/operations/${op.id}/events`)).events.filter(e => e.data.kind === 'artifact_archive_completed' && e.data.sequence === sequence).length, 1)
    const bad = await hub.client.call(`${root}/artifact-evidence`, { ...evidence, id: 'bad-content' })
    const corrupted = structuredClone(bundle), content = Object.keys(corrupted.contents)[0]
    corrupted.contents[content] = Buffer.from('wrong').toString('base64')
    const badData = Buffer.from(JSON.stringify(corrupted)), badIdentity = { archive_hash: createHash('sha256').update(badData).digest('hex'), bytes: badData.length }
    const badPath = `${root}/artifact-archives/${bad.sequence}`
    for (let offset = 0, index = 0; offset < badData.length; offset += chunkSize, index++) await hub.client.call(`${badPath}/chunks/${index}`, { ...badIdentity, data: badData.subarray(offset, offset + chunkSize).toString('base64') })
    await assert.rejects(hub.client.call(`${badPath}/complete`, badIdentity), /content hash or size mismatch/)
    assert.equal((await hub.client.call(badPath)).complete, false)
  } finally { await materializer?.close(); await recoveredMaterializer?.close(); if (hub) await writable(hub.root); await hub?.close(); await rm(f.root, { recursive: true, force: true }); await rm(storage, { recursive: true, force: true }) }
})

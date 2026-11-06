import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, symlink, link, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { inspectAssignmentSource, validSourceRequest, executeAssignmentSourceTool } from '../src/assignment-source-tools.js'

test('source inspection returns actual bounded UTF-8 bytes and excludes metadata without following links', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kode-source-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'source.txt'), 'hello 世界\n')
  await mkdir(join(root, '.git'))
  await symlink('source.txt', join(root, 'alias'))
  const inspect = (name, path) => inspectAssignmentSource(root, name, { path }, undefined, async () => {})
  const listing = await inspect('kode_list_source', '.')
  assert.deepEqual(listing.entries, [{ name: 'alias', kind: 'symlink' }, { name: 'source.txt', kind: 'file' }])
  const read = await inspect('kode_read_source', 'source.txt')
  assert.equal(read.text, 'hello 世界\n'); assert.equal(read.bytes, Buffer.byteLength(read.text))
  assert.equal(read.sha256, createHash('sha256').update(read.text).digest('hex'))
  await assert.rejects(inspect('kode_read_source', 'alias'), /symlink/)
  for (const path of ['../outside', '/outside', '.git/config', 'a/../source.txt', 'a\\b', 'a//b', '']) assert.equal(Boolean(validSourceRequest({ path })), false)
  await link(join(root, 'source.txt'), join(root, 'hardlink'))
  await assert.rejects(inspect('kode_read_source', 'hardlink'), /hardlinks/)
  await writeFile(join(root, 'large'), Buffer.alloc(256 * 1024 + 1, 65))
  await assert.rejects(inspect('kode_read_source', 'large'), /bounded/)
  await writeFile(join(root, 'binary'), Buffer.from([0, 1]))
  await assert.rejects(inspect('kode_read_source', 'binary'), /Binary/)
  await assert.rejects(inspectAssignmentSource(root, 'kode_list_source', { path: '.' }, undefined, () => { throw new Error('revoked') }), /revoked/)
})

test('source tool rejects mismatched managed ownership before touching a caller workspace', async () => {
  const runtime = { host: 'home', client: { async call() { return { id: 'assignment', state: 'prepared', worker: { session_id: 'other', node_id: 'home' } } } } }
  await assert.rejects(executeAssignmentSourceTool(runtime, { id: 'worker' }, { managedAssignment: { id: 'assignment' } },
    { root: '/not-accessed' }, 'kode_read_source', { path: 'source.txt' }), /ownership mismatch/)
})

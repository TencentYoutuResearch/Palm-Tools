import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, realpath, symlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { writeAssignmentSource, validWriteRequest } from '../src/assignment-write-tool.js'
const hash = text => createHash('sha256').update(text).digest('hex')
test('source writes create without overwrite, replace exact hashes, and expose observed idempotence', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kode-write-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const invoke = request => writeAssignmentSource(root, request, undefined, async () => {})
  const create = { path: 'source.txt', content: 'first\n', expected_sha256: null }
  assert.equal((await invoke(create)).state, 'written')
  assert.equal((await invoke(create)).state, 'already_present')
  await assert.rejects(invoke({ ...create, content: 'overwrite' }), /conflict/)
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), create.content)
  const replacement = { ...create, content: 'new 世界\n', expected_sha256: hash(create.content) }
  assert.equal((await invoke(replacement)).previous_sha256, hash(create.content))
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), replacement.content)
  assert.equal((await invoke(replacement)).state, 'already_present')
  await symlink('source.txt', join(root, 'alias'))
  await assert.rejects(invoke({ ...create, path: 'alias' }), /symlink/)
  assert.deepEqual((await readdir(root)).sort(), ['alias', 'source.txt'])
  for (const change of [{ path: '../escape' }, { path: '.git/config' }, { content: '\ud800' }, { content: '\0' }, { expected_sha256: 'wrong' }]) assert.equal(Boolean(validWriteRequest({ ...create, ...change })), false)
})
test('source writes preserve concurrent edits and report post-write authorization loss without rollback', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kode-write-race-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'source.txt'), request = { path: 'source.txt', content: 'desired', expected_sha256: hash('old') }
  await writeFile(path, 'old')
  let calls = 0
  await assert.rejects(writeAssignmentSource(root, request, undefined, async () => {
    if (++calls === 4) await writeFile(path, 'external edit')
  }), /conflict/)
  assert.equal(await readFile(path, 'utf8'), 'external edit')
  await writeFile(path, 'old')
  await assert.rejects(writeAssignmentSource(root, request, undefined, async () => {
    if (await readFile(path, 'utf8') === 'desired') throw new Error('revoked after filesystem write')
  }), /revoked after/)
  assert.equal(await readFile(path, 'utf8'), 'desired')
  assert.deepEqual(await readdir(root), ['source.txt'])
})

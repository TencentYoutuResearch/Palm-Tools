/** Isolated source-reader candidate tests. The range tool is not registered in production. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, symlink, link, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { inspectAssignmentSource } from '../src/assignment-source-tools.js'
import { inspectAssignmentSourceRange as read, validSourceRangeRequest as valid } from '../src/assignment-source-range-tool.js'
const request = (extra = {}) => ({ path: 'file', start_line: 1, line_count: 1, expected_sha256: null, ...extra })
const allow = async () => {}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(t, bytes) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kode-range-candidate-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'file'), bytes)
  return root
}
test('full reader preserves BOM, Unicode and CRLF while SHA-256 covers original bytes', async t => {
  const bytes = Buffer.from('\uFEFF😀中文\r\ne\u0301\n𐐀\r')
  const root = await fixture(t, bytes), source = await inspectAssignmentSource(root, 'kode_read_source', { path: 'file' }, undefined, allow)
  assert.equal(source.sha256, hash(bytes)); assert.equal(source.bytes, bytes.length)
  assert.ok(Buffer.from(source.text, 'utf8').equals(bytes))
  assert.equal(source.text.codePointAt(0), 0xFEFF)
})
test('range pages concatenate to original BOM/Unicode/CRLF bytes with one raw file hash', async t => {
  const bytes = Buffer.from('\uFEFF😀中文\r\ne\u0301\n𐐀\r'), root = await fixture(t, bytes)
  let line = 1, expected = null, combined = ''
  do {
    const page = await read(root, request({ start_line: line, expected_sha256: expected }), undefined, allow)
    assert.equal(page.sha256, hash(bytes)); assert.equal(page.file_bytes, bytes.length)
    assert.equal(page.range_bytes, Buffer.byteLength(page.text)); assert.equal(page.total_lines, 3)
    assert.equal(page.returned_line_count, 1); combined += page.text
    expected = page.sha256; line = page.next_start_line
  } while (line !== null)
  assert.ok(Buffer.from(combined, 'utf8').equals(bytes))
})
test('range CAS notices a BOM-only or newline-only edit', async t => {
  const root = await fixture(t, '\uFEFFa\r\nb\n'), first = await read(root, request(), undefined, allow)
  await writeFile(join(root, 'file'), 'a\r\nb\n')
  await assert.rejects(read(root, request({ start_line: 2, expected_sha256: first.sha256 }), undefined, allow), /hash conflict/)
  await writeFile(join(root, 'file'), '\uFEFFa\nb\n')
  await assert.rejects(read(root, request({ start_line: 2, expected_sha256: first.sha256 }), undefined, allow), /hash conflict/)
})
test('range counts UTF-8 bytes, never truncates oversized lines and retains 256 KiB file ceiling', async t => {
  const root = await fixture(t, '😀'.repeat(4096))
  const exact = await read(root, request(), undefined, allow)
  assert.equal(exact.range_bytes, 16384); assert.equal(exact.next_start_line, null)
  await writeFile(join(root, 'file'), '😀'.repeat(4096) + 'x')
  await assert.rejects(read(root, request(), undefined, allow), /exceeds 16 KiB/)
  await writeFile(join(root, 'file'), Buffer.alloc(256 * 1024 + 1, 65))
  await assert.rejects(read(root, request(), undefined, allow), /bounded/)
  await writeFile(join(root, 'file'), Buffer.from([0xEF, 0xBB, 0xBF, 0xFF]))
  await assert.rejects(read(root, request(), undefined, allow), /encoded data|encoding|UTF/i)
})
test('empty files and terminal newlines have explicit EOF without phantom lines', async t => {
  const root = await fixture(t, ''), empty = await read(root, request(), undefined, allow)
  assert.equal(empty.total_lines, 0); assert.equal(empty.end_line, 0); assert.equal(empty.next_start_line, null)
  await writeFile(join(root, 'file'), '\r\n')
  const newline = await read(root, request(), undefined, allow)
  assert.equal(newline.total_lines, 1); assert.equal(newline.text, '\r\n'); assert.equal(newline.next_start_line, null)
})
test('range does not follow symlinks or hardlinks and rechecks owner authority', async t => {
  const root = await fixture(t, 'one\ntwo\n')
  await symlink('file', join(root, 'alias'))
  await assert.rejects(read(root, request({ path: 'alias' }), undefined, allow), /symlink/)
  await link(join(root, 'file'), join(root, 'hard'))
  await assert.rejects(read(root, request({ path: 'hard' }), undefined, allow), /hardlinks/)
  await rm(join(root, 'hard'))
  let checks = 0
  await assert.rejects(read(root, request(), undefined, async () => { if (++checks === 2) throw Error('owner revoked') }), /owner revoked/)
  assert.equal(checks, 2)
})
test('range request rejects authority injection, traversal, unpinned continuation and malformed fields', () => {
  for (const extra of [{ root: '/private' }, { path: '../file' }, { path: '.git/config' }, { path: '/file' }, { path: 'a\\b' }, { path: '.' }, { path: '' }, { start_line: 0 }, { start_line: 1.2 }, { start_line: 2 }, { line_count: 0 }, { line_count: 121 }, { expected_sha256: 'bad' }]) assert.equal(valid(request(extra)), false)
  for (const bad of [null, [], 12, 'bad', {}]) assert.equal(valid(bad), false)
  assert.equal(valid(request()), true)
})

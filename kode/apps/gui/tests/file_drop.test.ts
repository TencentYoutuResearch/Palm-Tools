import assert from 'node:assert/strict'
import test from 'node:test'

import { absoluteDroppedFilePaths, absoluteOsDroppedPaths, composerPathReferences, hasExternalFileDrag, htmlDroppedPaths, pasteboardPathsForDrop } from '../src/lib/file_drop.ts'

test('uses the absolute path supplied by the desktop webview', () => {
  const files = { 0: { name: 'notes.md', path: '/Users/dev/docs/notes.md' }, length: 1 }
  assert.deepEqual(absoluteDroppedFilePaths(files), ['/Users/dev/docs/notes.md'])
})

test('falls back to decoded file URIs and preserves full paths', () => {
  const uriList = '# Finder drop\nfile:///Users/dev/My%20Project/spec.md\n'
  assert.deepEqual(absoluteDroppedFilePaths([], uriList), [
    '/Users/dev/My Project/spec.md',
  ])
})

test('accepts Finder URI-list drags without the generic Files type', () => {
  assert.equal(hasExternalFileDrag(['text/uri-list']), true)
  assert.equal(hasExternalFileDrag(['Files']), true)
  assert.equal(hasExternalFileDrag(['text/plain']), false)
})

test('falls back to absolute text/plain paths from desktop apps', () => {
  assert.deepEqual(
    absoluteDroppedFilePaths([], '', '/Users/dev/My Project/spec.md\n'),
    ['/Users/dev/My Project/spec.md'],
  )
})

test('never degrades an external drop to a bare filename', () => {
  const files = { 0: { name: 'notes.md' }, length: 1 }
  assert.deepEqual(absoluteDroppedFilePaths(files), [])
})

test('deduplicates paths exposed by both File.path and text/uri-list', () => {
  const files = { 0: { name: 'notes.md', path: '/tmp/notes.md' }, length: 1 }
  assert.deepEqual(
    absoluteDroppedFilePaths(files, 'file:///tmp/notes.md'),
    ['/tmp/notes.md'],
  )
})

test('uses native OS drop paths from Tauri', () => {
  assert.deepEqual(
    absoluteOsDroppedPaths([
      '/Users/dev/docs/notes.md',
      'file:///Users/dev/My%20Project/spec.md',
      'C:\\work\\file.txt',
      'D:\\work\\folder',
      'notes.md',
    ]),
    [
      '/Users/dev/docs/notes.md',
      '/Users/dev/My Project/spec.md',
      'C:\\work\\file.txt',
      'D:\\work\\folder',
    ],
  )
})

test('normalizes Windows verbatim and UNC paths', () => {
  assert.deepEqual(
    absoluteOsDroppedPaths([
      '\\\\?\\C:\\work\\file.txt',
      '\\\\?\\UNC\\server\\share\\folder',
      '\\\\server\\share\\file.txt',
      'file://server/share/My%20Folder',
    ]),
    [
      'C:\\work\\file.txt',
      '\\\\server\\share\\folder',
      '\\\\server\\share\\file.txt',
      '\\\\server\\share\\My Folder',
    ],
  )
})

test('formats dropped paths as non-submitting references', () => {
  assert.equal(
    composerPathReferences([
      'C:\\work\\file.txt',
      'D:\\work folder',
      'C:\\work\\file.txt',
      'relative.txt',
    ]),
    '@C:\\work\\file.txt @D:\\work folder @relative.txt ',
  )
})

const transfer = (names: string[], uriList = '') => ({
  files: Object.assign(names.map(name => ({ name })), { length: names.length }),
  getData: (type: string) => type === 'text/uri-list' ? uriList : '',
}) as unknown as DataTransfer

test('macOS drops without paths read them back from the drag pasteboard', async () => {
  const urls = ['file:///Users/dev/My%20Project/spec.md', 'file:///Users/dev/assets/']
  assert.deepEqual(await htmlDroppedPaths(transfer(['assets', 'spec.md']), async () => urls),
    ['/Users/dev/My Project/spec.md', '/Users/dev/assets/'])
})

test('a pasteboard left over from an earlier drag is ignored', async () => {
  assert.deepEqual(pasteboardPathsForDrop([{ name: 'new.md' }], ['file:///Users/dev/old.md']), [])
  assert.deepEqual(pasteboardPathsForDrop([{ name: 'a.md' }], ['file:///Users/dev/a.md', 'file:///Users/dev/b.md']), [])
  assert.deepEqual(pasteboardPathsForDrop([], ['file:///Users/dev/a.md']), [])
  assert.deepEqual(await htmlDroppedPaths(transfer(['new.md']), async () => { throw new Error('no ipc') }), [])
})

test('decomposed Finder names still match the dropped file', () => {
  const decomposed = 'file:///Users/dev/' + encodeURIComponent('résumé.md'.normalize('NFD'))
  assert.equal(pasteboardPathsForDrop([{ name: 'résumé.md' }], [decomposed]).length, 1)
})

test('paths the webview already supplies skip the pasteboard', async () => {
  const paths = await htmlDroppedPaths(transfer(['spec.md'], 'file:///Users/dev/spec.md'), async () => assert.fail('not read'))
  assert.deepEqual(paths, ['/Users/dev/spec.md'])
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { absoluteDroppedFilePaths, absoluteOsDroppedPaths } from '../src/lib/file_drop.ts'

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
      'notes.md',
    ]),
    ['/Users/dev/docs/notes.md', '/Users/dev/My Project/spec.md'],
  )
})

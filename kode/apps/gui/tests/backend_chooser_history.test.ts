import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isAbsoluteSessionCwd } from '../src/lib/session_history_path.ts'

const chooserSource = await readFile(
  new URL('../src/lib/BackendChooser.svelte', import.meta.url),
  'utf8',
)

test('session history reserves stable space before asynchronous results arrive', () => {
  const historyStyles = chooserSource.match(/\.session-history\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? ''

  assert.match(historyStyles, /height:\s*208px/)
  assert.match(historyStyles, /min-height:\s*208px/)
  assert.match(historyStyles, /overflow:\s*hidden/)
})

test('session history results scroll inside the reserved space', () => {
  const listStyles = chooserSource.match(/\.sh-list\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? ''

  assert.match(listStyles, /flex:\s*1/)
  assert.match(listStyles, /min-height:\s*0/)
  assert.match(listStyles, /overflow-y:\s*auto/)
})

test('session history accepts Windows and POSIX absolute paths', () => {
  assert.equal(isAbsoluteSessionCwd('/Users/example/project'), true)
  assert.equal(isAbsoluteSessionCwd('D:\\kode\\kode'), true)
  assert.equal(isAbsoluteSessionCwd('d:/kode/kode'), true)
  assert.equal(isAbsoluteSessionCwd('\\\\server\\share\\project'), true)
  assert.equal(isAbsoluteSessionCwd('relative\\project'), false)
  assert.equal(isAbsoluteSessionCwd('  '), false)
})

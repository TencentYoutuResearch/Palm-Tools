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
  // The slot is a fixed flex sibling of the card, never squeezed away.
  assert.match(historyStyles, /flex-shrink:\s*0/)
})

test('new session is a single view with a backend dropdown, no phase swapping', () => {
  assert.doesNotMatch(chooserSource, /phase\s*===\s*'(list|configure)'/)
  assert.doesNotMatch(chooserSource, /\{#if phase/)
  assert.match(chooserSource, /let selectedValue = \$state\(''\)/)
  assert.match(chooserSource, /<optgroup/)
})

test('new session button requires both a backend and a working directory', () => {
  assert.match(chooserSource, /disabled=\{submitting \|\| !selected \|\| !cwd\.trim\(\)\}/)
})

test('card keeps a fixed height so the view never jumps', () => {
  const cardStyles = chooserSource.match(/\.card\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? ''

  assert.match(cardStyles, /height:\s*min\(90vh/)
  assert.match(cardStyles, /overflow:\s*hidden/)
  assert.doesNotMatch(cardStyles, /overflow-y:\s*auto/)
  assert.match(cardStyles, /box-sizing:\s*border-box/)
})

test('unused vertical space goes to session history instead of an empty gap', () => {
  const historyStyles = chooserSource.match(/\.session-history\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? ''
  const scrollStyles = chooserSource.match(/\.setup-scroll\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? ''

  assert.match(historyStyles, /flex-grow:\s*1/)
  assert.doesNotMatch(scrollStyles, /flex:\s*1\s*;/)
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

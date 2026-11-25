import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isTerminalAbsolutePath,
  resolveTerminalPath,
  terminalPathSegments,
} from '../src/lib/terminal_path_links.ts'

test('Unix paths expose cumulative targets and reveal the next child', () => {
  assert.deepEqual(terminalPathSegments('/repo/src/lib/file.ts'), [
    { text: '/', start: 0, end: 1, target: '/', revealChild: '/repo', isFinal: false },
    { text: 'repo', start: 1, end: 5, target: '/repo', revealChild: '/repo/src', isFinal: false },
    { text: 'src', start: 6, end: 9, target: '/repo/src', revealChild: '/repo/src/lib', isFinal: false },
    { text: 'lib', start: 10, end: 13, target: '/repo/src/lib', revealChild: '/repo/src/lib/file.ts', isFinal: false },
    { text: 'file.ts', start: 14, end: 21, target: '/repo/src/lib/file.ts', revealChild: null, isFinal: true },
  ])
})

test('Windows drive and UNC paths keep their roots intact', () => {
  assert.deepEqual(
    terminalPathSegments('F:\\repo\\src\\main.rs').map(segment => [segment.text, segment.target]),
    [['F:\\', 'F:\\'], ['repo', 'F:\\repo'], ['src', 'F:\\repo\\src'], ['main.rs', 'F:\\repo\\src\\main.rs']],
  )
  assert.deepEqual(
    terminalPathSegments('\\\\server\\share\\repo\\file.txt').map(segment => segment.text),
    ['\\\\server\\share\\', 'repo', 'file.txt'],
  )
})

test('relative and home paths produce navigable prefixes', () => {
  assert.deepEqual(
    terminalPathSegments('src/lib/file.ts').map(segment => [segment.target, segment.revealChild]),
    [['src', 'src/lib'], ['src/lib', 'src/lib/file.ts'], ['src/lib/file.ts', null]],
  )
  assert.deepEqual(
    terminalPathSegments('~/repo/file.ts').map(segment => [segment.target, segment.revealChild]),
    [['~/', '~/repo'], ['~/repo', '~/repo/file.ts'], ['~/repo/file.ts', null]],
  )
})

test('relative targets resolve against POSIX and Windows cwd values', () => {
  assert.equal(resolveTerminalPath('src/lib/file.ts', '/repo'), '/repo/src/lib/file.ts')
  assert.equal(resolveTerminalPath('src\\lib\\file.ts', 'F:\\repo'), 'F:\\repo\\src\\lib\\file.ts')
  assert.equal(resolveTerminalPath('/absolute/file.ts', '/repo'), '/absolute/file.ts')
  assert.equal(resolveTerminalPath('~/file.ts', '/repo'), '~/file.ts')
  assert.equal(isTerminalAbsolutePath('C:\\repo'), true)
  assert.equal(isTerminalAbsolutePath('relative/file.ts'), false)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  joinWrappedTerminalRows,
  isTerminalAbsolutePath,
  resolveTerminalPath,
  terminalCharIndexAtPosition,
  terminalLinkTargets,
  terminalLogicalRowBounds,
  terminalPathSegments,
  terminalRangeForOffsets,
  type WrappedTerminalRow,
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

function row(y: number, text: string, isWrapped: boolean): WrappedTerminalRow {
  return {
    y,
    isWrapped,
    cells: [...text].map((char, index) => ({
      char,
      x: index + 1,
      endX: index + 2,
    })),
  }
}

test('wrapped rows rebuild a complete URL and multi-row range', () => {
  const line = joinWrappedTerminalRows([
    row(10, 'https://example.', false),
    row(11, 'com/a/b', true),
  ])
  assert.ok(line)
  assert.equal(line.text, 'https://example.com/a/b')
  const target = terminalLinkTargets(line.text)[0]
  assert.deepEqual(terminalRangeForOffsets(line, target.start, target.end), {
    start: { x: 1, y: 10 },
    end: { x: 8, y: 11 },
  })
  assert.equal(terminalCharIndexAtPosition(line, 10, 10), 9)
  assert.equal(terminalCharIndexAtPosition(line, 11, 1), 16)
})

test('wrapped path segments retain logical offsets across physical rows', () => {
  const line = joinWrappedTerminalRows([
    row(20, 'F:\\repo\\', false),
    row(21, 'src\\main.rs', true),
  ])
  assert.ok(line)
  const targets = terminalLinkTargets(line.text)
  assert.deepEqual(targets.map(target => target.text), ['F:\\', 'repo', 'src', 'main.rs'])
  assert.deepEqual(terminalRangeForOffsets(line, targets[2].start, targets[2].end), {
    start: { x: 1, y: 21 },
    end: { x: 4, y: 21 },
  })
})

test('hard newlines are not joined and CJK cells keep physical columns', () => {
  const flags = [false, false, true, false]
  assert.deepEqual(terminalLogicalRowBounds(index => flags[index], 2), { start: 1, end: 2 })
  assert.deepEqual(terminalLogicalRowBounds(index => flags[index], 3), { start: 3, end: 3 })

  const line = joinWrappedTerminalRows([{
    y: 30,
    isWrapped: false,
    cells: [
      { char: '你', x: 1, endX: 3 },
      { char: '/', x: 3, endX: 4 },
      { char: 'a', x: 4, endX: 5 },
    ],
  }])
  assert.ok(line)
  assert.equal(terminalCharIndexAtPosition(line, 30, 2), 0)
  assert.equal(terminalCharIndexAtPosition(line, 30, 3), 1)
  const target = terminalLinkTargets(line.text)[0]
  assert.deepEqual(terminalRangeForOffsets(line, target.start, target.end), {
    start: { x: 1, y: 30 },
    end: { x: 3, y: 30 },
  })
})

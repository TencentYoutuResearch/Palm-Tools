import assert from 'node:assert/strict'
import test from 'node:test'

import { stripTerminalMouseReports } from '../src/lib/terminal_mouse_reports.ts'

test('strips SGR mouse press, release, and motion reports', () => {
  assert.equal(stripTerminalMouseReports('\x1b[<0;12;34M'), '')
  assert.equal(stripTerminalMouseReports('\x1b[<0;12;34m'), '')
  assert.equal(stripTerminalMouseReports('\x1b[<35;12;34M'), '')
})

test('preserves SGR wheel reports for TCodex transcript scrolling', () => {
  assert.equal(stripTerminalMouseReports('\x1b[<64;12;34M'), '\x1b[<64;12;34M')
  assert.equal(stripTerminalMouseReports('\x1b[<65;12;34M'), '\x1b[<65;12;34M')
})

test('strips urxvt and X10 mouse reports', () => {
  assert.equal(stripTerminalMouseReports('\x1b[35;12;34M'), '')
  assert.equal(stripTerminalMouseReports('\x1b[M !!'), '')
})

test('preserves keyboard input and escape sequences around removed reports', () => {
  assert.equal(stripTerminalMouseReports('a\x1b[<0;1;2Mb'), 'ab')
  assert.equal(stripTerminalMouseReports('\x1b[A\x03'), '\x1b[A\x03')
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { TerminalMouseTrackingGate } from '../src/lib/terminal_mouse_tracking.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function filter(gate: TerminalMouseTrackingGate, value: string): string {
  return decoder.decode(gate.transform(encoder.encode(value)))
}

test('removes legacy or non-SGR TCodex mouse tracking modes', () => {
  const gate = new TerminalMouseTrackingGate()
  for (const mode of ['9', '1005', '1015']) {
    assert.equal(filter(gate, `a\x1b[?${mode}hb`), 'ab')
  }
})

test('preserves SGR button, motion, and format modes', () => {
  const gate = new TerminalMouseTrackingGate()
  for (const mode of ['1000', '1002', '1003', '1006']) {
    assert.equal(filter(gate, `a\x1b[?${mode}hb`), `a\x1b[?${mode}hb`)
  }
})

test('preserves mixed SGR and non-mouse modes', () => {
  const gate = new TerminalMouseTrackingGate()
  assert.equal(filter(gate, '\x1b[?1;1003;1006h'), '\x1b[?1;1003;1006h')
})

test('removes a split DECSET sequence across PTY chunks', () => {
  const gate = new TerminalMouseTrackingGate()
  assert.equal(filter(gate, 'before\x1b[?100'), 'before')
  assert.equal(filter(gate, '5hafter'), 'after')
})

test('preserves a split SGR DECSET sequence across PTY chunks', () => {
  const gate = new TerminalMouseTrackingGate()
  assert.equal(filter(gate, 'before\x1b[?10'), 'before')
  assert.equal(filter(gate, '03hafter'), '\x1b[?1003hafter')
})

test('leaves mouse disable and unrelated escape sequences unchanged', () => {
  const gate = new TerminalMouseTrackingGate()
  const input = '\x1b[?1002l\x1b[31mred\x1b[0m'
  assert.equal(filter(gate, input), input)
})

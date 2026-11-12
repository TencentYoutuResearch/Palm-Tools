import assert from 'node:assert/strict'
import test from 'node:test'

import { TerminalMouseTrackingGate } from '../src/lib/terminal_mouse_tracking.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function filter(gate: TerminalMouseTrackingGate, value: string): string {
  return decoder.decode(gate.transform(encoder.encode(value)))
}

test('removes every TCodex DECSET mouse tracking mode', () => {
  const gate = new TerminalMouseTrackingGate()
  for (const mode of ['9', '1000', '1002', '1003', '1005', '1006', '1015']) {
    assert.equal(filter(gate, `a\x1b[?${mode}hb`), 'ab')
  }
})

test('preserves non-mouse modes in a mixed DECSET sequence', () => {
  const gate = new TerminalMouseTrackingGate()
  assert.equal(filter(gate, '\x1b[?1;1002;1006h'), '\x1b[?1h')
})

test('removes a split DECSET sequence across PTY chunks', () => {
  const gate = new TerminalMouseTrackingGate()
  assert.equal(filter(gate, 'before\x1b[?10'), 'before')
  assert.equal(filter(gate, '02hafter'), 'after')
})

test('leaves mouse disable and unrelated escape sequences unchanged', () => {
  const gate = new TerminalMouseTrackingGate()
  const input = '\x1b[?1002l\x1b[31mred\x1b[0m'
  assert.equal(filter(gate, input), input)
})

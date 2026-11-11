import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TerminalImeOutputGate } from '../src/lib/terminal_ime.ts'

const bytes = (...values: number[]) => new Uint8Array(values)

test('IME composition defers terminal redraws and replays them in order', () => {
  const gate = new TerminalImeOutputGate()
  assert.deepEqual(gate.push(bytes(1)), bytes(1))

  gate.begin()
  assert.equal(gate.push(bytes(2)), null)
  assert.equal(gate.push(bytes(3, 4)), null)
  assert.equal(gate.deferring, true)

  const replay = gate.end()
  assert.deepEqual(replay, bytes(2, 3, 4))
  assert.equal(gate.deferring, false)
  assert.deepEqual(gate.push(bytes(5)), bytes(5))
})

test('clearing an interrupted composition discards only deferred output', () => {
  const gate = new TerminalImeOutputGate()
  gate.begin()
  gate.push(bytes(1, 2, 3))
  gate.clear()
  assert.equal(gate.end(), null)
  assert.deepEqual(gate.push(bytes(4)), bytes(4))
})

test('exceptional output flushes at the bound without losing ordered bytes', () => {
  const gate = new TerminalImeOutputGate(4)
  gate.begin()
  assert.equal(gate.push(bytes(1, 2)), null)
  assert.deepEqual(gate.push(bytes(3, 4)), bytes(1, 2, 3, 4))
  assert.equal(gate.push(bytes(5)), null)
  assert.deepEqual(gate.end(), bytes(5))
})

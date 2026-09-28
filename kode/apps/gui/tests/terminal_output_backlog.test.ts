import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TerminalOutputBacklog } from '../src/lib/terminal_output_backlog.ts'

test('hidden bytes retain their exact order until the tab is shown', () => {
  const backlog = new TerminalOutputBacklog(8)
  assert.equal(backlog.push(Uint8Array.of(0x1b, 0x5b)), null)
  assert.equal(backlog.push(Uint8Array.of(0x33, 0x31, 0x6d)), null)
  assert.deepEqual([...backlog.take()!], [0x1b, 0x5b, 0x33, 0x31, 0x6d])
  assert.equal(backlog.take(), null)
})

test('sustained hidden output flushes at the bound without losing later bytes', () => {
  const backlog = new TerminalOutputBacklog(4)
  assert.equal(backlog.push(Uint8Array.of(1, 2)), null)
  assert.deepEqual([...backlog.push(Uint8Array.of(3, 4))!], [1, 2, 3, 4])
  assert.equal(backlog.push(Uint8Array.of(5)), null)
  assert.deepEqual([...backlog.take()!], [5])
})

test('clear discards bytes only when the terminal is disposed', () => {
  const backlog = new TerminalOutputBacklog()
  backlog.push(Uint8Array.of(1))
  backlog.clear()
  assert.equal(backlog.take(), null)
})

test('queued bytes are independent of the IPC buffer lifetime', () => {
  const backlog = new TerminalOutputBacklog()
  const incoming = Uint8Array.of(7, 8)
  backlog.push(incoming)
  incoming[0] = 9
  assert.deepEqual([...backlog.take()!], [7, 8])
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { installConptyCursorGuard } from '../src/lib/conpty_cursor.ts'

const { Terminal } = createRequire(import.meta.url)('@xterm/xterm')
const write = (term: any, data: string) => new Promise<void>(resolve => term.write(data, resolve))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('ConPTY split redraw keeps intermediate cursor hidden until delayed restore', async () => {
  const term = new Terminal({ allowProposedApi: true, rows: 45 })
  const dispose = installConptyCursorGuard(term)
  try {
    // Replay the actual captured controls, splitting even inside CSI sequences.
    for (const char of '\x1b[?2026h\x1b[?25l\x1b[37;1H\x1b[?25h\x1b[0 q\x1b[?2026l') {
      await write(term, char)
    }
    assert.equal(term._core.coreService.isCursorHidden, true)
    await sleep(100) // Longer than the old 32/64ms batching limits.
    assert.equal(term._core.coreService.isCursorHidden, true)
    await write(term, '\x1b[?25l\x1b[39;8H\x1b[?25h')
    assert.equal(term._core.coreService.isCursorHidden, false)
    assert.equal(term.buffer.active.cursorY, 38)
    assert.equal(term.buffer.active.cursorX, 7)
  } finally { dispose(); term.dispose() }
})

test('missing post-frame restore has a bounded fallback', async () => {
  const term = new Terminal({ allowProposedApi: true })
  const dispose = installConptyCursorGuard(term)
  try {
    await write(term, '\x1b[?2026h\x1b[?25l\x1b[?25h\x1b[?2026l')
    await sleep(300)
    await write(term, '')
    assert.equal(term._core.coreService.isCursorHidden, false)
  } finally { dispose(); term.dispose() }
})

test('explicit hide cancels restoration and ordinary cursor modes pass through', async () => {
  const term = new Terminal({ allowProposedApi: true })
  const dispose = installConptyCursorGuard(term)
  try {
    await write(term, '\x1b[?2026h\x1b[?25l\x1b[?25h\x1b[?2026l\x1b[?25l')
    await sleep(300)
    assert.equal(term._core.coreService.isCursorHidden, true)
    await write(term, '\x1b[?25h')
    assert.equal(term._core.coreService.isCursorHidden, false)
  } finally { dispose(); term.dispose() }
})

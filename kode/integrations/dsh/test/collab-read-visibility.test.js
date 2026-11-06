import test from 'node:test'
import assert from 'node:assert/strict'
import { observeConversationRead } from '../packages/collab/read-visibility.js'

test('visible read cursor cannot skip unseen messages, run hidden, or continue after disposal', async () => {
  let tick, cleared = false, focused = true, positions = [[0, 60], [150, 210]], through = 0
  const writes = [], doc = { visibilityState: 'visible', hasFocus: () => focused }
  const root = { isConnected: true, getBoundingClientRect: () => ({ top: 0, bottom: 100, width: 100 }), querySelectorAll: () => positions.map(([top, bottom], i) => ({ dataset: { messageSequence: String(i + 1) }, getBoundingClientRect: () => ({ top, bottom, left: 0, right: 100, width: 100 }) })) }
  const stop = observeConversationRead({ root, document: doc, window: { innerHeight: 100, innerWidth: 100, setInterval: fn => { tick = fn; return 1 }, clearInterval: () => { cleared = true } },
    getState: () => ({ items: [{ sequence: 1 }, { sequence: 2 }], readState: { through_sequence: through } }), markRead: async seq => { writes.push(seq); through = seq } })
  const scan = async () => { tick(); await Promise.resolve(); await Promise.resolve() }
  doc.visibilityState = 'hidden'; await scan(); assert.deepEqual(writes, [])
  doc.visibilityState = 'visible'; focused = false; await scan(); assert.deepEqual(writes, [])
  focused = true
  positions = [[-100, -40], [0, 60]]; await scan(); assert.deepEqual(writes, [], 'later visible item cannot skip unseen prefix')
  positions = [[0, 60], [150, 210]]; await scan(); assert.deepEqual(writes, [2], 'both previously presented items form contiguous prefix')
  stop(); assert.equal(cleared, true); await scan(); assert.deepEqual(writes, [2])
})

test('oversized messages require seeing their beginning and end before acknowledgment', async () => {
  let tick, top = -200, bottom = 70, writes = 0
  const root = { isConnected: true, getBoundingClientRect: () => ({ top: 0, bottom: 100, width: 100 }), querySelectorAll: () => [{ dataset: { messageSequence: '7' }, getBoundingClientRect: () => ({ top, bottom, width: 100, left: 0, right: 100 }) }] }
  const stop = observeConversationRead({ root, document: { visibilityState: 'visible', hasFocus: () => true }, window: { innerHeight: 100, innerWidth: 100, setInterval: fn => { tick = fn }, clearInterval() {} }, getState: () => ({ items: [{ sequence: 7 }], readState: { through_sequence: 0 } }), markRead: async () => { writes++ } })
  const scan = async () => { tick(); await Promise.resolve(); await Promise.resolve() }
  await scan(); assert.equal(writes, 0)
  top = 0; bottom = 270; await scan(); assert.equal(writes, 0)
  top = -200; bottom = 70; await scan(); assert.equal(writes, 1)
  stop()
})

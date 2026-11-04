import test from 'node:test'
import assert from 'node:assert/strict'
import { repairNativeInboxSplices } from '../src/repair-inbox-splices.js'
const message = { id: 'input', role: 'user', content: [{ type: 'text', text: 'Keep this task' }] }
const splice = (seq, target, start, removedCount, inserted) => ({ type: 'agent/inbox/spliced', seq, time: seq, data: { target, start, removedCount, inserted } })
test('dangling duplicate transfer retains the original unclaimed input and every event identity', () => {
  const events = [splice(0, 'next-turn', 0, 0, [message]), splice(1, 'next-step', 0, 0, [message]), { type: 'turn/end', seq: 2, data: {} }]
  const repaired = repairNativeInboxSplices(events)
  assert.deepEqual(repaired.changes, [{ seq: 1, action: 'retain-original-queue' }])
  assert.equal(repaired.events[1].type, 'plugin:kode/inbox-splice-repair')
  assert.deepEqual(repaired.events.map(e => e.seq), [0, 1, 2])
  assert.deepEqual(repaired.events[0], events[0])
  assert.equal(events[1].type, 'agent/inbox/spliced')
  assert.deepEqual(repairNativeInboxSplices(repaired.events).changes, [])
})
test('completed legacy transfer removes before inserting, retaining final queue state', () => {
  const events = [splice(0, 'next-turn', 0, 0, [message]), splice(1, 'next-step', 0, 0, [message]), { type: 'plugin:kode/native-event', seq: 2 }, splice(3, 'next-turn', 0, 1, []), splice(4, 'next-step', 0, 1, [])]
  const result = repairNativeInboxSplices(events)
  assert.equal(result.events[1].data.target, 'next-turn')
  assert.equal(result.events[3].data.target, 'next-step')
  assert.deepEqual(repairNativeInboxSplices(result.events).changes, [])
})
test('ambiguous or different-content duplicates are refused', () => {
  const events = [splice(0, 'next-turn', 0, 0, [message]), splice(1, 'next-step', 0, 0, [message])]
  assert.throws(() => repairNativeInboxSplices([...events, splice(2, 'next-step', 0, 1, [])]), /Ambiguous/)
  assert.throws(() => repairNativeInboxSplices([events[0], splice(1, 'next-step', 0, 0, [{ ...message, content: [] }])]), /different content/)
})

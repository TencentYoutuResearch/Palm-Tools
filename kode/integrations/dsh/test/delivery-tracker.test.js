import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeliveryTracker, deliveryInputId } from '../src/delivery-tracker.js'
function fixture() {
  const log = [], records = new Map(), calls = []
  let flushes = 0
  const agent = { id: 'worker', session: { snapshotEvents: offset => log.filter(e => e.seq >= offset) }, ctx: { parallel: async () => { flushes++ } } }
  const client = { call: async (path, body) => {
    calls.push({ path, body, flushes })
    if (!body) return { deliveries: [...records.values()].filter(r => r.phase !== 'consumed'), next: null }
    const message_id = path.split('/').at(-2), old = records.get(message_id)
    if (old && ['prepared', 'queued', 'consumed'].indexOf(old.phase) >= ['prepared', 'queued', 'consumed'].indexOf(body.phase)) return old
    const row = { message_id, ...body }; records.set(message_id, row); return row
  } }
  return { log, records, calls, agent, tracker: () => createDeliveryTracker(agent, client) }
}
test('restart recovers persisted queue and consumption evidence without replay', async () => {
  const h = fixture(), message = { id: 'message' }, input = deliveryInputId(message.id)
  await h.tracker().prepare(message)
  h.log.push({ seq: 0, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: input }] } })
  await h.tracker().recover()
  assert.equal(h.records.get('message').phase, 'queued')
  h.log.push({ seq: 1, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } }, { seq: 2, type: 'user/message', data: { id: input } })
  await h.tracker().recover()
  assert.equal(h.records.get('message').phase, 'consumed')
  assert.equal(h.records.get('message').event_seq, 2)
  assert.ok(h.calls.filter(c => c.body && c.body.phase !== 'prepared').every(c => c.flushes > 0))
  assert.ok(h.calls.every(c => !/claim|create/.test(c.path)))
})
test('missing evidence and removed queued input never imply consumption', async () => {
  const h = fixture(), message = { id: 'message' }, input = deliveryInputId(message.id), tracker = h.tracker()
  await tracker.prepare(message)
  await tracker.recover()
  assert.equal(h.records.get('message').phase, 'prepared')
  h.log.push({ seq: 0, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: input }] } }, { seq: 1, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } })
  await tracker.recover()
  assert.equal(h.records.get('message').phase, 'prepared')
})
test('failed persistence cannot publish recovered consumption', async () => {
  const h = fixture(), message = { id: 'message' }
  await h.tracker().prepare(message)
  h.log.push({ seq: 0, type: 'user/message', data: { id: deliveryInputId(message.id) } })
  h.agent.ctx.parallel = async () => { throw new Error('disk unavailable') }
  await assert.rejects(h.tracker().recover(), /disk unavailable/)
  assert.equal(h.records.get('message').phase, 'prepared')
})

test('confirmation refuses missing or concurrently removed input evidence', async () => {
  const h = fixture(), message = { id: 'message' }, input = deliveryInputId(message.id), tracker = h.tracker()
  await tracker.prepare(message)
  await assert.rejects(tracker.confirm(message), /outcome remains uncertain/)
  h.log.push({ seq: 0, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: input }] } }, { seq: 1, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } })
  await assert.rejects(tracker.confirm(message), /outcome remains uncertain/)
  assert.equal(h.records.get('message').phase, 'prepared')
})
test('confirmation flushes consumption before publishing and retries a failed flush', async () => {
  const h = fixture(), message = { id: 'message' }, tracker = h.tracker()
  await tracker.prepare(message)
  h.log.push({ seq: 0, type: 'user/message', data: { id: deliveryInputId(message.id) } })
  const flush = h.agent.ctx.parallel
  h.agent.ctx.parallel = async () => { throw new Error('disk unavailable') }
  await assert.rejects(tracker.confirm(message), /disk unavailable/)
  assert.equal(h.records.get('message').phase, 'prepared')
  h.agent.ctx.parallel = flush
  await tracker.confirm(message)
  assert.equal(h.records.get('message').phase, 'consumed')
  assert.equal(h.calls.at(-1).flushes, 1)
})
test('runtime without readable event history cannot confirm durable queue or consumption', async () => {
  const h = fixture(), message = { id: 'message' }
  delete h.agent.session.snapshotEvents
  const tracker = h.tracker()
  await tracker.prepare(message)
  await assert.rejects(tracker.confirm(message), /Approximate submission only/)
  assert.equal(h.records.get('message').phase, 'prepared')
  assert.equal(h.calls.at(-1).flushes, 0)
})

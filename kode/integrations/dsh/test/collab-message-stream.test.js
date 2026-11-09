import test from 'node:test'
import assert from 'node:assert/strict'
import { createCollabData } from '../packages/collab/data.js'
import { readMessageStream, visibleMessageStream } from '../packages/collab/message-stream.js'
const message = sequence => ({ id: `msg-${sequence}`, home_hub: 'home', team_id: 'team', conversation_id: 'dm', sequence, content: 'hello' })
const page = (...numbers) => ({ home_hub: 'home', team_id: 'team', conversation_id: 'dm', items: numbers.map(message), next_cursor: null, has_more: false })
const store = async options => {
  const data = createCollabData({ request: async () => ({ home_hub: 'home', projection: 'configuration_revision', items: [{ id: 'team', superagent_id: 'super', conversation_id: 'dm', home_hub: 'home' }], next_cursor: null }), ...options })
  await data.loadTeams(); return data
}
test('stream batches a burst into one frame, accepts exact replays and fences foreign/conflicting pages', async () => {
  const frames = new Map(); let serial = 0, notifications = 0
  const data = await store({ schedulePublish: cb => { frames.set(++serial, cb); return serial }, cancelPublish: id => frames.delete(id) })
  const flush = () => { for (const [id, cb] of frames) { frames.delete(id); cb() } }
  flush(); data.subscribe(() => notifications++)
  for (let i = 1; i <= 1000; i++) data.acceptMessagePage('dm', page(i))
  assert.equal(frames.size, 1); assert.equal(notifications, 0); flush(); assert.equal(notifications, 1)
  data.acceptMessagePage('dm', page(999, 1000)); assert.equal(frames.size, 0)
  assert.throws(() => data.acceptMessagePage('dm', { ...page(1001), team_id: 'foreign' }))
  assert.throws(() => data.acceptMessagePage('dm', { ...page(1000), items: [{ ...message(1000), content: 'changed' }] }))
  assert.equal(data.getSnapshot().conversations.dm.cursor, 1000)
  assert.equal(data.getSnapshot().conversations.dm.items.length, 1000)
  data.dispose(); assert.equal(frames.size, 0)
})
test('an overlapping slow REST response cannot erase newer streamed messages', async () => {
  let reply; const data = await store()
  // Preserve the directory request but defer the message read.
  const other = await store({ request: async path => path.includes('/collab/teams') ? { home_hub: 'home', projection: 'configuration_revision', items: [{ id: 'team', superagent_id: 'super', conversation_id: 'dm', home_hub: 'home' }], next_cursor: null } : new Promise(resolve => { reply = resolve }) })
  const reading = other.loadMessages('dm'); await Promise.resolve()
  other.acceptMessagePage('dm', page(1, 2)); reply(page(1)); await reading
  assert.deepEqual(other.getSnapshot().conversations.dm.items.map(m => m.sequence), [1, 2])
  data.dispose(); other.dispose()
})
test('SSE parses fragmented UTF-8 with owner cookies, validates ids and cancels the stream', async () => {
  const bytes = new TextEncoder().encode(`: heartbeat\n\nevent: messages\nid: 3\ndata: ${JSON.stringify({ ...page(3), items: [{ ...message(3), content: '你好' }] })}\n\n`)
  const chunks = Array.from(bytes, value => Uint8Array.of(value)); let cancelled = false, init
  const received = []
  await assert.rejects(readMessageStream({ conversationId: 'dm', after: 2, onPage: value => received.push(value), fetcher: async (path, options) => {
    assert.match(path, /after=2/); init = options
    return new Response(new ReadableStream({ pull(controller) { if (chunks.length) controller.enqueue(chunks.shift()); else controller.close() }, cancel() { cancelled = true } }), { headers: { 'content-type': 'text/event-stream' } })
  } }), /ended/)
  assert.equal(received[0].items[0].content, '你好'); assert.equal(init.credentials, 'same-origin'); assert.equal(init.redirect, 'error')
  assert.equal(init.headers.accept, 'text/event-stream')
  await assert.rejects(readMessageStream({ conversationId: 'dm', after: 0, onPage() {}, fetcher: async () => new Response('event: messages\nid: 99\ndata: '+JSON.stringify(page(3))+'\n\n', { headers: { 'content-type': 'text/event-stream' } }) }), /cursor/)
})
test('hidden page aborts the stream, ignores late events and resumes from the accepted cursor', async () => {
  const data = await store(), listeners = new Map(), calls = [], timers = new Map()
  const doc = { visibilityState: 'visible', addEventListener: (key, cb) => listeners.set(key, cb), removeEventListener: key => listeners.delete(key) }
  const stop = visibleMessageStream({ store: data, conversationId: 'dm', document: doc, stream: options => { calls.push(options); return new Promise(resolve => options.signal.addEventListener('abort', resolve)) }, setTimer: cb => { timers.set(1, cb); return 1 }, clearTimer: id => timers.delete(id) })
  calls[0].onPage(page(1)); doc.visibilityState = 'hidden'; listeners.get('visibilitychange')()
  assert.equal(calls[0].signal.aborted, true); calls[0].onPage(page(2)); assert.equal(data.getSnapshot().conversations.dm.cursor, 1)
  await Promise.resolve(); assert.equal(timers.size, 0)
  doc.visibilityState = 'visible'; listeners.get('visibilitychange')(); assert.equal(calls[1].after, 1)
  stop(); assert.equal(calls[1].signal.aborted, true); assert.equal(listeners.size, 0); data.dispose()
})

test('a silent stalled stream cancels its reader after the inactivity deadline', async () => {
  let expire, cancelled = false, signal
  await assert.rejects(readMessageStream({ conversationId: 'dm', after: 0, onPage() {},
    setTimer: cb => { expire = cb; return 1 }, clearTimer() {}, fetcher: async (_, init) => {
      signal = init.signal
      return new Response(new ReadableStream({ start() { setImmediate(() => expire()) }, cancel() { cancelled = true } }), { headers: { 'content-type': 'text/event-stream' } })
    } }), /ended/)
  assert.equal(signal.aborted, true); assert.equal(cancelled, true)
})

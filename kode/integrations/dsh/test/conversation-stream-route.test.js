import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerConversationStream } from '../src/conversation-stream-route.js'

function harness({ pages = [], kind = 'owner', backendError } = {}) {
  let route
  const calls = []
  const timeoutRows = [], intervalRows = []
  const timers = {
    setTimeout(fn, delay) { const row = { fn, delay, active: true }; timeoutRows.push(row); return row },
    clearTimeout(row) { if (row) row.active = false },
    setInterval(fn, delay) { const row = { fn, delay, active: true }; intervalRows.push(row); return row },
    clearInterval(row) { if (row) row.active = false },
  }
  const backendClient = { call: async (...args) => {
    calls.push(args)
    if (backendError) throw backendError
    const next = pages.shift()
    if (next instanceof Promise) return next
    if (next instanceof Error) throw next
    return next ?? page([], null, false)
  } }
  const dispose = registerConversationStream({
    webServer: { register: value => { route = value } },
    connection: { admit: () => ({ peer: { principal: { kind } } }) },
    get: key => key === 'kodeAgents' ? { officialExecution: { host: 'home' } } : undefined,
  }, { backendClient }, timers)
  const makeRequest = (url, headers = {}, method = 'GET') => Object.assign(new EventEmitter(), { url, headers, method })
  const makeResponse = ({ blockedWrites = 0 } = {}) => {
    const response = new EventEmitter()
    response.headersSent = false; response.writableEnded = false; response.blocks = blockedWrites
    response.chunks = []; response.status = undefined; response.headers = undefined
    response.writeHead = (status, headers) => { response.headersSent = true; response.status = status; response.headers = headers }
    response.write = value => { response.chunks.push(value); if (response.blocks > 0) { response.blocks--; return false } return true }
    response.end = value => { if (value) response.chunks.push(value); response.writableEnded = true; response.emit('finish') }
    return response
  }
  const runTimeout = async delay => {
    const row = timeoutRows.find(item => item.active && (delay === undefined || item.delay === delay))
    assert.ok(row, `no active timeout${delay === undefined ? '' : ` at ${delay}ms`}`)
    row.active = false; row.fn(); await flush()
  }
  return { dispose, get route() { return route }, calls, timeoutRows, intervalRows, makeRequest, makeResponse, runTimeout }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)) }
const message = sequence => ({ id: `message-${sequence}`, conversation_id: 'conversation-a', team_id: 'team-a', home_hub: 'home', sequence, content: `message ${sequence}` })
const page = (items, next_cursor, has_more) => ({ home_hub: 'home', conversation_id: 'conversation-a', team_id: 'team-a', items, next_cursor, has_more })
const bodyOf = response => JSON.parse(response.chunks.join(''))

test('SSE route authenticates owner, rejects ambiguous scope/cursors and proves Home scope before headers', async () => {
  const h = harness({ kind: 'agent', pages: [page([], null, false)] })
  const denied = h.makeResponse()
  await h.route.handler(h.makeRequest('/?conversation_id=conversation-a'), denied)
  assert.equal(denied.status, 403); assert.equal(h.calls.length, 0)

  const owner = harness({ pages: [{ ...page([], null, false), conversation_id: 'other' }] })
  for (const url of [
    '/?conversation_id=conversation-a&unexpected=1',
    '/?conversation_id=conversation-a&conversation_id=conversation-a',
    '/?conversation_id=conversation-a&after=-1',
    '/?conversation_id=conversation-a&after=7',
  ]) {
    const response = owner.makeResponse()
    const headers = url.endsWith('after=7') ? { 'last-event-id': '6' } : {}
    await owner.route.handler(owner.makeRequest(url, headers), response)
    assert.equal(response.status, 400)
  }
  assert.equal(owner.calls.length, 0)

  const wrongScope = owner.makeResponse()
  await owner.route.handler(owner.makeRequest('/?conversation_id=conversation-a'), wrongScope)
  assert.equal(wrongScope.status, 409); assert.equal(wrongScope.headersSent, true)
  assert.equal(wrongScope.headers['content-type'], 'application/json')
  assert.equal(owner.calls.length, 1)
})

test('SSE emits bounded Home pages with sequence ids and resumes from the newest Last-Event-ID', async () => {
  const h = harness({ pages: [page([message(7)], null, false), page([message(8)], null, false)] })
  const response = h.makeResponse()
  await h.route.handler(h.makeRequest('/?conversation_id=conversation-a&after=5', { 'last-event-id': '6' }), response)
  assert.equal(response.status, 200)
  assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(h.calls[0][0], '/api/v1/messaging/conversations/conversation-a/messages?after=6&limit=50')
  assert.equal(h.calls[0][1], undefined)
  assert.ok(h.calls[0][2] instanceof AbortSignal)
  assert.match(response.chunks[0], /^id: 7\nevent: messages\ndata: /)
  assert.deepEqual(JSON.parse(response.chunks[0].split('data: ')[1].trim()), page([message(7)], null, false))

  await h.runTimeout(1000)
  assert.match(h.calls[1][0], /after=7&limit=50$/)
  assert.match(response.chunks[1], /^id: 8\nevent: messages\ndata: /)
  response.emit('close')
  assert.ok(h.intervalRows.every(row => !row.active))
  assert.ok(h.timeoutRows.every(row => !row.active))
})

test('SSE backpressure pauses polling until drain and keeps only one page in flight', async () => {
  const h = harness({ pages: [page([message(1)], 1, true), page([message(2)], null, false)] })
  const response = h.makeResponse({ blockedWrites: 1 })
  await h.route.handler(h.makeRequest('/?conversation_id=conversation-a'), response)
  assert.equal(h.calls.length, 1)
  assert.equal(h.timeoutRows.filter(row => row.active).length, 0)
  response.emit('drain')
  await h.runTimeout(0)
  assert.equal(h.calls.length, 2)
  assert.match(h.calls[1][0], /after=1&limit=50$/)
  assert.match(response.chunks[1], /^id: 2\nevent: messages\ndata: /)
  response.emit('close')
})

test('disconnect aborts the active Home request and stops further writes', async () => {
  let resolvePage, requestSignal
  const h = harness({ pages: [page([message(1)], null, false), new Promise(resolve => { resolvePage = resolve })] })
  const response = h.makeResponse()
  await h.route.handler(h.makeRequest('/?conversation_id=conversation-a'), response)
  await h.runTimeout(1000)
  requestSignal = h.calls[1][2]
  assert.ok(requestSignal instanceof AbortSignal)
  const priorChunks = response.chunks.length
  response.emit('close')
  assert.equal(requestSignal.aborted, true)
  resolvePage(page([message(2)], null, false)); await flush()
  assert.equal(response.chunks.length, priorChunks)
  assert.equal(h.timeoutRows.filter(row => row.active).length, 0)
})

test('disconnect during the preflight Home read aborts without opening an SSE response', async () => {
  let resolvePage, signal
  const h = harness({ pages: [new Promise(resolve => { resolvePage = resolve })] })
  const request = h.makeRequest('/?conversation_id=conversation-a'), response = h.makeResponse()
  const handling = h.route.handler(request, response)
  await flush(); signal = h.calls[0][2]
  request.emit('aborted')
  assert.equal(signal.aborted, true)
  resolvePage(page([], null, false)); await handling
  assert.equal(response.headersSent, false)
  assert.equal(response.chunks.length, 0)
})

test('maximum-size messages are split into bounded replayable events and a blocked page resumes without another Home read', async () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ ...message(i + 1), content: '\u0001'.repeat(65536) }))
  const h = harness({ pages: [page(items, null, false)] }), response = h.makeResponse({ blockedWrites: 1 })
  await h.route.handler(h.makeRequest('/?conversation_id=conversation-a'), response)
  assert.equal(response.chunks.length, 1); assert.equal(h.calls.length, 1)
  assert.ok(Buffer.byteLength(response.chunks[0]) < 1024 * 1024)
  const first = JSON.parse(response.chunks[0].split('data: ')[1].trim())
  assert.equal(first.items.length, 1); assert.equal(first.has_more, true); assert.equal(first.next_cursor, 1)
  response.emit('drain')
  assert.equal(response.chunks.length, 50); assert.equal(h.calls.length, 1)
  const last = JSON.parse(response.chunks.at(-1).split('data: ')[1].trim())
  assert.equal(last.items[0].sequence, 50); assert.equal(last.has_more, false); assert.equal(last.next_cursor, null)
  response.emit('close'); assert.ok(h.intervalRows.every(row => !row.active))
})

test('Home failures after a backlog use a delayed retry and never spin at zero milliseconds', async () => {
  const h = harness({ pages: [page([message(1)], 1, true), Error('unavailable')] }), response = h.makeResponse()
  await h.route.handler(h.makeRequest('/?conversation_id=conversation-a'), response)
  await h.runTimeout(0)
  assert.equal(h.timeoutRows.filter(row => row.active && row.delay === 0).length, 0)
  assert.equal(h.timeoutRows.filter(row => row.active && row.delay === 1000).length, 1)
  response.emit('close')
})

test('plugin disposal closes active streams and cancels all outstanding timers', async () => {
  const h = harness(), response = h.makeResponse()
  await h.route.handler(h.makeRequest('/?conversation_id=conversation-a'), response)
  assert.equal(response.writableEnded, false); h.dispose()
  assert.equal(response.writableEnded, true)
  assert.ok(h.timeoutRows.every(row => !row.active)); assert.ok(h.intervalRows.every(row => !row.active))
})

test('a heartbeat blocked during a Home read holds its reply until drain', async () => {
  let resolve
  const h = harness({ pages: [page([], null, false), new Promise(r => { resolve = r })] }), response = h.makeResponse()
  await h.route.handler(h.makeRequest('/?conversation_id=conversation-a'), response)
  await h.runTimeout(1000); response.blocks = 1; h.intervalRows.find(row => row.active).fn()
  assert.equal(response.chunks.length, 1)
  resolve(page([message(1), message(2)], null, false)); await flush()
  assert.equal(response.chunks.length, 1); assert.equal(h.calls.length, 2)
  response.emit('drain'); assert.equal(response.chunks.length, 3); response.emit('close')
})

test('invalid Home data during heartbeat backpressure terminates the stream for cursor reconnect', async () => {
  let resolve
  const h = harness({ pages: [page([], null, false), new Promise(r => { resolve = r })] }), response = h.makeResponse()
  await h.route.handler(h.makeRequest('/?conversation_id=conversation-a'), response)
  await h.runTimeout(1000); response.blocks = 1; h.intervalRows.find(row => row.active).fn()
  resolve({ ...page([message(1)], null, false), team_id: 'foreign' }); await flush()
  assert.equal(response.writableEnded, true)
  assert.ok(h.timeoutRows.every(row => !row.active)); assert.ok(h.intervalRows.every(row => !row.active))
  response.emit('drain'); assert.equal(h.calls.length, 2)
})

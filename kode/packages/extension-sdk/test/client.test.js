import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { KodeApiError, KodeExtension, parseSse } from '../src/index.js'

async function* bytes(...parts) {
  for (const part of parts) yield new TextEncoder().encode(part)
}

test('parser joins split frames, multi-line data and CRLF, and skips comments', async () => {
  const frames = []
  for await (const frame of parseSse(bytes(': keep-alive\n\n', 'id: 3\r\nevent: x\r\ndata: {"a":', '1}\r\n\r\n', 'data: one\ndata: two\n\n'))) frames.push(frame)
  assert.deepEqual(frames, [{ id: '3', event: 'x', data: '{"a":1}' }, { data: 'one\ntwo' }])
})

test('events resume after a dropped stream from the last delivered cursor', async () => {
  const requests = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    requests.push({ after: url.searchParams.get('after'), kinds: url.searchParams.get('kinds'), auth: req.headers.authorization })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const next = Number(url.searchParams.get('after')) + 1
    res.end(`id: ${next}\ndata: ${JSON.stringify({ seq: next, kind: 'session.turn_completed' })}\n\n`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const client = new KodeExtension({ api: `http://127.0.0.1:${server.address().port}/api/ext/v1/`, token: 'kext_test' })
  const controller = new AbortController()
  const seen = []
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, _ms, ...args) => originalSetTimeout(fn, 0, ...args)
  try {
    for await (const event of client.events({ after: 10, kinds: ['session.turn_completed'], signal: controller.signal })) {
      seen.push(event.seq)
      if (seen.length === 2) controller.abort()
    }
  } catch (error) {
    assert.equal(error.name, 'AbortError')
  } finally {
    globalThis.setTimeout = originalSetTimeout
    server.close()
  }
  assert.deepEqual(seen, [11, 12])
  assert.deepEqual(requests.slice(0, 2).map(r => r.after), ['10', '11'])
  assert.equal(requests[0].kinds, 'session.turn_completed')
  assert.equal(requests[0].auth, 'Bearer kext_test')
})

test('authorization failures surface instead of retrying forever', async () => {
  const server = createServer((_req, res) => { res.writeHead(401); res.end('{"error":"unauthorized"}') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const client = new KodeExtension({ api: `http://127.0.0.1:${server.address().port}/api/ext/v1`, token: 'kext_bad' })
  try {
    await assert.rejects(async () => { for await (const _ of client.events()) { /* none */ } }, error => error instanceof KodeApiError && error.status === 401)
    await assert.rejects(client.hello(), error => error instanceof KodeApiError && error.message === 'unauthorized')
  } finally {
    server.close()
  }
})

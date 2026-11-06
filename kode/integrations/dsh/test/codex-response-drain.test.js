import test from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { getEventListeners } from 'node:events'
import { CodexResponseObserver } from '../src/codex-response-observer.js'
import { drainCodexResponse } from '../src/codex-response-drain.js'

const frame = value => `data: ${JSON.stringify(value)}\n\n`
const terminal = frame({ type: 'response.completed', response: { id: 'owned', status: 'completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture({ closePeer = true, terminalFrame = terminal, timeoutMs = 100, maxTailBytes, finalDelay = 0 } = {}) {
  let controller, cancelled = 0
  const body = new ReadableStream({ start(value) { controller = value }, cancel() { cancelled++ } })
  const observer = new CodexResponseObserver(), abort = new AbortController()
  const response = new Writable({ write(_bytes, _encoding, done) { done(); if (closePeer) this.destroy() },
    final(done) { setTimeout(done, finalDelay) } })
  const promise = drainCodexResponse(body, response, { observer, signal: abort.signal, successful: true, timeoutMs, maxTailBytes })
  const push = value => controller.enqueue(Buffer.from(value))
  push(terminalFrame)
  return { observer, response, abort, promise, push, end: () => controller.close(), error: error => controller.error(error), cancelled: () => cancelled }
}
function clean(f) {
  assert.equal(getEventListeners(f.abort.signal, 'abort').length, 0)
  for (const event of ['finish', 'error', 'close']) assert.equal(f.response.listenerCount(event), 0, event)
}

test('peer close drains the same response to delayed EOF and releases listeners', async () => {
  const f = fixture()
  await tick()
  assert.equal(f.observer.ended, false)
  f.push(': heartbeat\n\n'); f.end()
  assert.deepEqual(await f.promise, { upstream_eof: true, peer_closed: true, tail_bytes: 13 })
  assert.ok(f.observer.usageEvidence())
  assert.equal(f.cancelled(), 0)
  clean(f)
})
for (const [name, tail] of [
  ['conflicting terminal', terminal],
  ['failed terminal', frame({ type: 'response.failed', response: { id: 'owned', status: 'failed' } })],
  ['truncated frame', 'data: {'],
  ['invalid utf8', Buffer.from([0xff])],
]) test(`peer-close drainage rejects ${name}`, async () => {
  const f = fixture(); const rejected = assert.rejects(f.promise, { code: 'managed_cli_upstream_tail_invalid' })
  await tick(); f.push(tail); if (name === 'truncated frame') f.end()
  await rejected; await tick(); clean(f)
})
test('tail deadline is absolute and cancellation errors cannot escape rejection', async () => {
  const f = fixture({ timeoutMs: 40 })
  const rejected = assert.rejects(f.promise, { code: 'managed_cli_upstream_drain_timeout' })
  await tick()
  const timer = setInterval(() => f.push(': heartbeat\n\n'), 5)
  try { await rejected } finally { clearInterval(timer) }
  await tick(); assert.equal(f.cancelled(), 1); clean(f)
})
test('tail size cap is bounded', async () => {
  const f = fixture({ maxTailBytes: 8 }); const rejected = assert.rejects(f.promise, { code: 'managed_cli_upstream_drain_limit' })
  await tick(); f.push('123456789'); await rejected; await tick(); clean(f)
})
test('abort and upstream failure reject after peer close without uncaught errors', async () => {
  for (const abort of [true, false]) {
    const f = fixture(); const rejected = assert.rejects(f.promise, { code: abort ? 'ABORT_ERR' : 'EPIPE' })
    await tick()
    if (abort) f.abort.abort(); else f.error(Object.assign(new Error('controlled'), { code: 'EPIPE' }))
    await rejected; await tick(); clean(f)
  }
})
test('a close before successful terminal cancels rather than draining', async () => {
  const f = fixture({ terminalFrame: ': waiting\n\n' })
  await assert.rejects(f.promise, { code: 'ERR_STREAM_PREMATURE_CLOSE' })
  await tick(); assert.equal(f.cancelled(), 1); clean(f)
})
test('normal upstream EOF waits for destination finish before settling', async () => {
  const f = fixture({ closePeer: false, finalDelay: 40 })
  let settled = false; f.promise.then(() => { settled = true })
  f.end(); await tick()
  assert.equal(f.observer.ended, true)
  assert.equal(settled, false)
  assert.equal(f.response.writableFinished, false)
  assert.equal((await f.promise).peer_closed, false)
  assert.equal(f.response.writableFinished, true)
  clean(f)
})

test('rejecting web-reader cancellation stays contained after the deadline', async () => {
  const observer = new CodexResponseObserver()
  const response = new Writable({ write(_chunk, _encoding, done) { done(); this.destroy() } })
  const body = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(terminal)) },
    cancel() { return Promise.reject(new Error('controlled cancellation rejection')) } })
  await assert.rejects(drainCodexResponse(body, response, { observer, successful: true, timeoutMs: 10 }),
    { code: 'managed_cli_upstream_drain_timeout' })
  await tick()
  for (const event of ['close', 'error', 'finish']) assert.equal(response.listenerCount(event), 0)
})

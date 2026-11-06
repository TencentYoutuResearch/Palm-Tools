import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexResponseObserver } from '../src/codex-response-observer.js'

test('terminal diagnostics accept fragmented SSE and retain only fixed fields', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const observer = new CodexResponseObserver()
    const bytes = Buffer.from(`: fixture${newline}data: {"type":"response.completed",${newline}data: "response":{"status":"completed","output":"private-fixture"}}${newline}${newline}`)
    for (const byte of bytes) observer.push(Buffer.from([byte]))
    assert.deepEqual(observer.terminal, { event: 'response.completed', status: 'completed' })
    assert.equal(Object.isFrozen(observer.terminal), true)
    assert.doesNotMatch(JSON.stringify(observer.terminal), /private-fixture/)
    assert.equal(observer.data, '')
  }
})

test('incomplete frames, output text and invalid statuses cannot claim completed diagnostics', () => {
  for (const data of [
    'data: {"type":"response.completed","response":{"status":"completed"}}\n',
    'data: {"type":"response.output_text.delta","delta":"response.completed"}\n\n',
    'event: response.completed\ndata: invalid\n\n',
  ]) {
    const observer = new CodexResponseObserver()
    observer.push(Buffer.from(data))
    assert.equal(observer.terminal, null)
  }
  const observer = new CodexResponseObserver()
  observer.push(Buffer.from('data: {"type":"response.failed","response":{"status":"private-fixture"}}\n\n'))
  assert.deepEqual(observer.terminal, { event: 'response.failed', status: null })
})

test('oversized events are discarded through their real blank-line boundary', () => {
  const observer = new CodexResponseObserver()
  const chunk = Buffer.alloc(65536, 'x')
  for (let index = 0; index < 129; index++) observer.push(chunk)
  assert.equal(observer.oversized, true)
  observer.push(Buffer.from('\ndata: {"type":"response.completed"}\n'))
  assert.equal(observer.terminal, null)
  observer.push(Buffer.from('\ndata: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n'))
  assert.deepEqual(observer.terminal, { event: 'response.incomplete', status: 'incomplete' })
})

const completed = (id = 'response-owned', usage = { input_tokens: 7, output_tokens: 3, total_tokens: 10 }) =>
  ({ type: 'response.completed', response: { id, status: 'completed', usage, output: 'private-content' } })
const send = (observer, frame) => observer.push(Buffer.from(`data: ${JSON.stringify(frame)}\n\n`))
test('provider usage requires an ended stream and one consistent response identity', () => {
  const observer = new CodexResponseObserver()
  send(observer, { type: 'response.created', response: { id: 'response-owned' } })
  for (const byte of Buffer.from(`data: ${JSON.stringify(completed())}\r\n\r\n`)) observer.push(Buffer.from([byte]))
  assert.equal(observer.usageEvidence(), null)
  observer.finish()
  const evidence = observer.usageEvidence()
  assert.equal(evidence.response_id, 'response-owned')
  assert.equal(evidence.usage.input_tokens, 7)
  assert.equal(Object.isFrozen(evidence.usage), true)
  assert.doesNotMatch(JSON.stringify(evidence), /private-content/)
})
test('a completed response ID on its own is sufficient; a missing ID is never invented', () => {
  for (const id of ['owned-single-frame', null]) {
    const observer = new CodexResponseObserver()
    send(observer, completed(id))
    observer.finish()
    assert.equal(observer.usageEvidence()?.response_id ?? null, id)
  }
})
test('foreign, conflicting, malformed and truncated response usage cannot establish evidence', () => {
  for (const frames of [
    [{ type: 'response.created', response: { id: 'foreign' } }, completed()],
    [completed(), completed()], [completed(undefined, {})],
    [completed(), { type: 'response.failed', response: { id: 'response-owned', status: 'failed' } }],
    [{ ...completed(), response_id: 'foreign' }],
  ]) {
    const observer = new CodexResponseObserver()
    for (const frame of frames) send(observer, frame)
    observer.finish()
    assert.equal(observer.usageEvidence(), null)
  }
  for (const trailer of ['data: broken\n\n', 'data: unfinished']) {
    const observer = new CodexResponseObserver()
    send(observer, completed())
    observer.push(Buffer.from(trailer))
    observer.finish()
    assert.equal(observer.usageEvidence(), null)
  }
})
test('invalid UTF8 and partial byte sequences cannot establish response usage', () => {
  for (const trailer of [Buffer.from([0xff]), Buffer.from([0xf0, 0x9f])]) {
    const observer = new CodexResponseObserver()
    send(observer, completed())
    observer.push(trailer)
    observer.finish()
    assert.equal(observer.usageEvidence(), null)
  }
})

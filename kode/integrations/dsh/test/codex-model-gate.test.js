import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { CodexModelGate } from '../src/codex-model-gate.js'

async function fixture(t, { admit = async () => {}, respond, effort, allowUserInput = true } = {}) {
  let forwarded = 0
  const upstream = createServer(async (request, response) => {
    forwarded++
    if (respond) return respond(request, response)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: {"fixture":true}\n\n')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const gate = new CodexModelGate({ endpoint: `http://127.0.0.1:${upstream.address().port}/responses`,
    model: 'fixture', tools: ['kode_read_source'], admit, effort, allowUserInput })
  t.after(async () => {
    await gate.close()
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections() })
  })
  const base = await gate.open()
  const send = (overrides = {}, path = '/responses') => fetch(base + path, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture',
      tools: [{ type: 'function', name: 'kode_read_source', parameters: { type: 'object' } }], ...overrides }) })
  return { gate, send, forwarded: () => forwarded }
}

test('managed CLI forwards one admitted inference and fences its automatic retry', async t => {
  let admitted = 0
  const f = await fixture(t, { admit: async () => { admitted++ } })
  const response = await f.send()
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'data: {"fixture":true}\n\n')
  assert.equal(f.gate.state, 'completed')
  const retry = await f.send()
  assert.equal(retry.status, 409)
  assert.match((await retry.json()).error.message, /another inference/)
  assert.match((await f.gate.failed).message, /another inference/)
  assert.equal(admitted, 1)
  assert.equal(f.forwarded(), 1)
})

test('disabling native questions does not permit any other native tool', async t => {
  let admissions = 0
  const f = await fixture(t, { allowUserInput: false, admit: async () => { admissions++ } })
  const response = await f.send({ tools: [
    { type: 'function', name: 'request_user_input' },
    { type: 'function', name: 'shell' },
  ] })
  assert.equal(response.status, 409)
  assert.equal(f.gate.failure.code, 'managed_cli_tool_contract_changed')
  assert.equal(admissions, 0)
  assert.equal(f.forwarded(), 0)
})

test('concurrent retry fences first admission before it can dispatch', async t => {
  let release, entered
  const waiting = new Promise(resolve => { entered = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  const f = await fixture(t, { admit: async () => { entered(); await blocked } })
  const first = f.send()
  await waiting
  assert.equal((await f.send()).status, 409)
  release()
  assert.equal((await first).status, 409)
  assert.equal(f.forwarded(), 0)
})

test('model, tool and native route mismatches fail before admission', async t => {
  for (const [overrides, path, code] of [
    [{ model: 'other' }, '/responses', 'managed_cli_model_contract_changed'],
    [{ tools: [{ type: 'function', name: 'shell' }] }, '/responses', 'managed_cli_tool_contract_changed'],
    [{ tools: [{ type: 'web_search' }] }, '/responses', 'managed_cli_tool_contract_changed'],
    [{}, '/models', 'managed_cli_inference_failed'],
  ]) {
    let admitted = 0
    const f = await fixture(t, { admit: async () => { admitted++ } })
    assert.equal((await f.send(overrides, path)).status, 409)
    assert.equal(f.gate.failure.code, code)
    assert.equal(admitted, 0)
    assert.equal(f.forwarded(), 0)
  }
})

test('an ambiguous admission error prevents inference and is never returned verbatim', async t => {
  const f = await fixture(t, { admit: async () => { throw Object.assign(new Error('fixture-private-detail'), { code: 'fixture-private-code' }) } })
  const response = await f.send()
  assert.equal(response.status, 409)
  assert.doesNotMatch(await response.text(), /fixture-private-detail/)
  assert.equal(f.forwarded(), 0)
  assert.equal((await f.send()).status, 409)
  assert.equal(f.gate.failureDetails.phase, 'admission')
  assert.equal(f.gate.failureDetails.transport_code, null)
  assert.equal(Object.isFrozen(f.gate.failureDetails), true)
  assert.doesNotMatch(JSON.stringify(f.gate.failureDetails), /fixture-private-detail|fixture-private-code/)
})

test('effective reasoning effort is checked at the actual provider request', async t => {
  const good = await fixture(t, { effort: 'high' })
  assert.equal((await good.send({ reasoning: { effort: 'high' } })).status, 200)
  for (const overrides of [{}, { reasoning: { effort: 'medium' } }]) {
    const rejected = await fixture(t, { effort: 'high' })
    assert.equal((await rejected.send(overrides)).status, 409)
    assert.equal(rejected.gate.failure.code, 'managed_cli_effort_contract_changed')
    assert.equal(rejected.forwarded(), 0)
  }
})

test('upstream redirect cannot move the CLI outside the admission gate', async t => {
  const f = await fixture(t, { respond: (_request, response) => {
    response.writeHead(307, { location: 'https://example.com/fixture' })
    response.end()
  } })
  const response = await f.send()
  assert.equal(response.status, 409)
  assert.match(await response.text(), /redirect rejected/)
  assert.equal(f.forwarded(), 1)
})

test('lost upstream response leaves one uncertain dispatch and refuses replay', async t => {
  const f = await fixture(t, { respond: request => request.destroy() })
  const response = await f.send()
  assert.equal(response.status, 409)
  assert.match(await response.text(), /dispatch failed/)
  assert.equal(f.forwarded(), 1)
  assert.equal((await f.send()).status, 409)
  assert.equal(f.forwarded(), 1)
  assert.equal(f.gate.forwarded, 1)
  assert.equal(f.gate.failureDetails.phase, 'upstream_connect')
  assert.equal(f.gate.failureDetails.upstream_status, null)
  assert.ok(['UND_ERR_SOCKET', 'ECONNRESET'].includes(f.gate.failureDetails.transport_code))
})

test('compressed SSE retains decoded bytes and strips hop headers', async t => {
  const f = await fixture(t, { respond: (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip',
      connection: 'close, x-fixture-private', 'x-fixture-private': 'drop' })
    response.end(gzipSync('data: fixture\n\n'))
  } })
  const response = await f.send()
  assert.equal(response.headers.get('content-encoding'), null)
  assert.equal(response.headers.get('x-fixture-private'), null)
  assert.equal(await response.text(), 'data: fixture\n\n')
})

test('interrupted upstream stream retains only its phase, HTTP status and allowlisted code', async t => {
  const f = await fixture(t, { respond: (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: pending\n\n')
    setTimeout(() => response.destroy(), 20)
  } })
  await assert.rejects(async () => { const response = await f.send(); await response.text() })
  await f.gate.failed
  assert.equal(f.gate.failureDetails.phase, 'response_stream')
  assert.equal(f.gate.failureDetails.upstream_status, 200)
  assert.equal(f.gate.failureDetails.cancelled, false)
  assert.equal(f.gate.failureDetails.stream_failure_side, 'upstream')
  assert.equal(f.gate.failureDetails.upstream_complete, false)
  assert.equal(f.gate.failureDetails.downstream_complete, false)
  assert.ok(['UND_ERR_SOCKET', 'ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET'].includes(f.gate.failureDetails.transport_code))
  assert.equal(f.forwarded(), 1)
})

test('downstream disconnect is distinguished from an upstream failure without replay', async t => {
  const f = await fixture(t, { respond: (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: pending\n\n')
  } })
  const response = await f.send()
  await response.body.cancel()
  await f.gate.failed
  assert.equal(f.gate.failureDetails.stream_failure_side, 'downstream')
  assert.equal(f.gate.failureDetails.upstream_complete, false)
  assert.equal(f.gate.failureDetails.downstream_complete, false)
  assert.equal(f.gate.failureDetails.cancelled, false)
  assert.equal((await f.send()).status, 409)
  assert.equal(f.forwarded(), 1)
})

test('a peer may close after a complete successful terminal SSE frame', async t => {
  const f = await fixture(t, { respond: (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    response.write('data: {"type":"response.completed","response":{"id":"owned","status":"completed","output":"private-fixture"}}\n\n')
    setTimeout(() => response.end(), 50)
  } })
  const response = await f.send()
  const reader = response.body.getReader()
  await reader.read()
  await reader.cancel()
  await f.gate.settled
  assert.equal(f.gate.state, 'completed')
  assert.equal(f.gate.completionBasis, 'upstream_eof_with_peer_close')
  assert.equal(f.gate.failureDetails, undefined)
  assert.equal(f.forwarded(), 1)
  assert.equal((await f.send()).status, 409)
  assert.equal(f.forwarded(), 1)
})

test('failed, unfinished and malformed terminal frames cannot excuse a peer disconnect', async t => {
  for (const frame of [
    'data: {"type":"response.completed","response":{"status":"completed"}}\n',
    'data: {"type":"response.completed","response":{"status":"incomplete"}}\n\n',
    'data: {"type":"response.failed","response":{"status":"failed"}}\n\n',
    'event: response.completed\ndata: invalid\n\n',
  ]) {
    const f = await fixture(t, { respond: (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(frame)
    } })
    const response = await f.send()
    const reader = response.body.getReader()
    await reader.read()
    await reader.cancel()
    await f.gate.failed
    assert.equal(f.gate.state, 'failed')
    assert.equal(f.gate.completionBasis, undefined)
    assert.equal(f.forwarded(), 1)
  }
})

test('provider receipt is scoped to one admitted inference and sealed native turn', async t => {
  const f = await fixture(t, { respond: (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: {"type":"response.created","response":{"id":"owned"}}\n\n'
      + 'data: {"type":"response.completed","response":{"id":"owned","status":"completed","usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}\n\n')
  } })
  f.gate.bindThread('thread')
  const response = await f.send()
  await response.text()
  await f.gate.settled
  assert.equal(f.gate.usageReceipt('thread', 'turn'), null, 'an early response cannot invent a native turn')
  f.gate.sealTurn('thread', 'turn')
  assert.equal(f.gate.usageReceipt('foreign-thread', 'turn'), null)
  assert.equal(f.gate.usageReceipt('thread', 'foreign-turn'), null)
  const receipt = f.gate.usageReceipt('thread', 'turn')
  assert.equal(receipt.response_id, 'owned')
  assert.equal(receipt.inference_id, f.gate.inferenceId)
  assert.equal(receipt.native_thread_id, 'thread')
  assert.equal(receipt.native_turn_id, 'turn')
  assert.throws(() => f.gate.sealTurn('thread', 'replacement'), /binding rejected/)
  assert.throws(() => f.gate.bindThread('replacement'), /binding rejected/)
  assert.equal((await f.send()).status, 409)
  assert.equal(f.gate.usageReceipt('thread', 'turn'), null, 'a second request invalidates the provider receipt')
})

test('completed terminal without upstream EOF fails the bounded drain', async t => {
  const f = await fixture(t, { respond: (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"type":"response.completed","response":{"id":"owned","status":"completed","usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}\n\n')
  } })
  f.gate.bindThread('thread'); f.gate.sealTurn('thread', 'turn')
  const response = await f.send(), reader = response.body.getReader()
  await reader.read(); await reader.cancel(); await f.gate.settled
  assert.equal(f.gate.completionBasis, undefined)
  assert.equal(f.gate.failure.code, 'managed_cli_upstream_drain_timeout')
  assert.equal(f.gate.usageReceipt('thread', 'turn'), null)
})
test('a reported provider label cannot change the admitted request-model boundary', async t => {
  let admissions = 0
  const f = await fixture(t, { admit: async () => { admissions++ }, respond: (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: {"type":"response.completed","response":{"id":"owned","model":"provider-label","status":"completed","usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}\n\n')
  } })
  assert.equal((await f.send({ model: 'provider-label' })).status, 409)
  assert.equal(admissions, 0)
  assert.equal(f.forwarded(), 0)
  assert.equal(f.gate.failure.code, 'managed_cli_model_contract_changed')
})

test('a terminal frame cannot hide upstream loss or owner cancellation', async t => {
  const frame = 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'
  const lost = await fixture(t, { respond: (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(frame)
    setTimeout(() => response.destroy(), 20)
  } })
  await assert.rejects(async () => { const response = await lost.send(); await response.text() })
  await lost.gate.failed
  assert.equal(lost.gate.failureDetails.stream_failure_side, 'upstream')
  assert.equal(lost.gate.completionBasis, undefined)
  const cancelled = await fixture(t, { respond: (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(frame)
  } })
  const response = await cancelled.send()
  const reader = response.body.getReader()
  await reader.read()
  cancelled.gate.stop.abort()
  await reader.cancel()
  await cancelled.gate.failed
  assert.equal(cancelled.gate.failureDetails.cancelled, true)
  assert.equal(cancelled.gate.completionBasis, undefined)
})

test('close drains an in-flight upstream response and prevents another listener', async t => {
  let started
  const waiting = new Promise(resolve => { started = resolve })
  const f = await fixture(t, { respond: (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: pending\n\n')
    started()
  } })
  const pending = f.send().then(async response => response.text()).catch(() => 'closed')
  await waiting
  await f.gate.close()
  await pending
  assert.equal(f.gate.server.listening, false)
  await assert.rejects(f.gate.open(), /gate closed/)
  await assert.rejects(f.send())
})

test('managed endpoint configuration rejects URL credentials and remote cleartext', () => {
  const options = { model: 'fixture', tools: [], admit: async () => {} }
  for (const endpoint of ['http://example.com/responses', 'https://fixture:secret@example.com/responses',
    'https://example.com/responses?key=fixture', 'https://example.com/responses#fragment']) {
    assert.throws(() => new CodexModelGate({ ...options, endpoint }))
  }
})

test('deferred wrapper transport accepts one exact loopback route before admission', async t => {
  let admitted = 0
  const gate = new CodexModelGate({ deferredEndpoint: true, model: 'fixture', tools: [],
    admit: async () => { admitted++ } })
  t.after(() => gate.close())
  for (const endpoint of ['https://example.com/responses', 'http://localhost/responses',
    'http://user:secret@127.0.0.1/responses', 'http://127.0.0.1/responses?key=fixture',
    'http://127.0.0.1/responses#fragment']) {
    assert.throws(() => gate.configureEndpoint(endpoint))
    assert.equal(gate.endpoint, null)
  }
  gate.configureEndpoint('http://127.0.0.1:4567/responses')
  assert.equal(gate.endpoint.href, 'http://127.0.0.1:4567/responses')
  assert.throws(() => gate.configureEndpoint('http://127.0.0.1:4568/responses'))
  assert.equal(admitted, 0)
})

test('missing wrapper transport rejects inference without admission and fences late configuration', async t => {
  let admitted = 0
  const gate = new CodexModelGate({ deferredEndpoint: true, model: 'fixture', tools: [],
    admit: async () => { admitted++ } })
  t.after(() => gate.close())
  const base = await gate.open()
  const response = await fetch(base + '/responses', { method: 'POST',
    body: JSON.stringify({ model: 'fixture', tools: [] }) })
  assert.equal(response.status, 409)
  assert.match(await response.text(), /transport unavailable/)
  assert.equal(admitted, 0)
  assert.equal(gate.forwarded, 0)
  assert.throws(() => gate.configureEndpoint('http://127.0.0.1:4567/responses'))
})

test('cancelled or closed gates refuse deferred transport configuration', async () => {
  const controller = new AbortController()
  const options = { deferredEndpoint: true, model: 'fixture', tools: [], admit: async () => {} }
  const cancelled = new CodexModelGate({ ...options, signal: controller.signal })
  controller.abort()
  assert.throws(() => cancelled.configureEndpoint('http://127.0.0.1:4567/responses'))
  assert.equal(cancelled.endpoint, null)
  await cancelled.close()
  const closed = new CodexModelGate(options)
  await closed.close()
  assert.throws(() => closed.configureEndpoint('http://127.0.0.1:4567/responses'))
  assert.equal(closed.endpoint, null)
})

test('a second native request during peer-close drainage invalidates the first receipt without forwarding', async t => {
  let release
  const f = await fixture(t, { respond: (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"type":"response.completed","response":{"id":"owned","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n')
    release = () => response.end()
  } })
  f.gate.bindThread('thread'); f.gate.sealTurn('thread', 'turn')
  const response = await f.send(), reader = response.body.getReader()
  await reader.read(); await reader.cancel()
  assert.equal((await f.send()).status, 409)
  release()
  await f.gate.failed
  assert.equal(f.forwarded(), 1)
  assert.equal(f.gate.state, 'failed')
  assert.equal(f.gate.usageReceipt('thread', 'turn'), null)
})

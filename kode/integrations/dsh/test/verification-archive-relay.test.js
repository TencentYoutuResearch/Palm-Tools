import test from 'node:test'
import assert from 'node:assert/strict'
import { deliverRemoteVerification } from '../src/verification-archive.js'
const operation = { id: 'op', home_node: 'home', attempt: 1, epoch: 1 }
test('remote verification upload uses bounded exact segments and validates final acknowledgement', async () => {
  const raw = JSON.stringify({ log: 'x'.repeat(100000) }), segments = [], received = []
  const client = { async call(path, body) {
    assert.ok(path.endsWith('/home')); assert.equal(body.worker_session, 'worker'); assert.equal(body.operation_id, 'op')
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 65536)
    const a = body.accounting.action
    if (a.kind === 'verification_complete') { assert.equal(Buffer.concat(received).toString(), raw); return { sequence: 7, record_hash: a.record_hash, archived: true, completion_authorized: false } }
    const s = a.segment; segments.push(s); received.push(Buffer.from(s.data, 'base64'))
    return { sequence: 7, record_hash: s.record_hash, bytes: s.bytes, offset: s.offset, segment_bytes: received.at(-1).length, completion_authorized: false }
  } }
  assert.equal((await deliverRemoteVerification(client, 'worker', operation, 7, raw)).archived, true)
  assert.equal(segments.length, 4)
  let calls = 0
  await assert.rejects(deliverRemoteVerification({ async call() { calls++; return {} } }, 'worker', operation, 7, raw), /receipt mismatch/)
  assert.equal(calls, 1)
})

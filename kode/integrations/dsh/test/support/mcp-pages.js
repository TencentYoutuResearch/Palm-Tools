/** Shared assertions through real STDIO MCP clients and a real fixture Hub. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
export async function checkMcpPages(call, admin, source, peerRegistration) {
  const peer = admin.forSession(peerRegistration.owner_token)
  const content = 'a🦊中\u0000'.repeat(2500), expected = new Set()
  for (let i = 0; i < 18; i++) {
    const sent = await peer.call('/api/v1/messaging/messages', { target: source, content, idempotency_key: randomUUID() })
    expected.add(sent.id)
  }
  let cursor = 0, preview
  const seen = new Set(), found = new Set()
  for (let page = 0; ; page++) {
    assert.ok(page < 100, 'bounded cursor traversal must converge')
    const response = await call('tools/call', { name: page === 0 ? 'kode_sessions_wait' : 'kode_sessions_read', arguments: { after: cursor, ...(page === 0 ? { timeout_seconds: 1 } : {}) } })
    assert.equal(response.result.isError, undefined)
    const result = JSON.parse(response.result.content[0].text)
    assert.ok(result.events.length <= 16); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192)
    if (!result.events.length) { assert.equal(result.cursor, cursor); break }
    assert.equal(result.cursor, result.events.at(-1).seq)
    for (const event of result.events) {
      assert.ok(event.seq > cursor); assert.ok(!seen.has(event.seq)); seen.add(event.seq)
      if (expected.has(event.message.id)) {
        found.add(event.message.id); preview ??= event.message
        assert.equal(event.message.content_truncated, true)
        assert.equal(Array.from(event.message.content).length, 1024)
      }
    }
    cursor = result.cursor
  }
  assert.deepEqual(found, expected)
  let restored = preview.content, offset = preview.continuation.offset
  while (offset !== null) {
    const response = await call('tools/call', { name: preview.continuation.tool, arguments: { message_id: preview.id, offset } })
    assert.equal(response.result.isError, undefined)
    const page = JSON.parse(response.result.content[0].text)
    assert.ok(Array.from(page.content).length <= 4096); assert.equal(page.offset, offset)
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192)
    assert.equal(page.token_budget.exact_tokens, false)
    restored += page.content; offset = page.next
  }
  assert.equal(restored, content)
  const invalid = await call('tools/call', { name: 'kode_sessions_message_read', arguments: { message_id: preview.id, offset: -1 } })
  assert.equal(invalid.result.isError, true)
  const stranger = await admin.call('/api/v1/messaging/sessions', { session_id: `stranger-${randomUUID()}`, title: 'Fixture stranger', runtime: 'external' })
  const foreign = await peer.call('/api/v1/messaging/messages', { target: stranger.session.address, content: 'Private fixture message', idempotency_key: randomUUID() })
  const denied = await call('tools/call', { name: 'kode_sessions_message_read', arguments: { message_id: foreign.id } })
  assert.equal(denied.result.isError, true); assert.match(denied.result.content[0].text, /403|foreign message/); assert.ok(!denied.result.content[0].text.includes('Private fixture message'))
  const controlRegistration = await admin.call('/api/v1/messaging/sessions', { session_id: `control-${randomUUID()}`, title: 'Control fixture', runtime: 'external' })
  const controlPeer = admin.forSession(controlRegistration.owner_token)
  const outgoingResponse = await call('tools/call', { name: 'kode_sessions_send', arguments: { ...controlRegistration.session.address, content: 'Cancelable fixture', idempotency_key: randomUUID() } })
  assert.equal(outgoingResponse.result.isError, undefined)
  const outgoing = JSON.parse(outgoingResponse.result.content[0].text)
  const claimed = await controlPeer.call(`/api/v1/messaging/sessions/${controlRegistration.session.address.session_id}/claim`, {})
  assert.ok(claimed.messages.some(row => row.id === outgoing.id))
  await controlPeer.call(`/api/v1/messaging/messages/${outgoing.id}/delivery`, { session_id: controlRegistration.session.address.session_id, input_id: 'fixture-input', phase: 'prepared', event_seq: null })
  const invoke = (name, message_id) => call('tools/call', { name, arguments: { message_id } })
  const delivery = await invoke('kode_sessions_delivery_status', outgoing.id)
  assert.equal(JSON.parse(delivery.result.content[0].text).delivery.phase, 'prepared')
  const cancellation = await invoke('kode_sessions_cancel_input', outgoing.id)
  assert.equal(cancellation.result.isError, undefined)
  const requested = JSON.parse(cancellation.result.content[0].text)
  assert.equal(requested.state, 'requested')
  const repeated = await invoke('kode_sessions_cancel_input', outgoing.id)
  assert.deepEqual(JSON.parse(repeated.result.content[0].text), requested)
  const status = await invoke('kode_sessions_cancellation_status', outgoing.id)
  assert.deepEqual(JSON.parse(status.result.content[0].text).cancellation, requested)
  await controlPeer.call(`/api/v1/messaging/messages/${outgoing.id}/cancellation/result`, { session_id: controlRegistration.session.address.session_id, input_id: 'fixture-input', state: 'queued_removed', reason: 'fixture removed' })
  let auditCursor = 0
  const audit = []
  for (let index = 0; ; index++) {
    assert.ok(index < 100)
    const response = await call('tools/call', { name: 'kode_sessions_lifecycle_read', arguments: { after: auditCursor } })
    assert.equal(response.result.isError, undefined)
    const page = JSON.parse(response.result.content[0].text)
    assert.ok(page.events.length <= 16); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192)
    if (!page.events.length) { assert.equal(page.cursor, auditCursor); break }
    for (const event of page.events) { assert.ok(event.seq > auditCursor); auditCursor = event.seq; audit.push(event) }
    assert.equal(page.cursor, auditCursor)
  }
  assert.ok(audit.some(event => event.message_id === outgoing.id && event.kind === 'cancellation' && event.data.state === 'queued_removed'))
  assert.ok(audit.some(event => event.message_id === outgoing.id && event.kind === 'delivery' && event.data.phase === 'prepared'))
  assert.ok(audit.every(event => event.message_id !== foreign.id))
  assert.deepEqual(new Set(audit.filter(event => expected.has(event.message_id)).map(event => event.message_id)), expected)
  const badCursor = await call('tools/call', { name: 'kode_sessions_lifecycle_read', arguments: { after: -1 } })
  assert.equal(badCursor.result.isError, true)
  const notSender = await invoke('kode_sessions_cancel_input', preview.id)
  assert.equal(notSender.result.isError, true)
  for (const name of ['kode_sessions_delivery_status', 'kode_sessions_cancellation_status', 'kode_sessions_cancel_input']) {
    const blocked = await invoke(name, foreign.id)
    assert.equal(blocked.result.isError, true)
    assert.ok(!blocked.result.content[0].text.includes('Private fixture message'))
  }

}

/** Shared assertions through real STDIO MCP clients and a real fixture Hub. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
export async function checkMcpPages(call, admin, source, peerRegistration) {
  const peer = admin.forSession(peerRegistration.owner_token)
  const content = 'a🦊中\u0000'.repeat(2500),
    expected = new Set()
  for (let i = 0; i < 18; i++) {
    const sent = await peer.call('/api/v1/messaging/messages', {
      target: source,
      content,
      idempotency_key: randomUUID(),
    })
    expected.add(sent.id)
  }
  let cursor = 0,
    preview
  const seen = new Set(),
    found = new Set()
  for (let page = 0; ; page++) {
    assert.ok(page < 100, 'bounded cursor traversal must converge')
    const response = await call('tools/call', {
      name: page === 0 ? 'kode_sessions_wait' : 'kode_sessions_read',
      arguments: {
        after: cursor,
        ...(page === 0 ? { timeout_seconds: 1 } : {}),
      },
    })
    assert.equal(response.result.isError, undefined)
    const result = JSON.parse(response.result.content[0].text)
    assert.ok(result.events.length <= 16)
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192)
    if (!result.events.length) {
      assert.equal(result.cursor, cursor)
      break
    }
    assert.equal(result.cursor, result.events.at(-1).seq)
    for (const event of result.events) {
      assert.ok(event.seq > cursor)
      assert.ok(!seen.has(event.seq))
      seen.add(event.seq)
      if (expected.has(event.message.id)) {
        found.add(event.message.id)
        preview ??= event.message
        assert.equal(event.message.content_truncated, true)
        assert.equal(Array.from(event.message.content).length, 1024)
      }
    }
    cursor = result.cursor
  }
  assert.deepEqual(found, expected)
  let restored = preview.content,
    offset = preview.continuation.offset
  while (offset !== null) {
    const response = await call('tools/call', {
      name: preview.continuation.tool,
      arguments: { message_id: preview.id, offset },
    })
    assert.equal(response.result.isError, undefined)
    const page = JSON.parse(response.result.content[0].text)
    assert.ok(Array.from(page.content).length <= 4096)
    assert.equal(page.offset, offset)
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192)
    assert.equal(page.token_budget.exact_tokens, false)
    restored += page.content
    offset = page.next
  }
  assert.equal(restored, content)
  const invalid = await call('tools/call', {
    name: 'kode_sessions_message_read',
    arguments: { message_id: preview.id, offset: -1 },
  })
  assert.equal(invalid.result.isError, true)
  const stranger = await admin.call('/api/v1/messaging/sessions', {
    session_id: `stranger-${randomUUID()}`,
    title: 'Fixture stranger',
    runtime: 'external',
  })
  const foreign = await peer.call('/api/v1/messaging/messages', {
    target: stranger.session.address,
    content: 'Private fixture message',
    idempotency_key: randomUUID(),
  })
  const denied = await call('tools/call', {
    name: 'kode_sessions_message_read',
    arguments: { message_id: foreign.id },
  })
  assert.equal(denied.result.isError, true)
  assert.match(denied.result.content[0].text, /403|foreign message/)
  assert.ok(!denied.result.content[0].text.includes('Private fixture message'))
}

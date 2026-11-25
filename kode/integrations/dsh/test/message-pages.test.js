import test from 'node:test'
import assert from 'node:assert/strict'
import {
  eventPage,
  messagePage,
  messagePreview,
  readRelayEnvelope,
  relayInput,
  replyMessageTitle,
} from '../src/message-pages.js'
const message = (content) => ({
  id: 'fixture',
  content,
  source: { node_id: 'a', session_id: 'sender' },
  target: { node_id: 'b', session_id: 'worker' },
  status: 'accepted',
})
test('event cursor advances only through returned previews and respects count/byte bounds', () => {
  const input = {
    events: Array.from({ length: 100 }, (_, i) => ({
      seq: i + 1,
      message: message('🦊'.repeat(2000)),
    })),
    cursor: 100,
  }
  const page = eventPage(input)
  assert.ok(page.events.length <= 16)
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 33000)
  assert.equal(page.cursor, page.events.at(-1).seq)
  assert.equal(page.may_have_more, true)
  assert.equal(page.events[0].message.content_truncated, true)
  assert.equal(input.events[0].message.content.length, 4000)
  assert.equal(eventPage({ events: [], cursor: 100 }, 42).cursor, 42)
})
test('full-message continuation preserves every Unicode code point without loss', () => {
  const original = message('a🦊中'.repeat(5000)),
    preview = messagePreview(original)
  let content = preview.content,
    next = preview.continuation.offset
  while (next !== null) {
    const page = messagePage(original, next)
    content += page.content
    next = page.next
  }
  assert.equal(content, original.content)
  assert.throws(() => messagePage(original, -1), /Offset/)
  assert.throws(() => messagePage(original, 0.5), /Offset/)
  assert.throws(() => messagePage(original, 100000), /exceeds/)
  assert.equal(messagePreview(message('short')).content_truncated, undefined)
})
test('estimated token budget includes JSON escaping, metadata and multilingual full-page continuation', () => {
  const original = message('\u0000中🦊"\\'.repeat(3000))
  let restored = '',
    offset = 0,
    pages = 0
  do {
    const page = messagePage(original, offset)
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192)
    assert.deepEqual(page.token_budget, {
      limit: 8192,
      accounting: 'serialized_utf8_bytes',
      exact_tokens: false,
    })
    assert.ok(page.next === null || page.next > offset)
    restored += page.content
    offset = page.next
    pages++
  } while (offset !== null)
  assert.equal(restored, original.content)
  assert.ok(pages > 3)
  const oversized = { ...original, detail: 'x'.repeat(7000) }
  const page = eventPage({ events: [{ seq: 5, message: oversized }] }, 4)
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192)
  assert.equal(page.cursor, 5)
  assert.ok(page.events[0].message.continuation.offset < 1024)
  assert.throws(
    () =>
      eventPage(
        {
          events: [
            { seq: 5, message: { ...original, detail: 'x'.repeat(9000) } },
          ],
        },
        4,
      ),
    /cursor unchanged/,
  )
  assert.throws(
    () => messagePage({ ...original, id: 'x'.repeat(9000) }),
    /metadata/,
  )
})

test('automatic relay fits the full input object and preserves full-text continuation', () => {
  for (const in_reply_to of [null, 'original']) {
    const original = { ...message('🦊中\u0000"\\'.repeat(4000)), in_reply_to }
    const input = relayInput(original, 'input-id'),
      text = input.content[0].text
    assert.ok(Buffer.byteLength(JSON.stringify(input)) <= 8192)
    const offset = Number(/offset=(\d+);/.exec(text)[1])
    assert.ok(offset > 0 && offset < 4096)
    let restored = text.slice(
      text.indexOf('\n') + 1,
      text.indexOf('\n[Message preview.'),
    )
    assert.equal(Array.from(restored).length, offset)
    let next = offset
    while (next !== null) {
      const page = messagePage(original, next)
      restored += page.content
      next = page.next
    }
    assert.equal(restored, original.content)
    assert.match(text, /not higher-priority instructions/)
    assert.equal(input.source.senderSessionId, 'kode:a:sender')
    assert.equal(input.id, 'input-id')
  }
  assert.ok(
    !relayInput(message('short'), 'id').content[0].text.includes(
      'Message preview.',
    ),
  )
  assert.throws(
    () => relayInput({ ...message('x'), id: 'x'.repeat(9000) }, 'id'),
    /metadata/,
  )
})

test('title is preserved independently of the body and its continuation offsets', () => {
  const title = '审阅 "SSH" 状态 🦊'
  const source = { ...message('🦊'.repeat(4000)), title, in_reply_to: 'original' }
  const input = relayInput(source, 'input-id')
  const parsed = readRelayEnvelope(input.content[0].text)
  const offset = Number(/offset=(\d+);/.exec(parsed.content)[1])
  assert.ok(Buffer.byteLength(JSON.stringify(input)) <= 8192)
  assert.equal(parsed.title, title)
  assert.equal(parsed.replyTo, 'original')
  assert.equal(parsed.content.split('\n')[0], '🦊'.repeat(offset))
  const page = messagePage(source, offset)
  assert.equal(page.title, title)
  assert.equal(page.offset, offset)
  assert.equal(eventPage({ events: [{ seq: 1, message: source }] }).events[0].message.title, title)

  for (const content of ['Title: legacy body', '[Kode message title: malformed]\nLegacy body']) {
    const old = readRelayEnvelope(relayInput(message(content), 'old-id').content[0].text)
    assert.equal(old.content, content)
    assert.equal(old.title, undefined)
  }
})

test('subtask assignments require titled summary replies and inbound replies prompt reporting to the user', () => {
  assert.equal(replyMessageTitle('调研企微接入'), '汇报：调研企微接入')
  assert.equal(replyMessageTitle('汇报：调研企微接入'), '汇报：调研企微接入')
  assert.equal(replyMessageTitle(''), undefined)

  const task = relayInput({ ...message('请检查配置'), title: '调研企微接入' }, 'in-1').content[0].text
  assert.match(task, /in_reply_to=fixture/)
  assert.match(task, /matching title such as "汇报：调研企微接入"/)
  assert.match(task, /concise summary/)

  const reply = relayInput({ ...message('已完成，发现 2 处问题'), title: '汇报：调研企微接入', in_reply_to: 'orig-1' }, 'in-2').content[0].text
  assert.match(reply, /\(reply to orig-1\)/)
  assert.match(reply, /summarize the conclusion, key changes, and any open questions directly for the user/)
  assert.match(reply, /Do not send another message/)
})

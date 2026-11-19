import assert from 'node:assert/strict'
import test from 'node:test'
import { tokenizeMessageText } from '../src/lib/message_text.ts'

test('keeps message whitespace and newlines unchanged outside URLs', () => {
  const text = 'line one\n  indented line\nline three'
  assert.deepEqual(tokenizeMessageText(text), [{ type: 'text', value: text }])
})

test('links URLs that start after a newline or indentation', () => {
  assert.deepEqual(
    tokenizeMessageText('docs:\n  https://example.com/a?b=1\nnext'),
    [
      { type: 'text', value: 'docs:\n  ' },
      { type: 'url', value: 'https://example.com/a?b=1' },
      { type: 'text', value: '\nnext' },
    ],
  )
})

test('keeps sentence punctuation outside the URL', () => {
  assert.deepEqual(tokenizeMessageText('See https://example.com/docs).'), [
    { type: 'text', value: 'See ' },
    { type: 'url', value: 'https://example.com/docs' },
    { type: 'text', value: ').' },
  ])
})

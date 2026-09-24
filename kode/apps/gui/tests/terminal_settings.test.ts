import assert from 'node:assert/strict'
import test from 'node:test'

import { terminalFontFamilyStack } from '../src/lib/terminal_font.ts'

const fallback = '"SF Mono", Menlo, monospace'

test('keeps an existing CSS font stack intact', () => {
  const stack = 'Cascadia Mono, Consolas, "SF Mono", Menlo, monospace'
  assert.equal(terminalFontFamilyStack(stack, fallback), stack)
})

test('quotes one selected family and appends fallback fonts', () => {
  assert.equal(
    terminalFontFamilyStack('JetBrains Mono', fallback),
    '"JetBrains Mono", "SF Mono", Menlo, monospace',
  )
})

test('keeps the generic monospace family unquoted', () => {
  assert.equal(
    terminalFontFamilyStack('monospace', fallback),
    'monospace, "SF Mono", Menlo, monospace',
  )
})

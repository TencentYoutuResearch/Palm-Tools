import assert from 'node:assert/strict'
import test from 'node:test'

import { terminalLinkModifierPressed } from '../src/lib/terminal_links.ts'

test('Windows terminal links open with Ctrl+Click', () => {
  assert.equal(terminalLinkModifierPressed({ metaKey: false, ctrlKey: true }, true), true)
  assert.equal(terminalLinkModifierPressed({ metaKey: false, ctrlKey: false }, true), false)
})

test('macOS terminal links keep Cmd+Click as the modifier', () => {
  assert.equal(terminalLinkModifierPressed({ metaKey: true, ctrlKey: false }, false), true)
  assert.equal(terminalLinkModifierPressed({ metaKey: false, ctrlKey: true }, false), false)
})

test('missing mouse modifiers never open a link', () => {
  assert.equal(terminalLinkModifierPressed(undefined, true), false)
  assert.equal(terminalLinkModifierPressed(null, false), false)
})

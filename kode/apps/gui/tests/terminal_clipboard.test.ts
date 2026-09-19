import { test } from 'node:test'
import assert from 'node:assert/strict'
import { windowsClipboardAction } from '../src/lib/terminal_clipboard.ts'

const key = { key: 'c', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, isComposing: false }
test('Windows clipboard keys preserve Ctrl+C and support copy/paste', () => {
  assert.equal(windowsClipboardAction(key, 'Windows NT 10.0'), null)
  assert.equal(windowsClipboardAction({ ...key, key: 'C', shiftKey: true }, 'Windows NT 10.0'), 'copy')
  for (const shiftKey of [false, true]) {
    assert.equal(windowsClipboardAction({ ...key, key: 'V', shiftKey }, 'Windows NT 10.0'), 'paste')
  }
})
test('clipboard override is Windows-only and excludes IME and AltGr', () => {
  const paste = { ...key, key: 'v' }
  for (const ua of ['Macintosh', 'Linux']) assert.equal(windowsClipboardAction(paste, ua), null)
  for (const override of [{ altKey: true }, { metaKey: true }, { isComposing: true }, { ctrlKey: false }]) {
    assert.equal(windowsClipboardAction({ ...paste, ...override }, 'Windows'), null)
  }
})

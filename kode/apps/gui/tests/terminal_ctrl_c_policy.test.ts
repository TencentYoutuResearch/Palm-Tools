import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldConfirmTcodexCtrlC } from '../src/lib/terminal_ctrl_c_policy.ts'

test('confirms the first idle Ctrl+C for Windows TCodex', () => {
  assert.equal(shouldConfirmTcodexCtrlC('\x03', true, 'tcodex', 'idle'), true)
  assert.equal(shouldConfirmTcodexCtrlC('\x03', true, 'gui:tcodex', undefined), true)
})

test('preserves busy interrupt and non-Windows behavior', () => {
  assert.equal(shouldConfirmTcodexCtrlC('\x03', true, 'tcodex', 'busy'), false)
  assert.equal(shouldConfirmTcodexCtrlC('\x03', false, 'tcodex', 'idle'), false)
  assert.equal(shouldConfirmTcodexCtrlC('a', true, 'tcodex', 'idle'), false)
})

test('does not apply the TCodex policy to other backends', () => {
  assert.equal(shouldConfirmTcodexCtrlC('\x03', true, 'codex', 'idle'), false)
})

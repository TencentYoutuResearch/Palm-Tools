import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isTcodexBackendKey,
  shouldOfferTcodexExitRecovery,
} from '../src/lib/session_exit_guard.ts'
import { isWindowsUserAgent } from '../src/lib/platform.ts'

test('recognizes local and namespaced tcodex backend keys', () => {
  assert.equal(isTcodexBackendKey('tcodex'), true)
  assert.equal(isTcodexBackendKey('gui:tcodex'), true)
  assert.equal(isTcodexBackendKey('codex'), false)
})

test('offers recovery only for a tcodex tab exiting successfully', () => {
  assert.equal(shouldOfferTcodexExitRecovery({ backendKey: 'tcodex' }, 0), true)
  assert.equal(shouldOfferTcodexExitRecovery({ backendKey: 'tcodex' }, 1), false)
  assert.equal(shouldOfferTcodexExitRecovery({ backendKey: 'codex' }, 0), false)
  assert.equal(shouldOfferTcodexExitRecovery(undefined, 0), false)
  assert.equal(shouldOfferTcodexExitRecovery({ backendKey: 'tcodex' }, null), false)
})

test('detects Windows user agents for platform-only protections', () => {
  assert.equal(isWindowsUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), true)
  assert.equal(isWindowsUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6)'), false)
  assert.equal(isWindowsUserAgent('Mozilla/5.0 (X11; Linux x86_64)'), false)
})

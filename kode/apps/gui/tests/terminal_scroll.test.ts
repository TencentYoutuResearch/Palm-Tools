import assert from 'node:assert/strict'
import test from 'node:test'
import { terminalScrollSensitivity, terminalWheelDelta } from '../src/lib/terminal_scroll.ts'

const options = { scrollSensitivity: terminalScrollSensitivity('tclaude') }

const event = {
  deltaY: 16,
  deltaMode: 0,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
}

test('only Claude-family sessions increase scroll sensitivity', () => {
  for (const key of ['claude', 'tclaude', 'claude-code', 'claudecode', 'claude-internal']) {
    assert.equal(terminalScrollSensitivity(key), 3)
  }
  for (const key of ['codex', 'tcodex', 'codebuddy', '', 'custom']) {
    assert.equal(terminalScrollSensitivity(key), 1)
  }
})

test('Claude wheel scrolling moves three rows for a one-row pixel delta', () => {
  assert.equal(terminalWheelDelta(event, 16, 384, options), 48)
  assert.equal(terminalWheelDelta({ ...event, deltaY: -16 }, 16, 384, options), -48)
})

test('line and page wheel deltas retain their units', () => {
  assert.equal(terminalWheelDelta({ ...event, deltaY: 1, deltaMode: 1 }, 16, 384, options), 48)
  assert.equal(terminalWheelDelta({ ...event, deltaY: -1, deltaMode: 2 }, 16, 384, options), -1152)
})

test('trackpad fractional deltas remain continuous without a minimum step', () => {
  assert.equal(terminalWheelDelta({ ...event, deltaY: 0.25 }, 16, 384, options), 0.75)
})

test('fallback respects xterm sensitivity and fast-scroll modifiers', () => {
  assert.equal(terminalWheelDelta(event, 16, 384, { scrollSensitivity: 2 }), 32)
  assert.equal(terminalWheelDelta({ ...event, altKey: true }, 16, 384, options), 240)
  assert.equal(terminalWheelDelta({ ...event, ctrlKey: true }, 16, 384, {
    ...options, fastScrollModifier: 'ctrl', fastScrollSensitivity: 2,
  }), 96)
  assert.equal(terminalWheelDelta({ ...event, altKey: true }, 16, 384, {
    ...options, fastScrollModifier: 'ctrl',
  }), 48)
})

test('horizontal gestures and empty vertical deltas are not consumed', () => {
  assert.equal(terminalWheelDelta({ ...event, shiftKey: true }, 16, 384, {}), 0)
  assert.equal(terminalWheelDelta({ ...event, deltaY: 0 }, 16, 384, {}), 0)
})

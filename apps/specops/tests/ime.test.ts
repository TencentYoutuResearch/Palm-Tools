import { describe, expect, test, vi } from 'vitest'

import { shouldSubmitOnEnter } from '../frontend/src/lib/ime.js'

function event(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, ...overrides } as KeyboardEvent
}

describe('IME enter guard', () => {
  test('does not submit while composing or for legacy keyCode 229', () => {
    expect(shouldSubmitOnEnter(event({ isComposing: true }), false, 0)).toBe(false)
    expect(shouldSubmitOnEnter(event({ keyCode: 229 }), false, 0)).toBe(false)
    expect(shouldSubmitOnEnter(event(), true, 0)).toBe(false)
  })

  test('suppresses the enter immediately after compositionend', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    expect(shouldSubmitOnEnter(event(), false, 950)).toBe(false)
    expect(shouldSubmitOnEnter(event(), false, 800)).toBe(true)
    vi.restoreAllMocks()
  })
})

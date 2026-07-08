import { describe, expect, test } from 'vitest'

import { LANGUAGE_DIRECTIVE } from '../src/domain/intake.js'
import { buildClarifyPrompt, detectClarifyCompletion } from '../src/domain/clarify.js'

describe('clarify', () => {
  test('prompt instructs agent to use plan mode and inspect codebase', () => {
    const prompt = buildClarifyPrompt('Add dark mode', 'clarify-abc')
    expect(prompt).toContain('specops.clarify.md')
    expect(prompt).toContain('constitution.md')
    expect(prompt).toContain('EnterPlanMode')
    expect(prompt).toContain('ExitPlanMode')
    expect(prompt).toContain('clarify-abc')
    expect(prompt).toContain('Add dark mode')
  })

  test('prompt embeds language directive so plan matches request language', () => {
    const prompt = buildClarifyPrompt('添加深色模式', 'clarify-zh')
    expect(prompt).toContain(LANGUAGE_DIRECTIVE)
    expect(prompt).toContain("Match the document language to the user request's language")
  })

  test('detectClarifyCompletion matches marker on its own line', () => {
    expect(detectClarifyCompletion('Some text\nCLARIFY_COMPLETE\n')).toBe(true)
    expect(detectClarifyCompletion('CLARIFY_COMPLETE')).toBe(true)
    expect(detectClarifyCompletion('  CLARIFY_COMPLETE  \n')).toBe(true)
  })

  test('detectClarifyCompletion does not match marker embedded in text', () => {
    expect(detectClarifyCompletion('The CLARIFY_COMPLETE marker is used')).toBe(false)
    expect(detectClarifyCompletion('I will not emit CLARIFY_COMPLETE yet')).toBe(false)
  })
})

import { describe, expect, test } from 'vitest'

import { formatQuestionsForTranscript, nextPendingPrompt } from '../src/domain/session-monitor.js'

describe('SpecOps session prompt monitoring', () => {
  test('advances multi-question AskUserQuestion events in CLI order', () => {
    const events = [
      { type: 'session.status', payload: { status: 'busy' } },
      { type: 'ask_user_question', payload: { question_id: 'ask-0', question: 'First?', options: [{ label: 'A' }] } },
      { type: 'ask_user_question', payload: { question_id: 'ask-1', question: 'Second?', options: [{ label: 'B' }] } },
    ]

    expect(nextPendingPrompt(events, [])?.id).toBe('ask-0')
    expect(nextPendingPrompt(events, ['ask-0'])?.id).toBe('ask-1')
    expect(nextPendingPrompt(events, ['ask-0', 'ask-1'])).toBeNull()
  })

  test('skips answered prompts before selecting a later plan review', () => {
    const events = [
      { type: 'ask_user_question', payload: { question_id: 'ask-0' } },
      { type: 'plan_proposed', payload: { plan_id: 'plan-0', plan_md: '# Plan' } },
    ]

    expect(nextPendingPrompt(events, ['ask-0'])).toMatchObject({ kind: 'plan_review', id: 'plan-0' })
  })

  test('persists the complete question and options before the answer', () => {
    expect(formatQuestionsForTranscript([
      { question_id: 'framework', prompt: 'Which framework?', options: [{ label: 'Svelte', description: 'Small bundle' }], multi_select: false },
      { question_id: 'tests', prompt: 'Which tests?', options: [{ label: 'Vitest' }], multi_select: false },
    ])).toBe([
      'Question 1: Which framework?',
      '  1. Svelte — Small bundle',
      '',
      'Question 2: Which tests?',
      '  1. Vitest',
    ].join('\n'))
  })
})

import { describe, expect, test } from 'vitest'

import { createTranscriptDisplayItems } from '../frontend/src/lib/transcriptDisplay.ts'
import type { TranscriptEntry } from '../frontend/src/lib/types.ts'

function message(text = 'hello'): TranscriptEntry {
  return { role: 'agent', text, kind: 'text' }
}

function toolUse(id?: string): TranscriptEntry {
  return {
    role: 'agent',
    text: '',
    kind: 'tool_use',
    tool: 'Read',
    tool_call_id: id,
    summary: 'Read file',
    status: 'running',
  }
}

function toolResult(id?: string, preview = '{"ok":true}'): TranscriptEntry {
  return {
    role: 'agent',
    text: '',
    kind: 'tool_result',
    tool: 'Read',
    tool_call_id: id,
    preview,
    status: 'ok',
  }
}

describe('createTranscriptDisplayItems', () => {
  test('pairs tool_use and tool_result by tool_call_id at the use position', () => {
    const use = toolUse('call-1')
    const result = toolResult('call-1')
    const after = message('after')

    const items = createTranscriptDisplayItems([use, after, result])

    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ kind: 'tool', entry: use, resultEntry: result })
    expect(items[1]).toMatchObject({ kind: 'message', entry: after })
  })

  test('keeps unfinished tool_use visible without a result', () => {
    const use = toolUse('call-1')

    const items = createTranscriptDisplayItems([use])

    expect(items).toEqual([{ kind: 'tool', entry: use, resultEntry: undefined, key: 'tool:call-1' }])
  })

  test('keeps isolated tool_result visible', () => {
    const result = toolResult('call-1')

    const items = createTranscriptDisplayItems([result])

    expect(items).toEqual([{ kind: 'tool', entry: result, resultEntry: undefined, key: 'tool-result:call-1' }])
  })

  test('does not pair tool entries without tool_call_id', () => {
    const use = toolUse()
    const result = toolResult()

    const items = createTranscriptDisplayItems([use, result])

    expect(items).toEqual([
      { kind: 'tool', entry: use, resultEntry: undefined, key: 'tool-use:0' },
      { kind: 'tool', entry: result, resultEntry: undefined, key: 'tool-result:1' },
    ])
  })

  test('consumes duplicate results for the same paired call id', () => {
    const use = toolUse('call-1')
    const firstResult = toolResult('call-1', '{"first":true}')
    const duplicateResult = toolResult('call-1', '{"duplicate":true}')

    const items = createTranscriptDisplayItems([use, firstResult, duplicateResult])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'tool', entry: use, resultEntry: firstResult })
  })

  test('pairs result that appears before its use and removes the result card', () => {
    const result = toolResult('call-1')
    const use = toolUse('call-1')

    const items = createTranscriptDisplayItems([result, use])

    expect(items).toEqual([{ kind: 'tool', entry: use, resultEntry: result, key: 'tool:call-1' }])
  })
})

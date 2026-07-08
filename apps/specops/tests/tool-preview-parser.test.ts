import { describe, expect, test } from 'vitest'

import { parseToolPreview } from '../frontend/src/lib/toolPreview.ts'

describe('parseToolPreview (lib/toolPreview.ts pure parser)', () => {
  test('parses a JSON object into kind:json', () => {
    const result = parseToolPreview('{"path":"/a/b","limit":10,"offset":0}')
    expect(result.kind).toBe('json')
    if (result.kind === 'json') expect(result.value).toEqual({ path: '/a/b', limit: 10, offset: 0 })
  })

  test('parses a JSON array into kind:json', () => {
    const result = parseToolPreview('[{"a":1},{"b":2}]')
    expect(result.kind).toBe('json')
    if (result.kind === 'json') expect(result.value).toEqual([{ a: 1 }, { b: 2 }])
  })

  test('falls back to text for JSON primitives (not object/array)', () => {
    const result = parseToolPreview('123')
    expect(result.kind).toBe('text')
  })

  test('falls back to text for malformed JSON that looks like JSON', () => {
    const result = parseToolPreview('{"unclosed": ')
    expect(result.kind).toBe('text')
  })

  test('parses multi-line key:value form into kind:kv', () => {
    const input = ['command: git status', 'exit_code: 0', 'output: clean'].join('\n')
    const result = parseToolPreview(input)
    expect(result.kind).toBe('kv')
    if (result.kind === 'kv') {
      expect(result.lines).toHaveLength(3)
      expect(result.lines[0]?.key).toBe('command')
      expect(result.lines[0]?.value).toBe('git status')
      expect(result.lines[1]?.key).toBe('exit_code')
      expect(result.lines[2]?.value).toBe('clean')
    }
  })

  test('kv form tolerates blank / non-matching lines mixed in', () => {
    const input = ['name: foo', '', 'note: a prose line below'].join('\n')
    const result = parseToolPreview(input)
    expect(result.kind).toBe('kv')
    if (result.kind === 'kv') {
      expect(result.lines.some((l) => l.raw === '')).toBe(true)
      expect(result.lines.find((l) => l.key === 'note')?.value).toBe('a prose line below')
    }
  })

  test('falls back to text for prose with a single colon (not kv)', () => {
    const result = parseToolPreview('just one: line of prose')
    expect(result.kind).toBe('text')
  })

  test('falls back to text for plain prose', () => {
    const result = parseToolPreview('hello world, nothing structured here')
    expect(result.kind).toBe('text')
    if (result.kind === 'text') expect(result.value).toBe('hello world, nothing structured here')
  })

  test('handles empty input without throwing', () => {
    expect(parseToolPreview('')).toEqual({ kind: 'text', value: '' })
    expect(parseToolPreview('   ')).toEqual({ kind: 'text', value: '   ' })
  })

  test('handles non-string input without throwing', () => {
    const result = parseToolPreview(undefined as unknown as string)
    expect(result.kind).toBe('text')
  })
})

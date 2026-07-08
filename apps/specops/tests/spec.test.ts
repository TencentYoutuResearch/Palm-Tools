import { describe, expect, test } from 'vitest'

import { parseDocument, serializeDocument } from '../src/domain/spec.js'

describe('spec document', () => {
  test('round trips markdown and frontmatter', () => {
    const content = serializeDocument({
      frontmatter: {
        schema_version: 1,
        id: 'config/no-positional',
        kind: 'spec',
        title: 'No positional arguments',
        status: 'active',
        verifies: ['core-tests'],
      },
      body: '# Constraint\n\nBackends must not add positional arguments.',
    })
    const parsed = parseDocument(content, '.specops/specs/no-positional.md')
    expect(parsed.frontmatter.id).toBe('config/no-positional')
    expect(parsed.frontmatter.verifies).toEqual(['core-tests'])
    expect(parsed.body).toContain('Backends must not add')
  })

  test('rejects unsupported schema', () => {
    expect(() => parseDocument('---\nschema_version: 9\nid: x\nkind: spec\ntitle: X\nstatus: active\n---\n', 'x.md'))
      .toThrow('schema_version must be 1')
  })
})

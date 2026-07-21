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
      .toThrow('schema_version must be 1 or 2')
  })

  test('separates normative specs from executable work items', () => {
    const normative = parseDocument('---\nschema_version: 2\nid: policy/no-workflow\nkind: spec\ndocument_class: normative\nspec_type: policy\ntitle: No workflow\nstatus: active\n---\n', 'spec.md')
    expect(normative.frontmatter.document_class).toBe('normative')
    expect(() => parseDocument('---\nschema_version: 2\nid: invalid\nkind: spec\ndocument_class: normative\nspec_type: policy\nworkflow_profile: feature\ntitle: Invalid\nstatus: active\n---\n', 'invalid.md')).toThrow('cannot declare workflow_profile')
    const work = parseDocument('---\nschema_version: 2\nid: fix/no-workflow\nkind: bug\ndocument_class: work_item\nwork_type: bugfix\ntargets: [policy/no-workflow]\ntitle: Fix it\nstatus: proposed\n---\n', 'proposal.md')
    expect(work.frontmatter.targets).toEqual(['policy/no-workflow'])
  })
})

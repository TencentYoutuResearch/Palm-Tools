import { describe, expect, test } from 'vitest'

import { buildIntakePrompt, buildIntakePlanPrompt, LANGUAGE_DIRECTIVE } from '../src/domain/intake.js'

describe('skill-driven intake', () => {
  test('analysis prompt allows one canonical document but forbids implementation', () => {
    const prompt = buildIntakePrompt('Why are sessions slow?', 'intake-123')
    expect(prompt).toContain('Create one or more canonical change folders')
    expect(prompt).toContain('Do not edit source files')
    expect(prompt).toContain('create a Git worktree')
    expect(prompt).toContain('.specops/state/intakes/intake-123.json')
    expect(prompt).not.toContain('SPECOPS_DOCUMENT')
  })

  test('plan-first prompt instructs agent to use plan mode and inspect codebase', () => {
    const prompt = buildIntakePlanPrompt('Add dark mode', 'intake-456')
    expect(prompt).toContain('plan-first intake')
    expect(prompt).toContain('EnterPlanMode')
    expect(prompt).toContain('ExitPlanMode')
    expect(prompt).toContain('intake-456')
    expect(prompt).toContain('Add dark mode')
  })

  test('prompts embed the language directive so docs match request language', () => {
    const direct = buildIntakePrompt('修复会话卡顿', 'intake-zh')
    const plan = buildIntakePlanPrompt('修复会话卡顿', 'intake-zh')
    for (const prompt of [direct, plan]) {
      expect(prompt).toContain(LANGUAGE_DIRECTIVE)
      expect(prompt).toContain("Match the document language to the user request's language")
      // Frontmatter keys must stay English even for Chinese requests
      expect(prompt).toContain('Keep YAML frontmatter')
    }
  })

  test('language directive keeps frontmatter keys in English', () => {
    expect(LANGUAGE_DIRECTIVE).toContain('schema_version')
    expect(LANGUAGE_DIRECTIVE).toContain('English')
    // The directive forbids translating the user request verbatim quotes
    expect(LANGUAGE_DIRECTIVE).toMatch(/Do not translate the user request/i)
  })

  test('validates a multi-document receipt', async () => {
    const { parseIntakeReceipt } = await import('../src/domain/intake.js')
    const receipt = parseIntakeReceipt(JSON.stringify({
      schema_version: 1,
      intake_id: 'intake-123',
      status: 'completed',
      primary: '.specops/changes/feature/search.md',
      documents: [
        '.specops/changes/feature/search.md',
        '.specops/specs/search-process.md',
      ],
    }), 'intake-123')
    expect(receipt.documents).toHaveLength(2)
    expect(receipt.primary).toBe('.specops/changes/feature/search.md')
  })

  test('checkProposal passes when all required sections exist', async () => {
    const { checkProposal } = await import('../src/domain/intake.js')
    const body = `# Title\n\n## Motivation\nNeed it.\n\n## Scope\nThing A.\n\n## Acceptance criteria\n- Works.\n\n## Out of scope\nThing B.`
    const result = checkProposal(body)
    expect(result.ok).toBe(true)
    expect(result.missing).toHaveLength(0)
  })

  test('checkProposal reports missing sections', async () => {
    const { checkProposal } = await import('../src/domain/intake.js')
    const body = `# Title\n\n## Motivation\nNeed it.\n`
    const result = checkProposal(body)
    expect(result.ok).toBe(false)
    expect(result.missing).toContain('## Scope')
    expect(result.missing).toContain('## Acceptance criteria')
    expect(result.missing).toContain('## Out of scope')
  })
})

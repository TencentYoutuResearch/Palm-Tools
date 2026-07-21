import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { BUILTIN_AGENT_PROMPTS, composeRolePrompt, resolveAgentPrompt } from '../src/domain/agent-prompts.js'
import { initWorkspace } from '../src/domain/commands.js'
import { loadConfig } from '../src/domain/config.js'
import { gitWorkspace } from './helpers.js'

const cleanup: string[] = []
afterEach(async () => Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true }))))

describe('agent prompts', () => {
  test('ships explicit responsibilities for the three workflow roles', () => {
    expect(BUILTIN_AGENT_PROMPTS.analysis).toContain('primary SpecOps agent')
    expect(BUILTIN_AGENT_PROMPTS.implementation).toContain('isolated Run worktree')
    expect(BUILTIN_AGENT_PROMPTS.review).toContain('Remain read-only')
  })

  test('loads a workspace prompt override without escaping the workspace', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    await writeFile(path.join(workspace, '.specops', 'agents', 'clarify.md'), 'Custom clarify contract\n')
    const resolved = await resolveAgentPrompt(workspace, await loadConfig(workspace), 'analysis')
    expect(resolved).toMatchObject({ content: 'Custom clarify contract', source: '.specops/agents/clarify.md', builtin: false })
  })

  test('composes the role contract before the current assignment', () => {
    expect(composeRolePrompt('Role contract', 'Do task')).toBe('Role contract\n\n---\n\n# Current assignment\n\nDo task')
  })
})
